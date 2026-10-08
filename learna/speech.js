// learna/speech.js
// Server side of Learna's speech features.
//
// TTS ($0 design). Premium voices come from Azure AI Speech on the Free (F0) tier, which includes 0.5 million neural characters
// a month. Three things keep it free:
//   1. Every phrase is synthesised once and kept in storage (B2). The next learner who presses Listen on it costs nothing.
//   2. The text is never sent by the browser. The browser names a course, lesson, step and part; the server finds the text
//      in the course itself. So the endpoint cannot be used as a free general text-to-speech service.
//   3. A monthly character budget (LEARNA_TTS_MONTHLY_CAP, default 400000) stops synthesis before the free allowance runs out.
//      Past it, the app falls back to the browser voice. Nothing is ever billed.
// If AZURE_SPEECH_KEY is not set, or Azure fails, the endpoint answers with a code and the browser speaks with its own voice.
//
// Transcription of recorded speech uses Whisper on Workers AI (the same binding the Note Taker uses).

import { b2UploadFile, b2DownloadFileBytes } from '../b2-client.js';
import { flatLessons } from './engine.js';

export const VOICES = [
  { id: 'ezinne', name: 'Ezinne', gender: 'female', lang: 'en-NG', azure: 'en-NG-EzinneNeural', default: true },
  { id: 'abeo', name: 'Abeo', gender: 'male', lang: 'en-NG', azure: 'en-NG-AbeoNeural' },
  { id: 'denise', name: 'Denise', gender: 'female', lang: 'fr-FR', azure: 'fr-FR-DeniseNeural', default: true },
  { id: 'henri', name: 'Henri', gender: 'male', lang: 'fr-FR', azure: 'fr-FR-HenriNeural' },
];

export const defaultLangFor = (course) => (course.language && course.language.tts) || 'en-NG';

/** Picks a voice for a language. `want` is a voice id, or 'alt' for the second voice. */
export function pickVoice(lang, want) {
  const forLang = VOICES.filter((v) => v.lang === lang);
  if (!forLang.length) return null;
  if (want === 'alt') return forLang.find((v) => !v.default) || forLang[0];
  return forLang.find((v) => v.id === want) || forLang.find((v) => v.default) || forLang[0];
}

export const plain = (s) => String(s || '').replace(/\[\[|\]\]/g, '');

/**
 * Finds the text a part of a step refers to. part: 'text:N' (paragraph), 'example' (the whole example),
 * 'example:N' (one line), 'target' (speaking task), 'prompt', or 'word' (a single word that must appear in the step).
 */
export function textForPart(course, lessonKey, stepId, part, word) {
  const f = flatLessons(course).find((x) => x.key === lessonKey);
  if (!f) return null;
  const st = f.lesson.steps.find((x) => x.id === stepId);
  if (!st) return null;
  const corpus = [];
  if (st.kind === 'teach') { st.text.forEach((t) => corpus.push(plain(t))); if (st.example) corpus.push(plain(st.example.text)); }
  else { corpus.push(plain(st.prompt || '')); if (st.target) corpus.push(plain(st.target)); (st.options || []).forEach((o) => corpus.push(plain(o.text))); }
  let text = null;
  if (part === 'word') {
    const w = String(word || '').trim();
    if (!w || w.length > 40 || /\s{2,}/.test(w)) return null;
    const hay = corpus.join('\n').toLowerCase();
    text = hay.includes(w.toLowerCase()) ? w : null;
  } else if (part === 'target') text = st.target ? plain(st.target).replace(/\s*\/\s*/g, '. ') : null;
  else if (part === 'prompt') text = st.prompt ? plain(st.prompt) : null;
  else if (part === 'example') text = st.example ? plain(st.example.text).replace(/\n+/g, ' ') : null;
  else if (/^example:\d+$/.test(part)) { const lines = st.example ? plain(st.example.text).split('\n') : []; text = lines[+part.split(':')[1]] || null; }
  else if (/^text:\d+$/.test(part)) text = st.kind === 'teach' ? (st.text[+part.split(':')[1]] ? plain(st.text[+part.split(':')[1]]) : null) : null;
  if (!text) return null;
  text = text.replace(/\s+/g, ' ').trim();
  return text.length && text.length <= 900 ? text : null;
}

