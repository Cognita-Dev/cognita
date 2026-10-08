// js/learna-speech.js
// Speech for Learna, in the browser. Four parts, each used only where it helps learning:
//
//   Voice    Listen to a word, line or paragraph. First choice is the premium neural voice from the Worker (Ezinne and Abeo for
//            English, Denise and Henri for French). If that is unavailable (no key, free plan, budget used, offline) the browser's
//            own speech voice is used, preferring Nigerian English, then British English, then any English voice. For other
//            languages it picks the best installed voice for that language.
//   Dictation  Speech to text with the browser's SpeechRecognition (free). Used for answers that are better said than typed,
//            and for the "say it aloud" practice. It is a recognition match, never an accent score.
//   Recorder Records audio or video with MediaRecorder for tasks that are submitted. The server checks the recording itself.
//   Cues     Web Audio: a soft pace guide for public speaking and short start and stop sounds. Web Audio cannot make speech, so it
//            is not used as a voice.
//
// Nothing here decides anything about progress. It only captures and plays.

const STORE_KEY = 'learna.speech';
export const prefs = {
  get() { try { return { voice: 'default', rate: 1, ...(JSON.parse(localStorage.getItem(STORE_KEY)) || {}) }; } catch (_) { return { voice: 'default', rate: 1 }; } },
  set(p) { try { localStorage.setItem(STORE_KEY, JSON.stringify({ ...prefs.get(), ...p })); } catch (_) { /* private mode: keep going without saving */ } },
};

// ── Voice (text to speech) ───────────────────────────────────────────────
let audioEl = null, speakToken = 0, premiumOff = false, voices = [];
const blobCache = new Map();             // request key -> object URL, so a repeat press plays instantly

function refreshVoices() { try { voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : []; } catch (_) { voices = []; } }
if (typeof window !== 'undefined' && window.speechSynthesis) { refreshVoices(); window.speechSynthesis.addEventListener && window.speechSynthesis.addEventListener('voiceschanged', refreshVoices); }

export function browserVoiceFor(lang) {
  if (!voices.length) refreshVoices();
  const l = String(lang || 'en-NG').toLowerCase(), base = l.split('-')[0];
  const exact = voices.find((v) => v.lang.toLowerCase().replace('_', '-') === l);
  if (exact) return exact;
  if (base === 'en') return voices.find((v) => /^en[-_]ng/i.test(v.lang)) || voices.find((v) => /^en[-_]gb/i.test(v.lang)) || voices.find((v) => /^en[-_]/i.test(v.lang)) || null;
  return voices.find((v) => v.lang.toLowerCase().startsWith(base)) || null;
}

export function ttsSupported() { return !!(window.speechSynthesis && window.SpeechSynthesisUtterance); }

export function stopSpeaking() {
  speakToken++;
  if (audioEl) { try { audioEl.pause(); } catch (_) { /* already stopped */ } audioEl = null; }
  try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (_) { /* nothing playing */ }
}

function speakWithBrowser(text, lang, rate, token, hooks) {
  return new Promise((resolve) => {
    if (!ttsSupported()) { resolve({ ok: false, reason: 'unsupported' }); return; }
    const u = new SpeechSynthesisUtterance(text);
    const v = browserVoiceFor(lang);
    u.lang = v ? v.lang : lang; if (v) { try { u.voice = v; } catch (_) { /* some engines reject a stale voice object: the language alone still selects a voice */ } } u.rate = rate || 1;
    u.onstart = () => { if (token === speakToken && hooks.onStart) hooks.onStart({ source: 'browser', voice: v ? v.name : 'your device voice', exact: !!v }); };
    u.onend = () => resolve({ ok: true, source: 'browser' });
    u.onerror = (e) => resolve({ ok: false, reason: e && e.error ? e.error : 'error' });
    try { window.speechSynthesis.cancel(); window.speechSynthesis.speak(u); } catch (_) { resolve({ ok: false, reason: 'error' }); }
  });
}

/**
 * Speaks one part of a lesson. `ref` = { course, lesson, step, part, word?, lang?, voice? }, `text` is the same text, used only
 * if the premium voice is unavailable. `api` is the authenticated fetch helper from learna.js.
 * Returns { ok, source: 'premium' | 'browser', note }.
 */
