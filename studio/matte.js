// studio/matte.js
// Background-removal mattes. A matte is one 8-bit alpha picture per sampled frame (0 = background, 255 = subject), made on this device by
// the U2-Net-P model (see bgremove.js). They are kept in memory for drawing and saved in the same IndexedDB store as the project's media,
// under the id clip.bg.key, so they survive reloads and are cleaned up with the project.
// render.js asks matteCanvas() for the alpha picture of a clip at a source time; the answer is the same in preview and export.

import { getAsset, putAsset, deleteAsset } from './store.js';

export const MATTE_SIZE = 320;
const reg = new Map();          // key -> { t0, rate, n, size, alpha: Uint8Array(n * size * size) }
const canv = new Map();         // key -> { cv, ctx, img, sig }

export const hasMatte = (key) => !!key && reg.has(key);
export const getMatte = (key) => reg.get(key) || null;
export function forgetMatte(key) { reg.delete(key); canv.delete(key); }

export async function saveMatte(key, rec) {
  reg.set(key, rec); canv.delete(key);
  await putAsset({ id: key, kind: 'matte', name: 'cut-out', size: rec.alpha.length, blob: new Blob([rec.alpha], { type: 'application/octet-stream' }), t0: rec.t0, rate: rec.rate, n: rec.n, msize: rec.size, createdAt: Date.now() });
}
export async function removeMatte(key) { forgetMatte(key); try { await deleteAsset(key); } catch (_) { /* ignore */ } }

// Loads the saved mattes of every clip in a project into memory (so preview and export can draw them).
export async function ensureMattes(project) {
  for (const c of project.clips || []) {
    const k = c.bg && c.bg.key; if (!k || reg.has(k)) continue;
    try {
      const rec = await getAsset(k); if (!rec || !rec.blob) continue;
      const buf = await rec.blob.arrayBuffer(); const size = rec.msize || MATTE_SIZE;
      if (buf.byteLength !== rec.n * size * size) continue;
      reg.set(k, { t0: rec.t0 || 0, rate: rec.rate || 1, n: rec.n, size, alpha: new Uint8Array(buf) });
    } catch (_) { /* a missing or damaged matte just means the clip is drawn without a cut-out */ }
  }
}

// The cut-out is drawn only when the user has it on and the matte exists.
export const bgActive = (clip) => !!(clip.bg && clip.bg.on && hasMatte(clip.bg.key));

const lutCache = { sig: '', lut: new Uint8Array(256) };
function lutFor(cutoff, soft) {
  const sig = cutoff + '|' + soft; if (lutCache.sig === sig) return lutCache.lut;
  const lo = Math.min(0.98, Math.max(0, cutoff - soft)), hi = Math.min(1, Math.max(lo + 0.02, cutoff + soft)); const L = lutCache.lut;
  for (let i = 0; i < 256; i++) { let t = (i / 255 - lo) / (hi - lo); t = t < 0 ? 0 : t > 1 ? 1 : t; L[i] = Math.round(t * t * (3 - 2 * t) * 255); }
  lutCache.sig = sig; return L;
}

// A canvas holding the alpha picture of clip.bg at source time t (frames either side are blended). Not copied: draw it straight away.
export function matteCanvas(clip, t) {
  const bg = clip.bg; const m = reg.get(bg.key); if (!m) return null;
  const S = m.size; const idx = m.n <= 1 ? 0 : Math.min(m.n - 1, Math.max(0, (t - m.t0) * m.rate)); const i0 = Math.floor(idx), i1 = Math.min(m.n - 1, i0 + 1), f = idx - i0;
  const cutoff = bg.cutoff == null ? 0.5 : bg.cutoff, soft = bg.soft == null ? 0.18 : bg.soft;
  const fq = Math.round(f * 16); const sig = [i0, i1, fq, cutoff, soft].join('|');
  let h = canv.get(bg.key);
  if (!h) { const cv = document.createElement('canvas'); cv.width = cv.height = S; const ctx = cv.getContext('2d', { willReadFrequently: true }); h = { cv, ctx, img: ctx.createImageData(S, S), sig: '' }; canv.set(bg.key, h); }
  if (h.sig === sig) return h.cv;
  const lut = lutFor(cutoff, soft), a0 = m.alpha, o0 = i0 * S * S, o1 = i1 * S * S, w1 = fq / 16, w0 = 1 - w1, d = h.img.data, n = S * S;
  for (let p = 0, q = 3; p < n; p++, q += 4) { d[q - 3] = 255; d[q - 2] = 255; d[q - 1] = 255; d[q] = lut[(a0[o0 + p] * w0 + a0[o1 + p] * w1 + 0.5) | 0]; }
  h.ctx.putImageData(h.img, 0, 0); h.sig = sig; return h.cv;
}
