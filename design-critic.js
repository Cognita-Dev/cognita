// design-critic.js
//
// Self-evaluation for create_design. Before this file, a design was built once and shown, whatever it looked like.
// Now the work goes in three steps, each cheap and bounded:
//
//   1. PICK    Several compositions (art directions) are derived for the same brief and each one is scored by a
//              deterministic design lint (hierarchy, copy load, contrast, picture situation, headline length).
//              The best one is built. No model call, no image call, no extra cost.
//   2. LOOK    When the designer service has rendered the design, the finished picture is shown to the Workers AI
//              vision model, which scores it and names concrete problems. This is advisory input for step 3 only.
//   3. REDO    If the look score is poor, ONE more version is built with a different design system (or composition)
//              and the better of the two is kept. At most two renders, so latency stays bounded.
//
// Everything that can fail fails quietly: a missing vision plan, a model error or an unreadable answer just means
// the first design is shown, exactly as before. Pure functions here are covered by tests/design-critic.test.mjs.

import { deriveDesignDirection } from './design-direction.js';
import { callVisionModel } from './providers.js';

export const CRITIC_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
export const CANDIDATES = 6;
export const REDO_BELOW = 6; // vision score out of 10; below this one redo is attempted

// ── Colour maths (WCAG contrast) ────────────────────────────────────────

function _rgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function _lum(rgb) {
  const f = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
}

