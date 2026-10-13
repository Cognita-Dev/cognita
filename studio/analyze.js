// studio/analyze.js
// On-device analysis jobs for a clip: video stabilisation, motion tracking and background removal. LOCAL: the footage is decoded here with
// Mediabunny (already vendored), frames are analysed here (stabilisation, tracking) or by the isolated model frame (background removal).
// Nothing is uploaded. Every job reports progress, can be cancelled with an AbortSignal, and returns plain data that is stored on the clip.

import { loadMediabunny } from './media.js';
import { getAsset } from './store.js';
import { videoRef, srcTime, nid, clamp } from './model.js';
import * as MO from './motion.js';
import { saveMatte, removeMatte, MATTE_SIZE } from './matte.js';
import * as ML from './ml-client.js';

const abortError = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });
const tick = () => new Promise((r) => setTimeout(r, 0));
export const MAX_STAB_SEC = 120, MAX_TRACK_SEC = 90, MAX_CUT_SEC = 90, MAX_CUT_FRAMES = 360;

// Why a job cannot run on this clip, or '' when it can.
export function blockReason(clip, kind) {
  if (!clip) return 'Select a clip first.';
  const isVideo = clip.kind === 'video', isImage = clip.kind === 'image';
  if (kind === 'cutout') { if (!isVideo && !isImage) return 'Select a video or picture clip.'; }
  else if (!isVideo) return 'Select a video clip.';
  if (!clip.assetId) return 'This clip has no media attached.';
  if (isVideo && clip.freeze) return 'A freeze frame has no motion. Turn Freeze off first.';
  const span = clip.duration * (clip.speed || 1);
  if (kind === 'stabilise' && span > MAX_STAB_SEC) return 'Stabilisation is limited to ' + MAX_STAB_SEC + ' seconds of footage per clip. Split the clip first.';
  if (kind === 'track' && span > MAX_TRACK_SEC) return 'Tracking is limited to ' + MAX_TRACK_SEC + ' seconds of footage per clip. Split the clip first.';
  if (kind === 'cutout' && isVideo && span > MAX_CUT_SEC) return 'Background removal on video is limited to ' + MAX_CUT_SEC + ' seconds per clip. Split the clip first.';
  return '';
}

async function openVideo(clip) {
  const rec = await getAsset(clip.assetId); if (!rec || !rec.blob) throw new Error('This clip’s media is missing on this device.');
  const mb = await loadMediabunny(); const input = new mb.Input({ source: new mb.BlobSource(rec.blob), formats: mb.ALL_FORMATS });
  const vt = await input.getPrimaryVideoTrack(); if (!vt) { try { input.dispose(); } catch (_) { /* ignore */ } throw new Error('No picture track was found in this file.'); }
  if (!(await vt.canDecode())) { try { input.dispose(); } catch (_) { /* ignore */ } throw new Error('This browser cannot decode this video, so it cannot be analysed here.'); }
  return { mb, input, vt, dur: await input.computeDuration() };
}

// Calls fn(canvas, index) for each timestamp, in order. A timestamp with no frame repeats the previous one.
async function eachFrame(clip, times, width, fn, signal) {
  const v = await openVideo(clip);
  try {
    const sink = new v.mb.CanvasSink(v.vt, { width }); let i = 0, last = null;
    for await (const w of sink.canvasesAtTimestamps(times)) {
      if (signal && signal.aborted) throw abortError();
      const cv = w ? w.canvas : last; last = cv; if (cv) await fn(cv, i); i++; if (i % 5 === 0) await tick();
    }
    if (signal && signal.aborted) throw abortError();
  } finally { try { v.input.dispose(); } catch (_) { /* ignore */ } }
}

let scratch = null;
function grey(cv, targetW) {
  scratch = scratch || document.createElement('canvas'); const w = targetW, h = Math.max(8, Math.round((cv.height * w) / cv.width)); scratch.width = w; scratch.height = h;
  const x = scratch.getContext('2d', { willReadFrequently: true }); x.drawImage(cv, 0, 0, w, h);
  return MO.toGrey(x.getImageData(0, 0, w, h).data, w, h, w);
}

function plan(clip, maxRate, maxFrames) {
  const span = clip.duration * (clip.speed || 1); const rate = clamp(Math.min(maxRate, maxFrames / Math.max(span, 0.1)), 2, maxRate);
  const n = Math.max(2, Math.floor(span * rate) + 1); const t0 = clip.in || 0; const times = []; for (let i = 0; i < n; i++) times.push(t0 + i / rate);
  return { span, rate, n, t0, times };
}

// ───────── stabilisation ─────────
// Returns the object stored as clip.stab. The picture is not changed here; render.js applies the correction from the stored raw path.
export async function analyseStabilise({ clip, fps, onProgress = () => {}, signal }) {
  const why = blockReason(clip, 'stabilise'); if (why) throw new Error(why);
  // analysed at the footage's own frame rate: interpolating a slower path loses accuracy on fast shake
  const p = plan(clip, clamp(fps || 25, 10, 30), 3000); const raw = []; let prev = null, aspect = 16 / 9, ax = 0, ay = 0, ar = 0, weak = 0;
  await eachFrame(clip, p.times, 192, (cv, i) => {
    const g = grey(cv, 192); if (i === 0) aspect = cv.width / cv.height;
    if (prev) { const m = MO.estimateMotion(prev, g); if (m.n < 4) weak++; ax += m.dx / g.w; ay += m.dy / g.w; ar += m.rot; }
    raw.push(ax, ay, ar); prev = g; onProgress({ stage: 'Analysing camera movement', frac: (i + 1) / p.n });
  }, signal);
  if (raw.length / 3 < 3) throw new Error('Not enough frames could be read from this clip.');
  const frames = raw.length / 3;
  return { stab: { on: true, strength: 0.5, zoomMax: 1.3, t0: p.t0, rate: p.rate, aspect, raw: raw.map((v) => Math.round(v * 1e5) / 1e5) }, frames, weakFrames: weak, weakShare: weak / Math.max(1, frames - 1) };
}

