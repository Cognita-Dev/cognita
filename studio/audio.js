// studio/audio.js
// ONE audio graph builder, used by live preview (AudioContext) and export (OfflineAudioContext), so what you hear is what you export.
// Works from the project model and a resolver for decoded buffers. No DOM.
//
//   scheduleProject(ctx, dest, project, bufs, { from, startAt, total })
//     bufs.get(clip) -> AudioBuffer | null   (decoded sound for an audio/video/narration clip)
// Returns { nodes, master, voiceRanges }.

import { valueAt, hasKeyframes, clamp } from './model.js';
import { scheduleMusic } from './engine.js';

// Which clips make sound: audio and music clips, narration clips, and video clips (footage sound) that are not muted.
export const isSoundClip = (c) => c.kind === 'audio' || c.kind === 'music' || (c.kind === 'video' && !c.audio.mute) || (c.kind === 'scene' && c.scene && c.scene.layout === 'video' && c.scene.keepAudio && !c.audio.mute);

export function audibleTracks(project) {
  const solo = project.tracks.some((t) => t.solo);
  const set = new Map();
  project.tracks.forEach((t) => { const ok = !t.muted && (!solo || t.solo) && !(t.type !== 'audio' && t.hidden && false); set.set(t.id, ok ? t : null); });
  return set;
}
// Time ranges where speech (narration or voice-over) plays. Ducking music and footage sound is driven by these.
export function voiceRanges(project) {
  const at = audibleTracks(project); const out = [];
  project.clips.forEach((c) => { if (c.kind === 'audio' && c.audio.role === 'voice' && !c.audio.mute && at.get(c.trackId)) out.push([c.start, c.start + c.duration]); });
  out.sort((a, b) => a[0] - b[0]);
  const merged = []; out.forEach((r) => { const l = merged[merged.length - 1]; if (l && r[0] <= l[1] + 0.05) l[1] = Math.max(l[1], r[1]); else merged.push([r[0], r[1]]); });
  return merged;
}
export function needsSound(project, opts = {}) {
  const at = audibleTracks(project);
  return project.clips.some((c) => isSoundClip(c) && at.get(c.trackId) && !c.audio.mute && (c.kind !== 'audio' || opts.audio !== false) && (c.kind !== 'music' || opts.music !== false));
}

const reverseCache = new WeakMap();
export function reversedBuffer(ctx, buf) {
  const hit = reverseCache.get(buf); if (hit) return hit;
  const r = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
  for (let ch = 0; ch < buf.numberOfChannels; ch++) { const s = buf.getChannelData(ch), d = r.getChannelData(ch); for (let i = 0, n = s.length; i < n; i++) d[i] = s[n - 1 - i]; }
  reverseCache.set(buf, r); return r;
}

// Gain envelope for one clip on the timeline: clip gain (with keyframes), fades, track volume, ducking.
function envelope(g, project, clip, track, start, end, from, at, duck) {
  const base = (clip.audio.gain == null ? 1 : clip.audio.gain) * (track ? track.volume : 1);
  const fi = Math.min(clip.audio.fadeIn, clip.duration / 2), fo = Math.min(clip.audio.fadeOut, clip.duration / 2);
  const kf = hasKeyframes(clip, 'audio.gain');
  const pts = new Set([start, end]);
  if (kf) clip.keyframes['audio.gain'].forEach((k) => { const tt = clip.start + k.t; if (tt > start && tt < end) pts.add(tt); });
  if (fi > 0) { pts.add(clip.start + fi); } if (fo > 0) { pts.add(clip.start + clip.duration - fo); }
  const steps = Math.max(2, kf ? Math.ceil((end - start) * 20) : 0); if (kf) for (let i = 1; i < steps; i++) pts.add(start + ((end - start) * i) / steps);
  const list = [...pts].filter((t) => t >= start && t <= end).sort((a, b) => a - b);
  let first = true;
  list.forEach((t) => {
    const local = t - clip.start; let v = kf ? valueAt(clip, 'audio.gain', local) * (track ? track.volume : 1) : base;
    if (fi > 0 && local < fi) v *= local / fi; if (fo > 0 && clip.duration - local < fo) v *= Math.max(0, (clip.duration - local) / fo);
    if (first) { g.gain.setValueAtTime(Math.max(0, v), at(t)); first = false; } else g.gain.linearRampToValueAtTime(Math.max(0, v), at(t));
  });
}
function duckNode(ctx, gain, ranges, project, from, at, total) {
  const d = project.audio.duck; const lo = 1 - clamp(d.amount, 0, 1);
  if (!ranges.length || d.amount <= 0) return;
  gain.gain.setValueAtTime(1, at(from));
  let level = 1;
  ranges.forEach(([s, e]) => {
    if (e <= from) return; const s0 = Math.max(from, s - d.attack), e0 = Math.max(from, e);
    if (s0 > from) { gain.gain.setValueAtTime(level, at(s0)); gain.gain.linearRampToValueAtTime(lo, at(s0) + d.attack); level = lo; }
    else if (level !== lo) { gain.gain.setValueAtTime(lo, at(from)); level = lo; }
    gain.gain.setValueAtTime(level, at(e0)); gain.gain.linearRampToValueAtTime(1, at(e0) + d.release); level = 1;
  });
}

