// docstudio-client.js
// Talks to the doc-studio service (the /doc-studio folder, deployed on its own host with Docker because it
// needs Chromium). Cognita's Worker sends it a content spec and gets back finished files plus a preview picture:
// PDF, Word, PowerPoint, Excel, PNG. This is what makes documents and graphic designs look designed instead of
// templated (8 design systems, real embedded fonts, per-slide variation).
//
// Setup (Worker secrets, never in the repo):
//   npx wrangler secret put DOCSTUDIO_URL     e.g. https://cognita-doc-studio.onrender.com   (https only)
//   npx wrangler secret put DOCSTUDIO_TOKEN   the same value as DOCSTUDIO_TOKEN on the doc-studio host
// Without DOCSTUDIO_URL, Cognita behaves exactly as before (docStudioConfigured() is false and the tools in
// media-tools.js that need it are not offered).
//
// Worker-only file: it is listed in .vercelignore.

export const DEFAULT_TIMEOUT_MS = 55000;
const MAX_RESPONSE_CHARS = 20 * 1024 * 1024; // base64 text; about 15 MB of files
const MAX_FILES = 4;

export function docStudioConfigured(env) {
  return !!(env && typeof env.DOCSTUDIO_URL === 'string' && env.DOCSTUDIO_URL.trim());
}

/** https only (plain http is allowed for localhost, which is how the tests run). Returns a clean base URL or null. */
export function docStudioBase(env) {
  if (!docStudioConfigured(env)) return null;
  let u;
  try { u = new URL(env.DOCSTUDIO_URL.trim()); } catch (_) { return null; }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return null;
  if (u.username || u.password) return null;
  return u.origin + u.pathname.replace(/\/+$/, '');
}

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/**
 * Renders one spec. `spec` is the doc-studio content spec (see doc-studio/AI-PROMPT.md); `formats` is an
 * optional list such as ['pdf']. Resolves { kind, design:{id,name}, preview:{mime,content}, files:[{format,name,mime,size,content}] }
 * where every `content` is base64. Rejects with an Error whose `.code` is one of:
 *   not_configured, timeout, unreachable, rejected (4xx), failed (5xx), bad_response.
 */
export async function renderWithDocStudio(env, spec, formats, opts = {}) {
  const base = docStudioBase(env);
  if (!base) throw fail('not_configured', 'The document service is not configured.');
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetch || fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (env.DOCSTUDIO_TOKEN) headers.Authorization = 'Bearer ' + env.DOCSTUDIO_TOKEN;

  let res;
  let text;
  try {
    res = await fetchImpl(base + '/api/render', { method: 'POST', headers, body: JSON.stringify({ spec, formats }), signal: controller.signal });
    text = await res.text();
  } catch (e) {
    if (e && e.name === 'AbortError') throw fail('timeout', 'The document service took too long.');
    throw fail('unreachable', 'The document service could not be reached.');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail = '';
    try { detail = JSON.parse(text).error || ''; } catch (_) { /* not JSON */ }
    console.warn('[docstudio] status=' + res.status + ' ' + String(detail).slice(0, 200));
    throw fail(res.status >= 400 && res.status < 500 ? 'rejected' : 'failed', 'The document service answered ' + res.status + '.');
  }
  if (text.length > MAX_RESPONSE_CHARS) throw fail('bad_response', 'The document was too large.');

  let j;
  try { j = JSON.parse(text); } catch (_) { throw fail('bad_response', 'The document service sent something unreadable.'); }
  return checkResult(j);
}

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Shapes and checks what the service sent, so nothing odd is ever forwarded to a person's browser. */
export function checkResult(j) {
  if (!j || typeof j !== 'object' || !Array.isArray(j.files) || !j.files.length || j.files.length > MAX_FILES) throw fail('bad_response', 'The document service sent no files.');
  const files = j.files.map((f) => {
    const name = typeof f.name === 'string' ? f.name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '').slice(0, 80) : '';
    if (!name || typeof f.content !== 'string' || !f.content || !B64.test(f.content)) throw fail('bad_response', 'The document service sent a broken file.');
    return { format: String(f.format || '').slice(0, 12), name, mime: String(f.mime || 'application/octet-stream').slice(0, 100), size: Math.round(f.content.length * 3 / 4), content: f.content };
  });
  const p = j.preview;
  const preview = p && typeof p.content === 'string' && B64.test(p.content) && /^image\/(?:jpeg|png)$/.test(p.mime) && p.content.length <= 600000
    ? { mime: p.mime, content: p.content } : null;
  const d = j.design && typeof j.design === 'object' ? { id: String(j.design.id || '').slice(0, 30), name: String(j.design.name || '').slice(0, 60) } : { id: '', name: '' };
  return { kind: String(j.kind || '').slice(0, 20), design: d, preview, files };
}
