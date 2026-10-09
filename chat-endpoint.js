// chat-endpoint.js

import { requireAuth, describeAuthError } from './auth-middleware.js';
import { resolveAccountWithRole, assertPlan } from './subscription.js';
import { checkAndIncrement, getUsage } from './usage.js';
import { getPlan, resolveChatTier, MODEL_TIERS, VISION_MODEL, planHasVision, planHasConnectorTools, planHasSandbox } from './entitlements.js';
import { callWithFallback, callVisionModel, callWithTools, makeSessionId } from './providers.js';
import { buildChatSystemPrompt, buildVisionSystemPrompt, chatPromptInfo, stableHistoryWindow } from './prompts.js';
import {
  getAvailableTools, toolRequiresConfirmation, describeTool, providerForTool,
  executeConnectorTool, shouldOfferConnectorTools, validateToolArgs, approvalScopeForTool, isToolApproved,
  getSandboxToolSchemas, isSandboxToolName, describeConfirmation, stepMeta,
} from './connector-tools.js';
import { selectSandboxProvider, cleanConversationId } from './sandbox-provider.js';
import * as sandboxTools from './sandbox-tools.js';
import * as mediaTools from './media-tools.js';
import { extractUiBlocks, createUiStream, UI_TYPES } from './ui-schema.js';

// ─────────────────────────────────────────────────────────────────────
// Agent loop bounds (see Bug 2 in the audit doc). A user request can
// require several dependent tool calls (read → analyze → write →
// verify); the loop below keeps calling tools and feeding results back
// to the model, without returning control to the user, until the model
// produces a plain reply with no further tool call, or one of these
// ceilings is hit. The ONLY thing that pauses the loop and returns
// control to the user mid-task is a write action that isn't already
// approved for this conversation (see REQUIRES_CONFIRMATION / the
// approvals mechanism below) — everything else auto-continues.
// ─────────────────────────────────────────────────────────────────────

// Hard ceiling on chained tool-call rounds in a single request. An agent
// loop with no ceiling can spin forever on a task it has misunderstood,
// burning API cost/quota with no human in the loop to notice. 8 rounds
// comfortably covers realistic chained work (read → analyze → write →
// commit → verify is 4) while bounding worst-case cost. Hitting this
// ends the turn with an honest "I got partway through and need your
// input to continue" message — never a fabricated completion.
const MAX_AGENT_ROUNDS = 8;

// Sandbox work is naturally longer (write, run, read the error, fix, run
// again), so a turn that can use the sandbox gets a higher ceiling. Every
// sandbox run is also counted against the plan's sandboxRunsPerDay and a
// per-turn cap (MAX_SANDBOX_CALLS_PER_TURN in sandbox-tools.js), so a higher
// round ceiling cannot become a way around those limits.
const MAX_AGENT_ROUNDS_SANDBOX = 14;

// If the model calls the same tool with invalid/missing arguments this
// many times in a row, stop silently retrying and surface it to the user
// honestly instead (Bug 3) — a call that keeps failing validation is a
// sign the model is missing information only the user can supply, not a
// transient slip worth hiding forever.
const MAX_INVALID_ARG_RETRIES_PER_TOOL = 2;

// If the model produces a plain-text reply that claims an action is done
// but no tool actually executed this turn, we give it exactly one chance
// to self-correct (call the tool, or admit it hasn't been done) before
// we override its text with an honest fallback ourselves (Bug 1 / Bug 5).
const MAX_GROUNDING_RETRIES = 1;

const MAX_IMAGES_PER_REQUEST = 4;
const HARD_MAX_IMAGE_BASE64_CHARS = 8_000_000;