export function contrastRatio(a, b) {
  const x = _rgb(a);
  const y = _rgb(b);
  if (!x || !y) return null;
  const l1 = _lum(x);
  const l2 = _lum(y);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// ── 1. Deterministic design lint ────────────────────────────────────────
// facts: { headline, words, items, hasImage, colors:{primary,accent,light,ink}, lastLayout }
// Returns { score: 0..100, issues: [string] }. Penalties are deliberately few and each one maps to a visible flaw.

export function lintDirection(d, facts) {
  const f = facts || {};
  const issues = [];
  let score = 100;
  const hit = (pts, msg) => { score -= pts; issues.push(msg); };
  const headWords = String(f.headline || '').trim().split(/\s+/).filter(Boolean).length;
  const picLed = d.layout === 'poster' || d.layout === 'stack' || d.layout === 'editorial' || d.layout === 'frame';

  if (headWords > 9) hit(8, 'headline is long for a poster (' + headWords + ' words)');
  if (headWords <= 1 && d.headScale > 1.2 && String(f.headline || '').length > 14) hit(5, 'one long word at a very large size may overflow');
  if ((d.layout === 'poster' || d.layout === 'stack' || d.layout === 'frame') && f.words > 36) hit(14, 'too much copy for a picture-led layout');
  if (d.layout === 'split' && f.words < 8 && f.items < 2) hit(8, 'information layout with almost nothing to inform');
  if (picLed && !f.hasImage && d.layout !== 'stack') hit(18, 'picture-led layout but there is no picture');
  if (d.layout === 'poster' && !f.hasImage) hit(10, 'poster composition needs a photograph to work');
  if (d.keyFact && d.keyFact !== 'none' && f.items === 0) hit(5, 'key fact promoted but there are no details');
  if (f.lastLayout && d.layout === f.lastLayout) hit(10, 'same layout as the previous design in this chat');
  if (d.energy === 'loud' && d.space === 'airy') hit(6, 'loud energy with airy spacing sends mixed signals');

  const c = f.colors || {};
  const onField = contrastRatio('#FFFFFF', c.primary);
  const onPaper = contrastRatio(c.ink, c.light);
  if (onField != null && onField < 3.2 && d.scheme !== 'inverse') hit(12, 'white type on the main colour is hard to read');
  if (onPaper != null && onPaper < 4.5) hit(12, 'dark type on the light colour is hard to read');
  const accent = contrastRatio(c.accent, c.primary);
  if (accent != null && accent < 1.6) hit(8, 'accent colour disappears against the main colour');

  return { score: Math.max(0, score), issues };
}

// ── Pick the best composition ───────────────────────────────────────────
// args: the cleaned create_design arguments. ctx: what deriveDesignDirection takes. facts: see lintDirection.
// With an explicit seed (a follow-up tweak) only that one composition is considered, so it stays put.

export function chooseDirection(args, ctx, facts, opts = {}) {
  const base = Number.isInteger(ctx && ctx.seed) ? (ctx.seed >>> 0) : 0;
  const n = opts.exact ? 1 : Math.max(1, opts.candidates || CANDIDATES);
  const seen = new Set();
  const tried = [];
  for (let i = 0; i < n; i++) {
    const seed = (base + Math.imul(i, 0x9e3779b1)) >>> 0;
    let d;
    try { d = deriveDesignDirection(args, { ...ctx, seed }); } catch (_) { continue; }
    const key = d.layout + '|' + d.voice + '|' + d.vAnchor + '|' + (d.graphic || '') + '|' + d.scheme;
    if (seen.has(key)) continue;
    seen.add(key);
    const lint = lintDirection(d, facts);
    tried.push({ direction: d, seed, score: lint.score, issues: lint.issues });
  }
  if (!tried.length) return null;
  // Highest score wins; on a tie the earliest candidate wins, which keeps the pick stable.
  const ranked = tried.map((t, i) => ({ t, i })).sort((a, b) => b.t.score - a.t.score || a.i - b.i).map((x) => x.t);
  return { ...ranked[0], alternatives: ranked.slice(1) };
}

// ── Photograph looks ────────────────────────────────────────────────────
// The old prompt ended every photo with the same stock-photo words, so every background had the same look.
// Each tone now gets its own photographic character, and the seed rotates between them.

const LOOKS = {
  calm: ['soft diffused window light, muted earthy tones, shallow depth of field, 50mm lens', 'overhead flat lay on natural linen, gentle shadows, quiet palette'],
  luxury: ['moody low-key lighting, deep shadows, subtle warm highlights, 85mm lens, editorial still life', 'dark backdrop, single soft light source, rich texture, restrained colour'],
  loud: ['high-contrast direct flash, saturated colour, dynamic low angle, 24mm lens', 'hard midday sun, punchy colour, motion and energy, wide lens'],
  playful: ['bright candy colours, hard sunlight, candid joyful moment, wide lens', 'cheerful saturated palette, spontaneous candid frame, soft shadows'],
  warm: ['golden hour glow, candid documentary moment, warm tones, 35mm film grain', 'soft window light, genuine emotion, natural skin tones, 35mm lens'],
  corporate: ['clean modern interior, cool daylight, candid professionals at work, 35mm lens, shallow depth of field', 'architectural lines, crisp daylight, neutral palette with one accent colour'],
  default: ['natural light, candid documentary style, 35mm lens, shallow depth of field', 'golden hour, editorial photography, balanced natural colour', 'overcast soft light, authentic everyday moment, muted colour grade'],
};

export function buildBackgroundPrompt(rawImg, room, direction, seed) {
  const tone = direction && direction.tone;
  const looks = LOOKS[tone] || LOOKS.default;
  const look = looks[(Number(seed) >>> 0) % looks.length];
  const treat = direction && direction.image && direction.image.treatment === 'muted' ? ', muted colour grade' : '';
  return String(rawImg).trim() + ', ' + look + treat + ', ' + (room || 'uncluttered composition with calm negative space') +
    ', one clear real-world subject, photographic, no text, no lettering, no logos, no watermark';
}

// ── 2. Look at the rendered design ──────────────────────────────────────

const LOOK_PROMPT =
  'You are a strict art director judging a finished graphic design (flyer, poster or social post). Judge only what you can see: ' +
  'is there ONE clear focal point, is the type easy to read against its background, is the spacing and alignment deliberate, ' +
  'is any text cut off or overlapping, does it look designed rather than templated. ' +
  'Reply in exactly this format and nothing else:\n' +
  'SCORE: <whole number 1-10>\n' +
  'PROBLEMS: <at most 3 short problems separated by semicolons, or none>';

/** Parses the reviewer's answer. Returns { score, problems } or null when it cannot be understood. */
export function parseLook(text) {
  const t = String(text || '');
  const m = /score\s*[:=]\s*(\d{1,2})(?:\s*\/\s*10)?/i.exec(t);
  if (!m) return null;
  const score = Math.min(10, Math.max(1, parseInt(m[1], 10)));
  const p = /problems?\s*[:=]\s*([^\n]*)/i.exec(t);
  const raw = p ? p[1].trim() : '';
  const problems = /^(?:none|n\/a|-)?\.?$/i.test(raw) ? [] : raw.split(/;|•/).map((x) => x.trim()).filter(Boolean).slice(0, 3);
  return { score, problems };
}

/**
 * Shows the rendered preview ({ mime, content: base64 }) to the vision model. Resolves { score, problems } or null.
 * Never throws. `opts.call` lets tests supply a fake model.
 */
export async function lookAtDesign(preview, env, opts = {}) {
  try {
    if (!preview || !preview.content || !/^image\/(?:png|jpeg)$/.test(preview.mime || '')) return null;
    if (!env || !env.AI) return null;
    if (preview.content.length > 600000) return null;
    const call = opts.call || callVisionModel;
    const res = await call(opts.model || CRITIC_MODEL, [{ role: 'user', content: LOOK_PROMPT }],
      [{ base64: preview.content, mimeType: preview.mime }], env, { maxTokens: 120 });
    return parseLook(res && res.text);
  } catch (e) {
    console.warn('[design-critic] look skipped:', e && e.message);
    return null;
  }
}

/** True when a look result is poor enough to justify one more render. */
export function needsRedo(look) {
  return !!look && look.score < REDO_BELOW;
}