// ───────── tracking ─────────
// (fx, fy): the point to follow as fractions of the source picture, picked at clip-local time `local`. Returns the track object for clip.tracks.
export async function analyseTrack({ clip, fps, fx, fy, local, size = 'medium', name, onProgress = () => {}, signal }) {
  const why = blockReason(clip, 'track'); if (why) throw new Error(why);
  const ref = videoRef(clip); const p = plan(clip, clamp(fps || 25, 10, 30), 1800); const srcT = srcTime(ref, clamp(local, 0, clip.duration));
  const frames = []; let first = null;
  await eachFrame(clip, p.times, 256, (cv, i) => { const g = grey(cv, 256); if (!first) first = g; frames.push(g); onProgress({ stage: 'Reading frames', frac: ((i + 1) / p.n) * 0.5 }); }, signal);
  if (frames.length < 2) throw new Error('Not enough frames could be read from this clip.');
  const w = frames[0].w, h = frames[0].h, start = clamp(Math.round((srcT - p.t0) * p.rate), 0, frames.length - 1);
  const frac = { small: 0.025, medium: 0.04, large: 0.07 }[size] || 0.04;
  onProgress({ stage: 'Following the point', frac: 0.55 }); await tick();
  const res = MO.trackPoint(frames, start, fx * w, fy * h, { radius: Math.max(5, Math.round(w * frac)) });
  const pts = [], ok = []; let lost = 0; for (let i = 0; i < frames.length; i++) { const r = res[i]; pts.push(Math.round(r.x * 1e5) / 1e5, Math.round(r.y * 1e5) / 1e5); ok.push(r.ok ? '1' : '0'); if (!r.ok) lost++; }
  const found = frames.length - lost; onProgress({ stage: 'Done', frac: 1 });
  return { track: { id: nid('tk'), name: name || 'Track', t0: p.t0, rate: p.rate, pts, ok: ok.join('') }, frames: frames.length, lost, found };
}

// ───────── background removal ─────────
const toMatteInput = (() => { let c = null, x = null; return (src) => { if (!c) { c = document.createElement('canvas'); c.width = c.height = MATTE_SIZE; x = c.getContext('2d', { willReadFrequently: true }); } x.drawImage(src, 0, 0, MATTE_SIZE, MATTE_SIZE); return x.getImageData(0, 0, MATTE_SIZE, MATTE_SIZE).data.buffer.slice(0); }; })();

// Makes mattes for a video or picture clip with the on-device model and saves them. Returns { bg, frames, seconds } for clip.bg.
export async function analyseCutout({ clip, previousKey, onProgress = () => {}, signal }) {
  const why = blockReason(clip, 'cutout'); if (why) throw new Error(why);
  const sup = ML.mlSupported(); if (!sup.ok) throw new Error(sup.reason);
  const t0wall = performance.now(); const key = 'matte_' + nid('m');
  const batches = []; let rate = 1, t0 = 0, n = 1;
  const send = async (list, done, total) => {
    const buf = new Uint8Array(list.length * MATTE_SIZE * MATTE_SIZE * 4); list.forEach((b, i) => buf.set(new Uint8Array(b), i * MATTE_SIZE * MATTE_SIZE * 4));
    const r = await ML.matteFrames(buf.buffer, list.length, { signal, onProgress: (m) => { if (m.indeterminate || !m.work) onProgress({ stage: m.what || 'Preparing', frac: 0.02, download: m.total ? m.loaded / m.total : 0 }); else onProgress({ stage: 'Cutting out the subject', frac: (done + m.loaded) / total }); } });
    batches.push(new Uint8Array(r.alpha));
  };
  if (clip.kind === 'image') {
    const rec = await getAsset(clip.assetId); if (!rec || !rec.blob) throw new Error('This picture is missing on this device.');
    const bmp = await createImageBitmap(rec.blob); try { await send([toMatteInput(bmp)], 0, 1); } finally { if (bmp.close) bmp.close(); }
  } else {
    const p = plan(clip, 10, MAX_CUT_FRAMES); rate = p.rate; t0 = p.t0; n = p.n; let pending = [], done = 0;
    await eachFrame(clip, p.times, MATTE_SIZE, async (cv, i) => {
      pending.push(toMatteInput(cv));
      if (pending.length >= 6 || i === p.n - 1) { const list = pending; pending = []; await send(list, done, p.n); done += list.length; }
    }, signal);
    if (pending.length) await send(pending, done, p.n);
  }
  const total = batches.reduce((a, b) => a + b.length, 0); const alpha = new Uint8Array(total); let o = 0; batches.forEach((b) => { alpha.set(b, o); o += b.length; });
  const count = total / (MATTE_SIZE * MATTE_SIZE); if (!(count >= 1)) throw new Error('The cut-out model returned nothing.');
  await saveMatte(key, { t0, rate, n: count, size: MATTE_SIZE, alpha });
  if (previousKey && previousKey !== key) await removeMatte(previousKey);
  return { bg: { on: true, key, cutoff: 0.5, soft: 0.18 }, frames: count, seconds: (performance.now() - t0wall) / 1000 };
}
