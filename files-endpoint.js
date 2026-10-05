// files-endpoint.js

import { requireAuth, describeAuthError } from './auth-middleware.js';
import { listGeneratedFiles, getGeneratedFileFromB2, saveGeneratedFileToB2 } from './chat-storage.js';
import { resolveAccountWithRole } from './subscription.js';
import { getPlan, planHasSandbox } from './entitlements.js';
import { checkAndIncrement, refundUsage } from './usage.js';

export async function handleFilesList(request, env, conversationId) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    const _authErr = describeAuthError(e);
    return _jsonError(_authErr.message, _authErr.status, env);
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
    const _authErr = describeAuthError(e);
    return _jsonError(_authErr.message, _authErr.status, env);
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

// ── Saving a file made in the code sandbox ──────────────────────────────
// The browser sends the file it wants kept; the Worker decides everything
// that matters: the type comes from the file extension (never from anything
// the browser claims), the size and daily count come from the plan, and the
// count is kept by the Worker, not the browser.

// Extension -> type. Only these can be saved.
export const ARTIFACT_MIME = {
  csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json',
  txt: 'text/plain', md: 'text/markdown', py: 'text/x-python', js: 'text/javascript',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml',
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};
export const MAX_SAVED_FILES_PER_CONVERSATION = 20;
const MAX_FILENAME_CHARS = 100;

/**
 * Turns whatever name the browser sent into a safe stored name, or returns
 * null if its extension is not allowed. Folders are dropped, control
 * characters and anything odd become "_", and the length is capped while
 * keeping the extension.
 */
export function cleanArtifactFilename(raw) {
  if (typeof raw !== 'string') return null;
  let name = raw.split(/[\\/]/).pop() || '';
  name = name.replace(/[\u0000-\u001f\u007f]/g, '').normalize('NFC');
  name = name.replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/\s+/g, ' ').trim().replace(/^[.\s]+/, '');
  const dot = name.lastIndexOf('.');
  if (dot < 1) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(ARTIFACT_MIME, ext)) return null;
  let stem = name.slice(0, dot);
  if (stem.length + 1 + ext.length > MAX_FILENAME_CHARS) stem = stem.slice(0, MAX_FILENAME_CHARS - 1 - ext.length);
  return stem ? stem + '.' + ext : null;
}

/** Decoded size of a base64 string, or -1 if it is not valid base64. */
export function base64ByteLength(b64) {
  if (typeof b64 !== 'string' || b64.length === 0 || b64.length % 4 !== 0) return -1;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return -1;
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return (b64.length / 4) * 3 - pad;
}

export async function handleFileSave(request, env, conversationId) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    const _authErr = describeAuthError(e);
    return _jsonError(_authErr.message, _authErr.status, env);
  }

  if (!/^[A-Za-z0-9_-]{1,80}$/.test(conversationId || '')) {
    return _jsonError('Missing or invalid conversation id.', 400, env);
  }

  let account;
  try {
    account = await resolveAccountWithRole(identity.uid, env);
  } catch (e) {
    console.error('[files] account resolution failed:', e.message);
    return _jsonError('Could not verify your account. Please try again.', 500, env);
  }
  const plan = getPlan(account.planId);
  if (!planHasSandbox(account.planId)) {
    return _jsonError('Saving files is not available on the ' + plan.name + ' plan.', 403, env);
  }

  let body;
  try { body = await request.json(); } catch (_) { return _jsonError('The request was not valid.', 400, env); }
  if (!body || typeof body !== 'object') return _jsonError('The request was not valid.', 400, env);

  const filename = cleanArtifactFilename(body.filename);
  if (!filename) {
    return _jsonError('That file type cannot be saved. Allowed: ' + Object.keys(ARTIFACT_MIME).join(', ') + '.', 400, env);
  }
  const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
  const mimeType = ARTIFACT_MIME[ext];

  const maxMB = plan.limits.sandboxArtifactMaxMB;
  const bytes = base64ByteLength(body.content);
  if (bytes < 0) return _jsonError('The file content was not valid.', 400, env);
  if (bytes === 0) return _jsonError('That file is empty.', 400, env);
  if (bytes > maxMB * 1024 * 1024) {
    return _jsonError('That file is larger than the ' + maxMB + ' MB the ' + plan.name + ' plan can save.', 413, env);
  }

  try {
    const existing = await listGeneratedFiles(env, identity.uid, conversationId);
    if (existing.length >= MAX_SAVED_FILES_PER_CONVERSATION) {
      return _jsonError('This chat already has ' + MAX_SAVED_FILES_PER_CONVERSATION + ' saved files. Delete the chat or start a new one to save more.', 409, env);
    }
  } catch (e) {
    console.error('[files] could not check saved files:', e.message);
    return _jsonError('Could not save the file. Please try again.', 502, env);
  }

  const charge = await checkAndIncrement(identity.uid, 'sandboxArtifacts', plan.limits.sandboxArtifactsPerDay, env);
  if (!charge.allowed) {
    return _jsonError('You have reached your daily limit for saving files on the ' + plan.name + ' plan (' + charge.limit + ' per day). It resets at midnight UTC.', 429, env);
  }

  try {
    const meta = await saveGeneratedFileToB2(env, identity.uid, conversationId, filename, mimeType, body.content);
    return new Response(JSON.stringify({ ...meta, conversationId }), { status: 200, headers: _corsJsonHeaders(env) });
  } catch (e) {
    console.error('[files] save failed:', e.message);
    // A failure on our side must not cost the person one of their saves.
    try { await refundUsage(identity.uid, 'sandboxArtifacts', env); } catch (_) { /* best effort */ }
    return _jsonError('Could not save the file. Please try again.', 502, env);
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
