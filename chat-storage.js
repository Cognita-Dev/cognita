// chat-storage.js
// Thin wrapper around b2-client.js for persisting chat conversations to
// Backblaze B2. Each conversation is stored as a single JSON object at
// chats/{uid}/{conversationId}.json. This file is the only place that
// knows that key layout — callers just pass uid/conversationId/data.

import { b2UploadFile, b2HideFile } from './b2-client.js';

const ENCODER = new TextEncoder();

function _keyFor(uid, conversationId) {
  return 'chats/' + uid + '/' + conversationId + '.json';
}

/**
 * Uploads (or overwrites) a conversation's JSON in B2. B2 versions files
 * by name automatically, so re-uploading the same key just creates a new
 * version — the previous version becomes noise but is harmless, and gets
 * cleaned up whenever the conversation is eventually deleted, or by a
 * bucket lifecycle rule you set to keep only the latest version.
 *
 * @param {object} env
 * @param {string} uid - Firebase uid, scopes the chat to its owner
 * @param {string} conversationId
 * @param {object} conversationData - { title, messages, meta, quality, updatedAt }
 */
export async function saveConversationToB2(env, uid, conversationId, conversationData) {
  const key = _keyFor(uid, conversationId);
  const bytes = ENCODER.encode(JSON.stringify(conversationData));
  return b2UploadFile(env, key, bytes, 'application/json');
}

/**
 * Hides the conversation's file in B2 so it's no longer retrievable,
 * mirroring a sidebar delete in the app.
 *
 * @param {object} env
 * @param {string} uid
 * @param {string} conversationId
 */
export async function deleteConversationFromB2(env, uid, conversationId) {
  const key = _keyFor(uid, conversationId);
  return b2HideFile(env, key);
}
