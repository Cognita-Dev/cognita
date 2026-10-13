// studio/media.js
// Everything about files: importing and probing (video, image, audio), the runtime resource hub the preview draws from,
// the export-side frame decoders, reverse-frame caches, and the AI picture call. The video library (Mediabunny, MPL-2.0,
// vendored in studio/vendor) loads only when footage or a WebCodecs export needs it. Nothing is ever uploaded.

import { ensureMattes } from './matte.js';
import { uid, putAsset, getAsset } from './store.js';
import { WORKER_URL } from './storyboard.js';
import * as eng from './engine.js';
import { activeJobs } from './render.js';
import { videoRef, srcTime, assetOf, clamp } from './model.js';
import { stickerById } from './library-data.js';
import { decodeTrack, decodeAudioBlob, computePeaks } from './audio.js';
import * as nar from './narration.js';

let mbPromise = null;
export const loadMediabunny = () => (mbPromise = mbPromise || import('./vendor/mediabunny.min.mjs'));
export const isMobileDevice = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
export const maxVideoMB = () => (isMobileDevice() ? 120 : 300);
export const maxAudioMB = () => 100;
export const MAX_ASSETS = 400;
export const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv)$/i, IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif|svg)$/i, AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac)$/i;
export const ACCEPT = 'video/*,image/*,audio/*,.mkv,.m4v,.opus,.flac,.avif';
export function kindOfFile(f) {
  const t = f.type || '';
  if (t.startsWith('video/') || VIDEO_EXT.test(f.name)) return 'video';
  if (t.startsWith('image/') || IMAGE_EXT.test(f.name)) return 'image';
  if (t.startsWith('audio/') || AUDIO_EXT.test(f.name)) return 'audio';
  return null;
}
const mb2 = (n) => Math.round(n / 1048576);
const err = (msg, code) => Object.assign(new Error(msg), { code });

// ───────── probing and importing ─────────
export async function probeVideo(file) {
  const mb = await loadMediabunny();
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  try {
    const vt = await input.getPrimaryVideoTrack();
    if (!vt) throw err('This file has no video track.', 'NO_VIDEO');
    if (!(await vt.canDecode())) throw err(vt.codec === 'hevc' ? 'This browser cannot play HEVC (H.265) video, which iPhones often save. Re-export the clip as H.264 (Most Compatible) or open Cognita in Safari or a recent Chrome.' : 'This browser cannot read this video format (' + (vt.codec || 'unknown codec') + ').', 'CODEC');
    const duration = await input.computeDuration(); const at = await input.getPrimaryAudioTrack();
    let fps = 0; try { const st = await vt.computePacketStats(60); fps = Math.round((st.averagePacketRate || 0) * 100) / 100; } catch (_) { /* optional */ }
    let thumb = '';
    try { const sink = new mb.CanvasSink(vt, { width: 240 }); const w = await sink.getCanvas(Math.min(0.5, duration / 2)); if (w) { const c = document.createElement('canvas'); c.width = w.canvas.width; c.height = w.canvas.height; c.getContext('2d').drawImage(w.canvas, 0, 0); thumb = c.toDataURL('image/jpeg', 0.7); } } catch (_) { /* optional */ }
    let audioOk = false; if (at) { try { audioOk = await at.canDecode(); } catch (_) { audioOk = false; } }
    return { duration, width: vt.displayWidth, height: vt.displayHeight, fps, hasAudio: !!at, audioOk, vcodec: vt.codec || '', acodec: at ? at.codec || '' : '', thumb, rotation: vt.rotation || 0 };
  } finally { try { input.dispose && input.dispose(); } catch (_) { /* ignore */ } }
}
async function thumbFromBitmap(bmp, w = 160) { const k = Math.min(1, w / Math.max(1, bmp.width)); const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(bmp.width * k)); c.height = Math.max(1, Math.round(bmp.height * k)); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); return c.toDataURL('image/jpeg', 0.7); }
async function storeBlob(id, blob, name, kind) {
  try { await putAsset({ id, blob, kind, name }); } catch (e) { throw err(e.code === 'STORAGE' ? e.message : 'There is not enough storage on this device for this file. Free some space or use a smaller file.', 'STORAGE'); }
}

