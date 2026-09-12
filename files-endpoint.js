// files-endpoint.js

import { requireAuth } from './auth-middleware.js';
import { listGeneratedFiles, getGeneratedFileFromB2 } from './chat-storage.js';

export async function handleFilesList(request, env, conversationId) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    return _jsonError('Not authenticated: ' + e.message, 401, env);
  }

  if (!conversationId) return _jsonError('Missing conversation id.', 400, env);

  try {
    const files = await listGeneratedFiles(env, identity.uid, conversationId);
    return new Response(JSON.stringify({ files }), {
      status: 200,
      headers: _corsJsonHeaders(env),
    });
  } catch (e) {
    console.error('[files] list failed:', e.message);
    return _jsonError('Could not list files.', 502, env);
  }
}

export async function handleFileGet(request, env, conversationId, fileId) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    return _jsonError('Not authenticated: ' + e.message, 401, env);
  }

  if (!conversationId || !fileId) {
    return _jsonError('Missing conversation id or file id.', 400, env);
  }

  const url = new URL(request.url);
  const filename = url.searchParams.get('filename');

  if (!filename) {
    return _jsonError('Missing filename query parameter.', 400, env);
  }

  try {
    const content = await getGeneratedFileFromB2(
      env,
      identity.uid,
      conversationId,
      fileId,
      filename
    );

    if (content === null) {
      return _jsonError('File not found.', 404, env);
    }

    return new Response(JSON.stringify({ filename, content }), {
      status: 200,
      headers: _corsJsonHeaders(env),
    });
  } catch (e) {
    console.error('[files] get failed:', e.message);
    return _jsonError('Could not retrieve the file.', 502, env);
  }
}

function _corsJsonHeaders(env) {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': env?.APP_ORIGIN || '*',
  };
}

function _jsonError(message, status, env) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: _corsJsonHeaders(env),
  });
}
