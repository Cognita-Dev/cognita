// chat-storage.js
// Thin wrapper around b2-client.js for persisting chat conversations to
// Backblaze B2. Each conversation is stored as a single JSON object at
// chats/{uid}/{conversationId}.json. This file is the only place that
// knows that key layout — callers just pass uid/conversationId/data.

import {
  b2UploadFile,
  b2HideFile,
  b2ListLatestVersionsByPrefix,
  b2DownloadFileByName,
} from './b2-client.js';

const ENCODER = new TextEncoder();

function _prefixFor(uid) {
  return 'chats/' + uid + '/';
}

function _keyFor(uid, conversationId) {
  return _prefixFor(uid) + conversationId + '.json';
}

function _conversationIdFromKey(uid, key) {
  const prefix = _prefixFor(uid);
  return key.slice(prefix.length, key.length - '.json'.length);
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
 * @returns {Promise<{fileId: string, fileName: string, uploadTimestamp: number}>}
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

/**
 * Lists every conversation this user has ever saved, live or deleted,
 * with the server-clock timestamp of its current state. Used for sync
 * reconciliation across devices — never downloads full conversation
 * bodies, just the lightweight version metadata.
 *
 * @param {object} env
 * @param {string} uid
 * @returns {Promise<Array<{conversationId: string, status: 'live'|'deleted', serverUpdatedAt: number}>>}
 */
export async function listConversationsForUser(env, uid) {
  const prefix = _prefixFor(uid);
  const latest = await b2ListLatestVersionsByPrefix(env, prefix);

  const results = [];
  for (const [fileName, info] of latest.entries()) {
    if (!fileName.endsWith('.json')) continue;
    results.push({
      conversationId: _conversationIdFromKey(uid, fileName),
      status: info.action === 'hide' ? 'deleted' : 'live',
      serverUpdatedAt: info.uploadTimestamp,
    });
  }
  return results;
}

/**
 * Fetches one conversation's full JSON body from B2. Returns null if it
 * doesn't exist (never saved, or the name is wrong) — a hidden/deleted
 * conversation also downloads fine here (this reads by exact name, not
 * through B2's "current visible file" resolution), so callers should
 * check listConversationsForUser's status first if that distinction
 * matters.
 *
 * @param {object} env
 * @param {string} uid
 * @param {string} conversationId
 */
export async function getConversationFromB2(env, uid, conversationId) {
  const key = _keyFor(uid, conversationId);
  const text = await b2DownloadFileByName(env, key);
  if (text === null) return null;
  return JSON.parse(text);
}