// Imports one file. Returns the asset record to add to the project. Throws a readable Error for unsupported or oversized files.
export async function importFile(file, { actx } = {}) {
  const kind = kindOfFile(file); if (!kind) throw err('"' + file.name + '" is not a supported video, image or audio file.', 'KIND');
  if (kind === 'video') {
    if (file.size > maxVideoMB() * 1048576) throw err('This clip is ' + mb2(file.size) + ' MB. The limit on this device is ' + maxVideoMB() + ' MB. Trim it first or use a shorter clip.', 'TOO_BIG');
    const m = await probeVideo(file); if (!(m.duration > 0.2)) throw err('This clip is too short to use.', 'SHORT');
    const id = uid('vid'); await storeBlob(id, file, file.name, 'video');
    return { id, kind: 'video', origin: 'upload', name: file.name, mime: file.type, size: file.size, duration: m.duration, width: m.width, height: m.height, fps: m.fps, hasAudio: m.hasAudio && m.audioOk, vcodec: m.vcodec, acodec: m.acodec, thumb: m.thumb, status: 'ready', note: m.hasAudio && !m.audioOk ? 'The sound in this clip uses a codec this browser cannot decode, so it will be silent.' : '' };
  }
  if (kind === 'image') {
    if (file.size > 40 * 1048576) throw err('This image is over 40 MB. Use a smaller one.', 'TOO_BIG');
    const keep = /\.(png|svg|gif|webp|avif)$/i.test(file.name) || /png|svg|gif|webp|avif/.test(file.type);
    let blob = file, width = 0, height = 0, thumb = '';
    let bmp; try { bmp = await eng.decodeImage(file); } catch (_) { throw err('This image format is not supported on this device.', 'CODEC'); }
    width = bmp.width || bmp.naturalWidth || 0; height = bmp.height || bmp.naturalHeight || 0; if (!width || !height) throw err('This image has no readable size. SVG files need a width and height.', 'CODEC');
    thumb = await thumbFromBitmap(bmp);
    if (bmp.close) bmp.close();
    if (!keep || file.size > 12 * 1048576 || Math.max(width, height) > 4096) { const d = await eng.downscaleImage(file, 2560); blob = d.blob; width = d.width; height = d.height; }
    const id = uid('img'); await storeBlob(id, blob, file.name, 'image');
    return { id, kind: 'image', origin: 'upload', name: file.name, mime: blob.type || file.type, size: blob.size, duration: 0, width, height, fps: 0, hasAudio: false, thumb, status: 'ready', note: /gif/i.test(file.name) ? 'Animated GIFs show their first frame only.' : '' };
  }
  if (file.size > maxAudioMB() * 1048576) throw err('This audio file is over ' + maxAudioMB() + ' MB.', 'TOO_BIG');
  const ctx = actx || new (eng.audioContextClass())(); let buf;
  try { const mb = await loadMediabunny().catch(() => null); buf = await decodeAudioBlob(file, ctx, mb); } catch (e) { throw err('This audio file could not be decoded (' + (e.message || 'unknown format') + ').', 'CODEC'); }
  if (!buf || !(buf.duration > 0.05)) throw err('This audio file is empty.', 'SHORT');
  const id = uid('aud'); await storeBlob(id, file, file.name, 'audio');
  return { id, kind: 'audio', origin: 'upload', name: file.name, mime: file.type, size: file.size, duration: buf.duration, width: 0, height: 0, fps: 0, hasAudio: true, thumb: '', status: 'ready', _buf: buf };
}
// Saves a blob that the app made itself (a voice-over recording or a generated picture) as an asset.
export async function importBlob(blob, name, kind, origin, actx) {
  const f = new File([blob], name, { type: blob.type });
  const a = await importFile(f, { actx }); a.origin = origin; return a;
}

