const PRODUCTION_NOTE_API = window.COGNITA_NOTE_API || '/api';

async function getToken() {
  if (typeof window.CognitaAuth?.getIdToken === 'function') return window.CognitaAuth.getIdToken();
  throw new Error('CognitaAuth.getIdToken must be wired to the existing Firebase auth client.');
}

export async function createNoteSession(payload) {
  const token = await getToken();
  const response = await fetch(`${PRODUCTION_NOTE_API}/note-sessions`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`Note session creation failed (${response.status})`);
  return response.json();
}

export async function persistNoteSegment(sessionId, segment) {
  const token = await getToken();
  const response = await fetch(`${PRODUCTION_NOTE_API}/note-sessions/${encodeURIComponent(sessionId)}/segments`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(segment) });
  if (!response.ok) throw new Error(`Note segment persistence failed (${response.status})`);
  return response.json();
}

export async function recoverNoteSession(sessionId) {
  const token = await getToken();
  const response = await fetch(`${PRODUCTION_NOTE_API}/note-sessions/${encodeURIComponent(sessionId)}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Note recovery failed (${response.status})`);
  return response.json();
}

export function openNoteStream() {
  const base = window.COGNITA_NOTE_STREAM_URL || `${location.origin.replace(/^http/, 'ws')}/api/note-stream`;
  return getToken().then(token => new WebSocket(`${base}?token=${encodeURIComponent(token)}`));
}

window.CognitaNoteTakerProduction = { createNoteSession, persistNoteSegment, recoverNoteSession, openNoteStream };
