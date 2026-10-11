// studio/export.js
// Exporters. Two paths, chosen automatically:
//   WebCodecs (preferred): frames are rendered one by one and handed to the hardware encoder, then muxed to MP4 (or WebM) by Mediabunny.
//     Faster than real time, frame-exact, and the audio is mixed offline so narration and music line up with the picture.
//   MediaRecorder (compatibility): records a canvas live. Real time, and it needs the tab in front. Used only when the browser has no
//     usable WebCodecs encoder for the project.

import * as eng from './engine.js';
import { loadMediabunny, ExportVideos } from './media.js';
import { loadBuffers } from './narration.js';

export const webCodecsPresent = () => typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined';

const MIME_CANDIDATES = [['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'mp4'], ['video/mp4', 'mp4'], ['video/webm;codecs=vp9,opus', 'webm'], ['video/webm;codecs=vp8,opus', 'webm'], ['video/webm', 'webm']];
export function recorderSupport() {
  if (typeof MediaRecorder === 'undefined') return { ok: false, reason: 'This browser cannot record video.' };
  const c = document.createElement('canvas');
  if (!c.captureStream) return { ok: false, reason: 'This browser cannot capture canvas frames.' };
  for (const [mime, ext] of MIME_CANDIDATES) if (MediaRecorder.isTypeSupported(mime)) return { ok: true, mime, ext };
  return { ok: true, mime: '', ext: 'webm' };
}
export function exportSupport() {
  const r = recorderSupport();
  if (webCodecsPresent()) return { ok: true, engine: 'webcodecs', fallback: r.ok };
  return r.ok ? { ok: true, engine: 'recorder', ext: r.ext, mime: r.mime } : { ok: false, reason: r.reason };
}

const yieldNow = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });
async function holdScreenAwake() { try { if (navigator.wakeLock) return await navigator.wakeLock.request('screen'); } catch (_) { /* optional */ } return null; }
const fail = (msg, code) => Object.assign(new Error(msg), { code });

export function wantsAudio(project, o) {
  const narr = o.includeNarration && eng.narrationRanges(project).length > 0;
  const music = o.includeMusic && project.music !== 'none';
  const foot = project.scenes.some((s) => s.layout === 'video' && s.video && s.keepAudio);
  return { narr, music, foot, any: narr || music || foot };
}

// ── WebCodecs path ──
export class WebCodecsExporter {
  constructor() { this.cancelled = false; this.output = null; }
  cancel() { this.cancelled = true; }