// ───────── the preview resource hub ─────────
// Holds everything the preview needs in memory: decoded images, one hidden <video> per footage asset, decoded sound, waveform peaks.
export class Hub {
  constructor() { this.imgs = new Map(); this.vids = new Map(); this.urls = new Map(); this.audio = new Map(); this.peaks = new Map(); this.svgs = new Map(); this.rev = new Map(); this.loading = new Map(); this.status = new Map(); this.actx = null; this.onChange = null; }
  ctx() { if (!this.actx) { const AC = eng.audioContextClass(); this.actx = new AC(); } return this.actx; }
  _once(key, fn) { if (this.loading.has(key)) return this.loading.get(key); const p = fn().finally(() => this.loading.delete(key)); this.loading.set(key, p); return p; }
  async ensure(asset) {
    if (!asset) return; const id = asset.id;
    return this._once('a:' + id, async () => {
      try {
        const rec = await getAsset(id);
        if (!rec || !rec.blob) { this.status.set(id, 'missing'); asset.status = 'missing'; return; }
        if (asset.kind === 'image') { if (!this.imgs.has(id)) this.imgs.set(id, await eng.decodeImage(rec.blob)); }
        else if (asset.kind === 'video') {
          if (!this.vids.has(id)) {
            const url = URL.createObjectURL(rec.blob); const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'auto'; v.setAttribute('playsinline', ''); v.src = url;
            await new Promise((res) => { v.onloadeddata = res; v.onerror = res; setTimeout(res, 8000); });
            if (v.error) { URL.revokeObjectURL(url); this.status.set(id, 'unsupported'); asset.status = 'unsupported'; return; }
            v.addEventListener('seeked', () => this.onChange && this.onChange()); v.addEventListener('loadeddata', () => this.onChange && this.onChange()); this.vids.set(id, v); this.urls.set(id, url);
          }
        }
        this.status.set(id, 'ready'); asset.status = 'ready';
      } catch (_) { this.status.set(id, 'unsupported'); asset.status = 'unsupported'; }
    });
  }
  async ensureAll(project) { await Promise.all([...project.assets.filter((a) => a.kind !== 'audio').map((a) => this.ensure(a)), ensureMattes(project)]); }
  // Decoded sound for an asset id: audio files, narration ("narr_<key>"), and the sound track of footage.
  async soundFor(project, id) {
    if (this.audio.has(id)) return this.audio.get(id);
    return this._once('s:' + id, async () => {
      let buf = null;
      try {
        if (id.startsWith('narr_')) buf = await nar.getBuffer(id.slice(5));
        else {
          const a = assetOf(project, id); const rec = await getAsset(id); if (!rec || !rec.blob) { if (a) a.status = 'missing'; return null; }
          const mb = await loadMediabunny();
          if (a && a.kind === 'video') { const input = new mb.Input({ source: new mb.BlobSource(rec.blob), formats: mb.ALL_FORMATS }); try { buf = await decodeTrack(input, this.ctx(), mb); } finally { try { input.dispose(); } catch (_) { /* ignore */ } } }
          else buf = await decodeAudioBlob(rec.blob, this.ctx(), mb);
        }
      } catch (e) { this.soundErr = e; buf = null; }
      this.audio.set(id, buf); return buf;
    });
  }
  async ensureSounds(project) {
    const ids = new Set(); project.clips.forEach((c) => { if ((c.kind === 'audio' && c.assetId) || (c.kind === 'video' && c.assetId && !c.audio.mute) || (c.kind === 'scene' && c.scene.layout === 'video' && c.scene.keepAudio && c.scene.video)) ids.add(c.kind === 'scene' ? c.scene.video : c.assetId); });
    await Promise.all([...ids].map((i) => this.soundFor(project, i)));
  }
  clipSound(c) { const id = c.kind === 'scene' ? c.scene.video : c.assetId; return id ? this.audio.get(id) || null : null; }
  bufs = { get: (c) => this.clipSound(c) };
  async peaksFor(project, id) {
    if (this.peaks.has(id)) return this.peaks.get(id);
    const buf = await this.soundFor(project, id); if (!buf) return null; const p = await computePeaks(buf, 1600); this.peaks.set(id, p); return p;
  }
  // The `res` object render.drawFrame reads from.
  res = {
    image: (id) => this.imgs.get(id) || null,
    frame: (ref) => { const rv = this.rev.get(ref.id); if (rv && ref.reverse) return rv.get(this._rt || 0, ref); return this.vids.get(ref.assetId) || null; },
    svg: (id, colour) => this.svg(id, colour),
  };
  svg(id, colour) {
    const k = id + '|' + colour; const hit = this.svgs.get(k); if (hit) return hit.ok ? hit.im : null;
    const st = stickerById(id); if (!st) return null; const im = new Image(); const rec = { im, ok: false }; this.svgs.set(k, rec);
    im.onload = () => { rec.ok = true; this.onChange && this.onChange(); }; im.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(st.svg(colour)); return null;
  }
  // Moves the hidden <video> elements to where the playhead is. Called before every preview draw.
  syncVideo(project, t, playing) {
    const jobs = activeJobs(project, t); const used = new Set();
    for (const j of jobs) {
      const ref = videoRef(j.clip); if (!ref) continue; const v = this.vids.get(ref.assetId); if (!v) continue;
      this._rt = t; if (ref.reverse) continue;
      if (used.has(ref.assetId)) continue; used.add(ref.assetId);
      const target = Math.min(srcTime(ref, j.local), Math.max(0, (Number.isFinite(v.duration) ? v.duration : 1e9) - 0.04));
      const rate = clamp(ref.speed || 1, 0.1, 8); if (Math.abs(v.playbackRate - rate) > 0.001) { try { v.playbackRate = rate; } catch (_) { /* ignore */ } }
      v.muted = true;
      if (!playing || ref.freeze) { if (!v.paused) v.pause(); if (Math.abs(v.currentTime - target) > 0.034) { try { v.currentTime = target; } catch (_) { /* ignore */ } } }
      else { if (v.paused) { try { v.currentTime = target; } catch (_) { /* ignore */ } v.play().catch(() => {}); } else if (Math.abs(v.currentTime - target) > 0.45) { try { v.currentTime = target; } catch (_) { /* ignore */ } } }
    }
    this.vids.forEach((v, id) => { if (!used.has(id) && !v.paused) v.pause(); });
  }
  pauseAll() { this.vids.forEach((v) => v.pause()); }
  forget(id) { const v = this.vids.get(id); if (v) { v.pause(); v.removeAttribute('src'); v.load(); } const u = this.urls.get(id); if (u) URL.revokeObjectURL(u); [this.imgs, this.vids, this.urls, this.audio, this.peaks, this.status].forEach((m) => { const x = m.get(id); if (x && x.close) { try { x.close(); } catch (_) { /* ignore */ } } m.delete(id); }); }
  dispose() { this.pauseAll(); [...new Set([...this.imgs.keys(), ...this.vids.keys()])].forEach((id) => this.forget(id)); this.rev.clear(); this.svgs.clear(); if (this.actx) { try { this.actx.close(); } catch (_) { /* ignore */ } this.actx = null; } }
  // Reverse playback cannot use <video>, so a short pre-decoded frame list stands in. Budgeted; refuses long clips.
  async prepareReverse(project, clip, width = 360, fps = 12) {
    const ref = videoRef(clip); if (!ref) return;
    const a = assetOf(project, ref.assetId); const span = clip.duration * (ref.speed || 1);
    const chk = reverseBudget(a, span, width, fps); if (!chk.ok) throw err(chk.reason, 'BUDGET');
    const rec = await getAsset(ref.assetId); if (!rec || !rec.blob) throw err('The clip is missing from this device.', 'MISSING');
    const rf = await ReverseFrames.build(rec.blob, ref.in, ref.in + span, width, fps); this.rev.set(clip.id, rf);
  }
}

