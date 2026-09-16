// Note Taker's production client API — talks to note-taker-endpoint.js on
// the Cognita Worker. Reuses the existing Firebase-backed auth (window.Auth,
// from auth.js) and the same Worker origin every other feature uses, rather
// than inventing a second auth/config convention.
const WORKER_URL = 'https://cognita.cognitai.workers.dev';

function auth() {
  if (!window.Auth) throw new Error('Auth is not ready yet.');
  return window.Auth;
}

export async function createNoteSession(payload) {
  const response = await auth().authedFetch(`${WORKER_URL}/api/note-sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Note session creation failed (${response.status})`);
  }
  return response.json();
}

export async function patchNoteSession(sessionId, payload) {
  const response = await auth().authedFetch(`${WORKER_URL}/api/note-sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const err = new Error(body.error || `Note session update failed (${response.status})`);
    err.status = response.status;
    err.session = body.session;
    throw err;
  }
  return response.json();
}

export async function persistNoteSegment(sessionId, segment) {
  const response = await auth().authedFetch(`${WORKER_URL}/api/note-sessions/${encodeURIComponent(sessionId)}/segments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(segment),
  });
  if (!response.ok) throw new Error(`Note segment persistence failed (${response.status})`);
  return response.json();
}

export async function recoverNoteSession(sessionId) {
  const response = await auth().authedFetch(`${WORKER_URL}/api/note-sessions/${encodeURIComponent(sessionId)}`);
  if (!response.ok) throw new Error(`Note recovery failed (${response.status})`);
  return response.json();
}

// WebSockets can't carry an Authorization header from the browser, so the
// ID token travels as a query param instead; the Worker accepts either.
// language/keywords are passed through to Nova-3 (see note-taker-endpoint.js).
export async function openNoteStream({ language, keywords } = {}) {
  const token = await auth().getIdToken(false);
  if (!token) throw new Error('Not signed in.');
  const params = new URLSearchParams({ token });
  if (language) params.set('language', language);
  if (keywords && keywords.length) params.set('keywords', keywords.join(','));
  const base = WORKER_URL.replace(/^http/, 'ws');
  return new WebSocket(`${base}/api/note-stream?${params.toString()}`);
}

window.CognitaNoteTakerProduction = { createNoteSession, patchNoteSession, persistNoteSegment, recoverNoteSession, openNoteStream };
