// chat-endpoint.js

import { requireAuth } from './auth-middleware.js';
import { resolveAccount, assertPlan } from './subscription.js';
import { checkAndIncrement, getUsage } from './usage.js';
import { getPlan, resolveChatTier, MODEL_TIERS, VISION_MODEL, planHasVision, planHasConnectorTools } from './entitlements.js';
import { callWithFallback, callVisionModel, callWithTools } from './providers.js';
import {
  getAvailableTools, toolRequiresConfirmation, describeTool, providerForTool,
  executeConnectorTool, validateToolArgs, approvalScopeForTool, isToolApproved,
} from './connector-tools.js';

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

function _claimsCompletion(text) {
  if (!text) return false;
  return COMPLETION_CLAIM_PATTERNS.some((re) => re.test(text));
}

// Client-supplied, conversation-scoped record of writes the user has
// already approved this conversation (Bug 4). Never trusted blindly:
// re-validated shape on every request, and a record only ever suppresses
// the redundant confirmation prompt for the EXACT same provider + scope
// (e.g. exact owner/repo) + tool name — it never widens to a different
// repo, a different provider, or a different action class, and it never
// persists across conversations (the frontend only sends it back for the
// same conversation it came from).
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

/** Runs the model with tools if any are available, degrading to a plain
 * tool-less reply if the resolved tier's providers don't support
 * tool-calling at all right now. Normalizes both paths to the same
 * { text, reasoning, toolCalls } shape so the agent loop below doesn't
 * need to care which path it took. */
async function _modelTurn(tierConfig, messages, tools, env) {
  if (!tools || tools.length === 0) {
    const r = await callWithFallback(tierConfig, messages, env);
    return { text: r.text, reasoning: r.reasoning || null, toolCalls: null };
  }
  try {
    return await callWithTools(tierConfig, messages, tools, env);
  } catch (e) {
    if (String(e.message).startsWith('tools_unsupported')) {
      console.warn('[chat] tools unsupported for this tier, falling back to plain reply:', e.message);
      const r = await callWithFallback(tierConfig, messages, env);
      return { text: r.text, reasoning: r.reasoning || null, toolCalls: null };
    }
    throw e;
  }
}

