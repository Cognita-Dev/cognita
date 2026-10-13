// studio/render.js
// THE renderer. drawFrame(ctx, W, H, project, t, res) is a pure function of (project, time, resources): the live preview, the
// timeline thumbnails, the project card thumbnails and the exporter all call it, so what you see is what you export.
//
// `res` supplies decoded media and nothing else:
//   res.image(assetId)            -> ImageBitmap | HTMLImageElement | canvas | null
//   res.frame(ref, sourceSeconds) -> CanvasImageSource | null      (ref comes from model.videoRef)
//   res.svg(stickerId, colour)    -> HTMLImageElement | null       (kicks off a load on first request)
// Effects use Canvas2D (ctx.filter where the browser has it) with a pixel-loop fallback, so they work everywhere.

import { valueAt, hasKeyframes, trackIndex, videoRef, srcTime, FONTS, clamp, ease } from './model.js';
import { trackAt, lerpAt, correctionFromPath } from './motion.js';
import { bgActive, matteCanvas, MATTE_SIZE } from './matte.js';
import { filterById } from './library-data.js';
import { drawSceneCore } from './engine.js';

// ───────── capability and canvas pool ─────────
let FILTER_OK = null;
export function supportsFilter() {
  if (FILTER_OK !== null) return FILTER_OK;
  try {
    if (typeof window !== 'undefined' && window.__studioNoFilter) { FILTER_OK = false; return false; }
    const c = document.createElement('canvas'); c.width = c.height = 4; const x = c.getContext('2d');
    if (!('filter' in x)) { FILTER_OK = false; return false; }
    x.filter = 'invert(1)'; x.fillStyle = '#fff'; x.fillRect(0, 0, 4, 4);
    FILTER_OK = x.getImageData(0, 0, 1, 1).data[0] < 30;
  } catch (_) { FILTER_OK = false; }
  return FILTER_OK;
}
const pool = { w: 0, h: 0, free: [] };
function makeCanvas(W, H) { const c = document.createElement('canvas'); c.width = W; c.height = H; return c; }
function resetCtx(x, W, H) { x.setTransform(1, 0, 0, 1, 0, 0); x.globalAlpha = 1; x.globalCompositeOperation = 'source-over'; if (x.filter !== undefined) x.filter = 'none'; x.shadowColor = 'rgba(0,0,0,0)'; x.shadowBlur = 0; x.shadowOffsetX = 0; x.shadowOffsetY = 0; x.imageSmoothingEnabled = true; x.clearRect(0, 0, W, H); }
function acquire(W, H) {
  if (pool.w !== W || pool.h !== H) { pool.free.forEach((c) => { c.width = 0; }); pool.free.length = 0; pool.w = W; pool.h = H; }
  const c = pool.free.pop() || makeCanvas(W, H); resetCtx(c.getContext('2d'), W, H); return c;
}
function release(c) { if (c.width === pool.w && c.height === pool.h && pool.free.length < 8) pool.free.push(c); else c.width = 0; }
let measureCtx = null;
const mctx = () => (measureCtx = measureCtx || document.createElement('canvas').getContext('2d'));

// ───────── track jobs and transitions ─────────
const clampDur = (d, a, b) => Math.max(0.05, Math.min(d, a.duration, b.duration));
function linkedIn(list, i) {
  const c = list[i]; const ti = c.transitionIn; if (!ti || ti.type === 'none') return null;
  const prev = list[i - 1]; if (prev && Math.abs(c.start - (prev.start + prev.duration)) <= 0.08) return { t: ti, prev };
  return null;
}
// Which clips of one track are on screen at time t, with their transition state. Clips on one track do not overlap, so a transition
// "straddles the cut": both clips are drawn for d/2 either side of it, holding their first or last frame.
export function trackJobs(list, t) {
  const jobs = [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i]; if (c.start - 1.6 > t) break;
    const end = c.start + c.duration;
    const tin = linkedIn(list, i); const nxt = list[i + 1]; const tout = nxt ? linkedIn(list, i + 1) : null;
    const dIn = tin ? clampDur(tin.t.duration, tin.prev, c) : 0, dOut = tout ? clampDur(tout.t.duration, c, nxt) : 0;
    if (t < c.start - dIn / 2 || t >= end + dOut / 2) continue;
    const mods = [];
    if (tin && t < c.start + dIn / 2) mods.push({ role: 'in', linked: true, type: tin.t.type, dir: tin.t.dir, q: clamp((t - (c.start - dIn / 2)) / dIn, 0, 1) });
    else if (!tin && c.transitionIn.type !== 'none') { const d = Math.min(c.transitionIn.duration, c.duration); if (t < c.start + d) mods.push({ role: 'in', linked: false, type: c.transitionIn.type, dir: c.transitionIn.dir, q: clamp((t - c.start) / d, 0, 1) }); }
    if (tout && t >= end - dOut / 2) mods.push({ role: 'out', linked: true, type: tout.t.type, dir: tout.t.dir, q: clamp((t - (end - dOut / 2)) / dOut, 0, 1) });
    else if (!tout && c.transitionOut.type !== 'none') { const d = Math.min(c.transitionOut.duration, c.duration); if (t >= end - d) mods.push({ role: 'out', linked: false, type: c.transitionOut.type, dir: c.transitionOut.dir, q: clamp((t - (end - d)) / d, 0, 1) }); }
    jobs.push({ clip: c, local: clamp(t - c.start, 0, Math.max(0, c.duration - 1e-4)), mods });
  }
  return jobs;
}
// All visual jobs at t in draw order (bottom first). Used by the renderer and by media preparation.
export function activeJobs(project, t) {
  const idx = trackIndex(project); const out = [];
  for (let i = project.tracks.length - 1; i >= 0; i--) {
    const tr = project.tracks[i]; if (tr.type === 'audio' || tr.hidden) continue;
    const l = idx.get(tr.id); if (l && l.length) trackJobs(l, t).forEach((j) => { j.track = tr; out.push(j); });
  }
  return out;
}