export function scheduleProject(ctx, dest, project, bufs, { from = 0, startAt = 0, total = 0, music = true, audio = true } = {}) {
  const nodes = []; const at = (t) => startAt + Math.max(0, t - from);
  const master = ctx.createGain(); master.gain.value = clamp(project.audio.master, 0, 2) * 0.92; master.connect(dest);
  const tracks = audibleTracks(project); const ranges = voiceRanges(project);
  const clips = project.clips.filter((c) => isSoundClip(c) && !c.audio.mute).sort((a, b) => a.start - b.start);
  for (const clip of clips) {
    const track = tracks.get(clip.trackId); if (!track) continue;
    if (clip.kind === 'music') {
      if (!music) continue;
      const end = clip.start + clip.duration; if (end <= from) continue;
      const dg = ctx.createGain(); dg.connect(master); if (clip.audio.duck) duckNode(ctx, dg, ranges, project, Math.max(from, clip.start), at, total);
      const cg = ctx.createGain(); cg.connect(dg);
      const s0 = Math.max(from, clip.start);
      envelope(cg, project, clip, track, s0, end, from, at);
      // scheduleMusic shapes its own start/end ramps; its master is unity here and our envelope does the real work
      const m = scheduleMusic(ctx, cg, { kind: clip.music.kind, volume: 1, total: end - clip.start, from: s0 - clip.start, startAt: at(s0), duck: [] });
      nodes.push(...m.nodes); continue;
    }
    if (clip.kind === 'audio' && !audio) continue;
    let buf = bufs.get(clip); if (!buf) continue;
    const end = clip.start + clip.duration; if (end <= from || clip.start >= (total || 1e9)) continue;
    const speed = clamp(clip.speed || 1, 0.1, 8); const rev = !!clip.reverse; if (rev) buf = reversedBuffer(ctx, buf);
    const g = ctx.createGain(); let tail = g;
    const ps = ctx.createStereoPanner ? ctx.createStereoPanner() : null; if (ps) { ps.pan.value = clamp(clip.audio.pan, -1, 1); }
    let head = null;
    if (clip.audio.denoise) { // basic noise reduction: rumble and hiss filters plus a gentle downward squeeze. Not a spectral denoiser.
      const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 90; const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 9500;
      const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -50; comp.ratio.value = 2.2; comp.attack.value = 0.01; comp.release.value = 0.25;
      hp.connect(lp); lp.connect(comp); head = hp; comp.connect(g);
    }
    if (ps) { g.connect(ps); tail = ps; }
    const duckG = ctx.createGain(); tail.connect(duckG); duckG.connect(master);
    if (clip.kind !== 'audio' || clip.audio.duck) { if (clip.audio.duck) duckNode(ctx, duckG, ranges.filter(([s, e]) => !(clip.kind === 'audio' && clip.audio.role === 'voice')), project, Math.max(from, clip.start), at, total); }
    const srcDur = buf.duration; const inPt = clamp(clip.in || 0, 0, srcDur);
    const place = (tl, off, len) => {
      const src = ctx.createBufferSource(); src.buffer = buf; src.playbackRate.value = speed; src.connect(head || g);
      let when = at(tl), offset = off; if (tl < from) { const skip = (from - tl) * speed; offset += skip; len -= skip; when = startAt; }
      if (len <= 0.001 || offset >= srcDur) return null;
      src.start(when, offset, Math.min(len, srcDur - offset)); nodes.push(src); return src;
    };
    // the source range this clip plays, in source seconds
    const need = clip.duration * speed; const srcStart = rev ? Math.max(0, srcDur - inPt - need) : inPt;
    const s0 = Math.max(from, clip.start); envelope(g, project, clip, track, s0, Math.min(end, total || 1e9), from, at);
    if (clip.audio.loop && !rev) {
      const span = Math.max(0.05, srcDur - inPt); let tl = clip.start, off = inPt; let guard = 0;
      while (tl < end && guard++ < 2000) { const take = Math.min(span, (end - tl) * speed); if (tl + take / speed > from) place(tl, off, take); tl += take / speed; off = inPt; }
    } else place(clip.start, srcStart, Math.min(need, srcDur - srcStart));
  }
  return { nodes, master, voiceRanges: ranges };
}

