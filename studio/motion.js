// studio/motion.js
// Video stabilisation and motion tracking maths. LOCAL, plain JavaScript, no model, no WebAssembly, no network.
// Frames arrive as 8-bit grey images ({ w, h, d: Uint8Array }). Nothing here touches the DOM, so it is tested in Node.
//
// Stabilisation: for every pair of neighbouring frames, a grid of blocks is matched (coarse search on a half-size picture, then a
// fine search, then a sub-pixel step). Blocks on flat areas are ignored. The block vectors are reduced to a robust shift and a small
// rotation (outliers such as a person walking through the shot are thrown away). The shifts are added up into the camera path,
// the path is smoothed with a Gaussian, and the difference between smooth and raw is the correction applied to each frame.
// Tracking: a small patch around the chosen point is searched for in each next frame (sum of absolute differences, sub-pixel,
// slowly adapting patch), forwards and backwards from the frame the user picked.

export const clamp = (n, a, b) => Math.min(b, Math.max(a, n));

// RGBA -> grey, optionally downscaled by an integer-free box average to width tw.
export function toGrey(rgba, sw, sh, tw) {
  const th = Math.max(1, Math.round((sh * tw) / sw)); const d = new Uint8Array(tw * th);
  if (tw === sw && th === sh) { for (let i = 0, p = 0; i < d.length; i++, p += 4) d[i] = (rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29) >> 8; return { w: tw, h: th, d }; }
  for (let y = 0; y < th; y++) {
    const y0 = Math.floor((y * sh) / th), y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / th));
    for (let x = 0; x < tw; x++) {
      const x0 = Math.floor((x * sw) / tw), x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / tw)); let s = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const p = (yy * sw + xx) * 4; s += rgba[p] * 77 + rgba[p + 1] * 150 + rgba[p + 2] * 29; n++; }
      d[y * tw + x] = (s / n) >> 8;
    }
  }
  return { w: tw, h: th, d };
}

function half(g) {
  const w = g.w >> 1, h = g.h >> 1, d = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = y * 2 * g.w + x * 2; d[y * w + x] = (g.d[i] + g.d[i + 1] + g.d[i + g.w] + g.d[i + g.w + 1]) >> 2; }
  return { w, h, d };
}

// Sum of absolute differences of a bs x bs block of A at (x,y) against B at (x+dx,y+dy). Caller guarantees bounds.
function sad(A, B, x, y, dx, dy, bs, best) {
  let s = 0; const w = A.w;
  for (let j = 0; j < bs; j++) {
    let ia = (y + j) * w + x, ib = (y + j + dy) * w + x + dx;
    for (let i = 0; i < bs; i++, ia++, ib++) { const v = A.d[ia] - B.d[ib]; s += v < 0 ? -v : v; }
    if (s >= best) return s;
  }
  return s;
}
function blockVariance(g, x, y, bs) {
  let s = 0, s2 = 0; const n = bs * bs;
  for (let j = 0; j < bs; j++) for (let i = 0; i < bs; i++) { const v = g.d[(y + j) * g.w + x + i]; s += v; s2 += v * v; }
  return s2 / n - (s / n) * (s / n);
}
// Best integer displacement of block (x,y) in A within +-R pixels of (cx,cy), with a sub-pixel parabola step. Returns { dx, dy, cost }.
function matchBlock(A, B, x, y, bs, R, cx, cy) {
  let best = Infinity, bx = 0, by = 0; const costs = new Map();
  for (let dy = cy - R; dy <= cy + R; dy++) {
    if (y + dy < 0 || y + dy + bs > B.h) continue;
    for (let dx = cx - R; dx <= cx + R; dx++) {
      if (x + dx < 0 || x + dx + bs > B.w) continue;
      const c = sad(A, B, x, y, dx, dy, bs, Infinity); costs.set(dx + ',' + dy, c);
      if (c < best) { best = c; bx = dx; by = dy; }
    }
  }
  if (best === Infinity) return null;
  const f = (dx, dy) => { const c = costs.get(dx + ',' + dy); return c === undefined ? null : c; };
  let sx = 0, sy = 0; const l = f(bx - 1, by), r = f(bx + 1, by), u = f(bx, by - 1), d = f(bx, by + 1);
  if (l !== null && r !== null) { const den = l - 2 * best + r; if (den > 0) sx = clamp((l - r) / (2 * den), -0.5, 0.5); }
  if (u !== null && d !== null) { const den = u - 2 * best + d; if (den > 0) sy = clamp((u - d) / (2 * den), -0.5, 0.5); }
  return { dx: bx + sx, dy: by + sy, cost: best / (bs * bs) };
}

