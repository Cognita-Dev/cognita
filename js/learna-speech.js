// js/learna-speech.js
// Speech for Learna, in the browser. Four parts, each used only where it helps learning:
//
//   Voice    Listen to a word, line or paragraph. Same order as Vertex, first that works wins:
//              1. The voice built into this browser (Microsoft Edge ships Ezinne and Abeo for Nigerian English, Denise and Henri for French).
//              2. The same voice streamed from the Worker (free, needs internet).
//              3. Any other voice on the device: Nigerian English, then British English, then any English voice; for other languages
//                 the best installed voice for that language.
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
let audioEl = null, audioDone = null, speakToken = 0, voices = [];
let premiumOff = false;                  // the plan or the server says no premium voice at all: stop asking for this page session
let premiumDownUntil = 0;                // the voice service just failed: use device voices until this time, then try again
const PREMIUM_COOLDOWN_MS = 120000, PREMIUM_TIMEOUT_MS = 14000;
const blobCache = new Map();             // request key -> object URL, so a repeat press plays instantly

function refreshVoices() { try { voices = window.speechSynthesis ? window.speechSynthesis.getVoices() : []; } catch (_) { voices = []; } }
if (typeof window !== 'undefined' && window.speechSynthesis) { refreshVoices(); window.speechSynthesis.addEventListener && window.speechSynthesis.addEventListener('voiceschanged', refreshVoices); }

const normLang = (l) => String(l || '').toLowerCase().replace(/_/g, '-');
// The neural voices as Edge names them in the browser, for example "Microsoft Denise Online (Natural) - French (France)".
// First entry is the default voice, second is the "alt" voice. Same order as VOICES on the server.
const NEURAL_NAMES = { en: [/ezinne/i, /abeo/i], fr: [/denise/i, /henri/i] };
const baseOf = (lang) => normLang(lang).split('-')[0];

/** The built-in neural voice the learner asked for (default or alt), if this browser has it. */
function nativeNeural(lang, want) {
  if (!voices.length) refreshVoices();
  const names = NEURAL_NAMES[baseOf(lang)]; if (!names) return null;
  const re = want === 'alt' ? names[1] : names[0];
  return voices.find((v) => baseOf(v.lang) === baseOf(lang) && re.test(v.name || '')) || null;
}

export function browserVoiceFor(lang, want) {
  if (!voices.length) refreshVoices();
  const l = normLang(lang || 'en-NG'), base = l.split('-')[0];
  // Prefer the neural pair if the device has it, the one asked for first.
  const names = NEURAL_NAMES[base];
  if (names) {
    const order = want === 'alt' ? [names[1], names[0]] : [names[0], names[1]];
    for (const re of order) { const m = voices.find((v) => baseOf(v.lang) === base && re.test(v.name || '')); if (m) return m; }
  }
  const exact = voices.find((v) => normLang(v.lang) === l);
  if (exact) return exact;
  if (base === 'en') return voices.find((v) => /^en-ng/i.test(normLang(v.lang))) || voices.find((v) => /^en-gb/i.test(normLang(v.lang))) || voices.find((v) => /^en-/i.test(normLang(v.lang))) || null;
  return voices.find((v) => normLang(v.lang).startsWith(base)) || null;
}

export function ttsSupported() { return !!(window.speechSynthesis && window.SpeechSynthesisUtterance); }

const premiumUsable = () => !premiumOff && Date.now() >= premiumDownUntil && typeof Audio !== 'undefined' && navigator.onLine !== false;

// One shared <audio> element. Phones only let a page play audio after a tap, and the premium voice starts after a network wait,
// so the element is "unlocked" with a short silent clip inside the first tap. A blob URL keeps this inside the page's media-src policy.
let audioPrimed = false, silentUrl = null;
function sharedAudio() { if (!audioEl) { audioEl = new Audio(); audioEl.preload = 'auto'; } return audioEl; }
function primeAudio() {
  if (audioPrimed || !premiumUsable()) return;
  audioPrimed = true;
  try {
    if (!silentUrl) { const bin = atob('UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAABErAAABAAgAZGF0YQAAAAA='); const u8 = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i); silentUrl = URL.createObjectURL(new Blob([u8], { type: 'audio/wav' })); }
    const a = sharedAudio(); a.dataset.primer = '1'; a.src = silentUrl;
    const pr = a.play(); if (pr && pr.catch) pr.catch((e) => { if (e && e.name === 'NotAllowedError') audioPrimed = false; });   // an AbortError just means the real clip replaced it
  } catch (_) { audioPrimed = false; }
}

export function stopSpeaking() {
  speakToken++;
  if (audioEl) { audioEl.onended = null; audioEl.onerror = null; try { audioEl.pause(); } catch (_) { /* already stopped */ } }
  if (audioDone) { const d = audioDone; audioDone = null; d(); }   // let a waiting speak() finish instead of hanging
  try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (_) { /* nothing playing */ }
}

// Device voices cut off long text after about 15 seconds in Chrome and Edge, so read in sentence sized pieces.
function chunkText(text, max = 180) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t ? [t] : [];
  const out = []; let cur = '';
  for (const raw of t.match(/[^.!?]+[.!?]*/g) || [t]) {
    const sent = raw.trim(); if (!sent) continue;
    if ((cur + ' ' + sent).trim().length <= max) { cur = (cur + ' ' + sent).trim(); continue; }
    if (cur) { out.push(cur); cur = ''; }
    if (sent.length <= max) { cur = sent; continue; }
    let w = '';
    for (const word of sent.split(' ')) { if ((w + ' ' + word).trim().length <= max) w = (w + ' ' + word).trim(); else { if (w) out.push(w); w = word; } }
    cur = w;
  }
  if (cur) out.push(cur);
  return out;
}