const DIRV = { left: [-1, 0], right: [1, 0], up: [0, -1], down: [0, 1] };
function modState(m) {
  const q = m.q, isIn = m.role === 'in'; const o = { alpha: 1, tx: 0, ty: 0, s: 1, rot: 0, rect: null, circle: -1, blur: 0, flash: 0 };
  const dv = DIRV[m.dir] || DIRV.left;
  switch (m.type) {
    case 'dissolve': o.alpha = isIn ? q : (m.linked ? 1 : 1 - q); break;
    case 'fade': o.alpha = isIn ? (m.linked ? clamp(2 * q - 1, 0, 1) : q) : (m.linked ? clamp(1 - 2 * q, 0, 1) : 1 - q); break;
    case 'wipe': {
      const k = isIn ? q : 1 - q; let r;
      if (isIn) r = m.dir === 'left' ? [0, 0, k, 1] : m.dir === 'right' ? [1 - k, 0, k, 1] : m.dir === 'up' ? [0, 0, 1, k] : [0, 1 - k, 1, k];
      else r = m.dir === 'left' ? [1 - k, 0, k, 1] : m.dir === 'right' ? [0, 0, k, 1] : m.dir === 'up' ? [0, 1 - k, 1, k] : [0, 0, 1, k];
      if (isIn || !m.linked) o.rect = r; break;
    }
    case 'slide': if (isIn) { o.tx = dv[0] * (1 - q); o.ty = dv[1] * (1 - q); } else if (!m.linked) { o.tx = -dv[0] * q; o.ty = -dv[1] * q; } break;
    case 'push': if (isIn) { o.tx = dv[0] * (1 - q); o.ty = dv[1] * (1 - q); } else { o.tx = -dv[0] * q; o.ty = -dv[1] * q; } break;
    case 'zoomIn': if (isIn) { o.s = 0.85 + 0.15 * q; o.alpha = q; } else { o.s = 1 + 0.5 * q; o.alpha = 1 - q; } break;
    case 'zoomOut': if (isIn) { o.s = 1.25 - 0.25 * q; o.alpha = q; } else { o.s = 1 - 0.4 * q; o.alpha = 1 - q; } break;
    case 'spin': if (isIn) { o.rot = (1 - q) * -Math.PI / 2; o.s = 0.3 + 0.7 * q; o.alpha = q; } else { o.rot = q * Math.PI / 2; o.s = 1 - 0.7 * q; o.alpha = 1 - q; } break;
    case 'blur': if (isIn) { o.blur = (1 - q) * 30; o.alpha = q; } else { o.blur = q * 30; o.alpha = 1 - q; } break;
    case 'flash': if (isIn) { o.alpha = q < 0.5 ? 0 : 1; o.flash = q >= 0.5 ? 2 * (1 - q) : 0; } else { o.alpha = q < 0.5 ? 1 : 0; o.flash = q < 0.5 ? 2 * q : 0; } break;
    case 'iris': if (isIn) o.circle = q; else if (!m.linked) o.circle = 1 - q; break;
    default: break;
  }
  return o;
}
function applyMods(c, W, H, sts) {
  if (!sts) return;
  for (const s of sts) {
    if (s.rect) { c.beginPath(); c.rect(s.rect[0] * W, s.rect[1] * H, s.rect[2] * W, s.rect[3] * H); c.clip(); }
    if (s.circle >= 0) { c.beginPath(); c.arc(W / 2, H / 2, Math.max(0.001, s.circle * Math.hypot(W, H) / 2), 0, Math.PI * 2); c.clip(); }
    if (s.tx || s.ty || s.s !== 1 || s.rot) { c.translate(W / 2 + s.tx * W, H / 2 + s.ty * H); if (s.rot) c.rotate(s.rot); c.scale(s.s, s.s); c.translate(-W / 2, -H / 2); }
  }
}

