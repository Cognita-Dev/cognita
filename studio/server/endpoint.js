// studio/server/endpoint.js
// Routes for Cognita Studio on the Worker:
//   GET  /api/studio/status  what this account may do (narration allowance, voices)
//   POST /api/studio/tts     one line of narration as MP3 {text, lang, voice, rate}
//   POST /api/studio/stt     one chunk (up to 30 s) of 16 kHz mono WAV sound -> words with timings, for automatic captions
// Narration and automatic captions are part of the Studio plan and the admin override only. The plan is read from the verified uid on the server.
// Image generation for scenes reuses the existing POST /api/image, and storyboards reuse POST /api/chat, so they keep their own limits.

import { requireAuth, describeAuthError } from '../../auth-middleware.js';
import { resolveAccountWithRole } from '../../subscription.js';
import { getPlan, UNLIMITED } from '../../entitlements.js';
import { getUsage, reserveUsage, adjustUsage, nextUsageResetIso } from '../../usage.js';
import { sttAvailable, estimateSeconds, transcribeChunk, STT_LANGUAGES, MAX_CHUNK_BYTES, MAX_CHUNK_SECONDS, MIN_CHARGE_SECONDS } from './stt.js';
import { STUDIO_VOICES, pickVoice, synthesizeStudio, studioTtsAvailable, edgeAvailable, meloAvailable, MAX_CHARS_PER_LINE, RATES } from './tts.js';

const TTS_USAGE = 'studioTts';
const STT_USAGE = 'studioSttSeconds';

const cors = (env, extra) => Object.assign({ 'Access-Control-Allow-Origin': (env && env.APP_ORIGIN) || '*' }, extra || {});
const json = (obj, status, env) => new Response(JSON.stringify(obj), { status: status || 200, headers: cors(env, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }) });
const fail = (message, status, env, code) => json({ error: message, code }, status, env);

function dayLimitFor(account) {
  const plan = getPlan(account.planId);
  return Number(plan.limits.studioTtsCharsPerDay) || 0;
}

function sttLimitFor(account) {
  const plan = getPlan(account.planId);
  return Number(plan.limits.studioSttSecondsPerDay) || 0;
}

async function status(env, uid, account) {
  const limit = dayLimitFor(account);
  const allowed = limit > 0;
  const unlimited = limit >= UNLIMITED;
  let used = 0;
  if (allowed && !unlimited) { try { used = await getUsage(uid, TTS_USAGE, env); } catch (_) { used = 0; } }
  const sLimit = sttLimitFor(account);
  const sAllowed = sLimit > 0;
  const sUnlimited = sLimit >= UNLIMITED;
  let sUsed = 0;
  if (sAllowed && !sUnlimited) { try { sUsed = await getUsage(uid, STT_USAGE, env); } catch (_) { sUsed = 0; } }
  return {
    transcription: {
      allowed: sAllowed,
      available: sttAvailable(env),
      reason: sAllowed ? '' : 'PLAN_REQUIRED',
      unlimited: sUnlimited,
      secondsPerDay: sUnlimited || !sAllowed ? null : sLimit,
      secondsUsed: sUsed,
      secondsLeft: !sAllowed ? 0 : sUnlimited ? null : Math.max(0, sLimit - sUsed),
      resetsAt: nextUsageResetIso(),
      maxChunkSeconds: MAX_CHUNK_SECONDS,
      maxChunkBytes: MAX_CHUNK_BYTES,
      languages: STT_LANGUAGES,
    },
    narration: {
      allowed,
      available: studioTtsAvailable(env),
      reason: allowed ? '' : 'PLAN_REQUIRED',
      unlimited,
      charsPerDay: unlimited || !allowed ? null : limit,
      charsUsed: used,
      charsLeft: !allowed ? 0 : unlimited ? null : Math.max(0, limit - used),
      maxCharsPerLine: MAX_CHARS_PER_LINE,
      rates: RATES,
      engines: { edge: edgeAvailable(env), workersAi: meloAvailable(env) },
      voices: STUDIO_VOICES.map((v) => ({ id: v.id, name: v.name, gender: v.gender, lang: v.lang, default: !!v.default })),
    },
  };
}

