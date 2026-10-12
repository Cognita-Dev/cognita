// studio/export.js
// Exporters. The picture comes from render.drawFrame and the sound from audio.scheduleProject, the same two functions the live
// preview uses, so the exported file is the timeline rendered, never a screen capture.
//   WebCodecs (preferred): frames are rendered in order and handed to the encoder, muxed to MP4 (H.264 + AAC) or WebM (VP9/AV1/VP8 + Opus)
//     by Mediabunny. Codecs are probed on this device first and the real container and codec are reported.
//   MediaRecorder (compatibility): records the canvas in real time when WebCodecs cannot encode. Its container label comes from what
//     the recorder actually produced, and the result says so when it is not a plain H.264/AAC file.
// A failed or cancelled export never touches the project.

import { drawFrame } from './render.js';
import { scheduleProject, needsSound } from './audio.js';
import { loadMediabunny, ExportFrames } from './media.js';
import { projectDuration, even } from './model.js';
import { audioContextClass } from './engine.js';

export const webCodecsPresent = () => typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';
const fail = (msg, code) => Object.assign(new Error(msg), { code });
const yieldNow = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });
async function holdAwake() { try { if (navigator.wakeLock) return await navigator.wakeLock.request('screen'); } catch (_) { /* optional */ } return null; }

export const QUALITY = { low: { label: 'Small file', f: 0.04 }, medium: { label: 'Balanced', f: 0.07 }, high: { label: 'High quality', f: 0.12 } };
export const RES_OPTIONS = [[480, '480p'], [720, '720p'], [1080, '1080p'], [1440, '1440p (2K)'], [2160, '2160p (4K)'], [0, 'Project size']];

const MIME_CANDIDATES = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
export function recorderSupport() {
  if (typeof MediaRecorder === 'undefined') return { ok: false, reason: 'This browser cannot record video.' };
  const c = document.createElement('canvas'); if (!c.captureStream) return { ok: false, reason: 'This browser cannot capture canvas frames.' };
  for (const m of MIME_CANDIDATES) if (MediaRecorder.isTypeSupported(m)) return { ok: true, mime: m };
  return { ok: true, mime: '' };
}
export function outputSize(project, short) {
  const { width: pw, height: ph } = project.settings;
  if (!short) return { width: even(pw), height: even(ph) };
  const k = short / Math.min(pw, ph); return { width: even(pw * k), height: even(ph * k) };
}
export const fsSaveSupported = () => typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';
export async function pickSaveHandle(name, ext) {
  const types = ext === 'mp4' ? [{ description: 'MP4 video', accept: { 'video/mp4': ['.mp4'] } }] : [{ description: 'WebM video', accept: { 'video/webm': ['.webm'] } }];
  return await window.showSaveFilePicker({ suggestedName: name + '.' + ext, types });
}