// ───────── adjustments ─────────
const A_KEYS = ['brightness', 'contrast', 'saturation', 'temperature', 'tint', 'exposure', 'blur', 'sharpen', 'vignette', 'grain'];
function effAdjust(clip, local) {
  const a = clip.adjust, o = {};
  for (const k of A_KEYS) o[k] = clip.keyframes && clip.keyframes['adjust.' + k] ? valueAt(clip, 'adjust.' + k, local) : (a[k] || 0);
  o.sepia = 0; o.gray = 0; o.hue = 0;
  if (clip.filter && clip.filter !== 'none') {
    const f = filterById(clip.filter), m = clip.filterAmount == null ? 1 : clip.filterAmount;
    for (const k in f.adjust) o[k] = (o[k] || 0) + f.adjust[k] * m;
    o.sepia = (f.sepia || 0) * m; o.gray = (f.gray || 0) * m; o.hue = (f.hue || 0) * m;
  }
  return o;
}
const adjActive = (o) => !!(o.brightness || o.contrast || o.saturation || o.temperature || o.tint || o.exposure || o.blur || o.sharpen || o.vignette || o.grain || o.sepia || o.gray || o.hue);
function cssFilter(o, u) {
  const p = [];
  const br = (1 + o.brightness / 100) * Math.pow(2, o.exposure); if (Math.abs(br - 1) > 0.002) p.push(`brightness(${Math.max(0, br).toFixed(3)})`);
  if (o.contrast) p.push(`contrast(${Math.max(0, 1 + o.contrast / 100).toFixed(3)})`);
  if (o.saturation) p.push(`saturate(${Math.max(0, 1 + o.saturation / 100).toFixed(3)})`);
  if (o.sepia) p.push(`sepia(${clamp(o.sepia, 0, 1).toFixed(3)})`);
  if (o.gray) p.push(`grayscale(${clamp(o.gray, 0, 1).toFixed(3)})`);
  if (o.hue) p.push(`hue-rotate(${o.hue.toFixed(1)}deg)`);
  if (o.blur) p.push(`blur(${(o.blur * u).toFixed(2)}px)`);
  return p.join(' ');
}
const hexRgb = (h) => { const m = /^#?([0-9a-f]{6})$/i.exec(String(h).length === 4 ? '#' + [...String(h).slice(1)].map((x) => x + x).join('') : h); if (!m) return [0, 255, 0]; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const NOISE = (() => { const a = new Int8Array(65536); let s = 12345; for (let i = 0; i < a.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; a[i] = ((s >> 16) & 255) - 128; } return a; })();

function pixelPass(lc, W, H, o) {
  const d0 = lc.getImageData(0, 0, W, H); const d = d0.data;
  if (o.rgb) {
    const off = Math.max(1, Math.round(o.rgb)); const src = new Uint8ClampedArray(d);
    for (let y = 0; y < H; y++) { const row = y * W; for (let x = 0; x < W; x++) { const i = (row + x) * 4; d[i] = src[(row + Math.min(W - 1, x + off)) * 4]; d[i + 2] = src[(row + Math.max(0, x - off)) * 4 + 2]; } }
  }
  if (o.sharpen) {
    const src = new Uint8ClampedArray(d); const amt = clamp(o.sharpen / 100, 0, 1) * 0.9; const rs = W * 4;
    for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { const i = (y * W + x) * 4; for (let k = 0; k < 3; k++) { const v = src[i + k]; d[i + k] = v + amt * (4 * v - src[i + k - 4] - src[i + k + 4] - src[i + k - rs] - src[i + k + rs]) * 0.5; } }
  }
  const tr = 1 + o.temp * 0.003, tb = 1 - o.temp * 0.003, tg = 1 - o.tint * 0.003, trb = 1 + o.tint * 0.0015;
  const ck = o.chroma; let kr = 0, kg = 0, kb = 0, tol = 0, soft = 0.01, greenKey = true;
  if (ck) { [kr, kg, kb] = hexRgb(ck.color); tol = ck.tolerance; soft = Math.max(0.005, ck.softness); greenKey = kg >= kb; }
  const grain = o.grain ? o.grain * 0.55 : 0; const gOff = (Math.random() * 65536) | 0;
  const bs = o.basic; let bB = 1, bC = 1, bS = 1, bSep = 0, bGray = 0;
  if (bs) { bB = (1 + bs.brightness / 100) * Math.pow(2, bs.exposure); bC = 1 + bs.contrast / 100; bS = 1 + bs.saturation / 100; bSep = bs.sepia; bGray = bs.gray; }
  const needColour = o.temp || o.tint || bs || grain || ck;
  if (needColour) {
    for (let i = 0, n = W * H * 4, k = 0; i < n; i += 4, k++) {
      let a = d[i + 3]; if (a === 0) continue;
      let r = d[i], g = d[i + 1], b = d[i + 2];
      if (ck) {
        const dr = r - kr, dg = g - kg, db = b - kb; const dist = Math.sqrt(dr * dr + dg * dg + db * db) / 441.67;
        if (dist < tol) { d[i + 3] = 0; continue; }
        if (dist < tol + soft) { a = a * (dist - tol) / soft; d[i + 3] = a; }
        if (greenKey) { const lim = (r + b) / 2; if (g > lim) g = lim + (g - lim) * 0.35; } else { const lim = (r + g) / 2; if (b > lim) b = lim + (b - lim) * 0.35; }
      }
      if (bs) {
        r *= bB; g *= bB; b *= bB;
        if (bC !== 1) { r = (r - 128) * bC + 128; g = (g - 128) * bC + 128; b = (b - 128) * bC + 128; }
        if (bS !== 1 || bGray) { const l = 0.2126 * r + 0.7152 * g + 0.0722 * b; const s = bS * (1 - bGray); r = l + (r - l) * s; g = l + (g - l) * s; b = l + (b - l) * s; }
        if (bSep) { const nr = 0.393 * r + 0.769 * g + 0.189 * b, ng = 0.349 * r + 0.686 * g + 0.168 * b, nb = 0.272 * r + 0.534 * g + 0.131 * b; r += (nr - r) * bSep; g += (ng - g) * bSep; b += (nb - b) * bSep; }
      }
      if (o.temp || o.tint) { r *= tr * trb; g *= tg; b *= tb * trb; }
      if (grain) { const nz = NOISE[(k * 7 + gOff) & 65535] * grain / 128 * 40; r += nz; g += nz; b += nz; }
      d[i] = r; d[i + 1] = g; d[i + 2] = b;
    }
  }
  lc.putImageData(d0, 0, 0);
}

// Blur `src` into `dst` (both W by H). Uses ctx.filter when present, otherwise a down/up-scale approximation.
let smallCv = null;
function blurInto(dst, src, W, H, r) {
  if (r < 0.3) { dst.drawImage(src, 0, 0); return; }
  if (supportsFilter()) { dst.save(); dst.filter = `blur(${r.toFixed(2)}px)`; dst.drawImage(src, 0, 0); dst.restore(); return; }
  const k = clamp(Math.round(r / 2), 1, 24); const sw = Math.max(2, Math.ceil(W / k)), sh = Math.max(2, Math.ceil(H / k));
  smallCv = smallCv || document.createElement('canvas'); smallCv.width = sw; smallCv.height = sh;
  const sx = smallCv.getContext('2d'); sx.imageSmoothingEnabled = true; sx.clearRect(0, 0, sw, sh); sx.drawImage(src, 0, 0, sw, sh);
  dst.save(); dst.imageSmoothingEnabled = true; dst.drawImage(smallCv, 0, 0, sw, sh, 0, 0, W, H); dst.restore();
}
function applyLayerEffects(L, lc, W, H, u, effects) {
  for (const fx of effects) {
    if (fx.type === 'blur') { const T = acquire(W, H); T.getContext('2d').drawImage(L, 0, 0); lc.clearRect(0, 0, W, H); blurInto(lc, T, W, H, fx.amount * u); release(T); }
    else if (fx.type === 'glow') { const T = acquire(W, H); blurInto(T.getContext('2d'), L, W, H, 18 * u); lc.save(); lc.globalCompositeOperation = 'lighter'; lc.globalAlpha = clamp(fx.amount, 0, 1.5); lc.drawImage(T, 0, 0); lc.restore(); release(T); }
    else if (fx.type === 'pixelate') { const s = Math.max(2, Math.round(fx.amount * u)); const sw = Math.max(1, Math.ceil(W / s)), sh = Math.max(1, Math.ceil(H / s)); smallCv = smallCv || document.createElement('canvas'); smallCv.width = sw; smallCv.height = sh; const sx = smallCv.getContext('2d'); sx.imageSmoothingEnabled = true; sx.drawImage(L, 0, 0, sw, sh); lc.clearRect(0, 0, W, H); lc.imageSmoothingEnabled = false; lc.drawImage(smallCv, 0, 0, sw, sh, 0, 0, W, H); lc.imageSmoothingEnabled = true; }
    else if (fx.type === 'mirror') { const T = acquire(W, H); T.getContext('2d').drawImage(L, 0, 0); lc.save(); lc.beginPath(); lc.rect(W / 2, 0, W / 2, H); lc.clip(); lc.clearRect(0, 0, W, H); lc.translate(W, 0); lc.scale(-1, 1); lc.drawImage(T, 0, 0); lc.restore(); release(T); }
  }
}
// Applies colour work and effects to a layer in place. Returns the CSS filter string to use when the layer is composited.
function processLayer(L, lc, W, H, u, clip, local, adj) {
  const useCss = supportsFilter();
  const fx = clip.effects || [];
  const rgb = fx.find((e) => e.type === 'rgbsplit');
  const o = { temp: adj.temperature, tint: adj.tint, sharpen: adj.sharpen, grain: adj.grain, chroma: clip.chroma && clip.chroma.on ? clip.chroma : null, rgb: rgb ? rgb.amount * u : 0, basic: useCss ? null : adj };
  const mutatesPixels = o.temp || o.tint || o.sharpen || o.grain || o.chroma || o.rgb || o.basic;
  if (fx.length) applyLayerEffects(L, lc, W, H, u, fx);
  if (mutatesPixels) pixelPass(lc, W, H, o);
  if (adj.vignette > 0) {
    lc.save(); lc.globalCompositeOperation = 'source-atop'; const g = lc.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.hypot(W, H) / 2);
    g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, `rgba(0,0,0,${clamp(adj.vignette / 100, 0, 1) * 0.85})`); lc.fillStyle = g; lc.fillRect(0, 0, W, H); lc.restore();
  }
  return useCss ? cssFilter(adj, u) : (adj.blur ? '' : '');
}

