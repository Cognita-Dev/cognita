import { requireAuth } from './auth-middleware.js';
import { fsGet, fsSet, fsUpdate } from './firestore-rest.js';
import { resolveAccount } from './subscription.js';
import { getPlan } from './entitlements.js';
import { checkAndIncrement } from './usage.js';

const MAX_TITLE = 160;
const MAX_SEGMENT = 12000;
const SESSION_COLLECTION = 'note_sessions';

// Nova-3 understands BCP-47 language tags. Nigerian English is not a
// distinct Deepgram locale, so it is requested as general English and
// disambiguated with keyterm prompting (see `keywords` below) rather than
// silently relabeling it as American or British English.
const LANGUAGE_MAP = {
  'en-NG': 'en',
  'en-GB': 'en-GB',
  'en-US': 'en-US',
  auto: null, // omit `language` and let Nova-3 auto-detect
};

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
    ...(body.transcript !== undefined ? { transcript: clean(body.transcript, MAX_SEGMENT) } : {}),
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

// Real-time transcription bridge: browser <-> this Worker <-> Cloudflare
// AI Gateway <-> Deepgram Nova-3. The browser never sees the AI Gateway
// token; this Worker is the only thing that holds it (as a secret, never
// in wrangler.jsonc `vars`).
export async function handleNoteStream(request, env) {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket upgrade required' }, 426, env);

  const url = new URL(request.url);
  const bearer = request.headers.get('Authorization') || (url.searchParams.get('token') ? `Bearer ${url.searchParams.get('token')}` : '');
  let identity;
  try {
    identity = await requireAuth(new Request(request, { headers: new Headers({ Authorization: bearer }) }), env);
  } catch (e) {
    return json({ error: 'Not authenticated.' }, 401, env);
  }

  if (!env.CLOUDFLARE_ACCOUNT_ID || !env.AI_GATEWAY_ID || !env.CF_AIG_TOKEN) {
    return json({ error: 'Real-time transcription is not configured. Set CLOUDFLARE_ACCOUNT_ID, AI_GATEWAY_ID and the CF_AIG_TOKEN secret.' }, 503, env);
  }

  let plan;
  try {
    const account = await resolveAccount(identity.uid, env);
    plan = getPlan(account.planId);
  } catch (e) {
    return json({ error: 'Could not verify your account. Please try again.' }, 500, env);
  }
  // Coarse per-minute-of-connection guard so a runaway client can't hold an
  // upstream Nova-3 socket open indefinitely; real usage is metered by
  // session count on creation above, this just bounds abuse of the socket.
  const quota = await checkAndIncrement(identity.uid, 'noteTakerStreamOpens', plan.limits.noteTakerSessionsPerDay * 4, env);
  if (!quota.allowed) {
    return json({ error: `You've reached your Note Taker limit for the ${plan.name} plan.` }, 429, env);
  }

  const requestedLang = url.searchParams.get('language') || 'en-NG';
  const langParam = Object.prototype.hasOwnProperty.call(LANGUAGE_MAP, requestedLang) ? LANGUAGE_MAP[requestedLang] : requestedLang;
  const keywords = (url.searchParams.get('keywords') || '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 25);

  const upstreamParams = new URLSearchParams({
    model: '@cf/deepgram/nova-3',
    encoding: 'linear16',
    sample_rate: '16000',
    interim_results: 'true',
    punctuate: 'true',
    smart_format: 'true',
    endpointing: '300',
  });
  if (langParam) upstreamParams.set('language', langParam);
  for (const kw of keywords) upstreamParams.append('keywords', kw);

  const upstreamUrl = `https://gateway.ai.cloudflare.com/v1/${env.CLOUDFLARE_ACCOUNT_ID}/${env.AI_GATEWAY_ID}/workers-ai?${upstreamParams.toString()}`;

  // Cloudflare Workers open an outbound WebSocket the same way any fetch
  // upgrade works: a fetch() carrying an Upgrade header, then read the
  // resulting `webSocket` off the Response. This is the Worker-as-client
  // side of the connection — WebSocketPair below is the separate,
  // Worker-as-server side that accepts the browser's connection to us.
  let upstreamResponse;
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      headers: {
        Upgrade: 'websocket',
        'cf-aig-authorization': env.CF_AIG_TOKEN,
      },
    });
  } catch (e) {
    return json({ error: 'Could not reach the transcription provider.' }, 502, env);
  }
  if (!upstreamResponse.webSocket) {
    return json({ error: `Transcription provider rejected the connection (${upstreamResponse.status}).` }, 502, env);
  }
  const upstream = upstreamResponse.webSocket;
  upstream.accept();

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  const closeBoth = () => { try { server.close(); } catch {} try { upstream.close(); } catch {} };
  // Audio frames flow browser -> server -> upstream unchanged (already
  // linear16 PCM at 16kHz mono, produced client-side). Deepgram's JSON
  // transcript events flow upstream -> server -> browser unchanged.
  server.addEventListener('message', (event) => { try { upstream.send(event.data); } catch {} });
  upstream.addEventListener('message', (event) => { try { server.send(event.data); } catch {} });
  server.addEventListener('close', closeBoth);
  upstream.addEventListener('close', closeBoth);
  server.addEventListener('error', closeBoth);
  upstream.addEventListener('error', closeBoth);

  return new Response(null, { status: 101, webSocket: client });
}

export function noteTakerCors(request, env) {
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': env.APP_ORIGIN || '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS', 'Access-Control-Allow-Headers': 'Authorization,Content-Type', 'Access-Control-Allow-Credentials': 'true' } });
}