async function speakWithBrowser(text, lang, rate, token, hooks, want) {
  if (!ttsSupported()) return { ok: false, reason: 'unsupported' };
  const v = browserVoiceFor(lang, want);
  const pieces = chunkText(text); if (!pieces.length) return { ok: false, reason: 'error' };
  try { window.speechSynthesis.cancel(); } catch (_) { /* nothing playing */ }
  for (let i = 0; i < pieces.length; i++) {
    if (token !== speakToken) return { ok: false, cancelled: true };
    const r = await new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(pieces[i]);
      u.lang = v ? v.lang : lang; if (v) { try { u.voice = v; } catch (_) { /* some engines reject a stale voice object: the language alone still selects a voice */ } } u.rate = rate || 1;
      let watchdog = null; const done = (x) => { if (watchdog) clearInterval(watchdog); resolve(x); };
      u.onstart = () => { if (i === 0 && token === speakToken && hooks.onStart) hooks.onStart({ source: 'browser', voice: v ? v.name : 'your device voice', exact: !!v }); };
      u.onend = () => done({ ok: true });
      u.onerror = (e) => done({ ok: false, reason: e && e.error ? e.error : 'error' });
      try {
        window.speechSynthesis.speak(u);
        watchdog = setInterval(() => { const ss = window.speechSynthesis; if (ss.speaking && !ss.paused) { ss.pause(); ss.resume(); } }, 10000);   // keeps Chrome from stalling mid-passage
      } catch (_) { done({ ok: false, reason: 'error' }); }
    });
    if (token !== speakToken) return { ok: false, cancelled: true };
    if (!r.ok) return { ...r, source: 'browser' };
  }
  return { ok: true, source: 'browser' };
}

const withTimeout = (p, ms) => new Promise((resolve, reject) => { const t = setTimeout(() => reject(new Error('timeout')), ms); p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); }); });

/**
 * Speaks one part of a lesson. `ref` = { course, lesson, step, part, word?, lang?, voice? }, `text` is the same text, used only
 * if the premium voice is unavailable. `api` is the authenticated fetch helper from learna.js.
 * Returns { ok, source: 'premium' | 'browser', note }.
 */
export async function speak(ref, text, api, hooks = {}) {
  stopSpeaking(); const token = ++speakToken;
  primeAudio();   // still inside the learner's tap, so phones allow the audio that follows
  const p = prefs.get(); const lang = ref.lang || 'en-NG'; const want = ref.voice || p.voice; const rate = ref.rate || p.rate;

  // 1. The built-in neural voice, when the browser has it. Instant, and it costs the server nothing.
  if (nativeNeural(lang, want)) {
    const r0 = await speakWithBrowser(text, lang, rate, token, hooks, want);
    if (r0.cancelled) return r0;
    if (r0.ok) return { ...r0, note: '' };
    // an online device voice can fail without a connection: carry on with the Worker voice or another device voice
  }

  // 2. The same voice from the Worker.
  if (premiumUsable()) {
    const body = { course: ref.course, lesson: ref.lesson, step: ref.step, part: ref.part, word: ref.word, lang: ref.lang, voice: want, rate };
    const key = JSON.stringify(body);
    try {
      let url = blobCache.get(key);
      if (!url) {
        const res = await withTimeout(api.blob('/speech/tts', body), PREMIUM_TIMEOUT_MS);
        if (token !== speakToken) return { ok: false, cancelled: true };
        if (!res.ok) { const code = res.code; if (code === 'TTS_NOT_CONFIGURED' || code === 'PLAN_REQUIRED') premiumOff = true; else if (code === 'TTS_FAILED') premiumDownUntil = Date.now() + PREMIUM_COOLDOWN_MS; throw new Error(code || 'tts'); }
        url = URL.createObjectURL(res.blob); blobCache.set(key, url);
        if (blobCache.size > 40) { const first = blobCache.keys().next().value; URL.revokeObjectURL(blobCache.get(first)); blobCache.delete(first); }
      }
      const a = sharedAudio();
      await new Promise((resolve, reject) => {
        audioDone = resolve; a.onended = () => { audioDone = null; resolve(); }; a.onerror = () => { audioDone = null; reject(new Error('play')); };
        delete a.dataset.primer; a.src = url;
        a.play().then(() => { if (hooks.onStart) hooks.onStart({ source: 'premium', voice: want === 'alt' ? 'second voice' : 'premium voice' }); }).catch((e) => { audioDone = null; reject(e); });
      });
      if (token !== speakToken) return { ok: false, cancelled: true };
      return { ok: true, source: 'premium' };
    } catch (e) {
      if (token !== speakToken) return { ok: false, cancelled: true };
      if (e && (e.message === 'timeout' || e.message === 'play' || e.name === 'NotAllowedError' || e.name === 'TypeError')) premiumDownUntil = Date.now() + PREMIUM_COOLDOWN_MS;   // network, timeout or playback trouble: rest the Worker voice for a while
      /* fall through to a device voice */
    }
  }

  // 3. Any device voice.
  const r = await speakWithBrowser(text, lang, rate, token, hooks, want);
  if (r.cancelled) return r;
  if (r.ok) return { ...r, note: browserVoiceFor(lang, want) ? '' : 'Your device has no ' + lang + ' voice installed, so a default voice was used. It may not sound right.' };
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