async function tts(env, uid, account, body) {
  const limit = dayLimitFor(account);
  if (!(limit > 0)) return fail('Narration in exported videos is part of the Cognita Studio plan.', 403, env, 'PLAN_REQUIRED');
  if (!studioTtsAvailable(env)) return fail('Narration is switched off right now. Captions and music still work.', 503, env, 'TTS_NOT_CONFIGURED');

  const text = String(body.text || '').replace(/\s+/g, ' ').trim();
  if (!text) return fail('There is no text to narrate.', 400, env, 'BAD_TEXT');
  if (text.length > MAX_CHARS_PER_LINE) return fail('That caption is too long to narrate (limit ' + MAX_CHARS_PER_LINE + ' characters). Shorten it or split the scene.', 400, env, 'TOO_LONG');
  const lang = String(body.lang || 'en-NG');
  const voice = pickVoice(lang, String(body.voice || ''));
  if (!voice) return fail('There is no narration voice for that language yet.', 400, env, 'NO_VOICE');
  const rate = RATES.includes(Number(body.rate)) ? Number(body.rate) : 1;

  let reservation = null;
  const charge = async (n) => {
    if (limit >= UNLIMITED) return true;
    reservation = await reserveUsage(uid, TTS_USAGE, n, limit, env);
    return reservation.allowed;
  };
  const r = await synthesizeStudio(env, voice, rate, text, charge);
  if (!r.ok) {
    if (reservation && r.refund) await adjustUsage(uid, TTS_USAGE, -r.refund, reservation.day, env).catch(() => {});
    const msg = {
      TTS_NOT_CONFIGURED: 'Narration is switched off right now. Captions and music still work.',
      DAILY_LIMIT: 'You have used today\u2019s narration allowance. It resets at midnight UTC.',
      TTS_FAILED: 'The narration voice is not available right now. Nothing was counted. Please try again in a few minutes.',
      BAD_TEXT: 'There is no text to narrate.',
    }[r.code] || 'Narration unavailable.';
    return fail(msg, r.code === 'DAILY_LIMIT' ? 429 : r.code === 'BAD_TEXT' ? 400 : 503, env, r.code);
  }
  let left = -1;
  if (limit < UNLIMITED) { try { left = Math.max(0, limit - (await getUsage(uid, TTS_USAGE, env))); } catch (_) { left = -1; } }
  return new Response(r.bytes, {
    status: 200,
    headers: cors(env, {
      'Content-Type': 'audio/mpeg',
      'Cache-Control': 'private, max-age=86400',
      'X-Studio-Engine': r.cached ? 'cache' : r.engine,
      'X-Studio-Voice-Engine': r.engine,
      'X-Studio-Voice': voice.name,
      'X-Studio-Chars-Left': String(left),
      'Access-Control-Expose-Headers': 'X-Studio-Engine,X-Studio-Voice-Engine,X-Studio-Voice,X-Studio-Chars-Left',
    }),
  });
}

const STT_MESSAGES = {
  PLAN_REQUIRED: 'Automatic captions are part of the Cognita Studio plan.',
  STT_NOT_CONFIGURED: 'Automatic captions are switched off right now. You can still type cues or import a subtitle file.',
  DAILY_LIMIT: 'You have used today\u2019s automatic caption time. It resets at midnight UTC.',
  PROVIDER_BUSY: 'The speech service is very busy right now. Nothing was counted. Please try again shortly.',
  STT_FAILED: 'The speech service could not read that audio. Nothing was counted.',
  CHUNK_TOO_LARGE: 'That audio chunk is too large.',
  NO_AUDIO: 'No audio was received.',
  BAD_AUDIO: 'That is not a WAV audio chunk.',
};
const sttFail = (code, status, env, extra) => json(Object.assign({ error: STT_MESSAGES[code] || 'Automatic captions are unavailable.', code }, extra || {}), status, env);