export const REVERSE_MAX_SEC = 12;
export function reverseBudget(asset, spanSec, width, fps) {
  if (spanSec > REVERSE_MAX_SEC) return { ok: false, reason: 'Reverse works on clips up to ' + REVERSE_MAX_SEC + ' seconds because every frame is held in memory. Split the clip first.' };
  const ar = asset && asset.width ? asset.height / asset.width : 16 / 9; const bytes = Math.ceil(spanSec * fps) * width * Math.round(width * ar) * 4;
  const cap = (isMobileDevice() ? 160 : 520) * 1048576; if (bytes > cap) return { ok: false, reason: 'Reversing this clip at this size needs about ' + mb2(bytes) + ' MB of memory, over the ' + mb2(cap) + ' MB budget. Shorten the clip or lower the export resolution.' };
  return { ok: true, bytes };
}
export class ReverseFrames {
  constructor(frames, start, step) { this.frames = frames; this.start = start; this.step = step; }
  static async build(blob, from, to, width, fps) {
    const mb = await loadMediabunny(); const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
    try {
      const vt = await input.getPrimaryVideoTrack(); const sink = new mb.CanvasSink(vt, { width }); const n = Math.max(1, Math.ceil((to - from) * fps)); const ts = []; for (let i = 0; i < n; i++) ts.push(Math.min(to - 0.001, from + i / fps));
      const frames = []; for await (const w of sink.canvasesAtTimestamps(ts)) frames.push(w ? w.canvas : frames[frames.length - 1] || null);
      return new ReverseFrames(frames, from, 1 / fps);
    } finally { try { input.dispose(); } catch (_) { /* ignore */ } }
  }
  get(_t, ref) { const i = Math.round((srcTime(ref, 0) - this.start) / this.step); return null || this.frames[clamp(i, 0, this.frames.length - 1)] || null; }
}

