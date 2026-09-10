// chat-sync-endpoint.js
// POST /api/chat/save   { conversationId, conversation }  -> stores the
//   conversation JSON in B2 under the caller's uid.
// POST /api/chat/delete { conversationId }                -> hides the
//   conversation's file in B2.
// Both are best-effort mirrors of the client's localStorage history — a
// failure here never blocks the chat itself, so the frontend fires these
// and logs/ignores errors rather than surfacing them to the user.

import { requireAuth } from './auth-middleware.js';
import { saveConversationToB2, deleteConversationFromB2 } from './chat-storage.js';

export async function handleChatSave(request, env) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    return _jsonError('Not authenticated: ' + e.message, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return _jsonError('Invalid JSON body.', 400);
  }

  const conversationId = (body.conversationId || '').trim();
  if (!conversationId) return _jsonError('Missing conversationId.', 400);
  if (!body.conversation || typeof body.conversation !== 'object') {
    return _jsonError('Missing conversation payload.', 400);
  }

  try {
    await saveConversationToB2(env, identity.uid, conversationId, body.conversation);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: _corsJsonHeaders() });
  } catch (e) {
    console.error('[chat-sync] save failed:', e.message);
    return _jsonError('Could not save the conversation.', 502);
  }
}

export async function handleChatDelete(request, env) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    return _jsonError('Not authenticated: ' + e.message, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return _jsonError('Invalid JSON body.', 400);
  }

  const conversationId = (body.conversationId || '').trim();
  if (!conversationId) return _jsonError('Missing conversationId.', 400);

  try {
    await deleteConversationFromB2(env, identity.uid, conversationId);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: _corsJsonHeaders() });
  } catch (e) {
    console.error('[chat-sync] delete failed:', e.message);
    return _jsonError('Could not delete the conversation.', 502);
  }
}

function _corsJsonHeaders() {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
}

function _jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: _corsJsonHeaders() });
}