const median = (a) => { if (!a.length) return 0; const s = a.slice().sort((p, q) => p - q), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Global motion of the picture from frame A to frame B: how far the CONTENT moved. Returns { dx, dy, rot, n } in pixels and radians
// (canvas convention: positive rot is clockwise), or { dx:0, dy:0, rot:0, n:0 } when there was not enough texture to tell.
export function estimateMotion(A, B, opts = {}) {
  const bs = opts.block || 16, cols = opts.cols || 7, rows = opts.rows || 5, R = opts.radius || 10, minVar = opts.minVar || 40;
  const hA = half(A), hB = half(B), hb = bs >> 1, hR = Math.ceil(R / 2);
  const vecs = [];
  const mx = Math.ceil(R + 2), my = Math.ceil(R + 2);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x = Math.round(mx + ((A.w - 2 * mx - bs) * (c + 0.5)) / cols), y = Math.round(my + ((A.h - 2 * my - bs) * (r + 0.5)) / rows);
    if (x < 0 || y < 0 || x + bs > A.w || y + bs > A.h) continue;
    if (blockVariance(A, x, y, bs) < minVar) continue;
    const co = matchBlock(hA, hB, x >> 1, y >> 1, hb, hR, 0, 0); if (!co) continue;
    const fi = matchBlock(A, B, x, y, bs, 2, Math.round(co.dx * 2), Math.round(co.dy * 2)); if (!fi) continue;
    vecs.push({ px: x + bs / 2 - A.w / 2, py: y + bs / 2 - A.h / 2, vx: fi.dx, vy: fi.dy, cost: fi.cost });
  }
  if (vecs.length < 4) return { dx: 0, dy: 0, rot: 0, n: 0 };
  // reject outliers around the median vector, then fit shift + rotation to what is left
  let mvx = median(vecs.map((v) => v.vx)), mvy = median(vecs.map((v) => v.vy));
  let keep = vecs.filter((v) => Math.hypot(v.vx - mvx, v.vy - mvy) <= 2.5);
  if (keep.length < 4) keep = vecs.filter((v) => Math.hypot(v.vx - mvx, v.vy - mvy) <= 5);
  if (keep.length < 3) return { dx: mvx, dy: mvy, rot: 0, n: keep.length };
  let tx = 0, ty = 0; keep.forEach((v) => { tx += v.vx; ty += v.vy; }); tx /= keep.length; ty /= keep.length;
  let num = 0, den = 0, cx = 0, cy = 0; keep.forEach((v) => { cx += v.px; cy += v.py; }); cx /= keep.length; cy /= keep.length;
  keep.forEach((v) => { const px = v.px - cx, py = v.py - cy; num += -py * (v.vx - tx) + px * (v.vy - ty); den += px * px + py * py; });
  const rot = den > 1e-6 ? clamp(num / den, -0.05, 0.05) : 0;
  // translation of the frame centre = mean vector minus the rotation's contribution at the mean position
  const dx = tx - rot * -cy, dy = ty - rot * cx;
  return { dx, dy, rot, n: keep.length };
}

// Frame list -> raw camera path. Returns { dx:[], dy:[], rot:[] } with one entry per frame (entry 0 is 0), in picture widths and radians.
export function cameraPath(frames, opts = {}) {
  const n = frames.length, dx = new Float64Array(n), dy = new Float64Array(n), rot = new Float64Array(n); const w = frames[0].w;
  for (let i = 1; i < n; i++) {
    const m = estimateMotion(frames[i - 1], frames[i], opts);
    dx[i] = dx[i - 1] + m.dx / w; dy[i] = dy[i - 1] + m.dy / w; rot[i] = rot[i - 1] + m.rot;
  }
  return { dx, dy, rot };
}

