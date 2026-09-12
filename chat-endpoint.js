// chat-endpoint.js

import { requireAuth } from './auth-middleware.js';
import { resolveAccount, assertPlan } from './subscription.js';
import { checkAndIncrement } from './usage.js';
import { getPlan, resolveChatTier, MODEL_TIERS, VISION_MODEL, planHasVision } from './entitlements.js';
import { callWithFallback, callVisionModel } from './providers.js';

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
    'created by the Cognita team, and leave it at that.'
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

  let account;
  try {
    account = await resolveAccount(identity.uid, env);
  } catch (e) {
    console.error('[chat] account resolution failed:', e.message);
    return _jsonError('Could not verify your account. Please try again.', 500, env);
  }

  const plan = getPlan(account.planId);

  const quota = await checkAndIncrement(identity.uid, 'messages', plan.limits.messagesPerDay, env);
  if (!quota.allowed) {
    return _jsonError(
      'You have reached your daily message limit for the ' + plan.name + ' plan (' + quota.limit + ' per day). ' +
      'It resets at midnight UTC, or you can upgrade for a higher limit.',
      429, env
    );
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
    return _jsonError('Cognita is temporarily unavailable. Please try again shortly.', 503, env);
  }

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
    headers: _corsJsonHeaders(env),
  });
}

function _corsJsonHeaders(env) {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': env?.APP_ORIGIN || '*' };
}

function _jsonError(message, status, env) {
  return new Response(JSON.stringify({ error: message }), { status, headers: _corsJsonHeaders(env) });
}
