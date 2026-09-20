// Note Taker's production client API — talks to note-taker-endpoint.js on
// the Cognita Worker. Reuses the existing Firebase-backed auth (window.Auth,
// from auth.js) and the same Worker origin every other feature uses, rather
// than inventing a second auth/config convention.
const WORKER_URL = 'https://api.cognita.com.ng';

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

// Sends one recorded audio chunk (a Blob from MediaRecorder) to the Worker,
// which transcribes it with Whisper on the Workers AI free daily
// allocation. No token in the URL needed here — this is a normal fetch,
// so authedFetch's Authorization header works as-is.
export async function transcribeChunk(sessionId, blob, language) {
  const response = await auth().authedFetch(`${WORKER_URL}/api/note-sessions/${encodeURIComponent(sessionId)}/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': blob.type || 'application/octet-stream', ...(language ? { 'X-Note-Language': language } : {}) },
    body: blob,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Transcription failed (${response.status})`);
  }
  return response.json();
}

window.CognitaNoteTakerProduction = { createNoteSession, patchNoteSession, persistNoteSegment, recoverNoteSession, transcribeChunk };