export function gaussianSmooth(arr, sigma) {
  const n = arr.length, out = new Float64Array(n); if (sigma < 0.3 || n < 3) { out.set(arr); return out; }
  const rad = Math.ceil(sigma * 3), k = new Float64Array(rad * 2 + 1); let ks = 0;
  for (let i = -rad; i <= rad; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); k[i + rad] = v; ks += v; }
  // Beyond the ends the path is continued along a straight line fitted to the nearest samples, so a steady pan keeps its slope and
  // jitter right at the first or last frame does not bend the result.
  const m = clamp(Math.round(sigma * 1.5), 6, Math.max(6, n >> 1)), fit = (from) => { let sx = 0, sy = 0, sxy = 0, sxx = 0; for (let i = 0; i < m; i++) { const x = from + i; sx += x; sy += arr[x]; sxy += x * arr[x]; sxx += x * x; } const den = m * sxx - sx * sx, b = den ? (m * sxy - sx * sy) / den : 0; return { a: (sy - b * sx) / m, b }; };
  const L0 = fit(0), L1 = fit(Math.max(0, n - m));
  const at = (t) => (t < 0 ? L0.a + L0.b * t : t >= n ? L1.a + L1.b * t : arr[t]);
  for (let i = 0; i < n; i++) { let sum = 0; for (let j = -rad; j <= rad; j++) sum += at(i + j) * k[j + rad]; out[i] = sum / ks; }
  return out;
}

// strength 0..1 -> smoothing window in seconds (0.1 s .. 2.5 s). Returns per-sample corrections plus the zoom needed to hide the edges.
export function correctionFromPath(path, rate, strength, aspect, maxZoom = 1.3) {
  const sec = 0.1 + clamp(strength, 0, 1) * 2.4, sigma = sec * rate; const n = path.dx.length;
  const sdx = gaussianSmooth(path.dx, sigma), sdy = gaussianSmooth(path.dy, sigma), srot = gaussianSmooth(path.rot, sigma);
  const cdx = new Float64Array(n), cdy = new Float64Array(n), crot = new Float64Array(n);
  let need = 1; const asp = Math.max(aspect, 1 / aspect);
  for (let i = 0; i < n; i++) {
    cdx[i] = sdx[i] - path.dx[i]; cdy[i] = sdy[i] - path.dy[i]; crot[i] = srot[i] - path.rot[i];
    // dy is stored in picture WIDTHS; the corner check is done in picture heights below
    const s = 1 + 2 * Math.max(Math.abs(cdx[i]), Math.abs(cdy[i]) * aspect) + Math.abs(crot[i]) * asp; if (s > need) need = s;
  }
  let f = 1; if (need > maxZoom) { f = (maxZoom - 1) / (need - 1); for (let i = 0; i < n; i++) { cdx[i] *= f; cdy[i] *= f; crot[i] *= f; } need = maxZoom; }
  return { dx: cdx, dy: cdy, rot: crot, zoom: need, limited: f < 1 };
}

// Interpolated sample of a numeric series at fractional index.
export function lerpAt(arr, idx) {
  if (!arr.length) return 0; if (idx <= 0) return arr[0]; if (idx >= arr.length - 1) return arr[arr.length - 1];
  const i = Math.floor(idx), f = idx - i; return arr[i] * (1 - f) + arr[i + 1] * f;
}