// Deliberately cheap, deterministic, maintained-by-hand pattern list — NOT
// an LLM call. This has to run on every single response, so it must be
// fast, and it must not itself be a source of hallucination. It only
// needs to catch the common confident-completion phrasings; see Bug 1.
const COMPLETION_CLAIM_PATTERNS = [
  /\bI(?:'ve| have) (?:just )?(?:committed|added|updated|created|removed|deleted|opened|merged|closed|renamed|pushed|posted|scheduled)\b/i,
  /\b(?:has|have)(?:'s)? (?:now )?been (?:added|updated|committed|created|removed|deleted|opened|merged|closed|renamed|pushed|posted|scheduled)\b/i,
  /\bis now (?:updated|committed|live|merged|scheduled|on your calendar)\b/i,
  /\ball (?:set|done)\b/i,
  /\bsuccessfully\b/i,
  /\b(?:that's|this is|it's) (?:done|complete|finished|taken care of)\b/i,
  /\bI(?:'m| am) done\b/i,
  /\bthe (?:file|issue|branch|commit|pull request|pr|event|design) (?:is|has been) (?:updated|created|committed|opened|merged|added)\b/i,
];

// Bug 1/5 catches a reply that falsely CLAIMS the task is done. This
// catches the other failure mode we've now actually seen in testing: a
// reply that never claims anything, isn't a real answer to the user at
// all, and stops the task silently — either a short mechanical
// tool-narration line (the kind that used to get fed back as fake
// assistant speech, see the workingMessages fix above) or a reply that's
// obviously just describing an in-progress action rather than
// addressing the user. Deliberately narrow (a handful of verb-first
// progress-narration openers) so it never flags a genuine short answer
// like "Yes, I can do that." or "No repositories found.".
const NARRATION_LEAK_PATTERNS = [
  /^(Running|Working on|Checking|Looking at|Reading|Fetching|Attempting)\b.{0,120}(to understand|to check|to see|to find out)\b/i,
  /^Running\s+(Checking|Looking at|Reading|Fetching)\b/i,
];

function _looksLikeLeakedNarration(text) {
  if (!text) return false;
  const t = text.trim();
  if (!t || t.length > 200) return false; // a real, substantive answer is never this and this short
  return NARRATION_LEAK_PATTERNS.some((re) => re.test(t));
}

function _claimsCompletion(text) {
  if (!text) return false;
  return COMPLETION_CLAIM_PATTERNS.some((re) => re.test(text));
}

// A third failure mode, distinct from both of the above: the model
// narrates an *intention* to keep investigating ("I'll examine the
// JavaScript files… let me check a few key files") and then just stops,
// handing that back as if it were the final answer. It's not a false
// completion claim (nothing is claimed done) and it's not the short
// mechanical narration pattern above — it reads like a real sentence,
// which is exactly why it used to slip through as "Completed" in the UI
// even though the task plainly wasn't. Bounded separately from the
// grounding retries below (MAX_STALL_RETRIES) since this isn't a
// hallucination to correct, it's a legitimate task that just needs the
// model to actually keep going.
const MAX_STALL_RETRIES = 2;
const STALL_PATTERNS = [
  /^(?:I(?:'ll| will)|Let me|I(?:'m| am) going to|I need to)\s+(?:check|examine|look at|review|investigate|explore|dig into|go through|take a look at|see)\b/i,
];

function _looksLikeUnfinishedStall(text) {
  if (!text) return false;
  const t = text.trim();
  // A genuine clarifying question to the user ends with "?" — that's the
  // "genuinely blocked" pause the system prompt explicitly allows, never
  // a stall to correct.
  if (!t || t.length > 220 || t.endsWith('?')) return false;
  return STALL_PATTERNS.some((re) => re.test(t));
}

// Client-supplied, conversation-scoped record of writes the user has
// already approved this conversation (Bug 4). Never trusted blindly:
// re-validated shape on every request, and a record only ever suppresses
// the redundant confirmation prompt for the EXACT same provider + scope
// (e.g. exact owner/repo) + tool name — it never widens to a different
// repo, a different provider, or a different action class, and it never
// persists across conversations (the frontend only sends it back for the
// same conversation it came from).
// The browser's report of a sandbox run it just did for us (Tier 1). It is
// treated as data only: the call description, the result and the trace are
// size-capped and re-shaped here, and nothing in it can grant a permission
// (billing for the run happens here, in the Worker, not from this object).
function _parseSandboxResume(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const call = raw.call && typeof raw.call === 'object' ? raw.call : null;
  if (!call || typeof call.name !== 'string' || !isSandboxToolName(call.name)) return null;
  return {
    call: { id: typeof call.id === 'string' ? call.id.slice(0, 40) : '', name: call.name, args: (call.args && typeof call.args === 'object') ? call.args : {} },
    assistantText: typeof raw.assistantText === 'string' ? raw.assistantText.slice(0, 4000) : '',
    result: raw.result && typeof raw.result === 'object' ? raw.result : {},
    cancelled: !!raw.cancelled,
    trace: sandboxTools.sanitizeTrace(raw.trace),
  };
}

function _sanitizeApprovals(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((a) => a && typeof a === 'object' && typeof a.provider === 'string' && typeof a.scope === 'string' && Array.isArray(a.approvedActionClasses))
    .slice(0, 50)
    .map((a) => ({
      provider: a.provider,
      scope: a.scope,
      approvedActionClasses: a.approvedActionClasses.filter((x) => typeof x === 'string').slice(0, 50),
    }));
}

function _mergeApproval(approvals, provider, scope, actionClass) {
  const list = approvals.slice();
  const idx = list.findIndex((a) => a.provider === provider && a.scope === scope);
  if (idx === -1) {
    list.push({ provider, scope, approvedActionClasses: [actionClass] });
  } else if (!list[idx].approvedActionClasses.includes(actionClass)) {
    list[idx] = { ...list[idx], approvedActionClasses: [...list[idx].approvedActionClasses, actionClass] };
  }
  return list;
}

// Forwards the model's reply to the browser while it is still being written.
// Provider text chunks arrive through onText (see providers.js streaming):
//   - prose goes out as `event: text` frames ({ t }), with the cognita-ui fence
//     and any <think> block held back so raw JSON / reasoning never shows as text;
//   - the same chunks feed the existing incremental parser (createUiStream), and
//     only validated blocks/patches go out as `event: ui` frames.
// `event: text_reset` tells the browser to drop what it showed for a model turn
// that turned out not to be the final answer (tool call, grounding retry).
// `done` still carries the full, final, validated result and replaces the preview.
const _FENCE = '```cognita-ui';
function _makeTurnStreamer(emit) {
  let raw = '';
  let sent = '';
  let ui = createUiStream();
  let lastSig = '';
  let streamed = false;
  const count = (list) => list.reduce((n, b) => n + 1 + count(b.children || []) + ((b.props && Array.isArray(b.props.items) && (b.type === 'tabs' || b.type === 'accordion')) ? b.props.items.reduce((m, it) => m + count(it.children || []), 0) : 0), 0);

  // `text` is what the existing parser (createUiStream) says is prose: fenced
  // cognita-ui blocks are already removed (open ones too) and prose written
  // after a block is kept. Reasoning blocks and a half-typed fence marker are
  // held back so they never flash up as text.
  function visibleOf(text, final) {
    let v = text.replace(/<think>[\s\S]*?<\/think>/g, '');
    const t = v.indexOf('<think>');
    if (t !== -1) v = v.slice(0, t);
    const f = v.indexOf(_FENCE);
    if (f !== -1) v = v.slice(0, f);
    if (!final) {
      for (const tok of [_FENCE, '<think>']) {
        for (let k = Math.min(tok.length - 1, v.length); k > 0; k--) {
          if (tok.startsWith(v.slice(v.length - k))) { v = v.slice(0, v.length - k); break; }
        }
      }
    }
    return v;
  }
  function flushText(parsedText, final) {
    const v = visibleOf(parsedText, final);
    if (v.length > sent.length && v.startsWith(sent)) {
      const t = v.slice(sent.length);
      sent = v;
      streamed = true;
      emit('text', { t });
    }
  }
  function onText(delta) {
    if (!delta) return;
    raw += delta;
    let r = null;
    try { r = ui.push(delta); } catch (_) { r = null; }
    flushText(r ? r.text : raw, false);
    if (!r || raw.indexOf('cognita-ui') === -1) return;
    // Component types the model has started writing but that are not complete yet.
    const started = (raw.match(/"type"\s*:\s*"([a-z_]+)"/g) || []).map((m) => m.replace(/.*"([a-z_]+)"$/, '$1')).filter((t) => UI_TYPES.includes(t));
    const pending = started.slice(count(r.ui)).slice(0, 3);
    const sig = JSON.stringify([r.ui, r.patches, pending]);
    if ((r.ui.length || r.patches.length || pending.length) && sig !== lastSig) {
      lastSig = sig;
      streamed = true;
      emit('ui', { ui: r.ui, patches: r.patches, pending });
    }
  }
  return {
    onText,
    finish() { let t = raw; try { t = ui.end().text; } catch (_) {} flushText(t, true); },
    reset() {
      if (streamed) emit('text_reset', {});
      raw = ''; sent = ''; lastSig = ''; streamed = false;
      ui = createUiStream();
    },
  };
}

// Some models call the component format as if it were a tool ("cognita-ui", or a component name such
// as "pie_chart"). There is no such tool, and an unknown tool name turns into an approval card for
// "a connected app", which ends the turn with the answer cut off and no components. This turns such a
// call back into what it was meant to be: a cognita-ui block appended to the answer, validated later
// by extractUiBlocks like any other.
export function _uiBlockFromPseudoCall(call, isRealTool) {
  if (!call || typeof call.name !== 'string' || isRealTool(call.name)) return null;
  const name = call.name.trim().toLowerCase().replace(/[\s-]+/g, '_');
  const a = call.args && typeof call.args === 'object' ? call.args : null;
  if (!a) return null;
  let blocks = null;
  if (name === 'cognita_ui' || name === 'cognitaui' || name === 'ui' || name === 'render_ui' || name === 'show_ui') {
    if (Array.isArray(a)) blocks = a;
    else if (Array.isArray(a.blocks)) blocks = a.blocks;
    else if (Array.isArray(a.ui)) blocks = a.ui;
    else if (typeof a.type === 'string') blocks = [a];
  } else if (UI_TYPES.includes(name)) {
    blocks = [{ type: name, ...(a.props && typeof a.props === 'object' ? a : { props: a }) }];
  }
  return blocks && blocks.length ? blocks : null;
}

/** Runs the model with tools if any are available, degrading to a plain
 * tool-less reply if the resolved tier's providers don't support
 * tool-calling at all right now. Normalizes both paths to the same
 * { text, reasoning, toolCalls } shape so the agent loop below doesn't
 * need to care which path it took. */
async function _modelTurn(tierConfig, messages, tools, env, cacheOptions) {
  if (!tools || tools.length === 0) {
    const r = await callWithFallback(tierConfig, messages, env, cacheOptions);
    return { text: r.text, reasoning: r.reasoning || null, toolCalls: null };
  }
  try {
    return await callWithTools(tierConfig, messages, tools, env, cacheOptions);
  } catch (e) {
    if (String(e.message).startsWith('tools_unsupported')) {
      console.warn('[chat] tools unsupported for this tier, falling back to plain reply:', e.message);
      const r = await callWithFallback(tierConfig, messages, env, cacheOptions);
      return { text: r.text, reasoning: r.reasoning || null, toolCalls: null };
    }
    if (String(e.message).startsWith('All providers unavailable')) {
      // Every tool-capable provider failed (rate limits, a removed model).
      // Plain chat has one more safety net, Workers AI, so answer without
      // tools rather than show an error. The model is told tools are off so
      // it cannot claim to have run anything.
      console.warn('[chat] tool providers exhausted, answering without tools');
      const note = '\n\nTools are temporarily unavailable. Answer from your own knowledge, do not claim to have run code or used any connected app, and say so briefly if the request needed one.';
      const plain = messages.map((m, i) => (i === 0 && m.role === 'system' ? { ...m, content: String(m.content) + note } : m));
      const r = await callWithFallback(tierConfig, plain, env, cacheOptions);
      return { text: r.text, reasoning: r.reasoning || null, toolCalls: null };
    }
    throw e;
  }
}

// The chat system prompts (identity, tone, date handling, formatting rules, and
// the connected-app tool rules) are built by prompts.js. They are split into
// small modules and assembled so that everything that stays the same comes
// FIRST and everything that varies (today's date, the user's first name)
// comes LAST. That is what lets the model providers reuse their work from
// earlier requests instead of re-reading the full prompt every time.

function _tierForQualityHint(hint) {
  if (hint === 'thorough') return 'reasoning';
  if (hint === 'advanced') return 'advanced';
  // 'v0' is only ever a real option for the plan resolved server-side
  // (see PLANS.admin) — a non-admin sending this hint simply fails the
  // allowedTiers.includes(requestedTier) check right below, same as
  // any other tier they're not entitled to.
  if (hint === 'v0') return 'v0';
  return 'fast';
}

// Strips an inline <think> block so it never reaches the answer. The reasoning itself is discarded.
function _stripThinking(text) {
  if (!text) return text || '';
  return text.replace(/<think>[\s\S]*?<\/think>/i, '').trim();
}

function _validateImages(images, plan) {
  if (!Array.isArray(images)) return { ok: false, error: 'images must be an array.' };
  if (images.length === 0) return { ok: true, images: [] };
  if (images.length > MAX_IMAGES_PER_REQUEST) {
    return { ok: false, error: 'You can attach up to ' + MAX_IMAGES_PER_REQUEST + ' images per message.' };
  }

  const maxCharsForPlan = Math.min(
    HARD_MAX_IMAGE_BASE64_CHARS,
    Math.floor((plan.limits.maxFileSizeMB || 5) * 1024 * 1024 * 1.37)
  );

  for (const img of images) {
    if (!img || typeof img.base64 !== 'string' || typeof img.mimeType !== 'string') {
      return { ok: false, error: 'Malformed image attachment.' };
    }
    if (!/^image\/(png|jpe?g|webp|gif)$/i.test(img.mimeType)) {
      return { ok: false, error: 'Unsupported image type: ' + img.mimeType };
    }
    if (img.base64.length > maxCharsForPlan) {
      return { ok: false, error: 'One of the attached images exceeds your plan\'s ' + plan.limits.maxFileSizeMB + 'MB file size limit.' };
    }
  }
  return { ok: true, images };
}

function _firstNameFromClaims(claims) {
  const raw = claims && claims.name ? String(claims.name).trim() : '';
  if (!raw) return null;
  const first = raw.split(/\s+/)[0];
  return first || null;
}

export async function handleChatRequest(request, env) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    const _authErr = describeAuthError(e);
    return _jsonError(_authErr.message, _authErr.status, env);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return _jsonError('Invalid JSON body.', 400, env);
  }

  const history = Array.isArray(body.messages) ? body.messages : null;
  if (!history || history.length === 0) {
    return _jsonError('Missing messages.', 400, env);
  }

  // A confirmToolCall request is the second half of the write-action
  // confirmation flow (see the tool-calling section below): the frontend
  // is not sending a new user message, it's telling us "the user approved
  // the pending action you proposed last turn, go ahead and run it." It
  // reuses the same /api/chat endpoint and the same message history, so
  // it does NOT count against the daily message quota — only tool-call
  // quota, once the action actually executes.
  const confirmToolCall = (body.confirmToolCall && typeof body.confirmToolCall === 'object' &&
    typeof body.confirmToolCall.name === 'string')
    ? { name: body.confirmToolCall.name, args: (body.confirmToolCall.args && typeof body.confirmToolCall.args === 'object') ? body.confirmToolCall.args : {} }
    : null;

  // Session-scoped (really: conversation-scoped) write approvals the
  // frontend has persisted for this specific conversation — see Bug 4.
  // Never trusted beyond "does an exact provider+scope+tool match exist";
  // see _sanitizeApprovals / isToolApproved.
  let approvals = _sanitizeApprovals(body.approvals);

  // Tier 1 sandbox runs happen in the person's browser. When one finishes,
  // the browser sends its result back on this same endpoint (see the agent
  // loop below), exactly like a confirmed action resumes a paused turn.
  const sandboxResume = _parseSandboxResume(body.sandboxResume);
  // Design requirements flow (media-tools.js). `designResume` is the second half
  // of a paused create_design: the person filled in the request card, and the
  // original call continues with their answers. Like confirmToolCall it is not
  // a new message, so it does not use the daily message quota.
  const designIn = mediaTools.sanitizeDesignInputs(body);
  const designResume = designIn.resume;
  const conversationId = cleanConversationId(body.conversationId);

  let account;
  try {
    // resolveAccountWithRole applies the unlimited/v0 'admin' plan
    // override for a verified admins/{uid} role: 'admin' doc; everyone
    // else resolves to their real plan exactly as before.
    account = await resolveAccountWithRole(identity.uid, env);
  } catch (e) {
    console.error('[chat] account resolution failed:', e.message);
    return _jsonError('Could not verify your account. Please try again.', 500, env);
  }

  const plan = getPlan(account.planId);

  if (confirmToolCall && !planHasConnectorTools(account.planId)) {
    return _jsonError('Connected-app actions are not available on the ' + plan.name + ' plan.', 403, env);
  }

  if (sandboxResume && !planHasSandbox(account.planId)) {
    return _jsonError('The sandbox is not available on the ' + plan.name + ' plan.', 403, env);
  }

  let quota;
  if (confirmToolCall || sandboxResume || designResume) {
    // Not a new message — just read today's count for the response's
    // remainingToday field, don't increment it.
    const used = await getUsage(identity.uid, 'messages', env);
    quota = { allowed: true, used, limit: plan.limits.messagesPerDay };
  } else {
    quota = await checkAndIncrement(identity.uid, 'messages', plan.limits.messagesPerDay, env);
    if (!quota.allowed) {
      return _jsonError(
        'You have reached your daily message limit for the ' + plan.name + ' plan (' + quota.limit + ' per day). ' +
        'It resets at midnight UTC, or you can upgrade for a higher limit.',
        429, env
      );
    }
  }

  // Each finished sandbox run is counted here, by the Worker, when its result
  // comes back: the browser never reports usage, it only asks to continue,
  // and every continuation costs one run.
  if (sandboxResume) {
    const runQuota = await checkAndIncrement(identity.uid, 'sandboxRuns', plan.limits.sandboxRunsPerDay, env);
    if (!runQuota.allowed) {
      return _jsonError(
        'You have reached your daily code-running limit for the ' + plan.name + ' plan (' + runQuota.limit +
        ' runs per day). It resets at midnight UTC, or you can upgrade for a higher limit.',
        429, env
      );
    }
  }

  const hasImages = Array.isArray(body.images) && body.images.length > 0;
  let images = [];

  if (hasImages) {
    if (!planHasVision(account.planId)) {
      return _jsonError(
        'Image understanding is available on ' + getPlan('plus').name + ' and above. Upgrade to attach images.',
        403, env
      );
    }

    const validated = _validateImages(body.images, plan);
    if (!validated.ok) {
      return _jsonError(validated.error, 400, env);
    }
    images = validated.images;

    const visionQuota = await checkAndIncrement(identity.uid, 'vision', plan.limits.visionPerDay, env);
    if (!visionQuota.allowed) {
      return _jsonError(
        'You have reached your daily image-understanding limit for the ' + plan.name + ' plan (' +
        visionQuota.limit + ' per day). It resets at midnight UTC.',
        429, env
      );
    }
  }

  const requestedTier = _tierForQualityHint(body.quality);
  let actualTier = 'fast';

  if (!hasImages) {
    const allowedTiers = plan.models.chat;
    if (!allowedTiers.includes(requestedTier)) {
      return _jsonError(
        'The "' + (body.quality || 'advanced') + '" quality level isn\'t available on the ' + plan.name +
        ' plan. Upgrade to unlock it, or switch to Standard quality.',
        403, env
      );
    }

    if (requestedTier !== 'fast') {
      const advQuota = await checkAndIncrement(identity.uid, 'advancedModel', plan.limits.advancedModelPerDay, env);
      if (!advQuota.allowed) {
        return _jsonError(
          'You\'ve reached your daily limit for Advanced/Thorough quality on the ' + plan.name + ' plan (' +
          advQuota.limit + ' per day). It resets at midnight UTC — switch to Standard quality to keep chatting, or upgrade for a higher limit.',
          429, env
        );
      }
    }

    actualTier = requestedTier;
  }

  const userFirstName = _firstNameFromClaims(identity.claims);

  // The window never exceeds the plan's maxContextMessages, but its START
  // only moves in small steps instead of on every message, so the provider
  // can keep reusing its work on the earlier part of a long conversation.
  const trimmedHistory = stableHistoryWindow(
    history.filter(m => m.role === 'user' || m.role === 'assistant'),
    plan.limits.maxContextMessages
  ).map(m => ({ role: m.role, content: m.content }));

  // Each kind of turn gets only the prompt it needs (see prompts.js):
  //   - image questions  -> a slim vision prompt
  //   - normal chat      -> the core chat prompt (connected-app rules are
  //                         added further down, only if tools are offered)
  const messages = [
    {
      role: 'system',
      content: hasImages
        ? buildVisionSystemPrompt({ firstName: userFirstName })
        : buildChatSystemPrompt({ firstName: userFirstName, hasTools: false }),
    },
    ...trimmedHistory,
  ];

  // Prompt-cache hints (see providers.js): names this feature in the
  // "[cache]" log line, and sends related requests from the same user to the
  // same place so the provider can reuse the prompt it already read.
  const cacheOptions = { feature: hasImages ? 'chat-vision' : 'chat', sessionId: await makeSessionId('chat', identity.uid) };

  const tierConfig = MODEL_TIERS[actualTier];
  // confirmToolCall requests must also go through the connector-tools
  // path (not just plain callWithFallback) — resuming after a user's
  // confirmation is now the "confirmed first round" of the same agent
  // loop, and the loop needs the `tools` schema available so it can keep
  // chaining further tool calls afterward (Bug 2).
  const connectorToolsEnabled = !hasImages && planHasConnectorTools(account.planId);
  // The sandbox (sandbox-tools.js) needs no connected app, so it is gated by
  // its own plan flag, not by connectorToolsEnabled.
  //
  // Offering it costs about 1,300 tokens on every message, so it is only
  // offered when the request needs it (see shouldOfferSandbox): the person is
  // resuming a browser run, the browser says this chat already uses the
  // workspace or has a data file attached, or the message asks for something
  // code is for. Everything else gets the plain chat prompt with no tools.
  const planAllowsSandbox = !hasImages && planHasSandbox(account.planId);
  const gateUserMsg = [...trimmedHistory].reverse().find((m) => m.role === 'user');
  const gate = planAllowsSandbox
    ? sandboxTools.shouldOfferSandbox({
        text: gateUserMsg && typeof gateUserMsg.content === 'string' ? gateUserMsg.content : '',
        hint: body.sandboxHint === true,
        resuming: !!sandboxResume,
      })
    : { offer: false, reason: hasImages ? 'images' : 'plan' };
  const sandboxEnabled = planAllowsSandbox && gate.offer;
  console.log('[chat][sandbox] gate=' + (sandboxEnabled ? 'offered' : 'skipped') + ' reason=' + gate.reason);

  // Picture and design tools (media-tools.js) run inside the Worker and need no
  // connected app or sandbox, so every plan can use them (the daily picture
  // allowance is imageGenPerDay). Like the sandbox they are only offered when
  // the message asks for something visual, so ordinary chats pay no extra
  // tokens. `mediaHint` is sent by the browser when this chat already
  // contains a generated picture, so "make it bluer" keeps working.
  const mediaGate = !hasImages
    ? mediaTools.shouldOfferMedia({
        text: gateUserMsg && typeof gateUserMsg.content === 'string' ? gateUserMsg.content : '',
        hint: body.mediaHint === true,
      })
    : { offer: false, reason: 'images' };
  const mediaEnabled = mediaGate.offer || (!!designResume && !hasImages);
  // Everything the person has said in this chat. The design validator only
  // trusts what they said (never what the model wrote) when deciding which
  // details are already known.
  const allUserText = trimmedHistory
    .filter((m) => m && m.role === 'user' && typeof m.content === 'string')
    .map((m) => m.content).join('\n').slice(-6000);
  const designCtx = { assets: designIn.assets, facts: designIn.facts, skipped: designIn.skipped, userText: allUserText };
  console.log('[chat][media] gate=' + (mediaEnabled ? 'offered' : 'skipped') + ' reason=' + mediaGate.reason);

  // Diagnostics for the connector tool-calling pipeline (see project
  // notes on issue 5c — "connected tools aren't used in chat"). Never
  // logs tokens, message content, or tool arguments — only enough to
  // tell, from logs alone, how far a given request got through the
  // pipeline and why it stopped where it did.
  console.log(
    '[chat][tools] uid=' + identity.uid +
    ' plan=' + account.planId +
    ' role=' + (account.role || 'none') +
    ' connectorToolsEnabled=' + connectorToolsEnabled + ' sandboxEnabled=' + sandboxEnabled +
    (connectorToolsEnabled ? '' :
      ' reason=' + (hasImages ? 'has_images' : confirmToolCall ? 'confirm_tool_call' : 'plan_lacks_connectorTools'))
  );

  // Fingerprint of the cacheable (never-changing) part of the prompt. If this
  // value differs between two requests of the same kind, something that
  // varies has leaked into the static part and caching will suffer.
  const _pi = chatPromptInfo({ hasTools: false, vision: hasImages });
  console.log('[chat][prompt] version=' + _pi.version + ' variant=' + _pi.variant + ' fp=' + _pi.fingerprint + ' ~tokens=' + _pi.approxTokens);

  // ── Real-time streaming (Server-Sent Events) ──
  // Everything above this point (auth, quota, plan checks, validation)
  // fails fast with a plain JSON error response, exactly as before — the
  // request never even opens a stream if it was going to be rejected
  // outright. From here on, though, the agent loop can take several
  // seconds and (with connector tools) run several dependent rounds, so
  // the response switches to text/event-stream: each tool-call step is
  // pushed to the client the moment it actually resolves, instead of the
  // client waiting in silence and then getting the whole trace at once
  // to fake-animate (see js/app.js). Event types on the wire:
  //   event: round  — the model is starting to think about the next
  //                    step (data: { round })
  //   event: step   — one entry of the `steps` trace just completed
  //                    (data: the step object itself, same shape as
  //                    before: { type, name, provider, ok, summary })
  //   event: error  — something failed after the stream opened, so it
  //                    could not come back as a normal HTTP error status
  //                    (data: { message, status })
  //   event: done   — the turn is finished; data is the exact same JSON
  //                    shape /api/chat used to return in one shot
  //                    ({ reply, ... })
  // A `: ping` comment line is sent periodically as a heartbeat so
  // intermediate proxies/CDNs don't time out an idle-looking connection
  // during a long model call.
  const abortCtl = new AbortController();
  function _sseError(message, status) {
    return Object.assign(new Error(message), { __sseError: true, status });
  }

  async function _agent(emit) {
  const streamer = _makeTurnStreamer(emit);
  const streamOptions = Object.assign({ maxTokens: 4096 }, cacheOptions, { onText: streamer.onText, signal: abortCtl.signal });
  let result;
  let pendingToolCall = null;
  let pendingDesignRequest = null;
  // Full recorded chain for this turn — every tool call that ran (or was
  // blocked, or ended up awaiting confirmation) gets one entry, in order.
  // This is what lets the user see "read file → rewrote it → committed"
  // as a sequence, instead of the model having to narrate progress in
  // prose (Bug 2's "recorded thought chain").
  let steps = [];
  let quotaExceededError = null;
  // Sandbox bookkeeping. `turnTrace` is every finished tool exchange of this
  // turn (connector and sandbox), in order. The Worker keeps no state between
  // requests, so when a Tier 1 sandbox call has to run in the browser, the
  // trace goes out with the paused turn and comes back with the result.
  let pendingSandboxCall = null;
  let turnTrace = [];
  let stepNo = 0;
  // The newest user message, kept so the end of the turn can tell whether the
  // person asked for a file (see collectDeliverables in sandbox-tools.js).
  let lastUserText = '';

  try {
    if (hasImages) {
      result = await callVisionModel(VISION_MODEL, messages, images, env);
    } else if (connectorToolsEnabled || sandboxEnabled || mediaEnabled) {
      // Only used by getAvailableTools' router, and only once a user's
      // connected-tool count actually crosses ROUTER_THRESHOLD — see
      // connector-tools.js. Below that, this is computed but ignored, so
      // it's cheap/harmless for the common case of 1-2 connectors.
      const lastUserMsg = [...trimmedHistory].reverse().find((m) => m.role === 'user');
      const intentText = lastUserMsg && typeof lastUserMsg.content === 'string' ? lastUserMsg.content : '';
      lastUserText = intentText;
      const recentUserTexts = [...trimmedHistory].reverse().filter((m) => m && m.role === 'user' && typeof m.content === 'string').map((m) => m.content);
      const connectorWanted = connectorToolsEnabled && shouldOfferConnectorTools(recentUserTexts);
      console.log('[chat][connectors] gate=' + (connectorWanted ? 'offered' : 'skipped'));
      const connectorTools = connectorWanted ? await getAvailableTools(identity.uid, env, intentText) : [];

      // Sandbox tools: offered only for what the active provider can really
      // do, and withheld once today's run allowance is used up or the person
      // just stopped a run, so the model never plans around a tool it cannot
      // call.
      let sandboxProvider = null;
      let sandboxToolSchemas = [];
      let sandboxLimitNote = '';
      if (sandboxEnabled) {
        sandboxProvider = await selectSandboxProvider(env, account.planId);
        const usedRuns = await getUsage(identity.uid, 'sandboxRuns', env);
        if (usedRuns >= plan.limits.sandboxRunsPerDay) {
          sandboxLimitNote = '\n\nThe user has used up today\'s code-running allowance. Do not run code and do not claim to have run any; answer without it and mention the limit briefly if it matters.';
        } else if (!(sandboxResume && sandboxResume.cancelled)) {
          sandboxToolSchemas = getSandboxToolSchemas(sandboxProvider.capabilities);
        }
      }
      const mediaToolSchemas = mediaEnabled ? mediaTools.toolSchemas() : [];
      const tools = connectorTools.concat(sandboxToolSchemas, mediaToolSchemas);
      if (tools.length > 0 || sandboxLimitNote) {
        // The tools variant starts with the exact same text as the normal
        // chat prompt and adds the connected-app / sandbox rules after it,
        // so the provider's cached beginning is shared by every variant.
        messages[0] = {
          role: 'system',
          content: buildChatSystemPrompt({
            firstName: userFirstName,
            hasTools: connectorTools.length > 0,
            hasSandbox: sandboxToolSchemas.length > 0,
            hasMedia: mediaToolSchemas.length > 0,
          }) + sandboxLimitNote,
        };
      }
      const maxRounds = sandboxToolSchemas.length > 0 ? MAX_AGENT_ROUNDS_SANDBOX : MAX_AGENT_ROUNDS;
      let mediaCallsThisTurn = 0;
      console.log(
        '[chat][tools] providers=' + [...new Set(tools.map((t) => providerForTool(t.function.name) || (mediaTools.isMediaTool(t.function.name) ? 'media' : 'unknown')))].join(',') +
        ' toolCount=' + tools.length +
        ' tier=' + actualTier + ' provider=' + tierConfig.provider + ' model=' + tierConfig.model +
        ' resuming=' + !!confirmToolCall + ' sandboxResume=' + !!sandboxResume +
        ' sandboxProvider=' + (sandboxProvider ? sandboxProvider.id : 'none')
      );

      if (tools.length === 0 && !confirmToolCall && !sandboxResume) {
        // Nothing connected — identical to the pre-tools code path, no
        // overhead for users who haven't set up any connector.
        result = await callWithFallback(tierConfig, messages, env, streamOptions);
      } else {
        // ── The bounded, recorded agent loop (Bug 2) ──
        // `workingMessages` accumulates plain assistant/user turns as
        // tool results come back — the model never sees the raw
        // tool_calls/role:"tool" protocol here (kept deliberately simple
        // and provider-agnostic; see the historical comment this
        // replaced). `round` and the various retry counters below are
        // what keep this loop bounded no matter what the model does.
        let workingMessages = messages;
        let round = 0;
        let invalidArgAttempts = {}; // tool name -> consecutive invalid-arg count
        let groundingRetries = 0;
        let stallRetries = 0;

        // If this request is the second half of a confirmation
        // (confirmToolCall), the first "round" is running the action the
        // user already approved — the model is NOT re-asked whether to
        // call it; the user's click already decided that. We fold it
        // straight into the loop's bookkeeping so everything after it
        // (further chained steps, the grounding check) works identically
        // to the fresh-message path.
        if (confirmToolCall) {
          const toolQuota = await checkAndIncrement(identity.uid, 'toolCalls', plan.limits.toolCallsPerDay, env);
          if (!toolQuota.allowed) {
            quotaExceededError = 'You have reached your daily connected-app action limit for the ' + plan.name + ' plan (' +
              toolQuota.limit + ' per day). It resets at midnight UTC.';
          } else {
            const confirmedMeta = stepMeta(confirmToolCall.name);
            emit('step_start', { name: confirmToolCall.name, provider: providerForTool(confirmToolCall.name), ...confirmedMeta, summary: describeTool(confirmToolCall.name, confirmToolCall.args) });
            const confirmedT0 = Date.now();
            const execOutcome = await executeConnectorTool(confirmToolCall.name, confirmToolCall.args, identity.uid, env);
            console.log('[chat][tools] executorRan=true (confirmed) tool=' + confirmToolCall.name + ' success=' + !execOutcome.error);
            steps.push({
              type: 'executed',
              name: confirmToolCall.name,
              provider: providerForTool(confirmToolCall.name),
              ...confirmedMeta,
              ms: Date.now() - confirmedT0,
              ok: !execOutcome.error,
              summary: describeTool(confirmToolCall.name, confirmToolCall.args),
            });
            emit('step', steps[steps.length - 1]);
            // Record the approval: this exact provider+scope+tool is now
            // pre-approved for the rest of this conversation (Bug 4).
            const scope = approvalScopeForTool(confirmToolCall.name, confirmToolCall.args);
            if (scope !== 'unscoped') {
              approvals = _mergeApproval(approvals, providerForTool(confirmToolCall.name), scope, confirmToolCall.name);
            }
            const confirmedEntry = sandboxTools.makeTraceEntry({
              n: ++stepNo, kind: 'tool', assistantText: '',
              description: describeTool(confirmToolCall.name, confirmToolCall.args),
              resultText: JSON.stringify(execOutcome.error ? execOutcome : execOutcome.result),
              blob: execOutcome.error ? null : sandboxTools.extractImportableText(execOutcome.result),
            });
            turnTrace.push(confirmedEntry);
            workingMessages = sandboxTools.appendExchange(workingMessages, confirmedEntry, true);
            round = 1;
          }
        }

        // Resuming after a Tier 1 sandbox run finished in the browser: rebuild
        // what the model had already done this turn, then add the run's real
        // result as the newest tool exchange.
        if (sandboxResume) {
          turnTrace = sandboxResume.trace.slice();
          stepNo = turnTrace.reduce((m, e) => Math.max(m, e.n), 0);
          for (const e of turnTrace) workingMessages = sandboxTools.appendExchange(workingMessages, e);
          const normalized = sandboxTools.normalizeResult(sandboxResume.result, sandboxTools.describe(sandboxResume.call.name, sandboxResume.call.args));
          // The person asked for a file, this run made one, and nothing has been
          // offered yet this turn: tell the model to offer it (see resultForModel).
          const offeredSoFar = turnTrace.some((e) => e.o);
          const madeFile = Array.isArray(normalized.files) && normalized.files.some((f) => f.change !== 'deleted');
          const offerHint = normalized.ok && madeFile && !offeredSoFar &&
            sandboxResume.call.name !== 'sandbox_offer_file' && sandboxTools.userWantsFile(lastUserText);
          const ranEntry = sandboxTools.makeTraceEntry({
            n: ++stepNo, kind: 'sbx', assistantText: sandboxResume.assistantText,
            description: describeTool(sandboxResume.call.name, sandboxResume.call.args),
            resultText: sandboxTools.resultForModel(normalized, offerHint),
            tool: sandboxResume.call.name,
            files: normalized.files,
            offered: normalized.ok && sandboxResume.call.name === 'sandbox_offer_file'
              ? { path: sandboxResume.call.args.path, title: sandboxResume.call.args.title } : null,
          });
          turnTrace.push(ranEntry);
          workingMessages = sandboxTools.appendExchange(workingMessages, ranEntry);
          console.log('[chat][sandbox] resumed tool=' + sandboxResume.call.name + ' ok=' + normalized.ok + ' exit=' + normalized.exitCode + ' ms=' + normalized.durationMs + ' cancelled=' + !!sandboxResume.cancelled);
          if (sandboxResume.cancelled) {
            workingMessages = workingMessages.concat([{
              role: 'user',
              content: 'The user stopped that run. Do not start another one. Say briefly where things stand and what they can ask for next.',
            }]);
          }
          round = turnTrace.length;
        }

        // Second half of a paused create_design: run it now with the person's
        // answers merged in. The model is not asked again; afterwards it just
        // writes the closing reply, exactly as after a confirmed action.
        if (designResume && !quotaExceededError) {
          const dArgs = mediaTools.applyDesignAnswers(designResume.args, designResume.answers);
          const dMeta = { providerLabel: mediaTools.providerLabelFor('create_design'), kind: 'run' };
          const dSummary = mediaTools.describe('create_design', dArgs);
          emit('step_start', { name: 'create_design', provider: 'media', ...dMeta, summary: dSummary });
          const dT0 = Date.now();
          let dOutcome;
          try {
            dOutcome = await mediaTools.execute('create_design', dArgs, {
              uid: identity.uid, plan, env,
              assets: designIn.assets, userText: allUserText,
              facts: { ...designIn.facts, ...designResume.answers },
            });
          } catch (e) {
            console.error('[chat][media] resumed design threw:', e && e.message);
            dOutcome = { ok: false, modelResult: 'Error: this could not be made right now. Tell the user plainly and suggest trying again shortly.' };
          }
          mediaCallsThisTurn++;
          steps.push({ type: 'executed', name: 'create_design', provider: 'media', ...dMeta, ms: Date.now() - dT0, ok: !!dOutcome.ok, summary: dSummary });
          emit('step', steps[steps.length - 1]);
          if (dOutcome.ok && dOutcome.media) emit('media', dOutcome.media);
          console.log('[chat][media] tool=create_design (resumed after details) ok=' + !!dOutcome.ok);
          const dEntry = sandboxTools.makeTraceEntry({
            n: ++stepNo, kind: 'tool', assistantText: '',
            description: dSummary, resultText: dOutcome.modelResult,
          });
          turnTrace.push(dEntry);
          workingMessages = sandboxTools.appendExchange(workingMessages, dEntry);
        }

        if (!quotaExceededError) {
          while (round < maxRounds) {
            if (!result) {
              streamer.reset();
              emit('round', { round });
              result = await _modelTurn(tierConfig, workingMessages, tools, env, streamOptions);
              // The component format called as a "tool": keep it as a component block, not a tool call.
              if (result && result.toolCalls && result.toolCalls.length) {
                const uiBlocks = _uiBlockFromPseudoCall(result.toolCalls[0], (n) => !!providerForTool(n) || mediaTools.isMediaTool(n));
                if (uiBlocks) result = { ...result, toolCalls: null, text: (result.text || '').trimEnd() + '\n\n```cognita-ui\n' + JSON.stringify(uiBlocks) + '\n```' };
              }
              // A turn that asks for a tool is internal: drop any preamble it streamed.
              if (result && result.toolCalls && result.toolCalls.length) streamer.reset();
            }

            const call = result.toolCalls && result.toolCalls.length ? result.toolCalls[0] : null;
            // Only the first proposed tool call per model turn is acted
            // on; if the model asked for several at once, the rest are
            // implicitly re-offered next round once it sees this one's
            // result.
            if (!call) {
              // Plain reply, no further tool call requested — the loop's
              // natural end. Run the grounding check (Bug 1 / Bug 5)
              // before accepting this as the final answer.
              const claimsCompletion = _claimsCompletion(result.text || '');
              const leakedNarration = _looksLikeLeakedNarration(result.text || '');
              const somethingExecutedThisTurn = steps.some((s) => s.type === 'executed' && s.ok) || turnTrace.length > 0;
              if ((claimsCompletion && !somethingExecutedThisTurn) || leakedNarration) {
                if (groundingRetries < MAX_GROUNDING_RETRIES) {
                  console.warn(
                    '[chat][grounding] ' + (leakedNarration ? 'leaked tool-narration line' : 'completion claim with no successful tool this turn') +
                    ' — retrying. uid=' + identity.uid
                  );
                  groundingRetries++;
                  workingMessages = workingMessages.concat([
                    { role: 'assistant', content: result.text || '' },
                    {
                      role: 'user',
                      content: leakedNarration
                        ? 'That wasn\'t a real reply to the user — it looked like an internal progress note. ' +
                          'Either call the next tool the task actually needs, or write a plain, complete answer ' +
                          'addressed to the user about where things stand and what (if anything) you need from them.'
                        : 'You have not actually called a tool to do this yet in this conversation. ' +
                          'If completing this requires an action in a connected app, call the right tool now. ' +
                          'If you are not sure it has happened, or you have not done it, say so plainly instead ' +
                          'of stating it is done.',
                    },
                  ]);
                  result = null;
                  round++;
                  continue;
                }
                // Retried once and it's still not giving the user a real
                // answer — override its text ourselves rather than show
                // a broken-looking log line or a fabricated success.
                // Always logged, per the audit doc, as the signal for
                // whether this needs a stronger corrective prompt
                // upstream.
                console.error('[chat][grounding] forced honest rewrite after repeated ' + (leakedNarration ? 'non-answer' : 'false completion claim') + '. uid=' + identity.uid);
                result = {
                  text: leakedNarration
                    ? 'I\'ve looked into this but haven\'t made the actual change yet. Want me to go ahead, ' +
                      'or is there something specific you\'d like me to check first?'
                    : 'I haven\'t actually completed that yet — I wasn\'t able to confirm the action went through, ' +
                      'so I don\'t want to tell you it\'s done when it isn\'t. Let me know if you\'d like me to try again, ' +
                      'or if there\'s more detail I need first.',
                  reasoning: result.reasoning || null,
                  toolCalls: null,
                };
              } else if (_looksLikeUnfinishedStall(result.text || '') && stallRetries < MAX_STALL_RETRIES) {
                // The model said it would keep investigating and then
                // stopped instead of actually doing so — push it to
                // really take the next step rather than letting that
                // stand in as the final answer (this is what used to
                // show a misleading "Completed" trace in the UI).
                console.warn('[chat][grounding] stalled mid-task without continuing — retrying. uid=' + identity.uid);
                stallRetries++;
                workingMessages = workingMessages.concat([
                  { role: 'assistant', content: result.text || '' },
                  {
                    role: 'user',
                    content: 'Go ahead and actually do that now — call the tool for the step you just described ' +
                      'instead of telling me you are about to. Keep going until the task is fully answered.',
                  },
                ]);
                result = null;
                round++;
                continue;
              }
              break;
            }

            // Picture and design tools (media-tools.js). They run right here in
            // the Worker, need no connected app and no confirmation, and hand
            // the finished picture to the browser as a `media` event. The model
            // only ever sees a short plain-text result.
            if (mediaTools.isMediaTool(call.name)) {
              const mv = mediaTools.validateArgs(call.name, call.args);
              if (!mv.ok || mediaCallsThisTurn >= mediaTools.MAX_MEDIA_CALLS_PER_TURN) {
                invalidArgAttempts[call.name] = (invalidArgAttempts[call.name] || 0) + 1;
                const tooMany = mediaCallsThisTurn >= mediaTools.MAX_MEDIA_CALLS_PER_TURN;
                if (tooMany || invalidArgAttempts[call.name] > MAX_INVALID_ARG_RETRIES_PER_TOOL) {
                  result = {
                    text: tooMany
                      ? 'I\'ve made a few pictures already in this message. Tell me what to change and I\'ll make the next one.'
                      : 'I need a little more detail to make that. What should it show?',
                    reasoning: result.reasoning || null,
                    toolCalls: null,
                  };
                  break;
                }
                workingMessages = workingMessages.concat([
                  { role: 'assistant', content: 'Attempting ' + call.name + '.' },
                  { role: 'user', content: 'That call was missing required field(s): ' + mv.missing.join(', ') + '. Retry with them filled in, written out in full.' },
                ]);
                result = null;
                round++;
                continue;
              }
              // Design requirements: if something the design truly depends on is
              // missing (a name, a date, the person's own logo or photo ...), pause
              // here and let the browser ask for it. The paused call is returned to
              // the browser, which sends it back with the answers (designResume).
              if (call.name === 'create_design' && !designResume) {
                const dreq = mediaTools.checkDesignRequirements(call.args, {
                  ...designCtx, lastUserText: gateUserMsg && typeof gateUserMsg.content === 'string' ? gateUserMsg.content : '',
                  hasPriorMedia: body.mediaHint === true,
                });
                if (dreq) {
                  pendingDesignRequest = { name: 'create_design', args: call.args, request: dreq };
                  console.log('[chat][media] design paused for details: ' + dreq.fields.map((f) => f.id).join(','));
                  result = { text: result.text || '', reasoning: result.reasoning || null, toolCalls: null };
                  break;
                }
              }
              mediaCallsThisTurn++;
              const mediaMeta = { providerLabel: mediaTools.providerLabelFor(call.name), kind: 'run' };
              const mediaSummary = mediaTools.describe(call.name, call.args);
              emit('step_start', { name: call.name, provider: 'media', ...mediaMeta, summary: mediaSummary });
              const mediaT0 = Date.now();
              let mediaOutcome;
              try {
                mediaOutcome = await mediaTools.execute(call.name, call.args, { uid: identity.uid, plan, env, ...designCtx });
              } catch (e) {
                console.error('[chat][media] execute threw:', e && e.message);
                mediaOutcome = { ok: false, modelResult: 'Error: this could not be made right now. Tell the user plainly and suggest trying again shortly.' };
              }
              steps.push({ type: 'executed', name: call.name, provider: 'media', ...mediaMeta, ms: Date.now() - mediaT0, ok: !!mediaOutcome.ok, summary: mediaSummary });
              emit('step', steps[steps.length - 1]);
              if (mediaOutcome.ok && mediaOutcome.media) emit('media', mediaOutcome.media);
              console.log('[chat][media] tool=' + call.name + ' ok=' + !!mediaOutcome.ok);
              const mediaEntry = sandboxTools.makeTraceEntry({
                n: ++stepNo, kind: 'tool', assistantText: (result.text && result.text.trim()) ? result.text : '',
                description: mediaSummary, resultText: mediaOutcome.modelResult,
              });
              turnTrace.push(mediaEntry);
              workingMessages = sandboxTools.appendExchange(workingMessages, mediaEntry);
              result = null;
              round++;
              continue;
            }

            // Bug 3: validate required args BEFORE describeTool() ever
            // runs, so a malformed call never renders as a broken-looking
            // confirm/trace line (e.g. the historical `Read "?" from
            // owner/repo.`).
            const validation = validateToolArgs(call.name, call.args);
            if (!validation.ok) {
              invalidArgAttempts[call.name] = (invalidArgAttempts[call.name] || 0) + 1;
              if (invalidArgAttempts[call.name] > MAX_INVALID_ARG_RETRIES_PER_TOOL) {
                steps.push({
                  type: 'blocked',
                  name: call.name,
                  provider: providerForTool(call.name),
                  ok: false,
                  summary: 'I\'m having trouble figuring out the right details for this — could you confirm ' +
                    validation.missing.join(', ') + '?',
                });
                emit('step', steps[steps.length - 1]);
                result = {
                  text: steps[steps.length - 1].summary,
                  reasoning: result.reasoning || null,
                  toolCalls: null,
                };
                break;
              }
              console.warn('[chat][tools] invalid args for ' + call.name + ', missing=' + validation.missing.join(',') + ' — asking model to retry (attempt ' + invalidArgAttempts[call.name] + ')');
              workingMessages = workingMessages.concat([
                { role: 'assistant', content: 'Attempting ' + call.name + '.' },
                {
                  role: 'user',
                  content: 'That call was missing required field(s): ' + validation.missing.join(', ') +
                    '. Retry with the correct arguments — look them up with another tool first if you need to, ' +
                    'or ask me if you genuinely cannot determine them.',
                },
              ]);
              result = null;
              round++;
              continue;
            }

            // Sandbox tools. These change only the person's private scratch
            // workspace, so they never need the write confirmation below, and
            // they are counted against the sandbox run allowance instead of
            // the connected-app action allowance.
            if (isSandboxToolName(call.name)) {
              let sbName = call.name;
              let sbArgs = call.args || {};
              const sbValid = sandboxTools.validateSandboxArgs(sbName, sbArgs);
              let importFailure = null;
              if (sbValid.ok && sbName === 'sandbox_import_from_tool') {
                // The file text comes from an earlier connected-app result held in
                // this turn's trace, so the model never has to retype it and the
                // sandbox never needs a credential. It becomes a plain file write.
                const imp = sandboxTools.resolveImport(sbArgs, turnTrace);
                if (imp.ok) {
                  sbName = 'sandbox_write_file';
                  sbArgs = { path: sbArgs.path, content: imp.content, imported: true };
                } else {
                  importFailure = imp.error;
                }
              }
              const sbProblem = !sbValid.ok ? sbValid.error : importFailure;
              if (sbProblem) {
                invalidArgAttempts[call.name] = (invalidArgAttempts[call.name] || 0) + 1;
                if (invalidArgAttempts[call.name] > MAX_INVALID_ARG_RETRIES_PER_TOOL) {
                  result = { text: 'I could not get that step to work. ' + sbProblem, reasoning: result.reasoning || null, toolCalls: null };
                  break;
                }
                workingMessages = workingMessages.concat([
                  { role: 'assistant', content: 'Attempting ' + call.name + '.' },
                  { role: 'user', content: 'That call was not valid: ' + sbProblem + ' Fix it and try again.' },
                ]);
                result = null;
                round++;
                continue;
              }
              if (turnTrace.filter((e) => e.k === 'sbx').length >= sandboxTools.MAX_SANDBOX_CALLS_PER_TURN) {
                result = {
                  text: 'I ran a lot of steps on this and hit my limit for one request. Tell me if you want me to keep going from where things stand.',
                  reasoning: null, toolCalls: null,
                };
                break;
              }
              const sbUsed = await getUsage(identity.uid, 'sandboxRuns', env);
              if (sbUsed >= plan.limits.sandboxRunsPerDay) {
                quotaExceededError = 'You have reached your daily code-running limit for the ' + plan.name + ' plan (' +
                  plan.limits.sandboxRunsPerDay + ' runs per day). It resets at midnight UTC.';
                break;
              }

              if (sandboxProvider.site === 'client') {
                // Tier 1: pause the turn and ask the browser to run it. The run is
                // counted when its result comes back (see sandboxResume above).
                pendingSandboxCall = sandboxTools.buildClientCall(sbName, sbArgs, plan, { assistantText: (result.text || '').slice(0, 4000) });
                if (call.name === 'sandbox_import_from_tool') pendingSandboxCall.summary = describeTool('sandbox_import_from_tool', call.args);
                emit('sandbox_call', { id: pendingSandboxCall.id, name: pendingSandboxCall.name, summary: pendingSandboxCall.summary });
                console.log('[chat][sandbox] paused for browser run tool=' + sbName + ' provider=' + sandboxProvider.id);
                break;
              }

              // Tier 3 (server-side provider): run it now and keep going in this request.
              const sbCharge = await checkAndIncrement(identity.uid, 'sandboxRuns', plan.limits.sandboxRunsPerDay, env);
              if (!sbCharge.allowed) {
                quotaExceededError = 'You have reached your daily code-running limit for the ' + plan.name + ' plan (' + sbCharge.limit + ' runs per day). It resets at midnight UTC.';
                break;
              }
              emit('step_start', { name: call.name, provider: 'sandbox', providerLabel: 'Code', kind: 'run', summary: describeTool(call.name, call.args) });
              let sbResult;
              try {
                sbResult = await sandboxTools.execute(sbName, sbArgs, { provider: sandboxProvider, uid: identity.uid, conversationId, plan, env });
              } catch (e) {
                console.warn('[chat][sandbox] remote execution failed:', e && e.message);
                sbResult = sandboxTools.normalizeResult({ exitCode: 1, stderr: 'The sandbox could not run this right now.', error: true }, sandboxTools.describe(call.name, call.args));
              }
              steps.push({
                type: 'sandbox', name: call.name, provider: 'sandbox', providerLabel: 'Code', kind: 'run', ms: sbResult.durationMs, ok: sbResult.ok,
                summary: describeTool(call.name, call.args), sandbox: sbResult,
              });
              emit('step', steps[steps.length - 1]);
              const sbEntry = sandboxTools.makeTraceEntry({
                n: ++stepNo, kind: 'sbx', assistantText: (result.text && result.text.trim()) ? result.text : '',
                description: describeTool(call.name, call.args), resultText: sandboxTools.resultForModel(sbResult),
                tool: sbName, files: sbResult.files,
                offered: sbResult.ok && sbName === 'sandbox_offer_file' ? { path: sbArgs.path, title: sbArgs.title } : null,
              });
              turnTrace.push(sbEntry);
              workingMessages = sandboxTools.appendExchange(workingMessages, sbEntry);
              result = null;
              round++;
              continue;
            }

            // Bug 4: has this exact provider+scope+tool already been
            // approved earlier in this same conversation?
            const alreadyApproved = isToolApproved(approvals, call.name, call.args);
            const needsConfirmation = toolRequiresConfirmation(call.name) && !alreadyApproved;

            if (needsConfirmation) {
              // Hard stop — the only kind of stop that returns control to
              // the user mid-task. Everything recorded in `steps` so far
              // is already real, already-executed work; only this one
              // write is what's actually being asked about.
              // `summary` stays for the model and for chats saved before the new
              // card; the structured fields below feed the approval card.
              const card = describeConfirmation(call.name, call.args);
              pendingToolCall = {
                id: call.id,
                name: call.name,
                args: call.args,
                provider: providerForTool(call.name),
                summary: describeTool(call.name, call.args),
                providerKey: card.providerKey,
                providerLabel: card.providerLabel,
                verb: card.verb,
                title: card.title,
                details: card.details,
                consequence: card.consequence,
                // True only when approving this really covers the same kind of
                // action for the rest of the chat (see _mergeApproval above).
                remembers: approvalScopeForTool(call.name, call.args) !== 'unscoped',
              };
              steps.push({ type: 'awaiting_confirmation', name: call.name, provider: pendingToolCall.provider, ...stepMeta(call.name), summary: pendingToolCall.summary });
              emit('step', steps[steps.length - 1]);
              console.log('[chat][tools] executorRan=false (awaiting user confirmation) tool=' + call.name);
              break;
            }

            // Auto-execute: either a read-only tool, or a write tool
            // already approved earlier in this conversation (Bug 4 —
            // still fully recorded in the trace below, just not
            // re-prompted).
            const toolQuota = await checkAndIncrement(identity.uid, 'toolCalls', plan.limits.toolCallsPerDay, env);
            if (!toolQuota.allowed) {
              quotaExceededError = 'You have reached your daily connected-app action limit for the ' + plan.name + ' plan (' +
                toolQuota.limit + ' per day). It resets at midnight UTC.';
              break;
            }

            const autoMeta = stepMeta(call.name);
            emit('step_start', { name: call.name, provider: providerForTool(call.name), ...autoMeta, summary: describeTool(call.name, call.args) });
            const autoT0 = Date.now();
            const execOutcome = await executeConnectorTool(call.name, call.args, identity.uid, env);
            console.log(
              '[chat][tools] executorRan=true tool=' + call.name +
              ' success=' + !execOutcome.error + ' autoApprovedWrite=' + (alreadyApproved && toolRequiresConfirmation(call.name)) +
              (execOutcome.error ? ' code=' + execOutcome.code : '')
            );
            steps.push({
              type: 'executed',
              name: call.name,
              provider: providerForTool(call.name),
              ...autoMeta,
              ms: Date.now() - autoT0,
              ok: !execOutcome.error,
              summary: describeTool(call.name, call.args),
            });
            emit('step', steps[steps.length - 1]);

            // Only ever put words in the assistant's own mouth here if it
            // ACTUALLY said something alongside the tool call. Previously
            // this fell back to a robotic 'Running ' + describeTool(...)
            // line whenever result.text was empty (the normal case for a
            // pure tool call) — feeding that back turn after turn taught
            // the model, by imitation, to talk like a system log, and on
            // a later turn it would echo that same voice back as its
            // "final answer" with no tool call attached (see the
            // leaked-narration guard below, which now also catches this).
            // A tool result is plainly a fact about the world, not
            // something the assistant said, so it belongs in the 'user'
            // role either way.
            const sawAssistantText = !!(result.text && result.text.trim());
            const toolEntry = sandboxTools.makeTraceEntry({
              n: ++stepNo, kind: 'tool', assistantText: sawAssistantText ? result.text : '',
              description: describeTool(call.name, call.args),
              resultText: JSON.stringify(execOutcome.error ? execOutcome : execOutcome.result),
              // Full text of a fetched file, kept so sandbox_import_from_tool can place it in the workspace.
              blob: (sandboxToolSchemas.length > 0 && !execOutcome.error) ? sandboxTools.extractImportableText(execOutcome.result) : null,
            });
            turnTrace.push(toolEntry);
            workingMessages = sandboxTools.appendExchange(workingMessages, toolEntry);

            result = null;
            round++;
          }

          if (round >= maxRounds && !pendingToolCall && !pendingSandboxCall && !quotaExceededError && (!result || (result.toolCalls && result.toolCalls.length))) {
            // Hit the ceiling mid-task — never fabricate completion here.
            console.warn('[chat][tools] hit MAX_AGENT_ROUNDS uid=' + identity.uid);
            result = {
              text: 'I made progress on this but hit my step limit before finishing everything. ' +
                'Here\'s where things stand — let me know if you\'d like me to keep going.',
              reasoning: null,
              toolCalls: null,
            };
          }
        }
      }
    } else {
      result = await callWithFallback(tierConfig, messages, env, streamOptions);
    }
  } catch (e) {
    console.error('[chat] model call failed:', e.message);
    throw _sseError('Cognita is temporarily unavailable. Please try again shortly.', 503);
  }

  if (quotaExceededError) {
    throw _sseError(quotaExceededError, 429);
  }

  // The model's reasoning is never sent to the browser. An inline <think> block is stripped from the answer.
  let reply = _stripThinking(result.text || '');

  // When a write action is pending confirmation, prefer a clear
  // yes/no-shaped prompt over whatever (possibly empty, since some models
  // return no content at all alongside a tool_calls response) text the
  // model produced, so the frontend always has something sensible to show
  // above the confirm/cancel buttons.
  // NOTE: the frontend's confirmation card (the "awaiting_confirmation"
  // step) already displays `pendingToolCall.summary` right next to the
  // Confirm/Cancel buttons — see js/app.js's tool-trace-card--confirm
  // block. Repeating that same summary text here in `reply` used to make
  // it print a second time as an ordinary chat message directly below the
  // card (e.g. "Creating X" shown twice). Keep this fallback short and
  // free of the summary so it never duplicates what the card already
  // says.
  if (pendingDesignRequest) {
    // The card carries the question; the line above it stays short and warm.
    reply = 'Before I design this, I need a few details from you.';
  }
  if (pendingToolCall && !reply.trim()) {
    reply = 'Would you like me to go ahead?';
  }

  // Structured UI the model chose for this answer (see ui-schema.js). The
  // fenced block is removed from the visible text and validated here; the
  // browser validates it again before drawing anything. A paused turn
  // (confirmation, design questions, sandbox hand-off) never carries UI.
  let ui = [];
  let uiPatches = [];
  if (!pendingToolCall && !pendingDesignRequest && !pendingSandboxCall) {
    try { streamer.finish(); } catch (_) { /* streaming is best effort; `done` carries the result */ }
    const extracted = extractUiBlocks(reply);
    ui = extracted.ui;
    uiPatches = extracted.patches || [];
    reply = extracted.text;
    if ((ui.length || uiPatches.length) && !reply.trim()) reply = (ui[0] && ui[0].props && ui[0].props.title) || 'Done.';
  } else {
    reply = extractUiBlocks(reply).text;
  }

  return {
    reply,
    ui,
    // Controlled updates to components shown earlier (validated; see ui-schema.js).
    uiPatches,
    remainingToday: plan.limits.messagesPerDay - quota.used,
    pendingToolCall,
    // Set when create_design needs details or files from the person first.
    pendingDesignRequest,
    // Set only when a Tier 1 sandbox call has to run in the person's browser.
    // The browser runs it, then calls this endpoint again with
    // sandboxResume = { call, assistantText, result, trace: turnTrace }.
    pendingSandboxCall,
    turnTrace: pendingSandboxCall ? turnTrace : undefined,
    // Files from the workspace the person should be able to download, shown as
    // buttons under the answer. Includes files the model forgot to offer when
    // the person asked for one. Empty while the turn is still paused.
    deliverables: pendingSandboxCall ? [] : sandboxTools.collectDeliverables(turnTrace, lastUserText),
    // `steps` is the full recorded chain for this turn (possibly empty).
    // `toolExecuted` is kept as a legacy single-object mirror of the last
    // executed step, for any older client code that hasn't moved to
    // `steps` yet — new frontend code should read `steps`.
    steps,
    toolExecuted: [...steps].reverse().find((s) => s.type === 'executed') || null,
    approvals,
  };
  }

  const encoder = new TextEncoder();
  function _sseFrame(event, data) {
    return encoder.encode('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
  }

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const safeEnqueue = (chunk) => {
        if (closed) return;
        try {
          controller.enqueue(chunk);
        } catch (e) {
          // Client disconnected mid-stream — stop trying to write to it.
          closed = true;
        }
      };
      const emit = (event, data) => safeEnqueue(_sseFrame(event, data));

      const heartbeat = setInterval(() => {
        safeEnqueue(encoder.encode(': ping\n\n'));
      }, 15000);

      try {
        const payload = await _agent(emit);
        emit('done', payload);
      } catch (e) {
        if (e && e.__sseError) {
          emit('error', { message: e.message, status: e.status || 500 });
        } else {
          console.error('[chat] stream failed:', e && e.message);
          emit('error', { message: 'Cognita is temporarily unavailable. Please try again shortly.', status: 503 });
        }
      } finally {
        clearInterval(heartbeat);
        closed = true;
        try { controller.close(); } catch (_) {}
      }
    },
    cancel() {
      abortCtl.abort(); // stop the provider stream when the browser disconnects
      // Client navigated away / aborted the fetch — nothing further to
      // clean up here since the heartbeat/controller are scoped inside
      // start() and torn down in its own finally block.
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': env?.APP_ORIGIN || '*',
      'X-Accel-Buffering': 'no',
    },
  });
}

function _corsJsonHeaders(env) {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': env?.APP_ORIGIN || '*' };
}

function _jsonError(message, status, env) {
  return new Response(JSON.stringify({ error: message }), { status, headers: _corsJsonHeaders(env) });
}
