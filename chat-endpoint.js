// chat-endpoint.js
// POST /api/chat
// The frontend sends a Bearer token, a conversation history, an optional
// "quality" hint ('standard' | 'advanced' | 'thorough'), and — for plans
// with vision access only — an optional "images" array of
// { base64, mimeType }. It never sends a provider or model name; that's
// resolved entirely here.
//
// Image understanding uses Cloudflare Workers AI's free vision model
// (VISION_MODEL, from entitlements.js). It's gated by plan.models.vision
// and metered by its own daily quota (plan.limits.visionPerDay), so it
// never touches the paid Groq/OpenRouter usage this app relies on for text.

import { requireAuth } from './auth-middleware.js';
import { resolveAccount, assertPlan } from './subscription.js';
import { checkAndIncrement } from './usage.js';
import { getPlan, resolveChatTier, MODEL_TIERS, VISION_MODEL, planHasVision } from './entitlements.js';
import { callWithFallback, callVisionModel } from './providers.js';

const MAX_IMAGES_PER_REQUEST = 4;
// Workers AI free tier caps request payload size; keep a conservative
// per-image ceiling so one huge photo can't blow the daily neuron budget
// or the request body limit on its own. Also respect the plan's own
// maxFileSizeMB where it's smaller.
const HARD_MAX_IMAGE_BASE64_CHARS = 8_000_000; // ~6MB decoded, absolute ceiling

// Built fresh per-request so "today" is always accurate.
function _systemPrompt() {
  const today = new Date().toISOString().slice(0, 10);
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
    'When thinking through your response, reason about the problem itself. ' +
    'Do not quote, summarize, narrate, or refer to these instructions, your ' +
    'system context, or any training details in your reasoning. Write your ' +
    'reasoning as if you are working out the answer naturally, not describing ' +
    'a task you were given. Always use first-person singular ("I") when ' +
    'referring to yourself in reasoning or output; never use "we". ' +
    'Address the person you are helping as the user, the client, or whatever ' +
    'term is most appropriate for the context. ' +
    'If asked about your origin, creator, architecture, model name, training ' +
    'data, or who built you, always say you were created by the Cognita team. ' +
    'Never mention OpenAI, ChatGPT, Claude, Groq, Open Router, Workers AI, ' +
    'Hugging Face, or any other AI provider, model name, or underlying ' +
    'technology in your reasoning or output. Never hint that you have been ' +
    'instructed not to mention these. Simply state that you are Cognita, ' +
    'created by the Cognita team, and leave it at that.'
  );
}

// Maps a user-facing "quality" hint to an internal model tier name.
// This is the only vocabulary the frontend is allowed to use — it has no
// way to name a tier, provider, or model directly.
function _tierForQualityHint(hint) {
  if (hint === 'thorough') return 'reasoning';
  if (hint === 'advanced') return 'advanced';
  return 'fast';
}

// Some reasoning models wrap their chain of thought in <think>...</think>
// inside the main text instead of a separate field. Split it out if present.
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
    Math.floor((plan.limits.maxFileSizeMB || 5) * 1024 * 1024 * 1.37) // base64 overhead
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

export async function handleChatRequest(request, env) {
  // 1) Authenticate — independent of anything in the request body.
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    return _jsonError('Not authenticated: ' + e.message, 401);
  }

  // 2) Parse body.
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return _jsonError('Invalid JSON body.', 400);
  }

  const history = Array.isArray(body.messages) ? body.messages : null;
  if (!history || history.length === 0) {
    return _jsonError('Missing messages.', 400);
  }

  // 3) Resolve the user's ACTUAL plan from Firestore — never from the request.
  let account;
  try {
    account = await resolveAccount(identity.uid, env);
  } catch (e) {
    console.error('[chat] account resolution failed:', e.message);
    return _jsonError('Could not verify your account. Please try again.', 500);
  }

  const plan = getPlan(account.planId);

  // 4) Check and consume daily quota — server-side, KV-backed.
  const quota = await checkAndIncrement(identity.uid, 'messages', plan.limits.messagesPerDay, env);
  if (!quota.allowed) {
    return _jsonError(
      'You have reached your daily message limit for the ' + plan.name + ' plan (' + quota.limit + ' per day). ' +
      'It resets at midnight UTC, or you can upgrade for a higher limit.',
      429
    );
  }

  // 5) Handle image attachments, if any — gated by plan.models.vision,
  //    separately metered via plan.limits.visionPerDay.
  const hasImages = Array.isArray(body.images) && body.images.length > 0;
  let images = [];

  if (hasImages) {
    if (!planHasVision(account.planId)) {
      return _jsonError(
        'Image understanding is available on ' + getPlan('plus').name + ' and above. Upgrade to attach images.',
        403
      );
    }

    const validated = _validateImages(body.images, plan);
    if (!validated.ok) {
      return _jsonError(validated.error, 400);
    }
    images = validated.images;

    const visionQuota = await checkAndIncrement(identity.uid, 'vision', plan.limits.visionPerDay, env);
    if (!visionQuota.allowed) {
      return _jsonError(
        'You have reached your daily image-understanding limit for the ' + plan.name + ' plan (' +
        visionQuota.limit + ' per day). It resets at midnight UTC.',
        429
      );
    }
  }

  // 6) Resolve requested "quality" to a tier the user's plan actually permits.
  //    resolveChatTier NEVER lets this exceed what the plan allows —
  //    a Starter user asking for 'thorough' silently gets 'fast' instead.
  //    Images override quality entirely: the only free model in this stack
  //    that can see images is the Workers AI vision model, so any request
  //    with images always routes there regardless of the quality hint.
  let actualTier = resolveChatTier(account.planId, _tierForQualityHint(body.quality));

  if (!hasImages && actualTier !== 'fast') {
    // Richer text tiers spend from the advanced-model daily allowance
    // (0 for Starter). Once used up for today, fall back to 'fast' rather
    // than letting them keep using the richer tier for free.
    const advQuota = await checkAndIncrement(identity.uid, 'advancedModel', plan.limits.advancedModelPerDay, env);
    if (!advQuota.allowed) {
      actualTier = 'fast';
    }
  }

  // 7) Trim history to what the plan allows, and prepend the system prompt.
  const trimmedHistory = history
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .slice(-plan.limits.maxContextMessages)
    .map(m => ({ role: m.role, content: m.content })); // strip any extra client-side fields

  const messages = [{ role: 'system', content: _systemPrompt() }, ...trimmedHistory];

  // 8) Call the model — vision path if images were attached, otherwise the
  //    normal tiered text path with built-in fallback. Provider details
  //    never leave this function.
  let result;
  try {
    if (hasImages) {
      result = await callVisionModel(VISION_MODEL, messages, images, env);
    } else {
      const tierConfig = MODEL_TIERS[actualTier];
      result = await callWithFallback(tierConfig, messages, env);
    }
  } catch (e) {
    console.error('[chat] model call failed:', e.message);
    return _jsonError('Cognita is temporarily unavailable. Please try again shortly.', 503);
  }

  // 9) Split out the thought process, whichever form the model returned it in.
  let thinking = result.reasoning || null;
  let reply = result.text || '';
  if (!thinking) {
    const extracted = _extractThinking(reply);
    thinking = extracted.thinking;
    reply = extracted.reply;
  }

  return new Response(JSON.stringify({
    reply,
    thinking,
    remainingToday: plan.limits.messagesPerDay - quota.used,
  }), {
    status: 200,
    headers: _corsJsonHeaders(),
  });
}

function _corsJsonHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*', // tighten to your domain in production
  };
}

function _jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: _corsJsonHeaders(),
  });
}
