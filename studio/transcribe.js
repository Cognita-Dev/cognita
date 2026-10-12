// studio/transcribe.js
// Automatic captions, browser side. NEEDS SERVICE: the speech-to-text model runs on the Cognita Worker (POST /api/studio/stt).
// What happens, in order:
//   1. the sound of the chosen clip is decoded on this device and turned into 16 kHz mono sound for just the part that is on the timeline
//   2. it is cut into chunks of about 25 seconds, always at the quietest moment so words are not sliced in half
//   3. chunks that are pure silence are skipped (they would only use up the daily allowance)
//   4. each chunk is sent one at a time as a small WAV file. Only SOUND is sent, never the picture. Nothing else leaves the device.
//   5. the words that come back are grouped into caption cues and moved onto the timeline (speed and trim are taken into account)
// Pure functions where possible so the logic can be tested without a browser UI.

import { WORKER_URL } from './storyboard.js';
import { clamp, quant } from './model.js';

export const SR = 16000;
export const TARGET_SEC = 25;      // aim for this chunk length
export const MAX_SEC = 29;         // never longer (the server accepts up to 30 s and 1.2 MB)
export const TAIL_SEARCH_SEC = 3;  // look this far past the target for a quiet place to cut
export const MIN_PEAK = 0.004;     // a chunk quieter than this everywhere is treated as silence and not sent
export const MAX_CHARS = 42, MAX_CUE_SEC = 4, GAP_SEC = 0.7;

export const MESSAGES = {
  PLAN_REQUIRED: 'Automatic captions are part of the Cognita Studio plan.',
  STT_NOT_CONFIGURED: 'Automatic captions are switched off right now. You can still type cues or import a subtitle file.',
  DAILY_LIMIT: 'You have used today’s automatic caption time. It resets at midnight UTC.',
  PROVIDER_BUSY: 'The speech service is very busy right now. Nothing was counted. Please try again shortly.',
  STT_FAILED: 'The speech service could not read that audio. Nothing was counted.',
  CHUNK_TOO_LARGE: 'An audio chunk was too large.',
  BAD_AUDIO: 'The audio chunk was not accepted.',
  NETWORK: 'The connection dropped. Check your internet and try again. Time already processed may still count toward today’s allowance.',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const abortError = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });

// Can this clip be transcribed? Returns { ok, reason, seconds } where seconds is the length of sound that would be sent.
export function canTranscribe(clip, project) {
  if (!clip) return { ok: false, reason: 'Select a video or audio clip on the timeline first.' };
  if (clip.kind !== 'video' && clip.kind !== 'audio') return { ok: false, reason: 'Select a video or audio clip. Text and pictures have no sound.' };
  if (!clip.assetId) return { ok: false, reason: 'This clip has no media attached.' };
  if (clip.reverse) return { ok: false, reason: 'Reversed clips cannot be transcribed. Turn Reverse off first.' };
  if (clip.kind === 'video') {
    const a = project.assets.find((x) => x.id === clip.assetId);
    if (a && a.hasAudio === false) return { ok: false, reason: 'This video has no sound to transcribe.' };
  }
  if (clip.audio && clip.audio.mute) return { ok: false, reason: 'This clip is muted. Unmute it first so you can hear what is being captioned.' };
  return { ok: true, reason: '', seconds: Math.ceil(clip.duration * (clip.speed || 1)) };
}

// The sound of the part of the clip that is on the timeline, as 16 kHz mono. `pcm` starts at source time clip.in.
export async function prepareClipAudio(project, clip, hub) {
  const buf = await hub.soundFor(project, clip.assetId);
  if (!buf) throw new Error('The sound of this clip could not be read on this device.');
  const speed = clip.speed || 1;
  const srcStart = clamp(clip.in || 0, 0, buf.duration);
  const srcLen = Math.min(clip.duration * speed, buf.duration - srcStart);
  if (!(srcLen >= 0.3)) throw new Error('There is less than a third of a second of sound in this clip.');
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OAC) throw new Error('This browser cannot prepare audio for captions.');
  const off = new OAC(1, Math.max(1, Math.ceil(srcLen * SR)), SR);
  const src = off.createBufferSource(); src.buffer = buf; src.connect(off.destination); src.start(0, srcStart, srcLen);
  const out = await off.startRendering();
  return { pcm: out.getChannelData(0), srcStart, srcLen, speed };
}