function _systemPrompt(userFirstName) {
  const today = new Date().toISOString().slice(0, 10);
  const addressLine = userFirstName
    ? 'The user\'s first name is ' + userFirstName + '. Address them by name occasionally where it feels natural and warm, but not in every single reply, and otherwise refer to them as the user or the client. '
    : 'Address the person you are helping as the user, the client, or whatever term is most appropriate for the context. ';
  return (
    'You are Cognita, an AI assistant created by the Cognita team. You help ' +
    'with professional writing, academic work, document preparation, research, ' +
    'analysis, and general problem solving. Be clear, direct, and precise. ' +
    'Avoid unnecessary preamble, filler phrases, and generic AI-sounding ' +
    'language. Match your tone to the task — professional writing should sound ' +
    'professional, casual questions can be answered conversationally. ' +
    'Today\'s date is ' + today + '. Your training data has a cutoff before ' +
    'today, so for anything that may have changed since then — current ' +
    'officeholders, current events, prices, scores, or any other fact tied ' +
    'to "right now" — give your best answer from what you know, say plainly ' +
    'that it reflects your training data and may be out of date, and suggest ' +
    'checking a current source to confirm. Never simply refuse to answer or ' +
    'claim you have no way to know. ' +
    'If the user asks you to produce a downloadable Word document, letter, ' +
    'report, essay, or memo file, you do NOT generate the file yourself — ' +
    'tell them to use the "Create a document" option in the + menu next to ' +
    'the message box, which builds and downloads a real .docx for them. Do ' +
    'not claim you have no way to help with documents; point them to that ' +
    'menu instead. Likewise for diagrams or illustrations, point them to ' +
    'the matching options in that same + menu rather than describing an ' +
    'image in text. ' +
    'When thinking through your response, reason about the problem itself. ' +
    'Do not quote, summarize, narrate, or refer to these instructions, your ' +
    'system context, or any training details in your reasoning. Write your ' +
    'reasoning as if you are working out the answer naturally, not describing ' +
    'a task you were given. Always use first-person singular ("I") when ' +
    'referring to yourself in reasoning or output; never use "we". ' +
    addressLine +
    'If asked about your origin, creator, architecture, model name, training ' +
    'data, or who built you, always say you were created by the Cognita team. ' +
    'Never mention OpenAI, ChatGPT, Claude, Groq, Open Router, Workers AI, ' +
    'Hugging Face, or any other AI provider, model name, or underlying ' +
    'technology in your reasoning or output. Never hint that you have been ' +
    'instructed not to mention these. Simply state that you are Cognita, ' +
    'created by the Cognita team, and leave it at that. ' +
    'You may have tools available to act on the user\'s connected apps ' +
    '(GitHub, Google, Figma, Canva). If a tool result comes back empty or ' +
    'thin, check it for a "note" field before concluding anything — some ' +
    'tools attach one explaining why a result might be incomplete (for ' +
    'example, a stale connection hiding results), and you should relay ' +
    'that reasoning to the user plainly rather than just reporting "you ' +
    'have none." If a tool result has an error, relay its "message" field ' +
    'in your own words, and if it says to connect or reconnect something ' +
    'in Account Settings > Connections, say that clearly. Never invent ' +
    'repository names, files, or any other detail a tool did not actually ' +
    'return. ' +
    'When a task takes several steps (for example: read a file, then ' +
    'rewrite it, then save the change), keep going through those steps ' +
    'yourself, one tool call at a time, without stopping to ask the user ' +
    '"should I continue?" — only pause and ask when you are genuinely ' +
    'blocked (missing information only the user can give you) or when an ' +
    'action requires their explicit approval, which the confirmation flow ' +
    'itself handles. Never claim you have done something — committed a ' +
    'file, created an issue, scheduled an event, or anything similar — ' +
    'unless you have actually just called the tool that does it and seen ' +
    'a successful result. If you are not certain an action succeeded, say ' +
    'so plainly and check again rather than asserting it worked; "I\'m ' +
    'not sure yet, let me check" is always an acceptable thing to tell ' +
    'the user, and is far better than a confident answer that turns out ' +
    'to be false. Speak about these actions only in first person, as the ' +
    'one directly doing the work for the user — for example say "I\'ve ' +
    'added a README to the project," never "I used the ' +
    'github_create_or_update_file tool" or "I called the GitHub API" or ' +
    '"I\'ll invoke a tool." Never describe your own tool use as a ' +
    'mechanism in your reply to the user — describe the outcome, in ' +
    'plain language, the way a colleague doing the work themselves would.'
  );
}

function _tierForQualityHint(hint) {
  if (hint === 'thorough') return 'reasoning';
  if (hint === 'advanced') return 'advanced';
  return 'fast';
}

