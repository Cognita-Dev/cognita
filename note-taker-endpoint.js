import { requireAuth } from './auth-middleware.js';
import { fsGet, fsSet, fsUpdate } from './firestore-rest.js';
import { resolveAccount } from './subscription.js';
import { getPlan } from './entitlements.js';
import { checkAndIncrement } from './usage.js';

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
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;

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
    account = await resolveAccount(identity.uid, env);
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

// Free-tier transcription: the browser records short audio chunks
// (MediaRecorder) and POSTs each one here; this endpoint transcribes it with
// Whisper on the Workers AI free daily allocation (env.AI binding — no
// AI Gateway, no external token, no per-minute billing). This trades true
// word-by-word streaming for a fresh transcript roughly every chunk length,
// in exchange for $0 marginal cost.
export async function handleNoteChunkTranscribe(request, env, sessionId) {
  const identity = await requireAuth(request, env);
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(sessionId)) return json({ error: 'Invalid session id' }, 400, env);

  let plan;
  try {
    const account = await resolveAccount(identity.uid, env);
    plan = getPlan(account.planId);
  } catch (e) {
    return json({ error: 'Could not verify your account. Please try again.' }, 500, env);
  }
  const quota = await checkAndIncrement(identity.uid, 'noteTakerChunks', plan.limits.noteTakerChunksPerDay, env);
  if (!quota.allowed) {
    return json({ error: `You've reached your Note Taker transcription limit for the ${plan.name} plan (${quota.limit} chunks per day).` }, 429, env);
  }

  const audioBuffer = await request.arrayBuffer();
  if (!audioBuffer.byteLength) return json({ error: 'No audio received.' }, 400, env);
  if (audioBuffer.byteLength > MAX_CHUNK_BYTES) return json({ error: 'Audio chunk too large.' }, 413, env);

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
    return json({ error: 'Transcription is temporarily unavailable.' }, 502, env);
  }

  return json({ text: (result?.text || '').trim() }, 200, env);
}

export function noteTakerCors(request, env) {
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': env.APP_ORIGIN || '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS', 'Access-Control-Allow-Headers': 'Authorization,Content-Type,X-Note-Language,X-Note-Context', 'Access-Control-Allow-Credentials': 'true' } });
}
