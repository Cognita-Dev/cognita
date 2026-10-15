// vision-review.js
// A second opinion on how a finished file LOOKS. The browser draws the pages of a deck, Word file or PDF into one
// small picture (see check() in sandbox-frame.html); this module shows that picture to the Workers AI vision model
// and returns a few plain sentences the sandbox model can act on.
//
// The vision model is weak and sees one image per call, so its notes are ADVICE only. The pass/fail gate rests on the
// measured taste score in check(); nothing here can fail a file or block a download. Every failure is silent: the
// run carries on exactly as before.

import { callVisionModel } from './providers.js';

export const REVIEW_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const MAX_IMAGES = 2;
const MAX_B64_CHARS = 190_000;
const MAX_NOTE_CHARS = 900;
const JPEG_RE = /^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/;

const PROMPT =
  'You are a strict visual design reviewer. The picture shows the pages or slides of a finished file, side by side. ' +
  'Judge only what you can see: visual hierarchy, spacing and margins, alignment, crowding or empty areas, colour contrast, ' +
  'text running past its box, and whether the pages look like one consistent design. ' +
  'Reply with at most 4 short bullet points, each one a concrete problem and the fix. ' +
  'If it looks clean, reply with exactly: Looks clean. Do not praise, do not repeat the question.';

/** Keeps only small JPEG data addresses, at most MAX_IMAGES of them. Returns [{ kind, base64 }]. */
export function cleanReviewImages(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const it of raw) {
    if (out.length >= MAX_IMAGES) break;
    const url = it && typeof it.dataUrl === 'string' ? it.dataUrl : '';
    if (url.length > MAX_B64_CHARS) continue;
    const m = JPEG_RE.exec(url);
    if (!m) continue;
    out.push({ kind: it.kind === 'page-test' ? 'page-test' : 'pages', base64: m[1] });
  }
  return out;
}

function tidy(text) {
  const t = String(text || '').replace(/\r/g, '').replace(/[—–]/g, '-').trim();
  return t.length > MAX_NOTE_CHARS ? t.slice(0, MAX_NOTE_CHARS) + ' [cut]' : t;
}

/**
 * Reviews the pictures one at a time. Resolves to a string for the model ('' when there is nothing to say).
 * Never throws.
 */
export async function reviewPictures(rawImages, env, opts = {}) {
  const images = cleanReviewImages(rawImages);
  if (!images.length || !env || !env.AI) return '';
  const call = opts.call || callVisionModel;
  const notes = [];
  for (const img of images) {
    try {
      const res = await call(opts.model || REVIEW_MODEL,
        [{ role: 'user', content: PROMPT + (img.kind === 'page-test' ? ' This is a screenshot of a web page.' : '') }],
        [{ base64: img.base64, mimeType: 'image/jpeg' }], env, { maxTokens: 300 });
      const t = tidy(res && res.text);
      if (t && !/^looks clean\.?$/i.test(t)) notes.push((img.kind === 'page-test' ? 'Page test screenshot: ' : 'Pages: ') + t);
    } catch (e) {
      console.warn('[vision-review] skipped:', e && e.message);
    }
  }
  if (!notes.length) return '';
  return 'VISION REVIEW (advisory, from a small image model that can be wrong; the measured taste score above is what counts. ' +
    'Fix only what you agree is a real problem):\n' + notes.join('\n');
}