// ───────── content ─────────
const BLEND = { normal: 'source-over', multiply: 'multiply', screen: 'screen', overlay: 'overlay', darken: 'darken', lighten: 'lighten', 'soft-light': 'soft-light', 'hard-light': 'hard-light', difference: 'difference', add: 'lighter' };
const srcSize = (s) => [s.videoWidth || s.displayWidth || s.naturalWidth || s.width || 0, s.videoHeight || s.displayHeight || s.naturalHeight || s.height || 0];
function mediaDims(src, W, H, tr, fit) {
  const [iw, ih] = srcSize(src); if (!iw || !ih) return null;
  const cr = tr.crop; const sx = cr.l * iw, sy = cr.t * ih, sw = iw * (1 - cr.l - cr.r), sh = ih * (1 - cr.t - cr.b); if (sw < 2 || sh < 2) return null;
  let dw, dh;
  if (fit === 'stretch') { dw = W; dh = H; } else { const k = fit === 'fill' ? Math.max(W / sw, H / sh) : Math.min(W / sw, H / sh); dw = sw * k; dh = sh * k; }
  return { sx, sy, sw, sh, dw, dh };
}
function drawMedia(c, src, W, H, tr) {
  const fit = tr.fit; const m = mediaDims(src, W, H, tr, fit); if (!m) return null;
  if (fit === 'fitblur') {
    const kc = Math.max(W / m.sw, H / m.sh);
    c.save(); c.beginPath(); c.rect(-W / 2, -H / 2, W, H); c.clip();
    if (supportsFilter()) c.filter = 'blur(36px) brightness(0.8)';
    c.drawImage(src, m.sx, m.sy, m.sw, m.sh, -m.sw * kc / 2, -m.sh * kc / 2, m.sw * kc, m.sh * kc);
    if (!supportsFilter()) { c.fillStyle = 'rgba(0,0,0,0.55)'; c.fillRect(-W / 2, -H / 2, W, H); }
    c.restore();
  }
  if (fit === 'fill') { c.save(); c.beginPath(); c.rect(-W / 2, -H / 2, W, H); c.clip(); c.drawImage(src, m.sx, m.sy, m.sw, m.sh, -m.dw / 2, -m.dh / 2, m.dw, m.dh); c.restore(); return { w: W, h: H }; }
  c.drawImage(src, m.sx, m.sy, m.sw, m.sh, -m.dw / 2, -m.dh / 2, m.dw, m.dh);
  return { w: fit === 'fitblur' ? W : m.dw, h: fit === 'fitblur' ? H : m.dh };
}

