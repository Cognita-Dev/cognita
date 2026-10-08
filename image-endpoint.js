// image-endpoint.js

import { requireAuth, describeAuthError } from './auth-middleware.js';
import { resolveAccount } from './subscription.js';
import { checkAndIncrement } from './usage.js';
import { getPlan } from './entitlements.js';
import { callWithFallback } from './providers.js';
import { MODEL_TIERS } from './entitlements.js';
import { generateImage, isImageSafetyError as _isSafety } from './media-tools.js';

const DIAGRAM_SYSTEM_PROMPT =
  'You are an expert diagram creator. Generate clean, accurate, well-labelled ' +
  'SVG diagrams. Return ONLY raw SVG code — no markdown, no explanation, no ' +
  'code fences. Start with <svg and end with </svg>. Use viewBox="0 0 700 500" ' +
  'and width="100%". Use a white background, clear sans-serif labels, and ' +
  'distinct but professional colours. Include a title.';

export async function handleImageRequest(request, env) {
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

  const prompt = (body.prompt || '').trim();
  const kind = body.kind === 'illustration' ? 'illustration' : 'diagram';
  if (!prompt) return _jsonError('Missing prompt.', 400, env);
  if (prompt.length > 500) return _jsonError('Prompt is too long (max 500 characters).', 400, env);

  let account;
  try {
    account = await resolveAccount(identity.uid, env);
  } catch (e) {
    console.error('[image] account resolution failed:', e.message);
    return _jsonError('Could not verify your account. Please try again.', 500, env);
  }

  const plan = getPlan(account.planId);

  if (kind === 'diagram') {
    const quota = await checkAndIncrement(identity.uid, 'imageGen', plan.limits.imageGenPerDay, env);
    if (!quota.allowed) {
      return _jsonError(
        'You have reached your daily visual generation limit for the ' + plan.name + ' plan (' + quota.limit + ' per day).',
        429, env
      );
    }
    return _generateDiagram(prompt, env);
  }

  // Picture generation is open to every plan (it runs on Workers AI's free
  // allowance); the daily imageGenPerDay limit below is the only cap. Before
  // this change it was limited to Plus and above.
  const quota = await checkAndIncrement(identity.uid, 'imageGen', plan.limits.imageGenPerDay, env);
  if (!quota.allowed) {
    return _jsonError(
      'You have reached your daily image generation limit for the ' + plan.name + ' plan (' + quota.limit + ' per day).',
      429, env
    );
  }

  return _generateIllustration(prompt, env);
}

async function _generateDiagram(prompt, env) {
  const messages = [
    { role: 'system', content: DIAGRAM_SYSTEM_PROMPT },
    { role: 'user', content: 'Create a diagram showing: ' + prompt },
  ];

  try {
    const result = await callWithFallback(MODEL_TIERS.fast, messages, env);
    const svg = _extractSvg(result.text);
    if (!svg) throw new Error('No valid SVG in response.');
    return new Response(JSON.stringify({ type: 'svg', content: svg }), {
      status: 200,
      headers: _corsJsonHeaders(env),
    });
  } catch (e) {
    console.error('[image] diagram generation failed:', e.message);
    return _jsonError('Could not generate the diagram. Please try again.', 503, env);
  }
}

async function _generateIllustration(prompt, env) {
  if (!env.AI) return _jsonError('Image generation is temporarily unavailable.', 503, env);

  try {
    const img = await generateImage(prompt, env);
    if (!img || !img.base64) throw new Error('Could not extract image from provider response.');

    return new Response(JSON.stringify({ type: 'image', content: img.base64, mime: img.mime }), {
      status: 200,
      headers: _corsJsonHeaders(env),
    });
  } catch (e) {
    console.error('[image] illustration generation failed:', e.message);
    if (isImageSafetyError(e)) {
      return _jsonError('That description was blocked by the safety filter. Try wording it differently.', 422, env);
    }
    return _jsonError('Could not generate the image. Please try again.', 503, env);
  }
}

// Shared Workers AI illustration call, exported so other endpoints (e.g.
// resources-endpoint.js, for image flashcards) can reuse the exact same
// model/prompt-wrapping/decoding logic instead of duplicating it. Throws
// on failure — callers decide how to handle a failed single image (e.g.
// resources-endpoint.js just skips that one card rather than failing the
// whole deck).
export async function generateIllustrationBase64(prompt, env, opts = {}) {
  // Tries each Workers AI image model in turn (see media-tools.js). The
  // classroomSafe wording for flashcards lives there too.
  const img = await generateImage(prompt, env, { classroomSafe: !!opts.classroomSafe });
  return img.base64;
}

// True when the error came from Workers AI's content-safety filter
// (error code 8007, "Input prompt contains NSFW content").
export function isImageSafetyError(e) {
  return !!(e && e.safety) || _isSafety(e);
}

function _extractSvg(text) {
  if (!text) return null;
  const clean = text.replace(/```[\w]*\n?/g, '').replace(/```/g, '').trim();
  const start = clean.indexOf('<svg');
  const end = clean.lastIndexOf('</svg>');
  if (start === -1 || end === -1) return null;
  return clean.slice(start, end + 6);
}

function _corsJsonHeaders(env) {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': env?.APP_ORIGIN || '*' };
}

function _jsonError(message, status, env) {
  return new Response(JSON.stringify({ error: message }), { status, headers: _corsJsonHeaders(env) });
}