function quietestPoint(pcm, a, b) {
  const win = Math.round(0.1 * SR), hop = Math.round(0.05 * SR); let best = a, bestE = Infinity;
  for (let s = a; s + win <= b; s += hop) {
    let e = 0; for (let i = s; i < s + win; i += 4) e += pcm[i] * pcm[i];
    if (e < bestE) { bestE = e; best = s + (win >> 1); }
  }
  return best;
}
// [[startSample, endSample], ...]. Every chunk is at most MAX_SEC long.
export function splitChunks(pcm) {
  const out = []; const n = pcm.length; const T = TARGET_SEC * SR, MAXN = MAX_SEC * SR, TAIL = TAIL_SEARCH_SEC * SR; let pos = 0;
  while (pos < n) {
    if (n - pos <= MAXN) { out.push([pos, n]); break; }
    const cut = quietestPoint(pcm, pos + T, Math.min(pos + MAXN, pos + T + TAIL)); out.push([pos, cut]); pos = cut;
  }
  return out;
}
export function peakOf(pcm, a, b) { let m = 0; for (let i = a; i < b; i += 2) { const v = Math.abs(pcm[i]); if (v > m) m = v; } return m; }

// 16-bit PCM WAV of pcm[a..b)
export function toWav(pcm, a, b) {
  const n = Math.max(0, b - a); const buf = new ArrayBuffer(44 + n * 2); const v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) { const s = clamp(pcm[a + i], -1, 1); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
  return new Blob([buf], { type: 'audio/wav' });
}

async function sendChunk(blob, ms, lang, signal) {
  const url = WORKER_URL + '/api/studio/stt?lang=' + encodeURIComponent(lang) + '&ms=' + Math.round(ms);
  for (let attempt = 0; attempt < 2; attempt++) {
    let res;
    // A dropped connection is not retried: the server may already have counted the chunk, and a second try could count it twice.
    try { res = await window.Auth.authedFetch(url, { method: 'POST', headers: { 'Content-Type': 'audio/wav' }, body: blob, signal }); }
    catch (e) { if (e && e.name === 'AbortError') throw e; throw Object.assign(new Error(MESSAGES.NETWORK), { code: 'NETWORK' }); }
    if (res.ok) return await res.json();
    let d = {}; try { d = await res.json(); } catch (_) { /* ignore */ }
    // 502 and 503 are refunded by the server (nothing was counted), so one retry is safe.
    if ((res.status === 502 || res.status === 503) && d.code !== 'STT_NOT_CONFIGURED' && attempt === 0) { await sleep(2000); if (signal && signal.aborted) throw abortError(); continue; }
    throw Object.assign(new Error(MESSAGES[d.code] || d.error || 'Automatic captions failed.'), { code: d.code, status: res.status });
  }
  throw new Error('Automatic captions failed.');
}