// ───────── export-side decoding ─────────
class ClipStream {
  constructor(sink, dur) { this.sink = sink; this.dur = dur; this.it = null; this.cur = null; this.next = null; }
  async restart(ts) { await this.stop(); this.it = this.sink.canvases(Math.max(0, ts)); const a = await this.it.next(); this.cur = a.done ? null : a.value; const b = await this.it.next(); this.next = b.done ? null : b.value; }
  async get(ts) {
    ts = clamp(ts, 0, Math.max(0, this.dur - 0.001));
    if (!this.it || (this.cur && ts < this.cur.timestamp - 0.002) || (this.next && ts > this.next.timestamp + 1.5)) await this.restart(ts);
    while (this.next && this.next.timestamp <= ts + 1e-4) { this.cur = this.next; const b = await this.it.next(); this.next = b.done ? null : b.value; }
    return this.cur ? this.cur.canvas : null;
  }
  async stop() { if (this.it) { try { await this.it.return(); } catch (_) { /* ignore */ } } this.it = null; this.cur = null; this.next = null; }
}
// Decodes footage for export in time order, one iterator per clip, so memory stays flat and frames are exact.
export class ExportFrames {
  constructor(project, W, H) { this.project = project; this.W = W; this.H = H; this.inputs = new Map(); this.streams = new Map(); this.cur = new Map(); this.rev = new Map(); this.imgs = new Map(); this.svgs = new Map(); this.missingIds = new Set(); this.unsupported = new Set(); }
  async open() {
    await ensureMattes(this.project);
    const mb = this.mb = await loadMediabunny();
    const vids = new Set(); this.project.clips.forEach((c) => { const r = videoRef(c); if (r && r.assetId) vids.add(r.assetId); });
    for (const id of vids) {
      const rec = await getAsset(id); if (!rec || !rec.blob) { this.missingIds.add(id); continue; }
      const input = new mb.Input({ source: new mb.BlobSource(rec.blob), formats: mb.ALL_FORMATS }); const vt = await input.getPrimaryVideoTrack();
      if (!vt || !(await vt.canDecode())) { this.unsupported.add(id); continue; }
      const width = Math.min(vt.displayWidth, Math.max(this.W, this.H)); this.inputs.set(id, { input, vt, sink: new mb.CanvasSink(vt, { width }), dur: await input.computeDuration() });
    }
    for (const a of this.project.assets) if (a.kind === 'image') { const rec = await getAsset(a.id); if (rec && rec.blob) { try { this.imgs.set(a.id, await eng.decodeImage(rec.blob)); } catch (_) { /* skip */ } } }
    for (const c of this.project.clips) if (c.kind === 'scene') for (const k of [c.scene.image]) if (k && !this.imgs.has(k)) { const rec = await getAsset(k); if (rec && rec.blob) { try { this.imgs.set(k, await eng.decodeImage(rec.blob)); } catch (_) { /* skip */ } } }
    const stickers = this.project.clips.filter((c) => c.kind === 'sticker' && c.sticker.type === 'svg');
    await Promise.all(stickers.map((c) => this.loadSvg(c.sticker.id, c.sticker.color)));
    // reverse clips are pre-decoded now so the render loop never seeks backwards
    for (const c of this.project.clips) { const r = videoRef(c); if (r && r.reverse && this.inputs.has(r.assetId)) {
      const span = c.duration * (r.speed || 1); const a = assetOf(this.project, r.assetId); const chk = reverseBudget(a, span, Math.min(this.W, 1280), this.project.settings.fps); if (!chk.ok) throw err(chk.reason, 'BUDGET');
      const rec = await getAsset(r.assetId); this.rev.set(c.id, await ReverseFrames.build(rec.blob, r.in, r.in + span, Math.min(this.W, 1280), this.project.settings.fps));
    } }
  }
  loadSvg(id, colour) { const k = id + '|' + colour; if (this.svgs.has(k)) return Promise.resolve(); const st = stickerById(id); if (!st) return Promise.resolve(); const im = new Image(); this.svgs.set(k, im); return new Promise((res) => { im.onload = res; im.onerror = res; im.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(st.svg(colour)); }); }
  res = { image: (id) => this.imgs.get(id) || null, frame: (ref) => (ref.reverse && this.rev.has(ref.id) ? this.rev.get(ref.id).get(0, ref) : this.cur.get(ref.id) || null), svg: (id, c) => { const im = this.svgs.get(id + '|' + c); return im && im.complete && im.naturalWidth ? im : null; } };
  async prepare(t) {
    for (const j of activeJobs(this.project, t)) {
      const ref = videoRef(j.clip); if (!ref || ref.reverse) continue; const it = this.inputs.get(ref.assetId); if (!it) continue;
      let s = this.streams.get(j.clip.id); if (!s) { s = new ClipStream(it.sink, it.dur); this.streams.set(j.clip.id, s); }
      const c = await s.get(srcTime(ref, j.local)); if (c) this.cur.set(ref.id, c);
    }
    // free iterators of clips that ended, so decoders are released
    this.streams.forEach((s, id) => { const c = this.project.clips.find((x) => x.id === id); if (c && t > c.start + c.duration + 1) { s.stop(); this.streams.delete(id); this.cur.delete(id); } });
  }
  missingCount() { let n = 0; this.project.clips.forEach((c) => { const r = videoRef(c); if (r && (this.missingIds.has(r.assetId) || this.unsupported.has(r.assetId))) n++; }); return n; }
  async close() { for (const s of this.streams.values()) await s.stop(); this.streams.clear(); this.inputs.forEach((i) => { try { i.input.dispose(); } catch (_) { /* ignore */ } }); this.inputs.clear(); this.cur.clear(); this.rev.clear(); this.imgs.forEach((b) => { try { b.close && b.close(); } catch (_) { /* ignore */ } }); this.imgs.clear(); }
}