// Capability report, run before the person presses Start. Never throws.
export async function planExport(project, o) {
  const warnings = []; const { width, height } = outputSize(project, o.short);
  const dur = Math.max(0, (o.range ? o.range.end - o.range.start : projectDuration(project)));
  const fps = o.fps || project.settings.fps;
  const bitrate = o.customMbps ? Math.round(o.customMbps * 1e6) : Math.round(Math.min(40e6, Math.max(1e6, width * height * fps * (QUALITY[o.quality] || QUALITY.medium).f)));
  const abr = 128000; const sr = o.sampleRate || 48000; const sound = o.audio !== false && needsSound(project, { audio: true, music: true });
  const plan = { ok: false, engine: '', ext: '', container: '', vcodec: '', acodec: '', width, height, fps, bitrate, sampleRate: sr, hasSound: sound, duration: dur, warnings, sizeBytes: Math.round(((bitrate + (sound ? abr : 0)) / 8) * dur), resOk: {} };
  if (!(dur > 0)) { plan.reason = 'The timeline is empty. Add some clips first.'; return plan; }
  if (sound) { const bytes = Math.ceil(dur * sr) * 2 * 4; if (bytes > 700 * 1048576) { plan.reason = 'The audio for this range would need about ' + Math.round(bytes / 1048576) + ' MB of memory to mix. Export a shorter range or turn audio off.'; return plan; } }
  if (webCodecsPresent()) {
    try {
      const mb = await loadMediabunny();
      const avc = await mb.getFirstEncodableVideoCodec(['avc'], { width, height, bitrate });
      const aac = sound ? await mb.getFirstEncodableAudioCodec(['aac'], { numberOfChannels: 2, sampleRate: sr, bitrate: abr }) : null;
      const vw = await mb.getFirstEncodableVideoCodec(['vp9', 'av1', 'vp8'], { width, height, bitrate });
      const op = sound ? await mb.getFirstEncodableAudioCodec(['opus'], { numberOfChannels: 2, sampleRate: sr, bitrate: abr }) : null;
      for (const [s] of RES_OPTIONS) { if (!s) continue; const sz = outputSize(project, s); try { plan.resOk[s] = !!(await mb.getFirstEncodableVideoCodec(['avc', 'vp9', 'av1', 'vp8'], { width: sz.width, height: sz.height, bitrate: Math.round(sz.width * sz.height * fps * 0.07) })); } catch (_) { plan.resOk[s] = false; } }
      const mp4Ok = !!avc && (!sound || !!aac), webOk = !!vw && (!sound || !!op);
      let pick = o.container === 'webm' ? (webOk ? 'webm' : '') : o.container === 'mp4' ? (mp4Ok ? 'mp4' : '') : (mp4Ok ? 'mp4' : webOk ? 'webm' : '');
      if (!pick && o.container === 'mp4' && webOk) { pick = 'webm'; warnings.push('This device has no H.264 + AAC encoder, so the file will be WebM (' + vw + ' + Opus) instead of MP4.'); }
      if (!pick && o.container === 'webm' && mp4Ok) { pick = 'mp4'; warnings.push('This device cannot encode WebM at this size, so the file will be MP4.'); }
      if (pick === 'mp4') Object.assign(plan, { ok: true, engine: 'webcodecs', ext: 'mp4', container: 'MP4', vcodec: 'H.264 (avc)', acodec: sound ? 'AAC' : '', _v: 'avc', _a: aac });
      else if (pick === 'webm') { if (o.container === 'auto' && !mp4Ok) warnings.push('This device cannot encode H.264 + AAC, so the file will be WebM. Most phones, WhatsApp and editors open WebM, but some older apps do not.'); Object.assign(plan, { ok: true, engine: 'webcodecs', ext: 'webm', container: 'WebM', vcodec: vw.toUpperCase(), acodec: sound ? 'Opus' : '', _v: vw, _a: op }); }
    } catch (e) { warnings.push('Could not probe the encoder: ' + (e.message || e)); }
  }
  if (!plan.ok) {
    const r = recorderSupport();
    if (!r.ok) { plan.reason = r.reason; return plan; }
    const mime = r.mime || 'video/webm'; const ext = /mp4/.test(mime) ? 'mp4' : 'webm'; const codecs = (/codecs=([^;]+)/.exec(mime) || [, ''])[1];
    Object.assign(plan, { ok: true, engine: 'recorder', ext, container: ext.toUpperCase(), vcodec: codecs ? codecs.split(',')[0] : 'browser default', acodec: sound ? (codecs.split(',')[1] || 'browser default') : '', _mime: r.mime });
    warnings.push('Compatibility mode: this device cannot encode with WebCodecs, so the video is recorded in real time (' + Math.round(dur) + ' s). Keep this tab in front. Footage sound and exact frame timing are best-effort.');
    if (ext === 'mp4' && /vp9|vp8|av1/.test(codecs)) warnings.push('This browser stores ' + codecs + ' inside an MP4 container. Some players cannot open it. Choose WebM if the file will not play.');
  }
  return plan;
}