// Turns word timings into caption cues. `chunks` = [{ offset, segments:[{start,end,text,words:[{word,start,end}]}] }], offset in seconds
// from the start of the transcribed sound (clip.in). Returns cues on the TIMELINE: [{ start, end, text }].
export function buildCues(chunks, clip, project) {
  const words = [];
  for (const ch of chunks) for (const s of ch.segments || []) {
    if (s.words && s.words.length) { for (const w of s.words) words.push({ t0: ch.offset + w.start, t1: ch.offset + Math.max(w.end, w.start + 0.05), text: w.word }); continue; }
    // the model gave only segment timing: spread the words of the segment across it in proportion to their length
    const toks = String(s.text || '').split(/\s+/).filter(Boolean); if (!toks.length) continue;
    const total = toks.reduce((a, t) => a + t.length + 1, 0); let at = ch.offset + s.start; const span = Math.max(0.2, s.end - s.start);
    for (const t of toks) { const d = (span * (t.length + 1)) / total; words.push({ t0: at, t1: at + d, text: t }); at += d; }
  }
  const groups = []; let cur = null;
  const flush = () => { if (cur && cur.words.length) groups.push(cur); cur = null; };
  for (const w of words) {
    if (cur) {
      const chars = cur.words.reduce((a, x) => a + x.text.length + 1, 0);
      if (w.t0 - cur.t1 > GAP_SEC || chars + w.text.length > MAX_CHARS || w.t1 - cur.t0 > MAX_CUE_SEC) flush();
    }
    if (!cur) cur = { t0: w.t0, t1: w.t1, words: [] };
    cur.words.push(w); cur.t1 = w.t1;
    if (/[.!?]["')\]]?$/.test(w.text) && cur.words.length >= 3) flush();
  }
  flush();
  const speed = clip.speed || 1; const cs = clip.start, ce = clip.start + clip.duration; const cues = [];
  for (const g of groups) {
    const text = g.words.map((w) => w.text).join(' ').replace(/\s+([,.;:!?])/g, '$1').trim();
    if (!text || /^[\s.\-♪♫\[\]()]*$/.test(text)) continue;
    const a = cs + g.t0 / speed, b = cs + (g.t1 + 0.15) / speed;
    if (a >= ce) continue;
    cues.push({ start: Math.max(cs, a), end: Math.min(ce, b), text: text.slice(0, 200) });
  }
  // tidy: sorted, no overlaps, at least 0.3 s on screen when there is room, snapped to the frame rate
  cues.sort((x, y) => x.start - y.start);
  for (let i = 0; i < cues.length; i++) {
    const next = cues[i + 1]; let end = Math.max(cues[i].end, cues[i].start + 0.3); if (next) end = Math.min(end, next.start); end = Math.min(end, ce);
    cues[i].start = quant(project, cues[i].start); cues[i].end = Math.max(quant(project, end), cues[i].start + 1 / ((project.settings && project.settings.fps) || 30));
  }
  return cues.filter((c) => c.end > c.start);
}

// Runs the whole job. onProgress({ stage, frac }). Cancel with signal. Returns
//   { cues, sentSeconds, skipped, chunks, secondsLeft, partial, error }
// `partial` is true when it stopped early (cancelled, limit reached, or an error) and `error` says why. Cues found so far are returned.
export async function transcribeClip({ project, clip, hub, lang = 'en-NG', signal, onProgress = () => {} }) {
  const chk = canTranscribe(clip, project); if (!chk.ok) throw new Error(chk.reason);
  onProgress({ stage: 'Reading the sound', frac: 0 });
  const { pcm, srcStart } = await prepareClipAudio(project, clip, hub); void srcStart;
  if (signal && signal.aborted) throw abortError();
  const parts = splitChunks(pcm); const results = []; let skipped = 0, sent = 0, left = null, partial = false, error = '';
  for (let i = 0; i < parts.length; i++) {
    if (signal && signal.aborted) { partial = true; error = 'Cancelled.'; break; }
    const [a, b] = parts[i]; onProgress({ stage: 'Transcribing part ' + (i + 1) + ' of ' + parts.length, frac: i / parts.length });
    if (peakOf(pcm, a, b) < MIN_PEAK) { skipped++; continue; }
    try {
      const r = await sendChunk(toWav(pcm, a, b), ((b - a) / SR) * 1000, lang, signal);
      sent += r.seconds || 0; if (r.secondsLeft != null) left = r.secondsLeft;
      results.push({ offset: a / SR, segments: r.segments || [] });
    } catch (e) {
      if (e && e.name === 'AbortError') { partial = true; error = 'Cancelled.'; break; }
      if (!results.length) throw e;
      partial = true; error = e.message || 'Stopped early.'; break;
    }
  }
  onProgress({ stage: 'Making caption cues', frac: 1 });
  return { cues: buildCues(results, clip, project), sentSeconds: sent, skipped, chunks: parts.length, secondsLeft: left, partial, error };
}