// text
const fontCss = (T, size) => `${T.italic ? 'italic ' : ''}${T.weight} ${size}px ${(FONTS[T.font] || FONTS.sans).css}`;
function wrapLines(c, text, maxW) {
  const out = [];
  String(text).split('\n').forEach((para) => {
    const words = para.split(/\s+/).filter(Boolean); let line = '';
    if (!words.length) { out.push(''); return; }
    words.forEach((w) => { const test = line ? line + ' ' + w : w; if (c.measureText(test).width > maxW && line) { out.push(line); line = w; } else line = test; });
    out.push(line);
  });
  return out.slice(0, 40);
}
function textStyleFor(clip) {
  const T = clip.text; if (clip.kind !== 'caption') return T;
  const p = (clip.cap && clip.cap.preset) || 'boxed';
  const box = { on: p === 'boxed' || p === 'karaoke', color: '#000000', alpha: 0.62, pad: 20, radius: 16 };
  const stroke = p === 'outlined' || p === 'pop' ? { w: 7, color: '#000000' } : { w: 0, color: '#000000' };
  const shadow = p === 'plain' ? { on: true, x: 0, y: 3, blur: 10, color: 'rgba(0,0,0,0.7)' } : { on: false, x: 0, y: 0, blur: 0, color: '#000' };
  return { ...T, box, stroke, shadow, animIn: p === 'pop' ? 'pop' : T.animIn };
}
function layoutText(c, T, W, u, content) {
  const size = T.size * u; c.font = fontCss(T, size);
  if ('letterSpacing' in c) c.letterSpacing = (T.letterSpacing * u) + 'px';
  const lines = wrapLines(c, content, T.width * W); const lh = size * T.lineHeight;
  const widths = lines.map((l) => c.measureText(l).width); const bw = Math.max(1, ...widths), bh = Math.max(lh, lines.length * lh);
  return { size, lines, widths, lh, bw, bh };
}
function textAnim(T, local, dur, W, H) {
  const o = { a: 1, dx: 0, dy: 0, s: 1, rot: 0 };
  const d = Math.max(0.05, T.animDur);
  const apply = (name, p) => {
    const e = ease('out', p);
    switch (name) {
      case 'fade': o.a *= p; break;
      case 'pop': o.s *= 0.6 + 0.4 * ease('spring', p); o.a *= Math.min(1, p * 3); break;
      case 'slideUp': o.dy += (1 - e) * 0.07; o.a *= p; break;
      case 'slideDown': o.dy -= (1 - e) * 0.07; o.a *= p; break;
      case 'slideLeft': o.dx += (1 - e) * 0.12; o.a *= p; break;
      case 'slideRight': o.dx -= (1 - e) * 0.12; o.a *= p; break;
      case 'zoom': o.s *= 1.5 - 0.5 * e; o.a *= p; break;
      default: break;
    }
  };
  if (T.animIn && T.animIn !== 'none') apply(T.animIn, clamp(local / d, 0, 1));
  if (T.animOut && T.animOut !== 'none') { const p = clamp((dur - local) / d, 0, 1); if (p < 1) { const s0 = { ...o, a: 1, dx: 0, dy: 0, s: 1 }; Object.assign(o, { a: o.a, dx: o.dx, dy: o.dy, s: o.s }); const keep = { a: o.a, dx: o.dx, dy: o.dy, s: o.s }; o.a = 1; o.dx = 0; o.dy = 0; o.s = 1; apply(T.animOut, p); o.a *= keep.a; o.dx += keep.dx; o.dy += keep.dy; o.s *= keep.s; void s0; } }
  if (T.animLoop === 'pulse') o.s *= 1 + 0.04 * Math.sin(local * Math.PI * 2 * 1.2);
  else if (T.animLoop === 'float') o.dy += Math.sin(local * Math.PI * 2 * 0.6) * 0.012;
  else if (T.animLoop === 'wiggle') o.rot += Math.sin(local * Math.PI * 2 * 2) * 2;
  else if (T.animLoop === 'shimmer') o.a *= 0.85 + 0.15 * Math.sin(local * Math.PI * 2 * 1.5);
  return o;
}
function roundRect(c, x, y, w, h, r) { r = Math.min(r, w / 2, h / 2); c.beginPath(); c.moveTo(x + r, y); c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r); c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath(); }
function textFill(c, T, bw, bh) {
  if (T.gradient && T.gradient.on) { const a = T.gradient.angle * Math.PI / 180; const dx = Math.cos(a) * bw / 2, dy = Math.sin(a) * bh / 2; const g = c.createLinearGradient(-dx, -dy, dx, dy); g.addColorStop(0, T.gradient.c1); g.addColorStop(1, T.gradient.c2); return g; }
  return T.color;
}
function drawText(c, W, H, u, clip, local) {
  const T = textStyleFor(clip); const content = T.content; if (!content) return null;
  const L = layoutText(c, T, W, u, content); const A = textAnim(T, local, clip.duration, W, H);
  const pad = T.box && T.box.on ? T.box.pad * u : 0;
  c.save();
  c.translate(A.dx * W, A.dy * H); if (A.rot) c.rotate(A.rot * Math.PI / 180); if (A.s !== 1) c.scale(A.s, A.s);
  c.globalAlpha *= clamp(A.a, 0, 1);
  if (T.box && T.box.on) {
    c.save(); c.globalAlpha *= T.box.alpha; c.fillStyle = T.box.color;
    if (T.shadow && T.shadow.on) { c.shadowColor = T.shadow.color; c.shadowBlur = T.shadow.blur * u; c.shadowOffsetX = T.shadow.x * u; c.shadowOffsetY = T.shadow.y * u; }
    roundRect(c, -L.bw / 2 - pad, -L.bh / 2 - pad, L.bw + pad * 2, L.bh + pad * 2, (T.box.radius || 0) * u); c.fill(); c.restore();
  }
  c.font = fontCss(T, L.size); c.textBaseline = 'middle'; c.textAlign = 'left';
  const lineX = (i) => (T.align === 'center' ? -L.widths[i] / 2 : T.align === 'left' ? -L.bw / 2 : L.bw / 2 - L.widths[i]);
  const fill = textFill(c, T, L.bw, L.bh);
  const shadowOn = T.shadow && T.shadow.on && !(T.box && T.box.on);
  const setShadow = () => { if (shadowOn) { c.shadowColor = T.shadow.color; c.shadowBlur = T.shadow.blur * u; c.shadowOffsetX = T.shadow.x * u; c.shadowOffsetY = T.shadow.y * u; } };
  const strokeW = T.stroke && T.stroke.w > 0 ? T.stroke.w * u * 2 : 0;
  const paintText = (txt, x, y, colour) => {
    if (strokeW) { c.save(); c.lineWidth = strokeW; c.lineJoin = 'round'; c.strokeStyle = T.stroke.color; c.strokeText(txt, x, y); c.restore(); }
    c.save(); setShadow(); c.fillStyle = colour == null ? fill : colour; c.fillText(txt, x, y); c.restore();
  };
  const mode = T.kinetic || 'none'; const isKaraoke = clip.kind === 'caption' && clip.cap && clip.cap.preset === 'karaoke';
  const spaceW = c.measureText(' ').width;
  const wordsOf = (i) => { const line = L.lines[i]; const ws = line.split(' ').filter((w) => w.length); let x = lineX(i); return ws.map((w) => { const wd = c.measureText(w).width; const it = { w, x, wd }; x += wd + spaceW; return it; }); };
  if (isKaraoke) {
    const dur = clip.cap.dur > 0 ? clip.cap.dur : clip.duration; const lead = clip.cap.dur > 0 ? clip.cap.lead : 0;
    const prog = clamp((local - lead) / Math.max(0.1, dur), 0, 1); const total = L.lines.join(' ').length || 1; let seen = 0;
    L.lines.forEach((ln, i) => {
      const y = -L.bh / 2 + L.lh * (i + 0.5);
      wordsOf(i).forEach((it) => { const mid = (seen + it.w.length / 2) / total; const active = prog > 0 && prog < 1 && Math.abs(mid - prog) < 0.5 / Math.max(3, total / 2.2); const col = active ? T.hl : (mid < prog ? T.color : 'rgba(255,255,255,0.6)'); paintText(it.w, it.x, y, col); seen += it.w.length + 1; });
    });
  } else if (mode === 'word' || mode === 'slideUp' || mode === 'letter') {
    let idx = 0; const dd = Math.max(0.25, T.animDur);
    L.lines.forEach((ln, i) => {
      const y = -L.bh / 2 + L.lh * (i + 0.5);
      wordsOf(i).forEach((it) => {
        const parts = mode === 'letter' ? [...it.w].map((ch, k, arr) => ({ t: ch, x: it.x + c.measureText(arr.slice(0, k).join('')).width, wd: c.measureText(ch).width })) : [{ t: it.w, x: it.x, wd: it.wd }];
        parts.forEach((pt) => {
          const p = clamp((local - idx * T.kStagger) / dd, 0, 1); idx++;
          if (p <= 0) return;
          c.save(); c.globalAlpha *= clamp(p * 2, 0, 1);
          const cx = pt.x + pt.wd / 2; c.translate(cx, y);
          if (mode === 'slideUp') c.translate(0, (1 - ease('out', p)) * L.size * 0.9);
          else { const s = mode === 'letter' ? 1.7 - 0.7 * ease('out', p) : 0.55 + 0.45 * ease('spring', p); c.scale(s, s); }
          paintText(pt.t, -pt.wd / 2, 0); c.restore();
        });
      });
    });
  } else if (mode === 'typewriter') {
    const n = Math.floor(local / Math.max(0.01, T.kStagger)); let left = n;
    L.lines.forEach((ln, i) => {
      const y = -L.bh / 2 + L.lh * (i + 0.5); const x = lineX(i);
      if (left <= 0) return; const take = Math.min(left, ln.length); left -= ln.length + 1;
      if (T.align === 'center') { const pre = ln.slice(0, take); c.textAlign = 'left'; paintText(pre, x, y); } else paintText(ln.slice(0, take), x, y);
    });
  } else {
    L.lines.forEach((ln, i) => { if (ln) paintText(ln, lineX(i), -L.bh / 2 + L.lh * (i + 0.5)); });
    if (mode === 'highlight') {
      const p = ease('inout', clamp((local - 0.2) / Math.max(0.4, T.animDur * 2 + 0.4), 0, 1));
      c.save(); c.beginPath(); c.rect(-L.bw / 2 - 4, -L.bh / 2 - 4, (L.bw + 8) * p, L.bh + 8); c.clip();
      L.lines.forEach((ln, i) => { if (ln) paintText(ln, lineX(i), -L.bh / 2 + L.lh * (i + 0.5), T.hl); }); c.restore();
    }
  }
  c.restore();
  return { w: L.bw + pad * 2, h: L.bh + pad * 2 };
}

