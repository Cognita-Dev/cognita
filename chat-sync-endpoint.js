// chat-sync-endpoint.js

import { requireAuth, describeAuthError } from './auth-middleware.js';
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
    const _authErr = describeAuthError(e);
    return _jsonError(_authErr.message, _authErr.status, env);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return _jsonError('Invalid JSON body.', 400, env);
  }

  const conversationId = (body.conversationId || '').trim();
  if (!conversationId) return _jsonError('Missing conversationId.', 400, env);
  if (!body.conversation || typeof body.conversation !== 'object') {
    return _jsonError('Missing conversation payload.', 400, env);
  }

  try {
    const result = await saveConversationToB2(env, identity.uid, conversationId, body.conversation);
    return new Response(JSON.stringify({ ok: true, serverUpdatedAt: result.uploadTimestamp }), {
      status: 200,
      headers: _corsJsonHeaders(env),
    });
  } catch (e) {
    console.error('[chat-sync] save failed:', e.message);
    return _jsonError('Could not save the conversation.', 502, env);
  }
}

export async function handleChatDelete(request, env) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    const _authErr = describeAuthError(e);
    return _jsonError(_authErr.message, _authErr.status, env);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return _jsonError('Invalid JSON body.', 400, env);
  }

  const conversationId = (body.conversationId || '').trim();
  if (!conversationId) return _jsonError('Missing conversationId.', 400, env);

  try {
    await deleteConversationFromB2(env, identity.uid, conversationId);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: _corsJsonHeaders(env) });
  } catch (e) {
    console.error('[chat-sync] delete failed:', e.message);
    return _jsonError('Could not delete the conversation.', 502, env);
  }
}

export async function handleChatList(request, env) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    const _authErr = describeAuthError(e);
    return _jsonError(_authErr.message, _authErr.status, env);
  }

  try {
    const conversations = await listConversationsForUser(env, identity.uid);
    return new Response(JSON.stringify({ conversations }), { status: 200, headers: _corsJsonHeaders(env) });
  } catch (e) {
    console.error('[chat-sync] list failed:', e.message);
    return _jsonError('Could not list conversations.', 502, env);
  }
}

export async function handleChatGet(request, env, conversationId) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    const _authErr = describeAuthError(e);
    return _jsonError(_authErr.message, _authErr.status, env);
  }

  if (!conversationId) return _jsonError('Missing conversation id.', 400, env);

  try {
    const conversation = await getConversationFromB2(env, identity.uid, conversationId);
    if (!conversation) return _jsonError('Conversation not found.', 404, env);
    return new Response(JSON.stringify({ conversation }), { status: 200, headers: _corsJsonHeaders(env) });
  } catch (e) {
    console.error('[chat-sync] get failed:', e.message);
    return _jsonError('Could not load the conversation.', 502, env);
  }
}

function _corsJsonHeaders(env) {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': env?.APP_ORIGIN || '*' };
}

function _jsonError(message, status, env) {
  return new Response(JSON.stringify({ error: message }), { status, headers: _corsJsonHeaders(env) });
}
