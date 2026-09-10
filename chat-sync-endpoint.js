// chat-sync-endpoint.js
// POST /api/chat/save   { conversationId, conversation }  -> stores the
//   conversation JSON in B2 under the caller's uid. Returns serverUpdatedAt
//   (B2's own upload timestamp) so the client can track "as of when" this
//   save is authoritative, for later sync reconciliation.
// POST /api/chat/delete { conversationId }                -> hides the
//   conversation's file in B2.
// GET  /api/chat/list                                     -> lightweight
//   list of every conversation (live or deleted) with its current state's
//   timestamp — used to reconcile against a device's local cache.
// GET  /api/chat/:id                                      -> full
//   conversation body, fetched lazily when a device opens a chat it
//   doesn't have cached locally.
//
// All of these are best-effort mirrors of the client's localStorage
// history — a failure here never blocks the chat itself, so the frontend
// fires these and logs/ignores errors rather than surfacing them to the
// user (except the explicit /list and /:id reads, which the UI does need
// to react to — but still never mutates local state on a failed read).

import { requireAuth } from './auth-middleware.js';
import {
  saveConversationToB2,
  deleteConversationFromB2,
  listConversationsForUser,
  getConversationFromB2,
} from './chat-storage.js';

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
    const result = await saveConversationToB2(env, identity.uid, conversationId, body.conversation);
    return new Response(JSON.stringify({ ok: true, serverUpdatedAt: result.uploadTimestamp }), {
      status: 200,
      headers: _corsJsonHeaders(),
    });
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

export async function handleChatList(request, env) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    return _jsonError('Not authenticated: ' + e.message, 401);
  }

  try {
    const conversations = await listConversationsForUser(env, identity.uid);
    return new Response(JSON.stringify({ conversations }), { status: 200, headers: _corsJsonHeaders() });
  } catch (e) {
    console.error('[chat-sync] list failed:', e.message);
    return _jsonError('Could not list conversations.', 502);
  }
}

export async function handleChatGet(request, env, conversationId) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    return _jsonError('Not authenticated: ' + e.message, 401);
  }

  if (!conversationId) return _jsonError('Missing conversation id.', 400);

  try {
    const conversation = await getConversationFromB2(env, identity.uid, conversationId);
    if (!conversation) return _jsonError('Conversation not found.', 404);
    return new Response(JSON.stringify({ conversation }), { status: 200, headers: _corsJsonHeaders() });
  } catch (e) {
    console.error('[chat-sync] get failed:', e.message);
    return _jsonError('Could not load the conversation.', 502);
  }
}

function _corsJsonHeaders() {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
}

function _jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: _corsJsonHeaders() });
}