  async run(o) {
    const { project, images, shortSide, fps, volume, onProgress, onStage } = o;
    if (!webCodecsPresent()) throw fail('WebCodecs is not available in this browser.', 'NO_WEBCODECS');
    const mb = await loadMediabunny();
    const { width, height } = eng.dimsFor(project.aspect, shortSide);
    const total = eng.totalDuration(project);
    const frames = Math.max(1, Math.round(total * fps));
    const au = wantsAudio(project, o);
    const bitrate = Math.round(Math.min(14e6, Math.max(1.5e6, width * height * fps * 0.07)));

    // 1. pick codecs this device can really encode
    let fmt = null;
    const vAvc = await mb.getFirstEncodableVideoCodec(['avc'], { width, height, bitrate });
    const aAac = au.any ? await mb.getFirstEncodableAudioCodec(['aac'], { numberOfChannels: 2, sampleRate: 48000, bitrate: 128000 }) : null;
    if (vAvc && (!au.any || aAac)) fmt = { f: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }), v: 'avc', a: aAac, ext: 'mp4' };
    if (!fmt) {
      const vW = await mb.getFirstEncodableVideoCodec(['vp9', 'vp8', 'av1'], { width, height, bitrate });
      const aOp = au.any ? await mb.getFirstEncodableAudioCodec(['opus'], { numberOfChannels: 2, sampleRate: 48000, bitrate: 128000 }) : null;
      if (vW && (!au.any || aOp)) fmt = { f: new mb.WebMOutputFormat(), v: vW, a: aOp, ext: 'webm' };
    }
    if (!fmt) throw fail('This device cannot encode ' + width + '\u00D7' + height + ' video' + (au.any ? ' with sound' : '') + ' using WebCodecs.', 'NO_ENCODER');

    // 2. open footage decoders and set up the output
    const videos = new ExportVideos(project, width, height);
    let wake = null;
    try {
      onStage && onStage('Preparing');
      await videos.open();
      const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext('2d', { alpha: false });
      const output = new mb.Output({ format: fmt.f, target: new mb.BufferTarget() });
      this.output = output;
      const vs = new mb.CanvasSource(canvas, { codec: fmt.v, bitrate, keyFrameInterval: 2 });
      output.addVideoTrack(vs, { frameRate: fps });
      let as = null;
      if (au.any) { as = new mb.AudioBufferSource({ codec: fmt.a, bitrate: 128000 }); output.addAudioTrack(as); }
      await output.start();
      wake = await holdScreenAwake();

      // 3. audio, mixed offline so it is exact
      if (as) {
        onStage && onStage('Mixing audio');
        const mixed = await this.mix(project, o, au, videos, total, volume);
        if (this.cancelled) throw fail('cancelled', 'CANCELLED');
        await as.add(mixed);
        as.close && as.close();
      }

      // 4. frames
      onStage && onStage('Rendering frames');
      for (let i = 0; i < frames; i++) {
        if (this.cancelled) throw fail('cancelled', 'CANCELLED');
        const t = i / fps;
        await videos.prepare(t);
        eng.drawFrame(ctx, width, height, project, Math.min(t, total - 0.001), images, videos.frames);
        await vs.add(t, 1 / fps);
        if (i % 6 === 0) { onProgress && onProgress(i / frames, i, frames); await yieldNow(); }
      }
      vs.close && vs.close();
      onStage && onStage('Finishing file');
      await output.finalize();
      const buf = output.target.buffer;
      if (!buf || !buf.byteLength) throw fail('The encoder produced an empty file.', 'EMPTY');
      onProgress && onProgress(1, frames, frames);
      return { blob: new Blob([buf], { type: fmt.ext === 'mp4' ? 'video/mp4' : 'video/webm' }), ext: fmt.ext, width, height, duration: total, audio: au.any, engine: 'webcodecs', missingFootage: videos.missing() };
    } catch (e) {
      try { if (this.output && this.output.state !== 'finalized' && this.output.state !== 'canceled') await this.output.cancel(); } catch (_) { /* ignore */ }
      if (e && e.code === 'CANCELLED') return { cancelled: true };
      throw e;
    } finally {
      videos.close();
      try { wake && wake.release && (await wake.release()); } catch (_) { /* ignore */ }
    }
  }

  async mix(project, o, au, videos, total, volume) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OAC) throw fail('This browser cannot mix audio offline.', 'NO_AUDIO');
    const sr = 48000;
    const off = new OAC(2, Math.max(1, Math.ceil(total * sr)), sr);
    const bus = off.createGain(); bus.gain.value = 0.92; bus.connect(off.destination);
    const ranges = [];
    if (au.narr) {
      const { buffers, missing } = await loadBuffers(project);
      if (missing.length) throw fail('Narration audio for ' + missing.length + ' scene(s) is no longer stored on this device. Generate narration again.', 'NARR_MISSING');
      eng.scheduleNarration(off, bus, project, buffers);
      eng.narrationRanges(project).forEach((r) => ranges.push(r));
    }
    if (au.music) eng.scheduleMusic(off, bus, { kind: project.music, volume, total, duck: ranges });
    if (au.foot) {
      const clips = await videos.audioClips();
      clips.forEach((c) => c.items.forEach((it) => {
        let begin = c.start + (it.timestamp - c.trimStart); let offset = 0;
        if (begin < c.start) { offset = c.start - begin; begin = c.start; }
        const room = c.start + c.dur - begin; if (room <= 0 || offset >= it.buffer.duration) return;
        const src = off.createBufferSource(); src.buffer = it.buffer; src.connect(bus);
        src.start(begin, offset, Math.min(it.buffer.duration - offset, room));
      }));
    }
    return await off.startRendering();
  }
}

