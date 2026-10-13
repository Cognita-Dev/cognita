// Stabilisation and tracking maths against synthetic footage with known ground truth. Run: node tests/studio-motion.test.mjs
import * as MO from '../studio/motion.js';
let fails = 0; const ok = (n, c, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + n + (d !== '' ? ' :: ' + d : '')); if (!c) fails++; };
let seed = 12345; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
// a textured "world" (soft blobs + hard edges), larger than the frame
const WW = 700, WH = 500, world = new Float32Array(WW * WH);
for (let k = 0; k < 260; k++) { const cx = rnd() * WW, cy = rnd() * WH, r = 4 + rnd() * 26, a = (rnd() - 0.5) * 220; const x0 = Math.max(0, cx - r * 2 | 0), x1 = Math.min(WW - 1, cx + r * 2 | 0), y0 = Math.max(0, cy - r * 2 | 0), y1 = Math.min(WH - 1, cy + r * 2 | 0); for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) world[y * WW + x] += a * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (2 * r * r)); }
for (let k = 0; k < 40; k++) { const x = rnd() * WW | 0, y = rnd() * WH | 0, w = 10 + rnd() * 60 | 0, h = 6 + rnd() * 40 | 0, a = (rnd() - 0.5) * 160; for (let j = 0; j < h && y + j < WH; j++) for (let i = 0; i < w && x + i < WW; i++) world[(y + j) * WW + x + i] += a; }
const samp = (x, y) => { x = Math.min(WW - 2, Math.max(0, x)); y = Math.min(WH - 2, Math.max(0, y)); const i = x | 0, j = y | 0, fx = x - i, fy = y - j; const a = world[j * WW + i], b = world[j * WW + i + 1], c = world[(j + 1) * WW + i], d = world[(j + 1) * WW + i + 1]; return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy; };
const FW = 256, FH = 144;
function frame(ox, oy, rot = 0, mover = null) {
  const d = new Uint8Array(FW * FH), cx = FW / 2, cy = FH / 2, cs = Math.cos(rot), sn = Math.sin(rot);
  for (let y = 0; y < FH; y++) for (let x = 0; x < FW; x++) { const px = x - cx, py = y - cy; const wx = 220 + cx + px * cs - py * sn + ox, wy = 180 + cy + px * sn + py * cs + oy; let v = 128 + samp(wx, wy) * 0.8; if (mover && Math.abs(x - mover.x) < 14 && Math.abs(y - mover.y) < 14) v = 230 - ((x + y) % 7) * 20; d[y * FW + x] = Math.max(0, Math.min(255, v)); }
  return { w: FW, h: FH, d };
}
// 1. shake with sub-pixel jitter, a slow pan and a small roll
const N = 60, truth = [], frames = [];
for (let i = 0; i < N; i++) { const pan = i * 0.6, jx = 5 * Math.sin(i * 1.9) + 3 * Math.sin(i * 4.3 + 1), jy = 4 * Math.cos(i * 2.3) + 2 * Math.sin(i * 5.1), jr = 0.012 * Math.sin(i * 1.3); truth.push({ ox: pan + jx, oy: jy, rot: jr }); frames.push(frame(pan + jx, jy, jr, { x: 40 + i * 3, y: 100 })); }
const path = MO.cameraPath(frames);
let errX = 0, errY = 0, errR = 0;
for (let i = 1; i < N; i++) { errX += (path.dx[i] * FW - (-(truth[i].ox - truth[0].ox))) ** 2; errY += (path.dy[i] * FW - (-(truth[i].oy - truth[0].oy))) ** 2; errR += (path.rot[i] - (-(truth[i].rot - truth[0].rot))) ** 2; }
errX = Math.sqrt(errX / (N - 1)); errY = Math.sqrt(errY / (N - 1)); errR = Math.sqrt(errR / (N - 1));
console.log('path error (px): x', errX.toFixed(2), 'y', errY.toFixed(2), ' rot (rad)', errR.toFixed(4));
ok('estimated camera path follows the true shake (RMS under 2.5 px over 60 frames, with a moving object in view)', errX < 2.5 && errY < 2.5, `${errX.toFixed(2)} / ${errY.toFixed(2)}`);
// slow drift is intended camera motion to a stabiliser; what matters is that the jitter (high-frequency part) is recovered
const hp = (arr) => { const sm = MO.gaussianSmooth(Float64Array.from(arr), 4); return Array.from(arr).map((v, i) => v - sm[i]); };
const trueRot = truth.map((tr) => -(tr.rot - truth[0].rot)); const hpEst = hp(path.rot), hpTrue = hp(trueRot);
let rj = 0, rt = 0; for (let i = 2; i < N - 2; i++) { rj += (hpEst[i] - hpTrue[i]) ** 2; rt += hpTrue[i] ** 2; }
ok('rotation jitter recovered with the right sign (error under 45% of the signal)', Math.sqrt(rj / rt) < 0.45, 'relative error ' + Math.sqrt(rj / rt).toFixed(2));
// 2. correction removes the jitter but keeps the pan
const rate = 30; const corr = MO.correctionFromPath(path, rate, 0.5, FW / FH);
const jit = (arr) => { let s = 0; for (let i = 2; i < arr.length; i++) { const a = arr[i] - 2 * arr[i - 1] + arr[i - 2]; s += a * a; } return Math.sqrt(s / (arr.length - 2)); };
const before = jit(Array.from(path.dx).map((v, i) => v * FW)), after = jit(Array.from(path.dx).map((v, i) => (v + corr.dx[i]) * FW));
ok('stabilised path is much smoother (second-difference jitter down by 3x or more)', after * 3 < before, `${before.toFixed(2)} -> ${after.toFixed(2)} px`);
const panKept = (path.dx[N - 1] + corr.dx[N - 1]) * FW - (path.dx[0] + corr.dx[0]) * FW;
const corr3 = MO.correctionFromPath(path, rate, 0.3, FW / FH); const panKept3 = (path.dx[N - 1] + corr3.dx[N - 1]) * FW - (path.dx[0] + corr3.dx[0]) * FW;
const slope = (arr) => { const n = arr.length; let sx = 0, sy = 0, sxy = 0, sxx = 0; arr.forEach((v, i) => { sx += i; sy += v; sxy += i * v; sxx += i * i; }); return (n * sxy - sx * sy) / (n * sxx - sx * sx); };
const keptSlope = slope(Array.from(path.dx).map((v, i) => (v + corr3.dx[i]) * FW));
const rawSlope = slope(Array.from(path.dx).map((v) => v * FW)), trueSlope = slope(truth.map((tr) => -(tr.ox - truth[0].ox)));
console.log('slope: true', trueSlope.toFixed(3), 'raw estimate', rawSlope.toFixed(3), 'after stabilising', keptSlope.toFixed(3));
ok('the intended pan is kept (smoothing does not change the slope the estimator saw by more than 0.05)', Math.abs(keptSlope - rawSlope) < 0.05, keptSlope.toFixed(3));
ok('estimated pan slope matches the true slope (within 0.1 px per frame)', Math.abs(rawSlope - trueSlope) < 0.1, `${rawSlope.toFixed(3)} vs ${trueSlope.toFixed(3)}`);
ok('zoom needed to hide borders is sensible', corr.zoom > 1.02 && corr.zoom <= 1.3, corr.zoom.toFixed(3));
const strong = MO.correctionFromPath(path, rate, 1, FW / FH), weak = MO.correctionFromPath(path, rate, 0, FW / FH);
const jw = jit(Array.from(path.dx).map((v, i) => (v + weak.dx[i]) * FW)), js = jit(Array.from(path.dx).map((v, i) => (v + strong.dx[i]) * FW));
ok('higher strength smooths more than lower strength', js < jw, `${jw.toFixed(3)} vs ${js.toFixed(3)}`);
const capped = MO.correctionFromPath(path, rate, 1, FW / FH, 1.05);
ok('zoom is capped and corrections are scaled down instead of showing black borders', capped.zoom <= 1.05 + 1e-9 && capped.limited, capped.zoom.toFixed(3));
// 3. flat picture: no invented motion
const flat = { w: FW, h: FH, d: new Uint8Array(FW * FH).fill(120) };
const m0 = MO.estimateMotion(flat, flat); ok('a flat picture gives zero motion', m0.dx === 0 && m0.dy === 0 && m0.n === 0);
// 4. tracking a point on the world texture while the camera shakes
const px = 130, py = 70; const start = 10; const tk = MO.trackPoint(frames.map((f, i) => frame(truth[i].ox, truth[i].oy, 0)), start, px, py);
let te = 0, lost = 0; for (let i = 0; i < N; i++) { const exp = { x: px - (truth[i].ox - truth[start].ox), y: py - (truth[i].oy - truth[start].oy) }; te += Math.hypot(tk[i].x * FW - exp.x, tk[i].y * FH - exp.y); if (!tk[i].ok) lost++; }
te /= N; ok('tracker stays on the point both forwards and backwards (mean error under 1.5 px)', te < 1.5 && lost === 0, `${te.toFixed(2)} px, lost ${lost}`);
// 5. a point that leaves the picture is flagged lost, not invented
const lostFrames = []; for (let i = 0; i < 30; i++) lostFrames.push(frame(i * 9, 0, 0)); const tl = MO.trackPoint(lostFrames, 0, 200, 70);
ok('a point that scrolls out of view is flagged as lost', tl.slice(-5).some((p) => !p.ok), tl.slice(-5).map((p) => p.ok).join(','));
// 6. trackAt interpolation
const tr = { t0: 2, rate: 10, pts: [0, 0, 0.1, 0.2, 0.2, 0.4] }; const a = MO.trackAt(tr, 2.05); ok('trackAt interpolates', Math.abs(a.x - 0.05) < 1e-9 && Math.abs(a.y - 0.1) < 1e-9);
process.exit(fails ? 1 : 0);