// Decodes the sound of an audio file (mp3, wav, m4a, aac, ogg, opus, flac) with the browser, falling back to Mediabunny.
export async function decodeAudioBlob(blob, ctx, mb) {
  const arr = await blob.arrayBuffer();
  try { return await ctx.decodeAudioData(arr.slice(0)); } catch (_) { /* try Mediabunny */ }
  if (!mb) throw new Error('This audio format cannot be decoded here.');
  const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
  try { return await decodeTrack(input, ctx, mb, 3600); } finally { try { input.dispose && input.dispose(); } catch (_) { /* ignore */ } }
}
// Decodes the primary audio track of an Input into one AudioBuffer. Refuses very long tracks (memory budget).
export const AUDIO_BUDGET_SEC = 900;
export async function decodeTrack(input, ctx, mb, maxSec = AUDIO_BUDGET_SEC) {
  const at = await input.getPrimaryAudioTrack(); if (!at) return null; if (!(await at.canDecode())) throw new Error('The sound in this file uses a codec this browser cannot decode.');
  const dur = await input.computeDuration(); if (dur > maxSec) throw Object.assign(new Error('The sound in this file is longer than ' + Math.round(maxSec / 60) + ' minutes, which is over the memory budget for editing.'), { code: 'BUDGET' });
  const sink = new mb.AudioBufferSink(at); const parts = []; let ch = 2, sr = 48000;
  for await (const wb of sink.buffers(0, dur + 0.1)) { parts.push({ b: wb.buffer, t: wb.timestamp }); ch = wb.buffer.numberOfChannels; sr = wb.buffer.sampleRate; }
  if (!parts.length) return null;
  const out = ctx.createBuffer(Math.min(2, ch), Math.max(1, Math.ceil(dur * sr)), sr);
  for (const p of parts) { const off = Math.max(0, Math.round(p.t * sr)); for (let c = 0; c < out.numberOfChannels; c++) { const src = p.b.getChannelData(Math.min(c, p.b.numberOfChannels - 1)); const d = out.getChannelData(c); const n = Math.min(src.length, d.length - off); if (n > 0) d.set(src.subarray(0, n), off); } }
  return out;
}

// Waveform peaks, computed in chunks so the page stays responsive. Returns Float32Array of `bins` peak values (0..1).
export async function computePeaks(buf, bins = 2000) {
  const n = buf.length, ch = buf.numberOfChannels; const out = new Float32Array(bins); const per = Math.max(1, Math.floor(n / bins));
  const data = []; for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
  let last = performance.now();
  for (let b = 0; b < bins; b++) {
    let m = 0; const s = b * per, e = Math.min(n, s + per); const step = Math.max(1, Math.floor((e - s) / 64));
    for (let c = 0; c < ch; c++) for (let i = s; i < e; i += step) { const v = Math.abs(data[c][i]); if (v > m) m = v; }
    out[b] = m;
    if (performance.now() - last > 12) { await new Promise((r) => setTimeout(r, 0)); last = performance.now(); }
  }
  return out;
}

// Onset (beat) detection on decoded audio: spectral-flux style energy rise on a mono mix. LOCAL, approximate.
export async function detectBeats(buf, { sensitivity = 1.4, minGap = 0.25 } = {}) {
  const sr = buf.sampleRate, hop = Math.floor(sr * 0.01), win = Math.floor(sr * 0.023);
  const ch = [...Array(buf.numberOfChannels).keys()].map((c) => buf.getChannelData(c));
  const frames = Math.floor((buf.length - win) / hop); if (frames < 10) return [];
  const e = new Float32Array(frames); let last = performance.now();
  for (let f = 0; f < frames; f++) {
    let s = 0; const o = f * hop; for (let i = 0; i < win; i += 2) { let v = 0; for (let c = 0; c < ch.length; c++) v += ch[c][o + i]; v /= ch.length; s += v * v; } e[f] = Math.sqrt(s / (win / 2));
    if (performance.now() - last > 12) { await new Promise((r) => setTimeout(r, 0)); last = performance.now(); }
  }
  const flux = new Float32Array(frames); for (let f = 1; f < frames; f++) flux[f] = Math.max(0, e[f] - e[f - 1]);
  const beats = []; const W = 40; let prev = -1e9;
  for (let f = 2; f < frames - 2; f++) {
    let m = 0; const a = Math.max(0, f - W), b = Math.min(frames, f + W); for (let i = a; i < b; i++) m += flux[i]; m /= (b - a);
    if (flux[f] > m * sensitivity + 0.002 && flux[f] >= flux[f - 1] && flux[f] >= flux[f + 1]) { const t = (f * hop) / sr; if (t - prev >= minGap) { beats.push(Math.round(t * 1000) / 1000); prev = t; } }
  }
  return beats;
}