export async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function buildSsml(text, voice, rate) {
  const pct = rate && rate !== 1 ? ' rate="' + Math.round((rate - 1) * 100) + '%"' : '';
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${voice.lang}"><voice name="${voice.azure}"><prosody${pct}>${esc(text)}</prosody></voice></speak>`;
}

export const ttsKeyFor = async (voice, rate, text) => 'learna-tts/' + (await sha256Hex(voice.azure + '|' + (rate || 1) + '|' + text)).slice(0, 40) + '.mp3';

const monthKey = () => 'learna:tts:' + new Date().toISOString().slice(0, 7);

export async function monthlyUsed(env) {
  if (!env.COGNITA_USAGE) return 0;
  return parseInt((await env.COGNITA_USAGE.get(monthKey())) || '0', 10) || 0;
}
export const monthlyCap = (env) => parseInt(env.LEARNA_TTS_MONTHLY_CAP || '400000', 10);
async function addMonthly(env, n) {
  if (!env.COGNITA_USAGE) return;
  await env.COGNITA_USAGE.put(monthKey(), String((await monthlyUsed(env)) + n), { expirationTtl: 40 * 86400 });
}

export const premiumAvailable = (env) => !!(env.AZURE_SPEECH_KEY && env.AZURE_SPEECH_REGION);

/**
 * Returns { ok:true, bytes, cached, chars } or { ok:false, code }.
 * `charge(n)` is called with the characters about to be synthesised; it returns false when the learner's daily allowance is spent.
 */
export async function synthesize(env, voice, rate, text, charge) {
  if (!premiumAvailable(env)) return { ok: false, code: 'TTS_NOT_CONFIGURED' };
  const key = await ttsKeyFor(voice, rate, text);
  try { const hit = await b2DownloadFileBytes(env, key); if (hit && hit.body) return { ok: true, bytes: new Uint8Array(await new Response(hit.body).arrayBuffer()), cached: true, chars: 0 }; } catch (_) { /* a cache miss or a storage hiccup: carry on and synthesise */ }
  if ((await monthlyUsed(env)) + text.length > monthlyCap(env)) return { ok: false, code: 'TTS_BUDGET' };
  if (charge && !(await charge(text.length))) return { ok: false, code: 'DAILY_LIMIT' };
  let res;
  try {
    res = await fetch('https://' + env.AZURE_SPEECH_REGION + '.tts.speech.microsoft.com/cognitiveservices/v1', {
      method: 'POST',
      headers: { 'Ocp-Apim-Subscription-Key': env.AZURE_SPEECH_KEY, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3', 'User-Agent': 'cognita-learna' },
      body: buildSsml(text, voice, rate),
    });
  } catch (_) { return { ok: false, code: 'TTS_FAILED', refund: text.length }; }
  if (res.status === 429 || res.status === 403) return { ok: false, code: 'TTS_BUDGET', refund: text.length };
  if (!res.ok) return { ok: false, code: 'TTS_FAILED', refund: text.length };
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (!bytes.length) return { ok: false, code: 'TTS_FAILED', refund: text.length };
  await addMonthly(env, text.length);
  try { await b2UploadFile(env, key, bytes, 'audio/mpeg'); } catch (e) { console.error('[learna-tts] cache write failed:', e.message); }
  return { ok: true, bytes, cached: false, chars: text.length };
}

// ── Transcription ───────────────────────────────────────────────────────
const LANG = { 'en-NG': 'en', 'en-GB': 'en', 'en-US': 'en', 'fr-FR': 'fr' };

/** Whisper on Workers AI. Returns { text, seconds } or throws. */
export async function transcribe(env, bytes, lang) {
  if (!env.AI) throw new Error('AI binding missing');
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const input = { audio: btoa(bin), task: 'transcribe', vad_filter: true };
  if (LANG[lang]) input.language = LANG[lang];
  if ((lang || '').startsWith('en')) input.initial_prompt = 'A speaker practising a short talk in English. Nigerian English is common.';
  const r = await env.AI.run('@cf/openai/whisper-large-v3-turbo', input);
  const seconds = Number(r && r.transcription_info && r.transcription_info.duration);
  return { text: String((r && r.text) || '').trim(), seconds: Number.isFinite(seconds) && seconds > 0 ? seconds : 0 };
}
