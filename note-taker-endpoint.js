import { requireAuth, describeAuthError } from './auth-middleware.js';
import { fsGet, fsSet, fsUpdate } from './firestore-rest.js';
import { resolveAccountWithRole } from './subscription.js';
import { getPlan, UNLIMITED } from './entitlements.js';
import { checkAndIncrement, getUsage, reserveUsage, adjustUsage, nextUsageResetIso } from './usage.js';

const MAX_TITLE = 160;
const MAX_SEGMENT = 12000;
const MAX_TRANSCRIPT = 200000; // full-meeting transcript; 12k silently truncated notes after ~15 minutes
const MAX_CONTEXT = 400;
const SESSION_COLLECTION = 'note_sessions';

// Whisper wants bare ISO-639-1 codes ('yo', 'fr'), not BCP-47 tags. The old
// code passed 'yo-NG' / 'fr-FR' straight through, which Whisper rejects.
// Nigerian English and Pidgin have no Whisper locale, so both use 'en' and
// lean on the context prompt below to pull in Nigerian names and vocabulary.
// `auto` omits the hint so Whisper detects the language itself.
const LANGUAGE_MAP = { 'en-NG': 'en', 'en-GB': 'en', 'en-US': 'en', 'pcm-NG': 'en', 'yo-NG': 'yo', 'ha-NG': 'ha', 'fr-FR': 'fr', auto: null };
const BASE_PROMPTS = {
  'en-NG': 'A meeting in Nigerian English. Names and places may include Lagos, Abuja, Ibadan, Port Harcourt, Kano, Enugu, Naira, NNPC, JAMB, WAEC, Adebayo, Chukwuemeka, Ibrahim, Ngozi.',
  'pcm-NG': 'Nigerian Pidgin conversation: how far, abeg, wahala, na so, wetin, dey, sabi, oga.',
  'yo-NG': 'Ọ̀rọ̀ ní èdè Yorùbá. Ẹ kú àárọ̀, ẹ ṣé, Ọ̀gbẹ́ni, Ìbàdàn, Èkó, Ọ̀yọ́.',
};

// ---------- Cloud (Whisper) transcription allowance ----------
// Metered in SECONDS OF AUDIO per UTC day, per plan (entitlements.js:
// noteTakerWhisperSecondsPerDay). Only this endpoint spends it. The browser's
// own SpeechRecognition never reaches the server, so it is free and uncounted.
// The client only ever displays what this file reports; it never reports usage.
const WHISPER_RESOURCE = 'noteTakerWhisperSeconds';
const MAX_CHUNK_BYTES = 1.5 * 1024 * 1024; // a 14 s chunk is ~250 KB at worst; anything bigger is not a real chunk
const MIN_CHARGE_SECONDS = 1;
const MAX_ESTIMATE_SECONDS = 60;   // most one request can reserve up front
const MAX_CHARGE_SECONDS = 120;    // most one request can be charged after Whisper reports the real length
const BYTES_PER_SECOND_CEILING = 40000; // 320 kbps: no speech recording is denser, so bytes / this can only under-count the length
const UPGRADE_PATH = ['free', 'plus', 'studio'];

function json(data, status = 200, env) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...(env.APP_ORIGIN ? { 'Access-Control-Allow-Origin': env.APP_ORIGIN } : {}) } });
}
function sessionPath(uid, id) { return `${SESSION_COLLECTION}/${uid}_${id}`; }
function clean(value, max) { return String(value ?? '').trim().slice(0, max); }

