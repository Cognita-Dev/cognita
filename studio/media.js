// studio/media.js
// Everything about files that are not text: footage (uploaded video), AI-generated pictures, and the video decoders.
// The video library (Mediabunny, MPL-2.0, vendored in studio/vendor) is loaded only when footage or a WebCodecs export needs it.

import { uid, putAsset, getAsset } from './store.js';
import { WORKER_URL } from './storyboard.js';
import * as eng from './engine.js';

let mbPromise = null;
export const loadMediabunny = () => (mbPromise = mbPromise || import('./vendor/mediabunny.min.mjs'));

export const isMobileDevice = () => /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
export const maxVideoMB = () => (isMobileDevice() ? 120 : 300);
export const MAX_CLIPS = 8;

// ── Footage ──
export async function probeVideo(file) {
  const mb = await loadMediabunny();
  const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
  try {
    const vt = await input.getPrimaryVideoTrack();
    if (!vt) throw Object.assign(new Error('This file has no video track.'), { code: 'NO_VIDEO' });
    if (!(await vt.canDecode())) throw Object.assign(new Error('This browser cannot read this video format. iPhone clips saved as HEVC often need Chrome or Safari; try exporting the clip as H.264 (Most Compatible).'), { code: 'CODEC' });
    const duration = await input.computeDuration();
    const at = await input.getPrimaryAudioTrack();
    let thumb = '';
    try {
      const sink = new mb.CanvasSink(vt, { width: 320 });
      const w = await sink.getCanvas(Math.min(0.5, duration / 2));
      if (w) { const c = document.createElement('canvas'); c.width = w.canvas.width; c.height = w.canvas.height; c.getContext('2d').drawImage(w.canvas, 0, 0); thumb = c.toDataURL('image/jpeg', 0.7); }
    } catch (_) { /* a thumbnail is optional */ }
    return { duration, width: vt.displayWidth, height: vt.displayHeight, hasAudio: !!at, thumb };
  } finally { try { input.dispose && input.dispose(); } catch (_) { /* ignore */ } }
}

export async function ingestVideo(file) {
  if (file.size > maxVideoMB() * 1048576) throw Object.assign(new Error('This clip is ' + Math.round(file.size / 1048576) + ' MB. The limit on this device is ' + maxVideoMB() + ' MB. Trim it first or use a shorter clip.'), { code: 'TOO_BIG' });
  const meta = await probeVideo(file);
  if (!(meta.duration > 0.2)) throw new Error('This clip is too short to use.');
  const id = uid('vid');
  try { await putAsset({ id, blob: file, kind: 'video', name: file.name }); }
  catch (e) { throw Object.assign(new Error('There is not enough storage on this device for this clip. Free some space or use a smaller clip.'), { code: 'STORAGE' }); }
  return { id, name: file.name, kind: 'video', width: meta.width, height: meta.height, duration: meta.duration, hasAudio: meta.hasAudio, thumb: meta.thumb };
}

// Live preview of footage: one hidden <video> element per clip. Preview only; the exporter decodes frames itself.
export class PreviewVideos {
  constructor() { this.els = new Map(); this.urls = new Map(); this.loading = new Map(); }
  async load(id) {
    if (this.els.has(id)) return this.els.get(id);
    if (this.loading.has(id)) return this.loading.get(id);
    const p = (async () => {
      const rec = await getAsset(id); if (!rec || !rec.blob) return null;
      const url = URL.createObjectURL(rec.blob); const v = document.createElement('video');
      v.muted = true; v.playsInline = true; v.preload = 'auto'; v.setAttribute('playsinline', ''); v.src = url;
      await new Promise((res) => { v.onloadeddata = res; v.onerror = res; setTimeout(res, 6000); });
      this.els.set(id, v); this.urls.set(id, url); return v;
    })();
    this.loading.set(id, p); const v = await p; this.loading.delete(id); return v;
  }
  frames = (scene) => (scene.video ? this.els.get(scene.video) || null : null);
  sync(scene, local, playing, volume = 1) {
    const v = scene.video && this.els.get(scene.video); if (!v) return;
    const dur = Number.isFinite(v.duration) ? v.duration : 1e9;
    const target = Math.min((scene.trimStart || 0) + local, Math.max(0, dur - 0.05));
    v.muted = !(playing && scene.keepAudio); v.volume = volume;
    if (!playing) { v.pause(); if (Math.abs(v.currentTime - target) > 0.04) { try { v.currentTime = target; } catch (_) { /* ignore */ } } return; }
    if ((scene.trimStart || 0) + local >= dur - 0.05) { v.pause(); return; }
    if (v.paused) { try { v.currentTime = target; } catch (_) { /* ignore */ } v.play().catch(() => {}); }
    else if (Math.abs(v.currentTime - target) > 0.4) { try { v.currentTime = target; } catch (_) { /* ignore */ } }
  }
  pauseAll() { this.els.forEach((v) => { v.pause(); v.muted = true; }); }
  dispose() { this.pauseAll(); this.urls.forEach((u) => URL.revokeObjectURL(u)); this.els.clear(); this.urls.clear(); }
}

