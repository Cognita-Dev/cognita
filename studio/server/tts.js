// studio/server/tts.js
// Narration for Cognita Studio videos. Two engines, tried in this order:
//   1. Microsoft Edge neural voices through learna/edge-tts.js. The same free engine Learna already uses, so it costs $0 and
//      has Nigerian English voices (Ezinne, Abeo). It is an unofficial service and can disappear.
//   2. Workers AI MeloTTS (@cf/myshell-ai/melotts) as the backup. About 19 neurons per audio minute, so a full day of narration for
//      a Studio user is a tiny fraction of the 10,000 free neurons per day. English and French only, no speed control.
// Every line is synthesised once and kept in B2. Asking for the same words with the same voice again is free and instant.
// The caller meters characters per day (see endpoint.js). Nothing here knows about plans.

import { b2UploadFile, b2DownloadFileBytes } from '../../b2-client.js';
import { edgeTtsSynthesize } from '../../learna/edge-tts.js';

export const STUDIO_VOICES = [
  { id: 'ezinne', name: 'Ezinne', gender: 'female', lang: 'en-NG', neural: 'en-NG-EzinneNeural', default: true },
  { id: 'abeo', name: 'Abeo', gender: 'male', lang: 'en-NG', neural: 'en-NG-AbeoNeural' },
  { id: 'sonia', name: 'Sonia', gender: 'female', lang: 'en-GB', neural: 'en-GB-SoniaNeural', default: true },
  { id: 'ryan', name: 'Ryan', gender: 'male', lang: 'en-GB', neural: 'en-GB-RyanNeural' },
  { id: 'jenny', name: 'Jenny', gender: 'female', lang: 'en-US', neural: 'en-US-JennyNeural', default: true },
  { id: 'guy', name: 'Guy', gender: 'male', lang: 'en-US', neural: 'en-US-GuyNeural' },
  { id: 'denise', name: 'Denise', gender: 'female', lang: 'fr-FR', neural: 'fr-FR-DeniseNeural', default: true },
  { id: 'henri', name: 'Henri', gender: 'male', lang: 'fr-FR', neural: 'fr-FR-HenriNeural' },
];

export const MAX_CHARS_PER_LINE = 600;
export const RATES = [0.75, 0.9, 1, 1.1, 1.25];
const MELO_LANG = { 'en-NG': 'en', 'en-GB': 'en', 'en-US': 'en', 'fr-FR': 'fr' };

export function pickVoice(lang, want) {
  const forLang = STUDIO_VOICES.filter((v) => v.lang === lang);
  if (!forLang.length) return null;
  return forLang.find((v) => v.id === want) || forLang.find((v) => v.default) || forLang[0];
}

export const edgeAvailable = (env) => String((env && env.STUDIO_EDGE_TTS_DISABLED) || '') !== '1' && String((env && env.LEARNA_TTS_DISABLED) || '') !== '1';
export const meloAvailable = (env) => !!(env && env.AI) && String((env && env.STUDIO_MELO_TTS_DISABLED) || '') !== '1';
export const studioTtsAvailable = (env) => String((env && env.STUDIO_TTS_DISABLED) || '') !== '1' && (edgeAvailable(env) || meloAvailable(env));

async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Text is cleaned the same way for the cache key and for synthesis, so equal words always share one cached file. */
export function cleanText(text) {
  return String(text || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ').replace(/\s+/g, ' ').trim();
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Workers AI has returned audio as a base64 string in an object, as raw bytes, or as a stream, depending on model version.
async function meloBytes(env, text, lang) {
  const r = await env.AI.run('@cf/myshell-ai/melotts', { prompt: text, lang });
  if (r && typeof r === 'object' && typeof r.audio === 'string') return b64ToBytes(r.audio);
  if (typeof r === 'string') return b64ToBytes(r);
  if (r instanceof Uint8Array) return r;
  if (r instanceof ArrayBuffer) return new Uint8Array(r);
  if (r && typeof r.getReader === 'function') return new Uint8Array(await new Response(r).arrayBuffer());
  throw new Error('unexpected MeloTTS response');
}

async function readCache(env, key) {
  try {
    const hit = await b2DownloadFileBytes(env, key);
    if (hit && hit.body) return new Uint8Array(await new Response(hit.body).arrayBuffer());
  } catch (_) { /* a miss or a storage hiccup: synthesise instead */ }
  return null;
}

/**
 * Returns { ok:true, bytes, engine:'edge'|'workers-ai', cached, chars } or { ok:false, code, refund? }.
 * `charge(n)` is called with the characters about to be synthesised and returns false when today's allowance is spent.
 */
export async function synthesizeStudio(env, voice, rate, rawText, charge) {
  if (!studioTtsAvailable(env)) return { ok: false, code: 'TTS_NOT_CONFIGURED' };
  const text = cleanText(rawText);
  if (!text) return { ok: false, code: 'BAD_TEXT' };
  const edgeKey = 'studio-tts/' + (await sha256Hex(voice.neural + '|' + rate + '|' + text)).slice(0, 40) + '.mp3';
  const meloKey = 'studio-tts-melo/' + (await sha256Hex((MELO_LANG[voice.lang] || '') + '|' + text)).slice(0, 40) + '.mp3';

  if (edgeAvailable(env)) {
    const hit = await readCache(env, edgeKey);
    if (hit) return { ok: true, bytes: hit, engine: 'edge', cached: true, chars: 0 };
  }
  if (meloAvailable(env) && MELO_LANG[voice.lang]) {
    const hit = await readCache(env, meloKey);
    // A backup-voice file is only reused when the better voice is switched off, so Edge audio is preferred whenever it works.
    if (hit && !edgeAvailable(env)) return { ok: true, bytes: hit, engine: 'workers-ai', cached: true, chars: 0 };
  }

  if (charge && !(await charge(text.length))) return { ok: false, code: 'DAILY_LIMIT' };

  if (edgeAvailable(env)) {
    try {
      const bytes = await edgeTtsSynthesize(text, voice.neural, rate);
      if (bytes && bytes.length) {
        try { await b2UploadFile(env, edgeKey, bytes, 'audio/mpeg'); } catch (e) { console.error('[studio-tts] cache write failed:', e.message); }
        return { ok: true, bytes, engine: 'edge', cached: false, chars: text.length };
      }
    } catch (e) { console.warn('[studio-tts] edge voice failed, trying Workers AI:', e && e.message); }
  }
  if (meloAvailable(env) && MELO_LANG[voice.lang]) {
    try {
      const bytes = await meloBytes(env, text, MELO_LANG[voice.lang]);
      if (bytes && bytes.length) {
        try { await b2UploadFile(env, meloKey, bytes, 'audio/mpeg'); } catch (e) { console.error('[studio-tts] cache write failed:', e.message); }
        return { ok: true, bytes, engine: 'workers-ai', cached: false, chars: text.length };
      }
    } catch (e) { console.error('[studio-tts] Workers AI voice failed:', e && e.message); }
  }
  return { ok: false, code: 'TTS_FAILED', refund: text.length };
}