// shapes and stickers
function starPath(c, rx, ry, n, inner) { c.beginPath(); for (let i = 0; i < n * 2; i++) { const a = -Math.PI / 2 + (i * Math.PI) / n; const r = i % 2 ? inner : 1; const x = Math.cos(a) * rx * r, y = Math.sin(a) * ry * r; if (i) c.lineTo(x, y); else c.moveTo(x, y); } c.closePath(); }
function polyPath(c, rx, ry, n) { c.beginPath(); for (let i = 0; i < n; i++) { const a = -Math.PI / 2 + (i * 2 * Math.PI) / n; const x = Math.cos(a) * rx, y = Math.sin(a) * ry; if (i) c.lineTo(x, y); else c.moveTo(x, y); } c.closePath(); }
function heartPath(c, w, h) { c.beginPath(); c.moveTo(0, h * 0.42); c.bezierCurveTo(-w * 0.1, h * 0.2, -w * 0.5, h * 0.05, -w * 0.5, -h * 0.2); c.bezierCurveTo(-w * 0.5, -h * 0.5, -w * 0.12, -h * 0.55, 0, -h * 0.28); c.bezierCurveTo(w * 0.12, -h * 0.55, w * 0.5, -h * 0.5, w * 0.5, -h * 0.2); c.bezierCurveTo(w * 0.5, h * 0.05, w * 0.1, h * 0.2, 0, h * 0.42); c.closePath(); }
function drawShape(c, W, H, u, clip) {
  const S = clip.shape; const w = S.w * u, h = S.h * u;
  c.save();
  let fill = S.fill;
  if (S.gradient && S.gradient.on) { const a = S.gradient.angle * Math.PI / 180; const dx = Math.cos(a) * w / 2, dy = Math.sin(a) * h / 2; const g = c.createLinearGradient(-dx, -dy, dx, dy); g.addColorStop(0, S.gradient.c1); g.addColorStop(1, S.gradient.c2); fill = g; }
  c.fillStyle = fill; c.strokeStyle = S.stroke; c.lineWidth = S.strokeW * u; c.globalAlpha *= S.fillAlpha;
  if (S.type === 'line') { c.lineCap = 'round'; c.strokeStyle = typeof fill === 'string' ? fill : S.fill; c.lineWidth = Math.max(1, h); c.beginPath(); c.moveTo(-w / 2, 0); c.lineTo(w / 2, 0); c.stroke(); c.restore(); return { w, h: Math.max(h, 4) }; }
  if (S.type === 'arrow') { const t = Math.max(2, h), head = t * 3; c.lineCap = 'round'; c.strokeStyle = typeof fill === 'string' ? fill : S.fill; c.lineWidth = t; c.beginPath(); c.moveTo(-w / 2, 0); c.lineTo(w / 2 - head * 0.6, 0); c.stroke(); c.fillStyle = c.strokeStyle; c.beginPath(); c.moveTo(w / 2, 0); c.lineTo(w / 2 - head, -head / 1.6); c.lineTo(w / 2 - head, head / 1.6); c.closePath(); c.fill(); c.restore(); return { w, h: head }; }
  if (S.type === 'ellipse') { c.beginPath(); c.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2); }
  else if (S.type === 'rounded') roundRect(c, -w / 2, -h / 2, w, h, S.radius * u);
  else if (S.type === 'star') starPath(c, w / 2, h / 2, S.points, S.inner);
  else if (S.type === 'polygon') polyPath(c, w / 2, h / 2, S.points);
  else { c.beginPath(); c.rect(-w / 2, -h / 2, w, h); }
  c.fill(); if (S.strokeW > 0) c.stroke();
  c.restore(); return { w, h };
}
const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif';
function drawSticker(c, W, H, u, clip, res) {
  const S = clip.sticker; const size = S.size * u;
  if (S.type === 'svg') { const im = res.svg(S.id, S.color); if (!im) return { w: size, h: size }; c.drawImage(im, -size / 2, -size / 2, size, size); return { w: size, h: size }; }
  c.font = `${size * 0.82}px ${EMOJI_FONT}`; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillStyle = '#000'; c.fillText(S.char || '⭐', 0, size * 0.04);
  return { w: size, h: size };
}

// masks: built on a separate canvas so feathering (a shadow trick that works in every browser) never disturbs the layer.
function maskPath(c, shape, cx, cy, w, h) {
  c.save(); c.translate(cx, cy);
  if (shape === 'ellipse') { c.beginPath(); c.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2); }
  else if (shape === 'heart') heartPath(c, w, h);
  else if (shape === 'star') starPath(c, w / 2, h / 2, 5, 0.45);
  else { c.beginPath(); c.rect(-w / 2, -h / 2, w, h); }
  c.restore();
}
function applyMask(c, box, mk, u, W, H) {
  const m = c.getTransform(); const M = acquire(W, H); const mx = M.getContext('2d');
  const f = mk.feather * u; const BIG = W * 3 + 2000;
  mx.setTransform(m.a, m.b, m.c, m.d, m.e - (f > 0 ? BIG : 0), m.f);
  if (f > 0) { mx.shadowColor = '#000'; mx.shadowBlur = f; mx.shadowOffsetX = BIG; }
  mx.fillStyle = '#000';
  mx.save(); maskPath(mx, mk.shape, mk.x * box.w, mk.y * box.h, mk.w * box.w, mk.h * box.h); mx.fill(); mx.restore();
  c.save(); c.setTransform(1, 0, 0, 1, 0, 0); c.globalCompositeOperation = mk.invert ? 'destination-out' : 'destination-in'; c.drawImage(M, 0, 0); c.restore();
  release(M);
}

// ───────── stabilisation, tracked points, cut-outs (all LOCAL; data lives on the clip) ─────────
const stabCache = new WeakMap();
// Correction for a stabilised clip at source time srcT: { dx, dy (picture widths), rot (radians), zoom } or null. The smoothing is
// recomputed only when the strength or the zoom limit changes.
export function stabCorr(clip, srcT) {
  const st = clip.stab; if (!st || !st.on || !st.raw || st.raw.length < 6) return null;
  let c = stabCache.get(st); const key = st.strength + '|' + (st.zoomMax || 1.3) + '|' + st.raw.length;
  if (!c || c.key !== key) {
    const n = st.raw.length / 3, dx = new Float64Array(n), dy = new Float64Array(n), rot = new Float64Array(n);
    for (let i = 0; i < n; i++) { dx[i] = st.raw[i * 3]; dy[i] = st.raw[i * 3 + 1]; rot[i] = st.raw[i * 3 + 2]; }
    c = { key, corr: correctionFromPath({ dx, dy, rot }, st.rate, st.strength == null ? 0.5 : st.strength, st.aspect || 1.78, st.zoomMax || 1.3) }; stabCache.set(st, c);
  }
  const i = (srcT - st.t0) * st.rate; return { dx: lerpAt(c.corr.dx, i), dy: lerpAt(c.corr.dy, i), rot: lerpAt(c.corr.rot, i), zoom: c.corr.zoom };
}
const clipMapCache = new WeakMap();
function clipOf(project, id) {
  let h = clipMapCache.get(project); if (!h || h.rev !== project._rev || h.n !== project.clips.length) { h = { rev: project._rev, n: project.clips.length, map: new Map(project.clips.map((c) => [c.id, c])) }; clipMapCache.set(project, h); }
  return h.map.get(id) || null;
}
// Where a point of the SOURCE picture (fractions 0..1) lands on the canvas, through crop, fit, stabilisation and the clip transform.
// Returns { x, y } as canvas pixels, or null when the picture is not available yet.
function sourceToCanvas(clip, local, fr, nx, ny, W, H) {
  const ref = videoRef(clip); const tf = effTransform(clip, local, null); const m = mediaDims(fr, W, H, clip.transform, clip.transform.fit); if (!m) return null;
  const [iw, ih] = srcSize(fr); let x = ((nx * iw - m.sx) / m.sw - 0.5) * m.dw, y = ((ny * ih - m.sy) / m.sh - 0.5) * m.dh;
  const sc = ref ? stabCorr(clip, srcTime(ref, local)) : null;
  if (sc) { x *= sc.zoom; y *= sc.zoom; const cs = Math.cos(sc.rot), sn = Math.sin(sc.rot); const rx = x * cs - y * sn, ry = x * sn + y * cs; x = rx + sc.dx * m.dw; y = ry + sc.dy * m.dw; }
  x *= tf.scale * (tf.flipX ? -1 : 1); y *= tf.scale * (tf.flipY ? -1 : 1);
  if (tf.rotation) { const a = tf.rotation * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a); const rx = x * cs - y * sn, ry = x * sn + y * cs; x = rx; y = ry; }
  return { x: W / 2 + tf.x * W + x, y: H / 2 + tf.y * H + y };
}
// The inverse: a canvas pixel -> a point of the source picture (fractions). Used to pick a point to track on the preview.
export function canvasToSource(clip, local, fr, px, py, W, H) {
  const ref = videoRef(clip); const tf = effTransform(clip, local, null); const m = mediaDims(fr, W, H, clip.transform, clip.transform.fit); if (!m) return null;
  let x = px - W / 2 - tf.x * W, y = py - H / 2 - tf.y * H;
  if (tf.rotation) { const a = -tf.rotation * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a); const rx = x * cs - y * sn, ry = x * sn + y * cs; x = rx; y = ry; }
  x /= tf.scale * (tf.flipX ? -1 : 1) || 1; y /= tf.scale * (tf.flipY ? -1 : 1) || 1;
  const sc = ref ? stabCorr(clip, srcTime(ref, local)) : null;
  if (sc) { x -= sc.dx * m.dw; y -= sc.dy * m.dw; const a = -sc.rot, cs = Math.cos(a), sn = Math.sin(a); const rx = x * cs - y * sn, ry = x * sn + y * cs; x = rx / sc.zoom; y = ry / sc.zoom; }
  const [iw, ih] = srcSize(fr);
  return { x: ((x / m.dw + 0.5) * m.sw + m.sx) / iw, y: ((y / m.dh + 0.5) * m.sh + m.sy) / ih };
}
// A tracker's point on the canvas, in pixels, at absolute project time t.
export function trackedCanvasPoint(project, srcClip, trackId, absT, W, H, res) {
  const tr = (srcClip.tracks || []).find((x) => x.id === trackId); const ref = videoRef(srcClip); if (!tr || !ref) return null;
  const local = clamp(absT - srcClip.start, 0, srcClip.duration), srcT = srcTime(ref, local); const pt = trackAt(tr, srcT); if (!pt) return null;
  const fr = res.frame(ref, srcT); if (!fr) return null; return sourceToCanvas(srcClip, local, fr, pt.x, pt.y, W, H);
}
export function trackedPoints(project, clip, local, W, H, res) {
  const out = []; for (const tr of clip.tracks || []) { const p = trackedCanvasPoint(project, clip, tr.id, clip.start + local, W, H, res); if (p) out.push({ id: tr.id, name: tr.name, x: p.x, y: p.y }); } return out;
}