export async function speak(ref, text, api, hooks = {}) {
  stopSpeaking(); const token = ++speakToken;
  const p = prefs.get(); const lang = ref.lang || 'en-NG';
  if (!premiumOff) {
    const rate = ref.rate || p.rate; const body = { course: ref.course, lesson: ref.lesson, step: ref.step, part: ref.part, word: ref.word, lang: ref.lang, voice: ref.voice || p.voice, rate };
    const key = JSON.stringify(body);
    try {
      let url = blobCache.get(key);
      if (!url) {
        const res = await api.blob('/speech/tts', body);
        if (token !== speakToken) return { ok: false, cancelled: true };
        if (!res.ok) { const code = res.code; if (code === 'TTS_NOT_CONFIGURED' || code === 'PLAN_REQUIRED' || code === 'TTS_BUDGET') premiumOff = true; throw new Error(code || 'tts'); }
        url = URL.createObjectURL(res.blob); blobCache.set(key, url);
        if (blobCache.size > 40) { const first = blobCache.keys().next().value; URL.revokeObjectURL(blobCache.get(first)); blobCache.delete(first); }
      }
      audioEl = new Audio(url);
      await new Promise((resolve, reject) => { audioEl.onended = resolve; audioEl.onerror = () => reject(new Error('play')); audioEl.play().then(() => { if (hooks.onStart) hooks.onStart({ source: 'premium', voice: ref.voice === 'alt' ? 'second voice' : 'premium voice' }); }).catch(reject); });
      return { ok: true, source: 'premium' };
    } catch (e) { if (token !== speakToken) return { ok: false, cancelled: true }; /* fall through to the browser voice */ }
  }
  const r = await speakWithBrowser(text, lang, ref.rate || p.rate, token, hooks);
  if (r.ok) return { ...r, note: browserVoiceFor(lang) ? '' : 'Your device has no ' + lang + ' voice installed, so a default voice was used. It may not sound right.' };
  return { ok: false, reason: r.reason, note: ttsSupported() ? 'Your device could not play speech.' : 'This browser cannot read text aloud. Use Chrome, Edge or Safari for listening.' };
}

// ── Dictation (speech to text) ───────────────────────────────────────────
const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;
export const dictationSupported = () => !!SR;

/**
 * Starts listening. onUpdate(finalText, interimText) is called as words arrive. Returns { stop }.
 * onEnd(reason) is called once when listening stops: 'done', 'denied', 'no-speech', 'unsupported' or 'error'.
 */
export function dictate(lang, { onUpdate, onEnd, continuous = true } = {}) {
  if (!SR) { setTimeout(() => onEnd && onEnd('unsupported'), 0); return { stop() {} }; }
  const rec = new SR(); rec.lang = lang || 'en-NG'; rec.continuous = continuous; rec.interimResults = true; rec.maxAlternatives = 1;
  let finalText = '', ended = false, wanted = true, reason = 'done';
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) { const t = e.results[i][0].transcript; if (e.results[i].isFinal) finalText += (finalText ? ' ' : '') + t.trim(); else interim += t; }
    onUpdate && onUpdate(finalText, interim.trim());
  };
  rec.onerror = (e) => { reason = e.error === 'not-allowed' || e.error === 'service-not-allowed' ? 'denied' : e.error === 'no-speech' ? 'no-speech' : e.error === 'aborted' ? 'done' : 'error'; };
  rec.onend = () => {
    // Some browsers stop after a pause. Restart while the learner still wants to dictate.
    if (wanted && continuous && reason === 'done') { try { rec.start(); return; } catch (_) { /* fall through to end */ } }
    if (!ended) { ended = true; onEnd && onEnd(reason, finalText); }
  };
  try { rec.start(); } catch (_) { setTimeout(() => onEnd && onEnd('error', ''), 0); }
  return { stop() { wanted = false; try { rec.stop(); } catch (_) { /* already stopped */ } } };
}

// ── Recorder ─────────────────────────────────────────────────────────────
export function recorderSupport(kind) {
  const ok = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
  if (!ok) return { ok: false, why: 'This browser cannot record. Use a recent Chrome, Edge, Firefox or Safari.' };
  if (!window.isSecureContext) return { ok: false, why: 'Recording needs a secure (https) page.' };
  return { ok: true, mime: bestMime(kind) };
}
export function bestMime(kind) {
  const list = kind === 'video' ? ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'] : ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  return list.find((m) => { try { return MediaRecorder.isTypeSupported(m); } catch (_) { return false; } }) || '';
}

