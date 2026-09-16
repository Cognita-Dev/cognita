import { requireAuth } from './auth-middleware.js';
import { fsGet, fsSet, fsUpdate } from './firestore-rest.js';

const MAX_TITLE = 160;
const MAX_SEGMENT = 12000;
const SESSION_COLLECTION = 'note_sessions';

function json(data, status = 200, env) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...(env.CORS_ORIGIN ? { 'Access-Control-Allow-Origin': env.CORS_ORIGIN } : {}) } });
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

export async function handleNoteStream(request, env) {
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return json({ error: 'WebSocket upgrade required' }, 426, env);
  const bearer = request.headers.get('Authorization') || (new URL(request.url).searchParams.get('token') ? `Bearer ${new URL(request.url).searchParams.get('token')}` : '');
  const identity = await requireAuth(new Request(request, { headers: new Headers({ Authorization: bearer }) }), env);
  if (!env.AI_GATEWAY_WS_URL || !env.AI_GATEWAY_MODEL) return json({ error: 'AI Gateway WebSocket is not configured. Set AI_GATEWAY_WS_URL and AI_GATEWAY_MODEL.' }, 503, env);
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();
  const upstream = new WebSocket(env.AI_GATEWAY_WS_URL, env.AI_GATEWAY_WS_PROTOCOL ? [env.AI_GATEWAY_WS_PROTOCOL] : undefined);
  const metadata = { type: 'session.start', uid: identity.uid, model: env.AI_GATEWAY_MODEL };
  upstream.addEventListener('open', () => upstream.send(JSON.stringify(metadata)));
  server.addEventListener('message', event => { if (upstream.readyState === WebSocket.OPEN) upstream.send(event.data); });
  upstream.addEventListener('message', event => server.send(event.data));
  const close = () => { try { server.close(); } catch {} try { upstream.close(); } catch {} };
  server.addEventListener('close', close); upstream.addEventListener('close', close); server.addEventListener('error', close); upstream.addEventListener('error', close);
  return new Response(null, { status: 101, webSocket: client });
}

export function noteTakerCors(request, env) {
  return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': env.CORS_ORIGIN || '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS', 'Access-Control-Allow-Headers': 'Authorization,Content-Type', 'Access-Control-Allow-Credentials': 'true' } });
}