// ───────── WebCodecs path ─────────
export class WebCodecsExporter {
  constructor() { this.cancelled = false; this.output = null; }
  cancel() { this.cancelled = true; }
  async run(o, plan) {
    const { project, hub, range, onProgress, onStage, fileHandle } = o; const mb = await loadMediabunny();
    const { width, height, fps, bitrate, sampleRate } = plan; const start = range ? range.start : 0, end = range ? range.end : projectDuration(project);
    const total = end - start; const nFrames = Math.max(1, Math.round(total * fps)); const burn = o.burnCaptions !== false;
    const frames = new ExportFrames(project, width, height); let wake = null; let writable = null;
    try {
      onStage && onStage('Preparing media'); await frames.open(); if (this.cancelled) throw fail('cancelled', 'CANCELLED');
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; const ctx = canvas.getContext('2d', { alpha: false });
      let target; if (fileHandle) { writable = await fileHandle.createWritable(); target = new mb.StreamTarget(writable, { chunked: true, chunkSize: 16 * 1048576 }); } else target = new mb.BufferTarget();
      const format = plan.ext === 'mp4' ? new mb.Mp4OutputFormat({ fastStart: fileHandle ? false : 'in-memory' }) : new mb.WebMOutputFormat();
      const output = new mb.Output({ format, target }); this.output = output;
      const vs = new mb.CanvasSource(canvas, { codec: plan._v, bitrate, keyFrameInterval: 2 }); output.addVideoTrack(vs, { frameRate: fps });
      let as = null; if (plan.hasSound) { as = new mb.AudioBufferSource({ codec: plan._a, bitrate: 128000 }); output.addAudioTrack(as); }
      await output.start(); wake = await holdAwake();
      if (as) {
        onStage && onStage('Mixing audio'); await hub.ensureSounds(project);
        const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext; if (!OAC) throw fail('This browser cannot mix audio offline.', 'NO_AUDIO');
        const off = new OAC(2, Math.max(1, Math.ceil(total * sampleRate)), sampleRate);
        scheduleProject(off, off.destination, project, hub.bufs, { from: start, startAt: 0, total: end });
        const mixed = await off.startRendering(); if (this.cancelled) throw fail('cancelled', 'CANCELLED');
        await as.add(mixed); as.close && as.close();
      }
      onStage && onStage('Rendering frames'); const t0 = performance.now();
      for (let i = 0; i < nFrames; i++) {
        if (this.cancelled) throw fail('cancelled', 'CANCELLED');
        const t = start + Math.min(i / fps, total - 1e-4); await frames.prepare(t);
        drawFrame(ctx, width, height, project, t, frames.res, { burnCaptions: burn });
        await vs.add(i / fps, 1 / fps);
        if (i % 4 === 0) { const el = (performance.now() - t0) / 1000; onProgress && onProgress(i / nFrames, i, nFrames, i > 8 ? (el / i) * (nFrames - i) : null); await yieldNow(); }
      }
      vs.close && vs.close(); onStage && onStage('Finishing file'); await output.finalize();
      onProgress && onProgress(1, nFrames, nFrames, 0);
      const missing = frames.missingCount();
      if (fileHandle) return { savedToFile: true, name: fileHandle.name, ext: plan.ext, width, height, duration: total, audio: plan.hasSound, engine: 'webcodecs', plan, missingFootage: missing };
      const buf = output.target.buffer; if (!buf || !buf.byteLength) throw fail('The encoder produced an empty file.', 'EMPTY');
      return { blob: new Blob([buf], { type: plan.ext === 'mp4' ? 'video/mp4' : 'video/webm' }), ext: plan.ext, width, height, duration: total, audio: plan.hasSound, engine: 'webcodecs', plan, missingFootage: missing };
    } catch (e) {
      try { if (this.output && this.output.state !== 'finalized' && this.output.state !== 'canceled') await this.output.cancel(); } catch (_) { /* ignore */ }
      try { writable && (await writable.abort()); } catch (_) { /* ignore */ }
      if (e && e.code === 'CANCELLED') return { cancelled: true }; throw e;
    } finally { await frames.close(); try { wake && wake.release && (await wake.release()); } catch (_) { /* ignore */ } }
  }
}