// ── MediaRecorder path ──
export class RecorderExporter {
  constructor() { this.cancelled = false; this.raf = 0; }
  cancel() { this.cancelled = true; }
  async run(o) {
    const sup = recorderSupport(); if (!sup.ok) throw fail(sup.reason, 'NO_RECORDER');
    const { project, images, shortSide, fps, volume, onProgress, onStage, previewVideos } = o;
    const { width, height } = eng.dimsFor(project.aspect, shortSide);
    const total = eng.totalDuration(project);
    const au = wantsAudio(project, { ...o, includeNarration: o.includeNarration });
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    const stream = canvas.captureStream(fps);
    let actx = null, bus = null;
    const footageSkipped = au.foot;
    if (au.narr || au.music) {
      const AC = eng.audioContextClass(); actx = new AC(); if (actx.state === 'suspended') await actx.resume();
      const dest = actx.createMediaStreamDestination(); bus = actx.createGain(); bus.gain.value = 0.92; bus.connect(dest);
      const ranges = [];
      if (au.narr) { const { buffers, missing } = await loadBuffers(project); if (missing.length) { actx.close(); throw fail('Narration audio for ' + missing.length + ' scene(s) is no longer stored on this device. Generate narration again.', 'NARR_MISSING'); } eng.scheduleNarration(actx, bus, project, buffers, { startAt: actx.currentTime + 0.15 }); eng.narrationRanges(project).forEach((r) => ranges.push(r)); }
      if (au.music) eng.scheduleMusic(actx, bus, { kind: project.music, volume, total, startAt: actx.currentTime + 0.15, duck: ranges });
      dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
    }
    const chunks = []; let recErr = null;
    const rec = new MediaRecorder(stream, Object.assign(sup.mime ? { mimeType: sup.mime } : {}, { videoBitsPerSecond: Math.round(Math.min(12e6, Math.max(2e6, width * height * fps * 0.09))) }));
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onerror = (e) => { recErr = e.error || new Error('Recording failed'); };
    const stopped = new Promise((r) => { rec.onstop = r; });
    const frames = previewVideos ? previewVideos.frames : null;
    const wake = await holdScreenAwake();
    onStage && onStage('Recording in real time');
    drawFrameSafe(ctx, width, height, project, 0, images, frames);
    rec.start(1000);
    const t0 = performance.now() + 150;
    try {
      await new Promise((resolve) => {
        const tick = () => {
          if (this.cancelled || recErr) return resolve();
          const t = Math.max(0, (performance.now() - t0) / 1000);
          if (t >= total) { drawFrameSafe(ctx, width, height, project, total - 0.001, images, frames); return resolve(); }
          if (previewVideos) { const { index, local } = eng.sceneAt(project, t); previewVideos.sync(project.scenes[index], local, true, 0); }
          drawFrameSafe(ctx, width, height, project, t, images, frames);
          onProgress && onProgress(t / total, Math.round(t * fps), Math.round(total * fps));
          this.raf = requestAnimationFrame(tick);
        };
        tick();
      });
    } finally { cancelAnimationFrame(this.raf); previewVideos && previewVideos.pauseAll(); }
    await new Promise((r) => setTimeout(r, 250));
    if (rec.state !== 'inactive') rec.stop();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());
    if (actx) { try { await actx.close(); } catch (_) { /* ignore */ } }
    try { wake && wake.release && (await wake.release()); } catch (_) { /* ignore */ }
    if (this.cancelled) return { cancelled: true };
    if (recErr) throw recErr;
    const type = (rec.mimeType || sup.mime || 'video/webm').split(';')[0];
    const blob = new Blob(chunks, { type });
    if (!blob.size) throw fail('The recording was empty. Keep this tab in front while rendering and try again.', 'EMPTY');
    return { blob, ext: type.includes('mp4') ? 'mp4' : 'webm', width, height, duration: total, audio: au.narr || au.music, engine: 'recorder', footageSoundSkipped: footageSkipped };
  }
}
function drawFrameSafe(ctx, W, H, project, t, images, frames) { eng.drawFrame(ctx, W, H, project, t, images, frames); }

export async function exportVideo(o) {
  const sup = exportSupport(); if (!sup.ok) throw fail(sup.reason, 'NO_EXPORT');
  const handle = { ex: null, stopped: false, cancel() { this.stopped = true; this.ex && this.ex.cancel(); } };
  const p = (async () => {
    if (sup.engine === 'webcodecs') {
      handle.ex = new WebCodecsExporter();
      try { return await handle.ex.run(o); }
      catch (e) {
        if (!(e && (e.code === 'NO_ENCODER' || e.code === 'NO_WEBCODECS')) || !sup.fallback) throw e;
        o.onStage && o.onStage('Switching to compatibility mode');
      }
    }
    handle.ex = new RecorderExporter();
    if (handle.stopped) handle.ex.cancel();
    return await handle.ex.run(o);
  })();
  handle.promise = p;
  return handle;
}
