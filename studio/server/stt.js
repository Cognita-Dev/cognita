// studio/server/stt.js
// Automatic captions for Cognita Studio: speech to text with Workers AI Whisper (@cf/openai/whisper-large-v3-turbo).
// The browser decodes the sound of a clip, turns it into short 16 kHz mono WAV chunks and sends them here one at a time.
// Only SOUND is sent, never the picture. Nothing is stored: the chunk is transcribed and forgotten.
// The caller meters SECONDS OF AUDIO per day (see endpoint.js). Nothing here knows about plans.
//
// Model: https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/
//   input  { audio: <base64 string>, task, language, vad_filter, initial_prompt, ... }
//   output { text, word_count, vtt, transcription_info:{language, duration, ...}, segments:[{start, end, text, words:[{word,start,end}]}] }
// The docs do not state an audio size limit, so chunks are kept small (see MAX_CHUNK_BYTES) and a failure is refunded.

export const MODEL = '@cf/openai/whisper-large-v3-turbo';
export const MAX_CHUNK_SECONDS = 30;                 // the browser cuts at about 25 s and never above this
export const MAX_CHUNK_BYTES = 1.2 * 1024 * 1024;    // 30 s of 16 kHz mono 16-bit WAV is about 0.96 MB
export const MIN_CHARGE_SECONDS = 1;
const BYTES_PER_SECOND_CEILING = 40000;              // bytes / this can only under-count the length, so it is a safe lower bound
const MAX_SEGMENTS = 400;
const MAX_WORDS_PER_SEGMENT = 120;

// Whisper wants bare ISO-639-1 codes. Nigerian English and Pidgin have no Whisper locale, so both use 'en'.
// null means "let Whisper detect the language".
const LANGUAGE_MAP = { 'en-NG': 'en', 'en-GB': 'en', 'en-US': 'en', 'pcm-NG': 'en', 'yo-NG': 'yo', 'ha-NG': 'ha', 'fr-FR': 'fr', auto: null };
export const STT_LANGUAGES = Object.keys(LANGUAGE_MAP);
const PROMPTS = {
  'en-NG': 'Nigerian English. Names and places may include Lagos, Abuja, Ibadan, Port Harcourt, Kano, Enugu, Naira, JAMB, WAEC.',
  'pcm-NG': 'Nigerian Pidgin: how far, abeg, wahala, na so, wetin, dey, sabi, oga.',
};

export const sttAvailable = (env) => String((env && env.STUDIO_STT_DISABLED) || '') !== '1' && !!(env && env.AI);

export function languageFor(requested) {
  const want = String(requested || 'en-NG');
  if (Object.prototype.hasOwnProperty.call(LANGUAGE_MAP, want)) return { key: want, code: LANGUAGE_MAP[want] };
  return { key: 'en-NG', code: 'en' };
}

/** Seconds to reserve before running the model. The browser's claim is only trusted upward; the byte size sets a floor. */
export function estimateSeconds(claimedMs, bytes) {
  const claimed = Math.max(0, Number(claimedMs) || 0) / 1000;
  const floor = bytes / BYTES_PER_SECOND_CEILING;
  return Math.min(MAX_CHUNK_SECONDS + 5, Math.max(MIN_CHARGE_SECONDS, Math.ceil(Math.max(claimed, floor))));
}

function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const t3 = (n) => Math.round((Number(n) || 0) * 1000) / 1000;

/**
 * Runs Whisper on one chunk. Returns { ok:true, text, segments, seconds, language } or { ok:false, code, busy }.
 * `segments` carries word timings when the model returns them; the browser falls back to segment timing when it does not.
 */
export async function transcribeChunk(env, bytes, langKey) {
  const lang = languageFor(langKey);
  const input = { audio: toBase64(bytes), task: 'transcribe', vad_filter: true };
  if (lang.code) input.language = lang.code;
  if (PROMPTS[lang.key]) input.initial_prompt = PROMPTS[lang.key];
  let result;
  try { result = await env.AI.run(MODEL, input); }
  catch (e) {
    console.error('[studio-stt] Whisper failed:', e && e.message);
    const busy = /limit|quota|neuron|capacity|too many|overload|429|4006/i.test(String((e && e.message) || e));
    return { ok: false, code: busy ? 'PROVIDER_BUSY' : 'STT_FAILED', busy };
  }
  const segments = (Array.isArray(result && result.segments) ? result.segments : []).slice(0, MAX_SEGMENTS).map((s) => ({
    start: t3(s.start), end: t3(s.end), text: String(s.text || '').trim().slice(0, 600),
    words: (Array.isArray(s.words) ? s.words : []).slice(0, MAX_WORDS_PER_SEGMENT).map((w) => ({ word: String(w.word || '').trim().slice(0, 60), start: t3(w.start), end: t3(w.end) })).filter((w) => w.word),
  })).filter((s) => s.text);
  const info = (result && result.transcription_info) || {};
  const reported = Number(info.duration);
  return { ok: true, text: String((result && result.text) || '').trim().slice(0, 4000), segments, seconds: Number.isFinite(reported) && reported > 0 ? reported : null, language: String(info.language || '') };
}