// ───────── MediaRecorder path ─────────
export class RecorderExporter {
  constructor() { this.cancelled = false; this.raf = 0; }
  cancel() { this.cancelled = true; }
  async run(o, plan) {
    const { project, hub, range, onProgress, onStage } = o; const { width, height, fps } = plan;
    const start = range ? range.start : 0, end = range ? range.end : projectDuration(project), total = end - start;
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height; const ctx = canvas.getContext('2d');
    const stream = canvas.captureStream(fps); let actx = null;
    await hub.ensureAll(project);
    if (plan.hasSound) {
      await hub.ensureSounds(project); const AC = audioContextClass(); actx = new AC(); if (actx.state === 'suspended') await actx.resume();
      const dest = actx.createMediaStreamDestination(); scheduleProject(actx, dest, project, hub.bufs, { from: start, startAt: actx.currentTime + 0.15, total: end }); dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
    }
    const chunks = []; let recErr = null; const burn = o.burnCaptions !== false;
    const rec = new MediaRecorder(stream, Object.assign(plan._mime ? { mimeType: plan._mime } : {}, { videoBitsPerSecond: plan.bitrate }));
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); }; rec.onerror = (e) => { recErr = e.error || new Error('Recording failed'); };
    const stopped = new Promise((r) => { rec.onstop = r; }); const wake = await holdAwake();
    onStage && onStage('Recording in real time'); hub.syncVideo(project, start, true); drawFrame(ctx, width, height, project, start, hub.res, { burnCaptions: burn });
    rec.start(1000); const t0 = performance.now() + 150;
    try {
      await new Promise((resolve) => {
        const tick = () => {
          if (this.cancelled || recErr) return resolve(); const t = start + Math.max(0, (performance.now() - t0) / 1000);
          if (t >= end) { drawFrame(ctx, width, height, project, end - 1e-3, hub.res, { burnCaptions: burn }); return resolve(); }
          hub.syncVideo(project, t, true); drawFrame(ctx, width, height, project, t, hub.res, { burnCaptions: burn });
          onProgress && onProgress((t - start) / total, Math.round((t - start) * fps), Math.round(total * fps), end - t); this.raf = requestAnimationFrame(tick);
        }; tick();
      });
    } finally { cancelAnimationFrame(this.raf); hub.pauseAll(); }
    await new Promise((r) => setTimeout(r, 250)); if (rec.state !== 'inactive') rec.stop(); await stopped;
    stream.getTracks().forEach((t) => t.stop()); if (actx) { try { await actx.close(); } catch (_) { /* ignore */ } } try { wake && wake.release && (await wake.release()); } catch (_) { /* ignore */ }
    if (this.cancelled) return { cancelled: true }; if (recErr) throw recErr;
    const type = (rec.mimeType || plan._mime || 'video/webm').split(';')[0]; const blob = new Blob(chunks, { type });
    if (!blob.size) throw fail('The recording was empty. Keep this tab in front while rendering and try again.', 'EMPTY');
    const real = rec.mimeType || ''; const ext = type.includes('mp4') ? 'mp4' : 'webm';
    return { blob, ext, width, height, duration: total, audio: plan.hasSound, engine: 'recorder', plan: { ...plan, ext, vcodec: (/codecs=([^;]+)/.exec(real) || [, plan.vcodec])[1].split(',')[0], container: ext.toUpperCase() }, footageSoundNote: plan.hasSound };
  }
}

export async function exportProject(o) {
  let plan = o.plan || (await planExport(o.project, o)); if (!plan.ok) throw fail(plan.reason || 'Export is not available on this device.', 'NO_EXPORT');
  const handle = { ex: null, stopped: false, plan, cancel() { this.stopped = true; this.ex && this.ex.cancel(); } };
  handle.promise = (async () => {
    if (plan.engine === 'webcodecs') {
      handle.ex = new WebCodecsExporter();
      try { return await handle.ex.run(o, plan); }
      catch (e) {
        if (!(e && (e.code === 'NO_ENCODER' || e.code === 'NO_WEBCODECS')) || o.fileHandle) throw e;
        const rp = recorderSupport(); if (!rp.ok) throw e; o.onStage && o.onStage('Switching to compatibility mode');
        plan = { ...plan, engine: 'recorder', _mime: rp.mime };
      }
    }
    handle.ex = new RecorderExporter(); if (handle.stopped) handle.ex.cancel(); return await handle.ex.run(o, plan);
  })();
  return handle;
}