export async function handleNoteSession(request, env, sessionId) {
  const identity = await requireAuth(request, env);
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(sessionId)) return json({ error: 'Invalid session id' }, 400, env);
  const path = sessionPath(identity.uid, sessionId);
  if (request.method === 'GET') {
    const session = await fsGet(path, env);
    if (!session) return json({ error: 'Session not found' }, 404, env);
    return json(session, 200, env);
  }
  if (request.method !== 'PATCH') return json({ error: 'Method not allowed' }, 405, env);
  const body = await request.json().catch(() => ({}));
  const existing = await fsGet(path, env);
  if (!existing) return json({ error: 'Session not found' }, 404, env);
  const expectedVersion = Number(body.version);
  if (!Number.isInteger(expectedVersion) || expectedVersion !== Number(existing.version)) return json({ error: 'Version conflict', session: existing }, 409, env);
  const patch = {
    ...(body.title !== undefined ? { title: clean(body.title, MAX_TITLE) || 'Untitled meeting' } : {}),
    ...(body.status !== undefined ? { status: ['recording', 'paused', 'completed', 'failed'].includes(body.status) ? body.status : existing.status } : {}),
    ...(body.transcript !== undefined ? { transcript: clean(body.transcript, MAX_TRANSCRIPT) } : {}),
    ...(body.updatedAt !== undefined ? { updatedAt: clean(body.updatedAt, 40) } : {}),
    version: expectedVersion + 1,
  };
  await fsUpdate(path, patch, env);
  return json({ ...existing, ...patch }, 200, env);
}

export async function handleNoteSessionCreate(request, env) {
  const identity = await requireAuth(request, env);
  let account;
  try {
    account = await resolveAccountWithRole(identity.uid, env);
  } catch (e) {
    console.error('[note-taker] account resolution failed:', e.message);
    return json({ error: 'Could not verify your account. Please try again.' }, 500, env);
  }
  const plan = getPlan(account.planId);
  const quota = await checkAndIncrement(identity.uid, 'noteTakerSessions', plan.limits.noteTakerSessionsPerDay, env);
  if (!quota.allowed) {
    return json({ error: `You've reached your Note Taker limit for the ${plan.name} plan (${quota.limit} sessions per day).` }, 429, env);
  }
  const body = await request.json().catch(() => ({}));
  const id = crypto.randomUUID().replaceAll('-', '');
  const now = new Date().toISOString();
  const session = { id, uid: identity.uid, title: clean(body.title, MAX_TITLE) || 'Untitled meeting', language: clean(body.language, 16) || 'en-NG', status: 'recording', transcript: '', version: 1, createdAt: now, updatedAt: now };
  await fsSet(sessionPath(identity.uid, id), session, env);
  return json(session, 201, env);
}

export async function handleNoteSessionSegment(request, env, sessionId) {
  const identity = await requireAuth(request, env);
  const body = await request.json().catch(() => ({}));
  const segmentId = clean(body.segmentId, 100);
  const text = clean(body.text, MAX_SEGMENT);
  if (!segmentId || !text) return json({ error: 'segmentId and text are required' }, 400, env);
  const path = `${SESSION_COLLECTION}/${identity.uid}_${sessionId}/segments/${segmentId}`;
  await fsSet(path, { id: segmentId, sessionId, uid: identity.uid, text, startMs: Math.max(0, Number(body.startMs) || 0), endMs: Math.max(0, Number(body.endMs) || 0), speaker: clean(body.speaker, 100) || null, createdAt: new Date().toISOString() }, env);
  return json({ ok: true, segmentId }, 201, env);
}

// Cloud transcription: the browser records short audio chunks (MediaRecorder)
// and POSTs each one here; this endpoint transcribes it with Whisper on
// Workers AI (env.AI binding, no external token). This trades true
// word-by-word streaming for a fresh transcript roughly every chunk length.
//
// Gating, in order, all server-side:
//   1. verified identity, then the plan resolved from that uid (never from the client)
//   2. size checks, before anything is charged
//   3. RESERVE an estimate of the chunk's length against today's allowance.
//      Already at or over the limit -> 429 WHISPER_QUOTA_EXHAUSTED, Whisper is never called.
//   4. run Whisper. If it fails, the reservation is refunded in full.
//   5. TRUE UP to the duration Whisper itself reports (transcription_info.duration),
//      so a client that under-reports the length cannot get cheap audio.
// Every response carries the fresh `quota` snapshot so the UI stays in step.
function authFailure(e, env) {
  const a = describeAuthError(e);
  return json({ error: a.message, ...(a.code ? { code: a.code } : {}) }, a.status, env);
}

async function planFor(uid, env) {
  const account = await resolveAccountWithRole(uid, env);
  return { account, plan: getPlan(account.planId) };
}