function effTransform(clip, local, ctx) {
  const t = clip.transform; const tf = { x: valueAt(clip, 'transform.x', local), y: valueAt(clip, 'transform.y', local), scale: valueAt(clip, 'transform.scale', local), rotation: valueAt(clip, 'transform.rotation', local), flipX: t.flipX, flipY: t.flipY };
  // A clip attached to a tracked point: its Position values become an offset from that point.
  if (ctx && clip.follow) {
    const src = clipOf(ctx.project, clip.follow.clipId);
    if (src && src.id !== clip.id) { const p = trackedCanvasPoint(ctx.project, src, clip.follow.trackId, clip.start + local, ctx.W, ctx.H, ctx.res); if (p) { tf.x += p.x / ctx.W - 0.5; tf.y += p.y / ctx.H - 0.5; } }
  }
  for (const fx of clip.effects || []) {
    if (fx.type === 'shake') { tf.x += Math.sin(local * 47.3) * Math.cos(local * 31.7) * fx.amount; tf.y += Math.cos(local * 39.1) * Math.sin(local * 53.9) * fx.amount; }
    else if (fx.type === 'pulse') tf.scale *= 1 + fx.amount * 0.5 * (1 + Math.sin(local * Math.PI * 2 * 2));
  }
  return tf;
}

const capCache = new WeakMap();
function captionLinks(project) {
  const hit = capCache.get(project); if (hit && hit.rev === project._rev && hit.n === project.clips.length) return hit.set;
  const hidden = new Set(project.tracks.filter((t) => t.hidden).map((t) => t.id)); const set = new Set();
  project.clips.forEach((c) => { if (c.kind === 'caption' && c.link && !hidden.has(c.trackId)) set.add(c.link); });
  capCache.set(project, { rev: project._rev, n: project.clips.length, set }); return set;
}

// Keeps only the subject: the matte is laid over the picture the same way the picture was drawn (same crop, fit, stabilisation). Only
// called when the clip is drawn on its own layer (needsLayer is true whenever a cut-out is active), so nothing else is erased.
function applyMatte(c, clip, srcT, src, W, H) {
  const m = mediaDims(src, W, H, clip.transform, clip.transform.fit); const mc = m && matteCanvas(clip, srcT); if (!mc) return;
  const cr = clip.transform.crop, S = MATTE_SIZE;
  c.save(); c.globalCompositeOperation = 'destination-in'; c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
  c.drawImage(mc, cr.l * S, cr.t * S, S * (1 - cr.l - cr.r), S * (1 - cr.t - cr.b), -m.dw / 2, -m.dh / 2, m.dw, m.dh); c.restore();
}

function drawContent(c, W, H, u, project, clip, local, res, tf, adj) {
  c.save();
  c.translate(W / 2 + tf.x * W, H / 2 + tf.y * H);
  if (tf.rotation) c.rotate(tf.rotation * Math.PI / 180);
  c.scale(tf.scale * (tf.flipX ? -1 : 1), tf.scale * (tf.flipY ? -1 : 1));
  let box = null;
  const k = clip.kind;
  if (k === 'image') { const im = res.image(clip.assetId); if (im) { box = drawMedia(c, im, W, H, clip.transform); if (box && bgActive(clip)) applyMatte(c, clip, 0, im, W, H); } }
  else if (k === 'video') {
    const ref = videoRef(clip); const st = ref ? srcTime(ref, local) : 0; const fr = ref && res.frame(ref, st);
    if (fr) {
      const sc = stabCorr(clip, st);
      if (sc) { const m = mediaDims(fr, W, H, clip.transform, clip.transform.fit); if (m) { c.translate(sc.dx * m.dw, sc.dy * m.dw); c.rotate(sc.rot); c.scale(sc.zoom, sc.zoom); } }
      box = drawMedia(c, fr, W, H, clip.transform);
      if (box && bgActive(clip)) applyMatte(c, clip, st, fr, W, H);
    }
  }
  else if (k === 'scene') {
    const ref = videoRef(clip); const sc = clip.scene;
    c.translate(-W / 2, -H / 2);
    drawSceneCore(c, W, H, sc, local, clip.duration, project.style, captionLinks(project).has(clip.id), { get: (id) => res.image(id) }, ref ? () => res.frame(ref, srcTime(ref, local)) : null);
    c.translate(W / 2, H / 2); box = { w: W, h: H };
  } else if (k === 'text' || k === 'caption') box = drawText(c, W, H, u, clip, local);
  else if (k === 'shape') box = drawShape(c, W, H, u, clip);
  else if (k === 'sticker') box = drawSticker(c, W, H, u, clip, res);
  const mk = clip.transform.mask;
  if (box && mk && mk.shape !== 'none') applyMask(c, box, mk, u, W, H);
  c.restore();
  return box;
}