// ───────── local analysis tools ─────────
// Scene detection: samples frames and flags large colour-histogram changes. LOCAL.
export async function detectScenes(blob, { threshold = 0.38, step = 0.25, onProgress } = {}) {
  const mb = await loadMediabunny(); const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS });
  try {
    const vt = await input.getPrimaryVideoTrack(); const dur = await input.computeDuration(); const sink = new mb.CanvasSink(vt, { width: 96 });
    const ts = []; for (let t = 0; t < dur; t += step) ts.push(t); const cuts = []; let prev = null; let i = 0; const c = document.createElement('canvas'); const x = c.getContext('2d', { willReadFrequently: true });
    for await (const w of sink.canvasesAtTimestamps(ts)) {
      if (w) { c.width = 32; c.height = 32; x.drawImage(w.canvas, 0, 0, 32, 32); const d = x.getImageData(0, 0, 32, 32).data; const h = new Float32Array(48); for (let p = 0; p < d.length; p += 4) { h[d[p] >> 4]++; h[16 + (d[p + 1] >> 4)]++; h[32 + (d[p + 2] >> 4)]++; } for (let k = 0; k < 48; k++) h[k] /= 1024;
        if (prev) { let diff = 0; for (let k = 0; k < 48; k++) diff += Math.abs(h[k] - prev[k]); diff /= 6; if (diff > threshold) cuts.push(Math.round(ts[i] * 100) / 100); } prev = h; }
      i++; if (onProgress && i % 8 === 0) onProgress(i / ts.length);
    }
    return cuts;
  } finally { try { input.dispose(); } catch (_) { /* ignore */ } }
}

// ───────── AI pictures: the existing POST /api/image (Flux on Workers AI). It has its own daily limit and safety filter. ──
export async function generateAiImage(prompt) {
  if (!navigator.onLine) throw new Error('You appear to be offline.');
  const res = await window.Auth.authedFetch(WORKER_URL + '/api/image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: String(prompt).slice(0, 480), kind: 'illustration' }) });
  let d = {}; try { d = await res.json(); } catch (_) { /* ignore */ }
  if (!res.ok) throw Object.assign(new Error(d.error || 'Could not generate the picture.'), { status: res.status });
  if (!d.content) throw new Error('The picture service returned nothing.');
  const bin = atob(d.content); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: d.mime || 'image/png' });
  return await eng.downscaleImage(blob, 1600);
}