function upgradeOption(planId) {
  const i = UPGRADE_PATH.indexOf(planId);
  if (i === -1 || i === UPGRADE_PATH.length - 1) return null; // Studio and admin have nothing above them
  const next = getPlan(UPGRADE_PATH[i + 1]);
  return { id: next.id, name: next.name, limitSeconds: next.limits.noteTakerWhisperSecondsPerDay };
}

// `used` is the raw day total, which can sit a few seconds past the limit
// (the last chunk is allowed to finish). Everything shown is clamped.
function quotaSnapshot(plan, used) {
  const limit = plan.limits.noteTakerWhisperSecondsPerDay;
  const unlimited = limit >= UNLIMITED;
  const usedSeconds = unlimited ? Math.max(0, used) : Math.min(Math.max(0, used), limit);
  return {
    unlimited,
    limitSeconds: unlimited ? null : limit,
    usedSeconds,
    remainingSeconds: unlimited ? null : Math.max(0, limit - used),
    resetsAt: nextUsageResetIso(),
    planId: plan.id,
    planName: plan.name,
    upgrade: unlimited ? null : upgradeOption(plan.id),
  };
}

function exhaustedMessage(plan) {
  return `You have used all of today's cloud transcription on the ${plan.name} plan. Live recognition in your browser is still free.`;
}

function estimateSeconds(claimedHeader, bytes) {
  const claimed = Math.max(0, Number(claimedHeader) || 0) / 1000;
  const floor = bytes / BYTES_PER_SECOND_CEILING;
  return Math.min(MAX_ESTIMATE_SECONDS, Math.max(MIN_CHARGE_SECONDS, Math.ceil(Math.max(claimed, floor))));
}

export async function handleNoteQuota(request, env) {
  let identity;
  try { identity = await requireAuth(request, env); } catch (e) { return authFailure(e, env); }
  let plan;
  try { ({ plan } = await planFor(identity.uid, env)); }
  catch (e) { console.error('[note-taker] quota: account resolution failed:', e.message); return json({ error: 'Could not load your transcription allowance. Please try again.' }, 500, env); }
  const metered = plan.limits.noteTakerWhisperSecondsPerDay < UNLIMITED;
  let used = 0;
  if (metered) {
    try { used = await getUsage(identity.uid, WHISPER_RESOURCE, env); }
    catch (e) { console.error('[note-taker] quota: usage read failed:', e.message); return json({ error: 'Could not load your transcription allowance. Please try again.' }, 500, env); }
  }
  return json({
    quota: quotaSnapshot(plan, used),
    audioMaxMB: Math.min(plan.limits.noteAudioMaxMB || 0, 30), // largest recording kept with a saved note; 0 = not included
    asksPerDay: plan.limits.noteTakerAsksPerDay < UNLIMITED ? plan.limits.noteTakerAsksPerDay : null,
  }, 200, env);
}

