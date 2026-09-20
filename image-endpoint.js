// image-endpoint.js

import { requireAuth, describeAuthError } from './auth-middleware.js';
import { resolveAccount } from './subscription.js';
import { checkAndIncrement } from './usage.js';
import { getPlan } from './entitlements.js';
import { callWithFallback } from './providers.js';
import { MODEL_TIERS } from './entitlements.js';

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

  if (!plan.models.vision) {
    return _jsonError(
      'Realistic image generation requires the Cognita Plus plan or higher.',
      403, env
    );
  }

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
    const response = await env.AI.run('@cf/black-forest-labs/flux-1-schnell', {
      prompt: 'A clean, professional, realistic illustration: ' + prompt + '. No text overlays. No cartoon style.',
      steps: 4,
    });

    const base64 = await _extractImageBase64(response);
    if (!base64) throw new Error('Could not extract image from provider response.');

    return new Response(JSON.stringify({ type: 'image', content: base64 }), {
      status: 200,
      headers: _corsJsonHeaders(env),
    });
  } catch (e) {
    console.error('[image] illustration generation failed:', e.message);
    return _jsonError('Could not generate the image. Please try again.', 503, env);
  }
}

function _extractSvg(text) {
  if (!text) return null;
  const clean = text.replace(/```[\w]*\n?/g, '').replace(/```/g, '').trim();
  const start = clean.indexOf('<svg');
  const end = clean.lastIndexOf('</svg>');
  if (start === -1 || end === -1) return null;
  return clean.slice(start, end + 6);
}

async function _extractImageBase64(response) {
  if (response && typeof response.image === 'string' && response.image.length > 0) {
    return response.image;
  }
  if (response && response.image instanceof ReadableStream) {
    const reader = response.image.getReader();
    const chunks = [];
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const total = chunks.reduce((acc, c) => acc + c.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length; }
    let binary = '';
    for (let i = 0; i < merged.length; i++) binary += String.fromCharCode(merged[i]);
    return btoa(binary);
  }
  return null;
}

function _corsJsonHeaders(env) {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': env?.APP_ORIGIN || '*' };
}

function _jsonError(message, status, env) {
  return new Response(JSON.stringify({ error: message }), { status, headers: _corsJsonHeaders(env) });
}