// One chunk of sound in, words with timings out. Gating, in order, all on the server:
//   1. verified identity, then the plan from that uid (never from the browser)    2. kill switch (STUDIO_STT_DISABLED=1)
//   3. size and format checks, before anything is counted                          4. RESERVE an estimate of the seconds against today's allowance
//   5. run Whisper; if it fails the reservation is refunded in full                6. TRUE UP to the length Whisper itself reports
async function stt(env, uid, account, request, url) {
  const limit = sttLimitFor(account);
  if (!(limit > 0)) return sttFail('PLAN_REQUIRED', 403, env);
  if (!sttAvailable(env)) return sttFail('STT_NOT_CONFIGURED', 503, env);
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > MAX_CHUNK_BYTES) return sttFail('CHUNK_TOO_LARGE', 413, env);
  const buf = await request.arrayBuffer();
  if (!buf.byteLength) return sttFail('NO_AUDIO', 400, env);
  if (buf.byteLength > MAX_CHUNK_BYTES) return sttFail('CHUNK_TOO_LARGE', 413, env);
  const bytes = new Uint8Array(buf);
  const tag = (a, b) => String.fromCharCode(...bytes.subarray(a, b));
  if (bytes.length < 64 || tag(0, 4) !== 'RIFF' || tag(8, 12) !== 'WAVE') return sttFail('BAD_AUDIO', 415, env);

  const estimate = estimateSeconds(url.searchParams.get('ms'), bytes.length);
  let reservation = null;
  if (limit < UNLIMITED) {
    try { reservation = await reserveUsage(uid, STT_USAGE, estimate, limit, env); }
    catch (e) { console.error('[studio-stt] usage reserve failed:', e && e.message); return sttFail('STT_FAILED', 503, env, { error: 'Could not check your allowance. Please try again.' }); }
    if (!reservation.allowed) return sttFail('DAILY_LIMIT', 429, env);
  }
  const refund = async () => { if (reservation) await adjustUsage(uid, STT_USAGE, -estimate, reservation.day, env).catch(() => {}); };

  const r = await transcribeChunk(env, bytes, url.searchParams.get('lang'));
  if (!r.ok) { await refund(); return sttFail(r.code, r.busy ? 503 : 502, env); }

  let charged = estimate;
  if (r.seconds) charged = Math.min(MAX_CHUNK_SECONDS + 5, Math.max(MIN_CHARGE_SECONDS, Math.ceil(r.seconds)));
  let usedNow = reservation ? reservation.used : 0;
  if (reservation && charged !== estimate) {
    const total = await adjustUsage(uid, STT_USAGE, charged - estimate, reservation.day, env).catch(() => null);
    if (total !== null && total !== undefined) usedNow = total;
  }
  const left = limit >= UNLIMITED ? null : Math.max(0, limit - usedNow);
  return json({ text: r.text, segments: r.segments, language: r.language, seconds: charged, secondsLeft: left }, 200, env);
}

export async function handleStudioRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/studio\/?/, '').split('/').filter(Boolean);
  let identity;
  try { identity = await requireAuth(request, env); } catch (e) { const a = describeAuthError(e); return fail(a.message, a.status, env); }
  try {
    const account = await resolveAccountWithRole(identity.uid, env);
    if (path[0] === 'status' && request.method === 'GET') return json(await status(env, identity.uid, account), 200, env);
    if (path[0] === 'tts' && request.method === 'POST') return await tts(env, identity.uid, account, await request.json().catch(() => ({})));
    if (path[0] === 'stt' && request.method === 'POST') return await stt(env, identity.uid, account, request, url);
    return fail('Not found.', 404, env);
  } catch (e) {
    console.error('[studio] request failed:', e && e.message);
    return fail('Studio is not available right now. Please try again.', 500, env);
  }
}