export async function handleNoteChunkTranscribe(request, env, sessionId) {
  let identity;
  try { identity = await requireAuth(request, env); } catch (e) { return authFailure(e, env); }
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(sessionId)) return json({ error: 'Invalid session id' }, 400, env);

  let plan;
  try { ({ plan } = await planFor(identity.uid, env)); }
  catch (e) { console.error('[note-taker] account resolution failed:', e.message); return json({ error: 'Could not verify your account. Please try again.', code: 'ACCOUNT_UNAVAILABLE' }, 500, env); }
  const limit = plan.limits.noteTakerWhisperSecondsPerDay;
  const metered = limit < UNLIMITED;

  // Reject bad uploads before they can cost anything.
  const declared = Number(request.headers.get('Content-Length') || 0);
  if (declared > MAX_CHUNK_BYTES) return json({ error: 'Audio chunk too large.', code: 'CHUNK_TOO_LARGE' }, 413, env);
  const audioBuffer = await request.arrayBuffer();
  if (!audioBuffer.byteLength) return json({ error: 'No audio received.', code: 'NO_AUDIO' }, 400, env);
  if (audioBuffer.byteLength > MAX_CHUNK_BYTES) return json({ error: 'Audio chunk too large.', code: 'CHUNK_TOO_LARGE' }, 413, env);

  // Reserve first. If the allowance cannot be checked we refuse rather than give away free Whisper time.
  const estimate = estimateSeconds(request.headers.get('X-Audio-Duration-Ms'), audioBuffer.byteLength);
  let reservation = null;
  if (metered) {
    try { reservation = await reserveUsage(identity.uid, WHISPER_RESOURCE, estimate, limit, env); }
    catch (e) { console.error('[note-taker] usage reserve failed:', e.message); return json({ error: 'Could not check your transcription allowance. Please try again.', code: 'QUOTA_UNAVAILABLE' }, 503, env); }
    if (!reservation.allowed) {
      return json({ error: exhaustedMessage(plan), code: 'WHISPER_QUOTA_EXHAUSTED', quota: quotaSnapshot(plan, reservation.used) }, 429, env);
    }
  }
  const refund = async () => { if (reservation) await adjustUsage(identity.uid, WHISPER_RESOURCE, -estimate, reservation.day, env).catch((e) => console.error('[note-taker] refund failed:', e.message)); };

  const requestedLang = request.headers.get('X-Note-Language') || 'en-NG';
  const langHint = Object.prototype.hasOwnProperty.call(LANGUAGE_MAP, requestedLang) ? LANGUAGE_MAP[requestedLang] : requestedLang.split('-')[0];
  let context = '';
  try { context = decodeURIComponent(request.headers.get('X-Note-Context') || '').slice(-MAX_CONTEXT); } catch { /* malformed header: ignore */ }
  const prompt = [BASE_PROMPTS[requestedLang], context].filter(Boolean).join(' ').slice(-800);

  let result;
  try {
    // large-v3-turbo takes base64 audio and handles accented speech far better
    // than base whisper, for ~13% more neurons per minute.
    const bytes = new Uint8Array(audioBuffer);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    const input = { audio: btoa(bin), task: 'transcribe', vad_filter: true };
    if (langHint) input.language = langHint;
    if (prompt) input.initial_prompt = prompt;
    result = await env.AI.run('@cf/openai/whisper-large-v3-turbo', input);
  } catch (e) {
    console.error('[note-taker] Whisper transcription failed:', e.message);
    await refund(); // our failure must never cost the person their allowance
    const snapshot = quotaSnapshot(plan, reservation ? Math.max(0, reservation.used - estimate) : 0);
    // Workers AI has its own account-wide daily allocation. Hitting it is not the person's doing, and
    // the client answers it differently (fall back to the free browser engine) from a personal limit.
    const busy = /limit|quota|neuron|capacity|too many|overload|429|4006/i.test(String(e?.message || e));
    return json({
      error: busy ? 'Cloud transcription is very busy right now. Please try again shortly.' : 'Transcription is temporarily unavailable.',
      code: busy ? 'PROVIDER_BUSY' : 'TRANSCRIPTION_FAILED',
      quota: snapshot,
    }, busy ? 503 : 502, env);
  }

  // True up to the length Whisper actually processed.
  let charged = estimate;
  const reported = Number(result?.transcription_info?.duration);
  if (Number.isFinite(reported) && reported > 0) charged = Math.min(MAX_CHARGE_SECONDS, Math.max(MIN_CHARGE_SECONDS, Math.ceil(reported)));
  let usedNow = reservation ? reservation.used : 0;
  if (reservation && charged !== estimate) {
    const total = await adjustUsage(identity.uid, WHISPER_RESOURCE, charged - estimate, reservation.day, env).catch((e) => { console.error('[note-taker] true-up failed:', e.message); return null; });
    if (total !== null) usedNow = total;
  }

  return json({ text: (result?.text || '').trim(), seconds: charged, quota: quotaSnapshot(plan, usedNow) }, 200, env);
}

export function noteTakerCors(request, env) {
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': env.APP_ORIGIN || '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS', 'Access-Control-Allow-Headers': 'Authorization,Content-Type,X-Note-Language,X-Note-Context,X-Audio-Duration-Ms', 'Access-Control-Allow-Credentials': 'true' } });
}
