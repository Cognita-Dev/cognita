// chat-storage.js
// Thin wrapper around b2-client.js for persisting chat conversations, and
// AI-generated files (docx/pdf/pptx from /api/document), to Backblaze B2.
//
// Layout:
//   chats/{uid}/{conversationId}.json                       — conversation body
//   generated/{uid}/{conversationId}/{fileId}-{filename}    — generated files
//
// Generated files live as long as their conversation does — they're
// deleted together when the conversation is deleted (see
// deleteGeneratedFilesForConversation, called from chat-sync-endpoint.js).
// This file is the only place that knows either key layout — callers just
// pass uid/conversationId/data.

import {
  b2UploadFile,
  b2HideFile,
  b2DeleteFileVersion,
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
 * mirroring a sidebar delete in the app. Also deletes every generated
 * file (docx/pdf/pptx) that belongs to this conversation, since those
 * are only meant to persist as long as the conversation does.
 *
 * @param {object} env
 * @param {string} uid
 * @param {string} conversationId
 */
export async function deleteConversationFromB2(env, uid, conversationId) {
  const key = _keyFor(uid, conversationId);
  const result = await b2HideFile(env, key);
  // Best-effort — a failure here shouldn't block the conversation delete
  // itself from succeeding, so it's caught and logged rather than thrown.
  try {
    await deleteGeneratedFilesForConversation(env, uid, conversationId);
  } catch (e) {
    console.error('[chat-storage] Could not clean up generated files for ' + conversationId + ':', e.message);
  }
  return result;
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

/* ════════════════════════════════════════════════════════
   GENERATED FILES (docx/pdf/pptx from /api/document)
════════════════════════════════════════════════════════ */

function _generatedPrefixFor(uid, conversationId) {
  return 'generated/' + uid + '/' + conversationId + '/';
}

// The stored key embeds the fileId and the original filename together
// (fileId-filename), so a single list call gives us everything needed to
// render a download list without a second round-trip per file. A small
// metadata sidecar (same key + ".meta.json") carries the mime type, since
// that can't be safely reconstructed from a filename alone (e.g. a
// filename with no/odd extension).
function _generatedKey(uid, conversationId, fileId, filename) {
  return _generatedPrefixFor(uid, conversationId) + fileId + '--' + filename;
}

function _generatedMetaKey(uid, conversationId, fileId, filename) {
  return _generatedKey(uid, conversationId, fileId, filename) + '.meta.json';
}

function _makeFileId() {
  return (crypto && crypto.randomUUID) ? crypto.randomUUID() : 'f-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}

/**
 * Saves a base64-encoded generated file (docx/pdf/pptx) to B2, scoped
 * under its owning conversation. Returns the metadata the frontend needs
 * to list and re-download it later, including a fresh fileId.
 *
 * @param {object} env
 * @param {string} uid
 * @param {string} conversationId
 * @param {string} filename - e.g. "quarterly_report.docx"
 * @param {string} mimeType
 * @param {string} base64Content
 * @returns {Promise<{fileId: string, filename: string, mimeType: string, createdAt: number}>}
 */
export async function saveGeneratedFileToB2(env, uid, conversationId, filename, mimeType, base64Content) {
  const fileId = _makeFileId();
  const key = _generatedKey(uid, conversationId, fileId, filename);
  const metaKey = _generatedMetaKey(uid, conversationId, fileId, filename);

  const byteChars = atob(base64Content);
  const bytes = new Uint8Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) bytes[i] = byteChars.charCodeAt(i);

  const uploadResult = await b2UploadFile(env, key, bytes, mimeType);
  const meta = { fileId, filename, mimeType, createdAt: uploadResult.uploadTimestamp };

  // Sidecar metadata upload is best-effort — if it fails, the file itself
  // is still saved and still listable/downloadable; the mime type just
  // falls back to a generic guess when listing (see listGeneratedFiles).
  try {
    await b2UploadFile(env, metaKey, ENCODER.encode(JSON.stringify(meta)), 'application/json');
  } catch (e) {
    console.error('[chat-storage] Could not save file metadata for ' + filename + ':', e.message);
  }

  return meta;
}

/**
 * Lists every generated file currently attached to a conversation
 * (newest first). Reads only lightweight version listings, not file
 * bodies — cheap to call whenever a conversation is opened.
 *
 * @param {object} env
 * @param {string} uid
 * @param {string} conversationId
 * @returns {Promise<Array<{fileId: string, filename: string, mimeType: string, createdAt: number}>>}
 */
export async function listGeneratedFiles(env, uid, conversationId) {
  const prefix = _generatedPrefixFor(uid, conversationId);
  const latest = await b2ListLatestVersionsByPrefix(env, prefix);

  const filesByKey = new Map();
  for (const [fileName, info] of latest.entries()) {
    if (info.action === 'hide') continue; // deleted
    if (fileName.endsWith('.meta.json')) continue; // handled below
    filesByKey.set(fileName, info);
  }

  const results = [];
  for (const [fileName, info] of filesByKey.entries()) {
    // fileName shape: generated/{uid}/{conversationId}/{fileId}--{filename}
    const base = fileName.slice(prefix.length);
    const sepIndex = base.indexOf('--');
    if (sepIndex === -1) continue;
    const fileId = base.slice(0, sepIndex);
    const filename = base.slice(sepIndex + 2);

    let mimeType = 'application/octet-stream';
    const metaKey = fileName + '.meta.json';
    try {
      const metaText = await b2DownloadFileByName(env, metaKey);
      if (metaText) {
        const meta = JSON.parse(metaText);
        if (meta.mimeType) mimeType = meta.mimeType;
      }
    } catch (e) {
      // fall back to the generic mime type above
    }

    results.push({ fileId, filename, mimeType, createdAt: info.uploadTimestamp });
  }

  results.sort((a, b) => b.createdAt - a.createdAt);
  return results;
}

/**
 * Fetches one generated file's raw base64 content by fileId. Needs the
 * exact filename too, since that's baked into the storage key — callers
 * get both from listGeneratedFiles first. Returns null if not found.
 *
 * @param {object} env
 * @param {string} uid
 * @param {string} conversationId
 * @param {string} fileId
 * @param {string} filename
 * @returns {Promise<string|null>} base64-encoded file content
 */
export async function getGeneratedFileFromB2(env, uid, conversationId, fileId, filename) {
  const key = _generatedKey(uid, conversationId, fileId, filename);
  const auth = null; // b2DownloadFileByName handles its own auth internally
  const text = await b2DownloadFileByNameAsBase64(env, key);
  return text;
}

// b2DownloadFileByName in b2-client.js returns text (it assumes UTF-8),
// which corrupts binary content like docx/pdf/pptx bytes. Generated files
// need their raw bytes back as base64 instead, so this does its own fetch
// rather than reusing that helper. Kept in this file rather than
// b2-client.js since it's specific to how generated files are consumed.
import { b2AuthorizeForDownload } from './b2-client.js';

async function b2DownloadFileByNameAsBase64(env, fileName) {
  const auth = await b2AuthorizeForDownload(env);
  const url = auth.downloadUrl + '/file/' + env.B2_BUCKET_NAME + '/' +
    encodeURIComponent(fileName).replace(/%2F/g, '/');

  const res = await fetch(url, { headers: { Authorization: auth.authorizationToken } });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text();
    throw new Error('B2 download failed (' + res.status + '): ' + text);
  }

  const arrayBuffer = await res.arrayBuffer();
  const bytes = new Uint8Array(arrayBuffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/**
 * Deletes every generated file (and its metadata sidecar) belonging to a
 * conversation. Called automatically when the conversation itself is
 * deleted (see deleteConversationFromB2 above) — generated files aren't
 * meant to outlive their conversation.
 *
 * @param {object} env
 * @param {string} uid
 * @param {string} conversationId
 */
export async function deleteGeneratedFilesForConversation(env, uid, conversationId) {
  const prefix = _generatedPrefixFor(uid, conversationId);
  const latest = await b2ListLatestVersionsByPrefix(env, prefix);

  for (const [fileName, info] of latest.entries()) {
    if (info.action === 'hide') continue; // already gone
    try {
      await b2DeleteFileVersion(env, fileName, info.fileId);
    } catch (e) {
      console.error('[chat-storage] Could not delete generated file ' + fileName + ':', e.message);
    }
  }
}