export class Recorder {
  constructor(kind, { maxSeconds = 120, onTick, onLevel, onAutoStop } = {}) { Object.assign(this, { kind, maxSeconds, onTick, onLevel, onAutoStop }); this.chunks = []; this.state = 'idle'; }
  async start(previewEl) {
    const constraints = this.kind === 'video' ? { audio: true, video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 } } } : { audio: { echoCancellation: true, noiseSuppression: true } };
    this.stream = await navigator.mediaDevices.getUserMedia(constraints);
    if (previewEl && this.kind === 'video') { previewEl.srcObject = this.stream; previewEl.muted = true; previewEl.play().catch(() => {}); }
    const mime = bestMime(this.kind);
    this.rec = new MediaRecorder(this.stream, { ...(mime ? { mimeType: mime } : {}), ...(this.kind === 'video' ? { videoBitsPerSecond: 500000, audioBitsPerSecond: 64000 } : { audioBitsPerSecond: 32000 }) });
    this.mime = (this.rec.mimeType || mime || (this.kind === 'video' ? 'video/webm' : 'audio/webm')).split(';')[0];
    this.rec.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.done = new Promise((resolve) => { this.rec.onstop = () => resolve(); });
    this.rec.start(1000);
    this.t0 = Date.now(); this.state = 'recording';
    this.timer = setInterval(() => { const s = (Date.now() - this.t0) / 1000; this.onTick && this.onTick(s); if (s >= this.maxSeconds) { this.onAutoStop && this.onAutoStop(); } }, 250);
    try {
      const AC = window.AudioContext || window.webkitAudioContext; this.ac = new AC(); const src = this.ac.createMediaStreamSource(this.stream); this.an = this.ac.createAnalyser(); this.an.fftSize = 512; src.connect(this.an);
      const buf = new Uint8Array(this.an.fftSize);
      const loop = () => { if (this.state !== 'recording') return; this.an.getByteTimeDomainData(buf); let peak = 0; for (const b of buf) peak = Math.max(peak, Math.abs(b - 128)); this.onLevel && this.onLevel(Math.min(1, peak / 90)); this.raf = requestAnimationFrame(loop); };
      loop();
    } catch (_) { /* a level meter is a nicety */ }
  }
  async stop() {
    if (this.state !== 'recording') return null;
    this.state = 'stopped'; clearInterval(this.timer); cancelAnimationFrame(this.raf);
    const ms = Date.now() - this.t0;
    try { this.rec.stop(); } catch (_) { /* already stopped */ }
    await this.done; this.release();
    return { blob: new Blob(this.chunks, { type: this.mime }), mime: this.mime, durationMs: ms };
  }
  release() { try { this.stream && this.stream.getTracks().forEach((t) => t.stop()); } catch (_) { /* tracks already ended */ } try { this.ac && this.ac.close(); } catch (_) { /* context already closed */ } }
  cancel() { this.state = 'stopped'; clearInterval(this.timer); cancelAnimationFrame(this.raf); try { this.rec && this.rec.state !== 'inactive' && this.rec.stop(); } catch (_) { /* nothing to stop */ } this.release(); }
}

export function micError(e) {
  const n = e && e.name;
  if (n === 'NotAllowedError' || n === 'SecurityError') return 'Cognita was not allowed to use your microphone' + ' (or camera)' + '. Allow it in your browser\u2019s site settings, then try again.';
  if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'No microphone or camera was found on this device.';
  if (n === 'NotReadableError') return 'Another app is using your microphone or camera. Close it and try again.';
  return 'Recording could not start. ' + (e && e.message ? e.message : '');
}

// ── Cues and pace guide (Web Audio) ──────────────────────────────────────
let ctx = null;
function ac() { try { if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)(); if (ctx.state === 'suspended') ctx.resume(); return ctx; } catch (_) { return null; } }
function tone(freq, ms, vol = 0.08, when = 0) {
  const c = ac(); if (!c) return;
  const o = c.createOscillator(), g = c.createGain(); o.type = 'sine'; o.frequency.value = freq;
  const t0 = c.currentTime + when; g.gain.setValueAtTime(0, t0); g.gain.linearRampToValueAtTime(vol, t0 + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t0 + ms / 1000);
  o.connect(g); g.connect(c.destination); o.start(t0); o.stop(t0 + ms / 1000 + 0.02);
}
export const cue = { start() { tone(660, 120); tone(880, 140, 0.08, 0.13); }, stop() { tone(660, 120); tone(440, 160, 0.08, 0.13); } };

let paceTimer = null;
/** A soft tick at a steady pace. wpm is words per minute; one tick per word is a rough guide for a steady speaking rate. */
export function paceGuide(on, wpm = 130) {
  clearInterval(paceTimer); paceTimer = null;
  if (on) paceTimer = setInterval(() => tone(520, 40, 0.035), Math.round(60000 / wpm));
  return !!on;
}
export const paceGuideOn = () => !!paceTimer;