// Frame-accurate decoding for export (WebCodecs through Mediabunny). Frames are pulled one at a time, in order, so memory stays flat.
export class ExportVideos {
  constructor(project, W, H) { this.project = project; this.W = W; this.H = H; this.items = new Map(); this.cur = new Map(); }
  async open() {
    const mb = await loadMediabunny();
    const ids = new Set(this.project.scenes.filter((s) => s.layout === 'video' && s.video).map((s) => s.video));
    for (const id of ids) {
      const rec = await getAsset(id);
      if (!rec || !rec.blob) { this.items.set(id, null); continue; }
      const input = new mb.Input({ source: new mb.BlobSource(rec.blob), formats: mb.ALL_FORMATS });
      const vt = await input.getPrimaryVideoTrack();
      if (!vt) { this.items.set(id, null); continue; }
      const sink = new mb.CanvasSink(vt, { width: this.W, height: this.H, fit: 'cover' });
      this.items.set(id, { mb, input, vt, sink, duration: await input.computeDuration() });
    }
  }
  missing() { return this.project.scenes.filter((s) => s.layout === 'video' && (!s.video || !this.items.get(s.video))).length; }
  frames = (scene) => this.cur.get(scene.id) || null;
  async prepare(t) {
    const { index, local, dur } = eng.sceneAt(this.project, t);
    const todo = [[this.project.scenes[index], local]];
    const nxt = this.project.scenes[index + 1];
    if (nxt && dur - local < 0.5) todo.push([nxt, 0]);
    for (const [s, loc] of todo) {
      const it = s.layout === 'video' && s.video ? this.items.get(s.video) : null; if (!it) continue;
      const ts = Math.max(0, Math.min((s.trimStart || 0) + loc, it.duration - 0.04));
      const w = await it.sink.getCanvas(ts); if (!w) continue;
      let c = this.cur.get(s.id); if (!c) { c = document.createElement('canvas'); c.width = this.W; c.height = this.H; this.cur.set(s.id, c); }
      c.getContext('2d').drawImage(w.canvas, 0, 0, this.W, this.H);
    }
  }
  // Decoded sound of every footage scene that keeps its original audio: [{ start, trimStart, dur, items:[{buffer,timestamp}] }]
  async audioClips() {
    const out = []; let acc = 0;
    for (const s of this.project.scenes) {
      const d = eng.sceneDur(this.project, s);
      const it = s.layout === 'video' && s.video && s.keepAudio ? this.items.get(s.video) : null;
      if (it) {
        try {
          const at = await it.input.getPrimaryAudioTrack();
          if (at && (await at.canDecode())) {
            const sink = new it.mb.AudioBufferSink(at); const items = [];
            for await (const wb of sink.buffers(s.trimStart || 0, (s.trimStart || 0) + d)) items.push({ buffer: wb.buffer, timestamp: wb.timestamp });
            out.push({ start: acc, trimStart: s.trimStart || 0, dur: d, items });
          }
        } catch (_) { /* a clip whose sound cannot be decoded is exported silent */ }
      }
      acc += d;
    }
    return out;
  }
  close() { this.items.forEach((it) => { try { it && it.input.dispose && it.input.dispose(); } catch (_) { /* ignore */ } }); this.items.clear(); this.cur.clear(); }
}

// ── AI pictures: the existing POST /api/image (Flux on Workers AI). It has its own daily limit and safety filter. ──
export async function generateAiImage(prompt) {
  if (!navigator.onLine) throw new Error('You appear to be offline.');
  const res = await window.Auth.authedFetch(WORKER_URL + '/api/image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: String(prompt).slice(0, 480), kind: 'illustration' }) });
  let d = {}; try { d = await res.json(); } catch (_) { /* ignore */ }
  if (!res.ok) throw Object.assign(new Error(d.error || 'Could not generate the picture.'), { status: res.status });
  if (!d.content) throw new Error('The picture service returned nothing.');
  const bin = atob(d.content); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const blob = new Blob([bytes], { type: d.mime || 'image/png' });
  const small = await eng.downscaleImage(blob, 1600);
  return small;
}