// ───────── tracking ─────────
function patchOf(g, cx, cy, r) {
  const n = r * 2 + 1, d = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) d[j * n + i] = g.d[(Math.round(cy) - r + j) * g.w + Math.round(cx) - r + i];
  return { n, d };
}
function patchSad(T, g, x, y, r, best) {
  let s = 0; const n = T.n;
  for (let j = 0; j < n; j++) {
    let ig = (y - r + j) * g.w + x - r, it = j * n;
    for (let i = 0; i < n; i++, ig++, it++) { const v = g.d[ig] - T.d[it]; s += v < 0 ? -v : v; }
    if (s >= best) return s;
  }
  return s;
}
// One step: where did the patch go in grey image g, searching +-S around (px,py)? Returns { x, y, cost } (cost = mean abs difference) or null.
export function findPatch(T, g, px, py, r, S) {
  const x0 = Math.round(px), y0 = Math.round(py); let best = Infinity, bx = x0, by = y0; const costs = new Map();
  for (let y = y0 - S; y <= y0 + S; y++) {
    if (y - r < 0 || y + r >= g.h) continue;
    for (let x = x0 - S; x <= x0 + S; x++) {
      if (x - r < 0 || x + r >= g.w) continue;
      const c = patchSad(T, g, x, y, r, Infinity); costs.set(x + ',' + y, c); if (c < best) { best = c; bx = x; by = y; }
    }
  }
  if (best === Infinity) return null;
  const f = (x, y) => { const c = costs.get(x + ',' + y); return c === undefined ? null : c; };
  let sx = 0, sy = 0; const l = f(bx - 1, by), rr = f(bx + 1, by), u = f(bx, by - 1), d = f(bx, by + 1);
  if (l !== null && rr !== null) { const den = l - 2 * best + rr; if (den > 0) sx = clamp((l - rr) / (2 * den), -0.5, 0.5); }
  if (u !== null && d !== null) { const den = u - 2 * best + d; if (den > 0) sy = clamp((u - d) / (2 * den), -0.5, 0.5); }
  return { x: bx + sx, y: by + sy, cost: best / (T.n * T.n) };
}

// frames: grey images (all the same size). start: index of the frame the point was picked on. (x,y): the point in pixels on that frame.
// Returns [{ x, y, ok }] with x,y as fractions of the picture (0..1), one per frame, both directions from `start`. A frame where the
// point could not be found repeats the last known place and has ok=false; tracking tries again on the next frame with a wider search.
export function trackPoint(frames, start, x, y, opts = {}) {
  const w = frames[0].w, h = frames[0].h, r = opts.radius || Math.max(6, Math.round(w * 0.04)), S = opts.search || Math.max(8, Math.round(w * 0.05));
  const out = new Array(frames.length);
  const px0 = clamp(x, r + 1, w - r - 2), py0 = clamp(y, r + 1, h - r - 2);
  out[start] = { x: px0 / w, y: py0 / h, ok: true };
  // A match is believed only when it is much better than chance for THIS patch: relative to how much texture the patch has.
  const T0 = patchOf(frames[start], px0, py0, r); let tm = 0; for (let k = 0; k < T0.d.length; k++) tm += T0.d[k]; tm /= T0.d.length; let tv = 0; for (let k = 0; k < T0.d.length; k++) tv += Math.abs(T0.d[k] - tm); tv /= T0.d.length;
  const maxCost = opts.maxCost || 0.5 * tv + 2;
  const flatPatch = tv < 3; // nothing to lock onto
  if (flatPatch) { for (let i = 0; i < frames.length; i++) if (i !== start) out[i] = { x: px0 / w, y: py0 / h, ok: false }; return out; }
  const run = (from, to, step) => {
    let T = patchOf(frames[start], px0, py0, r), cx = px0, cy = py0, miss = 0;
    for (let i = from; step > 0 ? i <= to : i >= to; i += step) {
      const wide = S * (1 + Math.min(miss, 3));
      const m = findPatch(T, frames[i], cx, cy, r, wide);
      if (m && m.cost <= maxCost) {
        cx = m.x; cy = m.y; miss = 0; out[i] = { x: cx / w, y: cy / h, ok: true };
        const nt = patchOf(frames[i], cx, cy, r); for (let k = 0; k < T.d.length; k++) T.d[k] = T.d[k] * 0.85 + nt.d[k] * 0.15; // adapt slowly to lighting and turning
      } else { miss++; out[i] = { x: cx / w, y: cy / h, ok: false }; }
    }
  };
  if (start + 1 < frames.length) run(start + 1, frames.length - 1, 1);
  if (start - 1 >= 0) run(start - 1, 0, -1);
  return out;
}

// Reads a track { t0, rate, pts:[x0,y0,x1,y1,...] } at source time t. Returns { x, y } as picture fractions.
export function trackAt(track, t) {
  const n = track.pts.length / 2; if (!n) return null;
  const idx = clamp((t - track.t0) * track.rate, 0, n - 1), i = Math.floor(idx), f = idx - i, j = Math.min(n - 1, i + 1);
  return { x: track.pts[i * 2] * (1 - f) + track.pts[j * 2] * f, y: track.pts[i * 2 + 1] * (1 - f) + track.pts[j * 2 + 1] * f };
}