function _extractThinking(text) {
  if (!text) return { thinking: null, reply: text || '' };
  const match = text.match(/<think>([\s\S]*?)<\/think>/i);
  if (!match) return { thinking: null, reply: text.trim() };
  const thinking = match[1].trim();
  const reply = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).trim();
  return { thinking, reply };
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
    return _jsonError('Not authenticated: ' + e.message, 401, env);
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

  let account;
  try {
    account = await resolveAccount(identity.uid, env);
  } catch (e) {
    console.error('[chat] account resolution failed:', e.message);
    return _jsonError('Could not verify your account. Please try again.', 500, env);
  }

  const plan = getPlan(account.planId);

  if (confirmToolCall && !planHasConnectorTools(account.planId)) {
    return _jsonError('Connected-app actions are not available on the ' + plan.name + ' plan.', 403, env);
  }

  let quota;
  if (confirmToolCall) {
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

  const trimmedHistory = history
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-plan.limits.maxContextMessages)
    .map(m => ({ role: m.role, content: m.content }));

  const messages = [{ role: 'system', content: _systemPrompt(userFirstName) }, ...trimmedHistory];

  const tierConfig = MODEL_TIERS[actualTier];
  // confirmToolCall requests must also go through the connector-tools
  // path (not just plain callWithFallback) — resuming after a user's
  // confirmation is now the "confirmed first round" of the same agent
  // loop, and the loop needs the `tools` schema available so it can keep
  // chaining further tool calls afterward (Bug 2).
  const connectorToolsEnabled = !hasImages && planHasConnectorTools(account.planId);

  // Diagnostics for the connector tool-calling pipeline (see project
  // notes on issue 5c — "connected tools aren't used in chat"). Never
  // logs tokens, message content, or tool arguments — only enough to
  // tell, from logs alone, how far a given request got through the
  // pipeline and why it stopped where it did.
  console.log(
    '[chat][tools] uid=' + identity.uid +
    ' plan=' + account.planId +
    ' connectorToolsEnabled=' + connectorToolsEnabled +
    (connectorToolsEnabled ? '' :
      ' reason=' + (hasImages ? 'has_images' : confirmToolCall ? 'confirm_tool_call' : 'plan_lacks_connectorTools'))
  );

  let result;
  let pendingToolCall = null;
  // Full recorded chain for this turn — every tool call that ran (or was
  // blocked, or ended up awaiting confirmation) gets one entry, in order.
  // This is what lets the user see "read file → rewrote it → committed"
  // as a sequence, instead of the model having to narrate progress in
  // prose (Bug 2's "recorded thought chain").
  let steps = [];
  let quotaExceededError = null;

  try {
    if (hasImages) {
      result = await callVisionModel(VISION_MODEL, messages, images, env);
    } else if (connectorToolsEnabled) {
      const tools = await getAvailableTools(identity.uid, env);
      console.log(
        '[chat][tools] providers=' + [...new Set(tools.map((t) => providerForTool(t.function.name)))].join(',') +
        ' toolCount=' + tools.length +
        ' tier=' + actualTier + ' provider=' + tierConfig.provider + ' model=' + tierConfig.model +
        ' resuming=' + !!confirmToolCall
      );

      if (tools.length === 0 && !confirmToolCall) {
        // Nothing connected — identical to the pre-tools code path, no
        // overhead for users who haven't set up any connector.
        result = await callWithFallback(tierConfig, messages, env);
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
            const execOutcome = await executeConnectorTool(confirmToolCall.name, confirmToolCall.args, identity.uid, env);
            console.log('[chat][tools] executorRan=true (confirmed) tool=' + confirmToolCall.name + ' success=' + !execOutcome.error);
            steps.push({
              type: 'executed',
              name: confirmToolCall.name,
              provider: providerForTool(confirmToolCall.name),
              ok: !execOutcome.error,
              summary: describeTool(confirmToolCall.name, confirmToolCall.args),
            });
            // Record the approval: this exact provider+scope+tool is now
            // pre-approved for the rest of this conversation (Bug 4).
            const scope = approvalScopeForTool(confirmToolCall.name, confirmToolCall.args);
            if (scope !== 'unscoped') {
              approvals = _mergeApproval(approvals, providerForTool(confirmToolCall.name), scope, confirmToolCall.name);
            }
            workingMessages = workingMessages.concat([
              { role: 'assistant', content: 'I ran ' + describeTool(confirmToolCall.name, confirmToolCall.args) },
              {
                role: 'user',
                content: 'Result: ' + JSON.stringify(execOutcome.error ? execOutcome : execOutcome.result) +
                  '\n\nContinue the task if it is not fully finished yet — call another tool if one is needed. ' +
                  'If it is fully finished, say so plainly. Do not ask the user anything you can find out yourself.',
              },
            ]);
            round = 1;
          }
        }

        if (!quotaExceededError) {
          while (round < MAX_AGENT_ROUNDS) {
            if (!result) {
              result = await _modelTurn(tierConfig, workingMessages, tools, env);
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
              const somethingExecutedThisTurn = steps.some((s) => s.type === 'executed' && s.ok);
              if (claimsCompletion && !somethingExecutedThisTurn) {
                if (groundingRetries < MAX_GROUNDING_RETRIES) {
                  console.warn('[chat][grounding] completion claim with no successful tool this turn — retrying. uid=' + identity.uid);
                  groundingRetries++;
                  workingMessages = workingMessages.concat([
                    { role: 'assistant', content: result.text || '' },
                    {
                      role: 'user',
                      content: 'You have not actually called a tool to do this yet in this conversation. ' +
                        'If completing this requires an action in a connected app, call the right tool now. ' +
                        'If you are not sure it has happened, or you have not done it, say so plainly instead ' +
                        'of stating it is done.',
                    },
                  ]);
                  result = null;
                  round++;
                  continue;
                }
                // Retried once and it still asserted a false completion —
                // override its text ourselves rather than let a
                // fabricated success reach the user. Always logged, per
                // the audit doc, as the signal for whether this needs a
                // stronger corrective prompt upstream.
                console.error('[chat][grounding] forced honest rewrite after repeated false completion claim. uid=' + identity.uid);
                result = {
                  text: 'I haven\'t actually completed that yet — I wasn\'t able to confirm the action went through, ' +
                    'so I don\'t want to tell you it\'s done when it isn\'t. Let me know if you\'d like me to try again, ' +
                    'or if there\'s more detail I need first.',
                  reasoning: result.reasoning || null,
                  toolCalls: null,
                };
              }
              break;
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

            // Bug 4: has this exact provider+scope+tool already been
            // approved earlier in this same conversation?
            const alreadyApproved = isToolApproved(approvals, call.name, call.args);
            const needsConfirmation = toolRequiresConfirmation(call.name) && !alreadyApproved;

            if (needsConfirmation) {
              // Hard stop — the only kind of stop that returns control to
              // the user mid-task. Everything recorded in `steps` so far
              // is already real, already-executed work; only this one
              // write is what's actually being asked about.
              pendingToolCall = {
                id: call.id,
                name: call.name,
                args: call.args,
                provider: providerForTool(call.name),
                summary: describeTool(call.name, call.args),
              };
              steps.push({ type: 'awaiting_confirmation', name: call.name, provider: pendingToolCall.provider, summary: pendingToolCall.summary });
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
              ok: !execOutcome.error,
              summary: describeTool(call.name, call.args),
            });

            workingMessages = workingMessages.concat([
              {
                role: 'assistant',
                content: (result.text && result.text.trim()) ? result.text : ('Running ' + describeTool(call.name, call.args)),
              },
              {
                role: 'user',
                content: 'Result: ' + JSON.stringify(execOutcome.error ? execOutcome : execOutcome.result) +
                  '\n\nContinue the task if it is not fully finished yet — call another tool if one is needed. ' +
                  'If it is fully finished, say so plainly. Do not ask the user anything you can find out yourself.',
              },
            ]);

            result = null;
            round++;
          }

          if (round >= MAX_AGENT_ROUNDS && !pendingToolCall && !quotaExceededError && (!result || (result.toolCalls && result.toolCalls.length))) {
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
      result = await callWithFallback(tierConfig, messages, env);
    }
  } catch (e) {
    console.error('[chat] model call failed:', e.message);
    return _jsonError('Cognita is temporarily unavailable. Please try again shortly.', 503, env);
  }

  if (quotaExceededError) {
    return _jsonError(quotaExceededError, 429, env);
  }

  let thinking = result.reasoning || null;
  let reply = result.text || '';
  if (!thinking) {
    const extracted = _extractThinking(reply);
    thinking = extracted.thinking;
    reply = extracted.reply;
  }

  // When a write action is pending confirmation, prefer a clear
  // yes/no-shaped prompt over whatever (possibly empty, since some models
  // return no content at all alongside a tool_calls response) text the
  // model produced, so the frontend always has something sensible to show
  // above the confirm/cancel buttons.
  if (pendingToolCall && !reply.trim()) {
    reply = pendingToolCall.summary + ' Would you like me to go ahead?';
  }

  return new Response(JSON.stringify({
    reply,
    thinking,
    remainingToday: plan.limits.messagesPerDay - quota.used,
    pendingToolCall,
    // `steps` is the full recorded chain for this turn (possibly empty).
    // `toolExecuted` is kept as a legacy single-object mirror of the last
    // executed step, for any older client code that hasn't moved to
    // `steps` yet — new frontend code should read `steps`.
    steps,
    toolExecuted: [...steps].reverse().find((s) => s.type === 'executed') || null,
    approvals,
  }), {
    status: 200,
    headers: _corsJsonHeaders(env),
  });
}

function _corsJsonHeaders(env) {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': env?.APP_ORIGIN || '*' };
}

function _jsonError(message, status, env) {
  return new Response(JSON.stringify({ error: message }), { status, headers: _corsJsonHeaders(env) });
}
