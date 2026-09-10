// files-endpoint.js
// GET /api/files/:conversationId              -> list generated files for a conversation
// GET /api/files/:conversationId/:fileId?filename=... -> fetch one file's base64 content
//
// Backs the "re-download a previously generated file after reloading the
// page" flow — the browser's one-time blob URL from /api/document dies on
// reload, so this lets the frontend rebuild a real download link from
// what's stored in B2. Files here live exactly as long as their owning
// conversation does (see chat-storage.js's deleteGeneratedFilesForConversation,
// wired into the conversation delete flow in chat-sync-endpoint.js).

import { requireAuth } from './auth-middleware.js';
import { listGeneratedFiles, getGeneratedFileFromB2 } from './chat-storage.js';

export async function handleFilesList(request, env, conversationId) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    return _jsonError('Not authenticated: ' + e.message, 401);
  }

  if (!conversationId) return _jsonError('Missing conversation id.', 400);

  try {
    const files = await listGeneratedFiles(env, identity.uid, conversationId);
    return new Response(JSON.stringify({ files }), { status: 200, headers: _corsJsonHeaders() });
  } catch (e) {
    console.error('[files] list failed:', e.message);
    return _jsonError('Could not list files.', 502);
  }
}

export async function handleFileGet(request, env, conversationId, fileId) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    return _jsonError('Not authenticated: ' + e.message, 401);
  }

  if (!conversationId || !fileId) return _jsonError('Missing conversation id or file id.', 400);

  const url = new URL(request.url);
  const filename = url.searchParams.get('filename');
  if (!filename) return _jsonError('Missing filename query parameter.', 400);

  try {
    const content = await getGeneratedFileFromB2(env, identity.uid, conversationId, fileId, filename);
    if (content === null) return _jsonError('File not found.', 404);
    return new Response(JSON.stringify({ filename, content }), { status: 200, headers: _corsJsonHeaders() });
  } catch (e) {
    console.error('[files] get failed:', e.message);
    return _jsonError('Could not retrieve the file.', 502);
  }
}

function _corsJsonHeaders() {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
}

function _jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: _corsJsonHeaders() });
}
