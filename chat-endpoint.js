// chat-endpoint.js

import { requireAuth } from './auth-middleware.js';
import { resolveAccount, assertPlan } from './subscription.js';
import { checkAndIncrement, getUsage } from './usage.js';
import { getPlan, resolveChatTier, MODEL_TIERS, VISION_MODEL, planHasVision, planHasConnectorTools } from './entitlements.js';
import { callWithFallback, callVisionModel, callWithTools } from './providers.js';
import { getAvailableTools, toolRequiresConfirmation, describeTool, providerForTool, executeConnectorTool } from './connector-tools.js';

// Cap how many tool calls a model can chain in a single follow-up round
// after a non-write tool executes. 1 keeps the request bounded and the
// latency predictable; the model can always ask a follow-up question in
// its next chat turn if it needs another tool after seeing the first
// result, rather than this endpoint silently looping.
const MAX_AUTO_TOOL_ROUNDS = 1;

const MAX_IMAGES_PER_REQUEST = 4;
const HARD_MAX_IMAGE_BASE64_CHARS = 8_000_000;

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
    'return.'
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
  const connectorToolsEnabled = !hasImages && !confirmToolCall && planHasConnectorTools(account.planId);

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
  let toolExecuted = null;

  try {
    if (confirmToolCall) {
      // Second half of the confirmation flow: run the action the user
      // already approved, then ask the model for one final natural-
      // language reply that incorporates the result. The model itself is
      // NOT re-asked whether to call the tool — the user's confirmation
      // click already decided that; re-offering tools here would let the
      // model second-guess or substitute a different action than the one
      // that was actually shown to the user.
      const toolQuota = await checkAndIncrement(identity.uid, 'toolCalls', plan.limits.toolCallsPerDay, env);
      if (!toolQuota.allowed) {
        return _jsonError(
          'You have reached your daily connected-app action limit for the ' + plan.name + ' plan (' +
          toolQuota.limit + ' per day). It resets at midnight UTC.',
          429, env
        );
      }

      const execOutcome = await executeConnectorTool(confirmToolCall.name, confirmToolCall.args, identity.uid, env);
      // Fold the tool's result into a plain assistant/user exchange rather
      // than replaying the OpenAI tool_calls/role:"tool" protocol here.
      // That protocol is only valid on a request that ALSO declares a
      // `tools` schema — this follow-up call intentionally declares none
      // (the user's click already decided the one action to take, so the
      // model isn't being offered a choice to call anything). Some
      // providers reject a tool-call-shaped history with no tools present
      // in the same request (Groq: "Tool choice is none, but model called
      // a tool"), and content: null on the synthetic assistant message
      // fails Workers AI's schema outright. Plain string content sidesteps
      // both, on every provider.
      const followUpMessages = messages.concat([
        {
          role: 'assistant',
          content: 'I ran ' + confirmToolCall.name + ' with the arguments you just confirmed.',
        },
        {
          role: 'user',
          content: 'Here is the result of that action:\n\n' +
            JSON.stringify(execOutcome.error ? execOutcome : execOutcome.result) +
            '\n\nReply to me naturally based on this result — do not call any more tools.',
        },
      ]);

      result = await callWithFallback(tierConfig, followUpMessages, env);
      toolExecuted = {
        name: confirmToolCall.name,
        provider: providerForTool(confirmToolCall.name),
        ok: !execOutcome.error,
        summary: describeTool(confirmToolCall.name, confirmToolCall.args),
      };
    } else if (hasImages) {
      result = await callVisionModel(VISION_MODEL, messages, images, env);
    } else if (connectorToolsEnabled) {
      const tools = await getAvailableTools(identity.uid, env);
      console.log(
        '[chat][tools] providers=' + [...new Set(tools.map((t) => providerForTool(t.function.name)))].join(',') +
        ' toolCount=' + tools.length +
        ' tier=' + actualTier + ' provider=' + tierConfig.provider + ' model=' + tierConfig.model
      );

      if (tools.length === 0) {
        // Nothing connected — identical to the pre-tools code path, no
        // overhead for users who haven't set up any connector.
        result = await callWithFallback(tierConfig, messages, env);
      } else {
        let usedToolsPath = true;
        try {
          result = await callWithTools(tierConfig, messages, tools, env);
        } catch (toolCallErr) {
          if (String(toolCallErr.message).startsWith('tools_unsupported')) {
            // Neither the primary nor fallback provider for this tier can
            // do tool-calling right now — degrade to a normal tool-less
            // reply rather than failing the whole request.
            console.warn('[chat] tools unsupported for this tier, falling back to plain reply:', toolCallErr.message);
            usedToolsPath = false;
            result = await callWithFallback(tierConfig, messages, env);
          } else {
            throw toolCallErr;
          }
        }

        const firstCall = result.toolCalls && result.toolCalls.length ? result.toolCalls[0] : null;
        // Only the first proposed tool call is acted on per turn (see
        // MAX_AUTO_TOOL_ROUNDS) — any additional calls in the same
        // response are ignored; the model can request them on a
        // subsequent turn once it sees this result.
        console.log(
          '[chat][tools] usedToolsPath=' + usedToolsPath +
          ' modelReturnedToolCalls=' + !!(result.toolCalls && result.toolCalls.length) +
          ' requestedTool=' + (firstCall ? firstCall.name : 'none')
        );

        if (firstCall) {
          if (toolRequiresConfirmation(firstCall.name)) {
            // Do NOT execute yet. Hand the proposed action back to the
            // frontend so it can show a confirmation prompt; execution
            // only happens if/when the user approves it (confirmToolCall
            // branch above, in a later request).
            pendingToolCall = {
              id: firstCall.id,
              name: firstCall.name,
              args: firstCall.args,
              provider: providerForTool(firstCall.name),
              summary: describeTool(firstCall.name, firstCall.args),
            };
            console.log('[chat][tools] executorRan=false (awaiting user confirmation) tool=' + firstCall.name);
          } else {
            // Read-only tool — safe to run immediately without a
            // round-trip confirmation.
            const toolQuota = await checkAndIncrement(identity.uid, 'toolCalls', plan.limits.toolCallsPerDay, env);
            if (!toolQuota.allowed) {
              return _jsonError(
                'You have reached your daily connected-app action limit for the ' + plan.name + ' plan (' +
                toolQuota.limit + ' per day). It resets at midnight UTC.',
                429, env
              );
            }

            const execOutcome = await executeConnectorTool(firstCall.name, firstCall.args, identity.uid, env);
            console.log(
              '[chat][tools] executorRan=true tool=' + firstCall.name +
              ' success=' + !execOutcome.error +
              (execOutcome.error ? ' code=' + execOutcome.code : '')
            );
            // See the matching comment in the confirmToolCall branch above —
            // same fix, same reason: no tool_calls/role:"tool" replay on a
            // request that declares no tools, and no content: null.
            const followUpMessages = messages.concat([
              {
                role: 'assistant',
                content: (result.text && result.text.trim()) ? result.text : ('I looked this up using ' + firstCall.name + '.'),
              },
              {
                role: 'user',
                content: 'Here is the result of that lookup:\n\n' +
                  JSON.stringify(execOutcome.error ? execOutcome : execOutcome.result) +
                  '\n\nReply to me naturally based on this result — do not call any more tools.',
              },
            ]);

            result = await callWithFallback(tierConfig, followUpMessages, env);
            console.log('[chat][tools] finalPassReceivedToolResult=true tool=' + firstCall.name);
            toolExecuted = {
              name: firstCall.name,
              provider: providerForTool(firstCall.name),
              ok: !execOutcome.error,
              summary: describeTool(firstCall.name, firstCall.args),
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
    toolExecuted,
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
