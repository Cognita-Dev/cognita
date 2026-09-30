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
// which transcribes it with Whisper. The Worker decides whether the person
// still has cloud transcription left today; this only reports the chunk length
// (X-Audio-Duration-Ms) as a hint, and the Worker trues it up to what Whisper
// actually processed. Failures carry { status, code, quota, offline } so the UI
// can tell "limit reached" from "network dropped" from "service busy".
export async function transcribeChunk(sessionId, blob, language, context = '', durationMs = 0) {
  let response;
  try {
    response = await auth().authedFetch(`${WORKER_URL}/api/note-sessions/${encodeURIComponent(sessionId)}/transcribe`, {
      method: 'POST',
      headers: {
        'Content-Type': blob.type || 'application/octet-stream',
        ...(language ? { 'X-Note-Language': language } : {}),
        ...(context ? { 'X-Note-Context': encodeURIComponent(context.slice(-400)) } : {}),
        ...(durationMs > 0 ? { 'X-Audio-Duration-Ms': String(Math.round(durationMs)) } : {}),
      },
      body: blob,
    });
  } catch (e) {
    const err = new Error('You appear to be offline.');
    err.offline = true;
    throw err;
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(body.error || `Transcription failed (${response.status})`);
    err.status = response.status;
    err.code = body.code || null;
    err.quota = body.quota || null;
    throw err;
  }
  return body; // { text, seconds, quota }
}

// Today's cloud transcription allowance, as the server counts it.
export async function getNoteQuota() {
  const response = await auth().authedFetch(`${WORKER_URL}/api/note-quota`);
  if (!response.ok) throw new Error(`Could not load your transcription allowance (${response.status})`);
  const body = await response.json();
  // The plan's other note limits ride along so the panel can say what is included before anyone hits a wall.
  return { ...body.quota, audioMaxMB: body.audioMaxMB, asksPerDay: body.asksPerDay };
}

// ---------- Saved notes (B2-backed, see saved-notes-endpoint.js) ----------

async function notesRequest(path, options, fallbackMessage) {
  let response;
  try {
    response = await auth().authedFetch(`${WORKER_URL}${path}`, options);
  } catch (e) {
    const err = new Error('You appear to be offline. Check your connection and try again.');
    err.offline = true;
    throw err;
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(body.error || `${fallbackMessage} (${response.status})`);
    err.status = response.status;
    throw err;
  }
  return body;
}

const jsonPost = (payload) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });

export async function listSavedNotes() {
  return notesRequest('/api/notes', undefined, 'Could not load your notes');
}
export async function getSavedNote(id) {
  return (await notesRequest(`/api/notes/${encodeURIComponent(id)}`, undefined, 'Could not open that note')).note;
}
export async function saveNote(note) {
  return (await notesRequest('/api/notes', jsonPost(note), 'Could not save the note')).note;
}
export async function deleteSavedNote(id) {
  return notesRequest(`/api/notes/${encodeURIComponent(id)}`, { method: 'DELETE' }, 'Could not delete the note');
}
export async function summarizeNote(payload) {
  return (await notesRequest('/api/note-summary', jsonPost(payload), 'Could not summarize the note')).summary;
}

export async function askNote(payload) {
  return notesRequest('/api/note-ask', jsonPost(payload), 'Could not answer that');
}
export async function compareNote(noteId) {
  return notesRequest('/api/note-compare', jsonPost({ noteId }), 'Could not compare these meetings');
}
export async function setTasksDone(noteId, keys, done) {
  return notesRequest(`/api/notes/${encodeURIComponent(noteId)}/tasks`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ keys, done }) }, 'Could not update that task');
}

// ---------- Audio kept with a saved note ----------

export async function uploadNoteAudio(noteId, blob) {
  return notesRequest(`/api/notes/${encodeURIComponent(noteId)}/audio`, { method: 'PUT', headers: { 'Content-Type': blob.type || 'audio/webm' }, body: blob }, 'Could not save the audio');
}
export async function deleteNoteAudio(noteId) {
  return notesRequest(`/api/notes/${encodeURIComponent(noteId)}/audio`, { method: 'DELETE' }, 'Could not delete the audio');
}
// The recording is private, so the browser fetches it with the sign-in token and plays it from memory.
export async function getNoteAudio(noteId) {
  let response;
  try { response = await auth().authedFetch(`${WORKER_URL}/api/notes/${encodeURIComponent(noteId)}/audio`); }
  catch (e) { const err = new Error('You appear to be offline. Check your connection and try again.'); err.offline = true; throw err; }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const err = new Error(body.error || `Could not load the audio (${response.status})`); err.status = response.status; throw err;
  }
  return response.blob();
}

window.CognitaNoteTakerProduction = { askNote, compareNote, setTasksDone, uploadNoteAudio, deleteNoteAudio, getNoteAudio, createNoteSession, patchNoteSession, persistNoteSegment, recoverNoteSession, transcribeChunk, getNoteQuota, listSavedNotes, getSavedNote, saveNote, deleteSavedNote, summarizeNote };