function needsLayer(clip, adj, extraBlur) {
  const mk = clip.transform.mask;
  return !!((mk && mk.shape !== 'none') || bgActive(clip) || (clip.chroma && clip.chroma.on) || (clip.effects && clip.effects.some((e) => e.type !== 'shake' && e.type !== 'pulse')) || clip.blend !== 'normal' || adjActive(adj) || extraBlur > 0.5);
}

function drawClip(ctx, W, H, u, project, clip, local, res, mods) {
  const opac = valueAt(clip, 'opacity', local); if (opac <= 0.001) return;
  const sts = mods && mods.length ? mods.map(modState) : null;
  let alpha = 1, blur = 0, flash = 0;
  if (sts) for (const s of sts) { alpha *= s.alpha; blur += s.blur; flash = Math.max(flash, s.flash); }
  if (alpha > 0.001) {
    const tf = effTransform(clip, local, { project, W, H, res }); const adj = effAdjust(clip, local);
    if (!needsLayer(clip, adj, blur)) {
      ctx.save(); applyMods(ctx, W, H, sts); ctx.globalAlpha *= opac * alpha;
      drawContent(ctx, W, H, u, project, clip, local, res, tf, adj); ctx.restore();
    } else {
      const L = acquire(W, H); const lc = L.getContext('2d');
      drawContent(lc, W, H, u, project, clip, local, res, tf, adj);
      const css = processLayer(L, lc, W, H, u, clip, local, adj);
      ctx.save(); applyMods(ctx, W, H, sts); ctx.globalAlpha *= opac * alpha; ctx.globalCompositeOperation = BLEND[clip.blend] || 'source-over';
      const f = (css + (blur > 0.5 ? ` blur(${(blur * u).toFixed(1)}px)` : '')).trim();
      if (f && supportsFilter()) ctx.filter = f;
      ctx.drawImage(L, 0, 0); ctx.restore(); release(L);
    }
  }
  if (flash > 0.01) { ctx.save(); ctx.globalAlpha = clamp(flash, 0, 1); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); ctx.restore(); }
}

// Effect and adjustment layers act on everything drawn beneath them.
function drawLayerClip(ctx, W, H, u, clip, local) {
  const opac = valueAt(clip, 'opacity', local); if (opac <= 0.001) return;
  const adj = clip.kind === 'adjustment' ? effAdjust(clip, local) : effAdjust({ ...clip, filter: 'none', adjust: {}, keyframes: {} }, local);
  const L = acquire(W, H); const lc = L.getContext('2d'); lc.drawImage(ctx.canvas, 0, 0, W, H);
  const css = processLayer(L, lc, W, H, u, { ...clip, chroma: { on: false } }, local, adj);
  ctx.save(); ctx.globalAlpha = opac; if (css && supportsFilter()) ctx.filter = css; ctx.drawImage(L, 0, 0); ctx.restore(); release(L);
}

export function drawFrame(ctx, W, H, project, t, res, opts = {}) {
  const u = Math.min(W, H) / 1080;
  ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; if (ctx.filter !== undefined) ctx.filter = 'none';
  ctx.shadowColor = 'rgba(0,0,0,0)'; ctx.fillStyle = project.settings.bg || '#000'; ctx.fillRect(0, 0, W, H);
  const idx = trackIndex(project);
  for (let i = project.tracks.length - 1; i >= 0; i--) {
    const tr = project.tracks[i]; if (tr.type === 'audio' || tr.hidden) continue;
    if (tr.type === 'caption' && opts.burnCaptions === false) continue;
    const list = idx.get(tr.id); if (!list || !list.length) continue;
    const jobs = trackJobs(list, t);
    for (const j of jobs) {
      if (j.clip.kind === 'effect' || j.clip.kind === 'adjustment') drawLayerClip(ctx, W, H, u, j.clip, j.local);
      else drawClip(ctx, W, H, u, project, j.clip, j.local, res, j.mods);
    }
  }
  ctx.restore();
}

// ───────── geometry for the on-canvas handles ─────────
function baseBox(project, clip, local, W, H, u, res) {
  const k = clip.kind;
  if (k === 'image') { const im = res.image(clip.assetId); const m = im && mediaDims(im, W, H, clip.transform, clip.transform.fit); return m ? { w: clip.transform.fit === 'fill' || clip.transform.fit === 'fitblur' ? W : m.dw, h: clip.transform.fit === 'fill' || clip.transform.fit === 'fitblur' ? H : m.dh } : null; }
  if (k === 'video') { const ref = videoRef(clip); const fr = ref && res.frame(ref, srcTime(ref, local)); const m = fr && mediaDims(fr, W, H, clip.transform, clip.transform.fit); return m ? { w: clip.transform.fit === 'fill' || clip.transform.fit === 'fitblur' ? W : m.dw, h: clip.transform.fit === 'fill' || clip.transform.fit === 'fitblur' ? H : m.dh } : { w: W, h: H }; }
  if (k === 'scene') return { w: W, h: H };
  if (k === 'text' || k === 'caption') { const T = textStyleFor(clip); const c = mctx(); const L = layoutText(c, T, W, u, T.content || ' '); const pad = T.box && T.box.on ? T.box.pad * u : 0; return { w: L.bw + pad * 2, h: L.bh + pad * 2 }; }
  if (k === 'shape') { const S = clip.shape; return { w: S.w * u, h: Math.max(S.h * u, S.type === 'arrow' ? S.h * u * 3 : 4) }; }
  if (k === 'sticker') return { w: clip.sticker.size * u, h: clip.sticker.size * u };
  return null;
}
// Box of a clip on the canvas in canvas pixels: centre, size and rotation (degrees). null for audio-only and layer clips.
export function clipBox(project, clip, local, W, H, res) {
  const u = Math.min(W, H) / 1080; const b = baseBox(project, clip, local, W, H, u, res); if (!b) return null;
  const tf = effTransform(clip, local, { project, W, H, res });
  return { cx: W / 2 + tf.x * W, cy: H / 2 + tf.y * H, w: b.w * tf.scale, h: b.h * tf.scale, rot: tf.rotation, bw: b.w, bh: b.h };
}
// Topmost clip under a canvas point at time t.
export function hitTest(project, t, res, W, H, px, py) {
  const jobs = activeJobs(project, t);
  for (let i = jobs.length - 1; i >= 0; i--) {
    const c = jobs[i].clip; if (c.kind === 'effect' || c.kind === 'adjustment') continue;
    const b = clipBox(project, c, jobs[i].local, W, H, res); if (!b) continue;
    const a = -b.rot * Math.PI / 180; const dx = px - b.cx, dy = py - b.cy; const x = dx * Math.cos(a) - dy * Math.sin(a), y = dx * Math.sin(a) + dy * Math.cos(a);
    if (Math.abs(x) <= b.w / 2 && Math.abs(y) <= b.h / 2) return c;
  }
  return null;
}
