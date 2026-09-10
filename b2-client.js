// b2-client.js
// Talks to Backblaze B2's native API (not the S3-compatible one — B2's own
// API is simpler to drive with plain fetch() and doesn't need request
// signing). This is the ONLY file that should ever see the B2 application
// key. Nothing here is exposed to the frontend — every function here is
// called exclusively from Worker route handlers.
//
// Required Worker secrets (set via `wrangler secret put NAME` or the
// Cloudflare dashboard's encrypted environment variables):
//   B2_KEY_ID          — from the "keyID" field Backblaze showed you
//   B2_APPLICATION_KEY — from the "applicationKey" field (shown once only)
//   B2_BUCKET_ID       — the bucket's ID (visible anytime on its dashboard page)
//   B2_BUCKET_NAME     — the bucket's name, e.g. "cognita-resources"

const B2_AUTH_URL = 'https://api.backblazeb2.com/b2api/v3/b2_authorize_account';

// Cached in module scope so multiple calls within the same warm Worker
// instance can skip re-authorizing. This is a best-effort optimization
// only — Workers can spin up fresh instances at any time, so every
// function below still checks and re-authorizes if the cache is empty or
// expired. Never assume this cache persists.
let _authCache = null; // { apiUrl, downloadUrl, authorizationToken, expiresAt }

async function _authorize(env) {
  if (_authCache && _authCache.expiresAt > Date.now()) {
    return _authCache;
  }

  const credentials = env.B2_KEY_ID + ':' + env.B2_APPLICATION_KEY;
  const basicAuth = btoa(credentials);

  const res = await fetch(B2_AUTH_URL, {
    method: 'GET',
    headers: { Authorization: 'Basic ' + basicAuth },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error('B2 authorization failed (' + res.status + '): ' + text);
  }

  const data = await res.json();

  _authCache = {
    apiUrl: data.apiInfo.storageApi.apiUrl,
    downloadUrl: data.apiInfo.storageApi.downloadUrl,
    authorizationToken: data.authorizationToken,
    // B2 auth tokens are valid for 24h; we refresh well before that to be safe.
    expiresAt: Date.now() + 12 * 60 * 60 * 1000,
  };

  return _authCache;
}

// Exposes the internal auth cache to other server-side modules that need
// to build their own download requests (e.g. chat-storage.js's binary-safe
// generated-file download, since b2DownloadFileByName here assumes text).
export async function b2AuthorizeForDownload(env) {
  return _authorize(env);
}

async function _getUploadUrl(env) {
  const auth = await _authorize(env);

  const res = await fetch(auth.apiUrl + '/b2api/v3/b2_get_upload_url', {
    method: 'POST',
    headers: {
      Authorization: auth.authorizationToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ bucketId: env.B2_BUCKET_ID }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error('B2 get_upload_url failed (' + res.status + '): ' + text);
  }

  return res.json(); // { uploadUrl, authorizationToken }
}

async function _sha1Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-1', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Uploads a file to the Cognita Resources bucket.
 *
 * @param {object} env - Worker env bindings (must include B2_* secrets)
 * @param {string} key - object key/path within the bucket,
 *   e.g. "generated/abc123/exports/lesson-plan.docx"
 * @param {Uint8Array} data - raw file bytes
 * @param {string} contentType - MIME type, e.g.
 *   "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
 * @returns {Promise<{fileId: string, fileName: string, uploadTimestamp: number}>}
 */
export async function b2UploadFile(env, key, data, contentType) {
  const { uploadUrl, authorizationToken } = await _getUploadUrl(env);
  const sha1 = await _sha1Hex(data);

  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: authorizationToken,
      'X-Bz-File-Name': encodeURIComponent(key),
      'Content-Type': contentType || 'b2/x-auto',
      'Content-Length': String(data.length),
      'X-Bz-Content-Sha1': sha1,
    },
    body: data,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error('B2 upload failed (' + res.status + '): ' + text);
  }

  const result = await res.json();
  // uploadTimestamp is B2's own server clock — used as the authoritative
  // "as of when is this version current" for sync reconciliation, so we
  // don't have to trust client clocks for that comparison.
  return { fileId: result.fileId, fileName: result.fileName, uploadTimestamp: result.uploadTimestamp };
}

/**
 * Deletes a specific file version from the bucket. Needed when a resource
 * is re-exported and the old export file should be cleaned up rather than
 * left to accumulate (see lifecycle rules in the spec).
 *
 * @param {object} env
 * @param {string} fileName - the exact key/path used at upload time
 * @param {string} fileId - the fileId returned from b2UploadFile
 */
export async function b2DeleteFileVersion(env, fileName, fileId) {
  const auth = await _authorize(env);

  const res = await fetch(auth.apiUrl + '/b2api/v3/b2_delete_file_version', {
    method: 'POST',
    headers: {
      Authorization: auth.authorizationToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fileName, fileId }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error('B2 delete failed (' + res.status + '): ' + text);
  }

  return res.json();
}

/**
 * Because the bucket is private, a file can't just be linked to directly —
 * anyone with the URL would need a valid auth token too. This generates a
 * short-lived download authorization scoped to a key PREFIX (not a single
 * file), so e.g. authorizing "generated/abc123/" lets the holder download
 * anything under that resource's folder for a limited time, and nothing
 * outside it.
 *
 * @param {object} env
 * @param {string} keyPrefix - e.g. "generated/abc123/exports/"
 * @param {number} validDurationSeconds - how long the token works (max 604800 = 7 days)
 * @returns {Promise<string>} the authorizationToken to append as a query param
 */
export async function b2GetDownloadAuthorization(env, keyPrefix, validDurationSeconds) {
  const auth = await _authorize(env);

  const res = await fetch(auth.apiUrl + '/b2api/v3/b2_get_download_authorization', {
    method: 'POST',
    headers: {
      Authorization: auth.authorizationToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      bucketId: env.B2_BUCKET_ID,
      fileNamePrefix: keyPrefix,
      validDurationInSeconds: Math.min(validDurationSeconds || 3600, 604800),
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error('B2 get_download_authorization failed (' + res.status + '): ' + text);
  }

  const result = await res.json();
  return result.authorizationToken;
}

/**
 * Builds the full, time-limited download URL for a private file. Combine
 * with b2GetDownloadAuthorization() — get one auth token per resource
 * folder, then build a URL per file inside it.
 *
 * @param {object} env
 * @param {string} key - the file's full key/path
 * @param {string} downloadAuthToken - token from b2GetDownloadAuthorization
 */
export async function b2BuildPrivateDownloadUrl(env, key, downloadAuthToken) {
  const auth = await _authorize(env);
  return auth.downloadUrl + '/file/' + env.B2_BUCKET_NAME + '/' +
    encodeURIComponent(key).replace(/%2F/g, '/') +
    '?Authorization=' + downloadAuthToken;
}

/**
 * "Deletes" a file by hiding it — b2_hide_file marks the current version
 * as hidden so normal downloads/listing no longer see it, without needing
 * to know the fileId up front (unlike b2_delete_file_version). Good fit
 * for user-initiated deletes where we only know the file's name/key, like
 * a chat conversation deleted from the sidebar. The hidden version still
 * exists until a lifecycle rule purges it, per the bucket's configured
 * file retention.
 *
 * @param {object} env
 * @param {string} fileName - the exact key/path used at upload time
 */
export async function b2HideFile(env, fileName) {
  const auth = await _authorize(env);

  const res = await fetch(auth.apiUrl + '/b2api/v3/b2_hide_file', {
    method: 'POST',
    headers: {
      Authorization: auth.authorizationToken,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ bucketId: env.B2_BUCKET_ID, fileName }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error('B2 hide_file failed (' + res.status + '): ' + text);
  }

  return res.json();
}

/**
 * Returns the latest version of every file under a prefix, keyed by
 * fileName — including hidden (deleted) files, which b2_list_file_names
 * would silently omit. This is what makes sync reconciliation possible:
 * for each chat, we learn both whether it's currently live or deleted,
 * AND the server-clock timestamp of that state, without downloading any
 * file content just to build a listing.
 *
 * B2 returns versions of the same fileName newest-first within the
 * paginated stream, so the first occurrence of a name we see is always
 * its current state.
 *
 * @param {object} env
 * @param {string} prefix - e.g. "chats/uid123/"
 * @returns {Promise<Map<string, {action: 'upload'|'hide', uploadTimestamp: number, fileId: string}>>}
 */
export async function b2ListLatestVersionsByPrefix(env, prefix) {
  const auth = await _authorize(env);
  const latestByName = new Map();

  let startFileName = prefix;
  let startFileId = null;
  const MAX_PAGES = 50; // defensive cap — 50k versions is far beyond any real personal chat history

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetch(auth.apiUrl + '/b2api/v3/b2_list_file_versions', {
      method: 'POST',
      headers: {
        Authorization: auth.authorizationToken,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        bucketId: env.B2_BUCKET_ID,
        prefix,
        startFileName,
        startFileId,
        maxFileCount: 1000,
      }),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error('B2 list_file_versions failed (' + res.status + '): ' + text);
    }

    const data = await res.json();

    for (const file of data.files) {
      if (!latestByName.has(file.fileName)) {
        latestByName.set(file.fileName, {
          action: file.action, // 'upload' = live, 'hide' = deleted
          uploadTimestamp: file.uploadTimestamp,
          fileId: file.fileId,
        });
      }
    }

    if (!data.nextFileName) break;
    startFileName = data.nextFileName;
    startFileId = data.nextFileId;
  }

  return latestByName;
}

/**
 * Downloads a file's raw content by its exact name/key, using the
 * account-level auth token (server-side only — never expose this token to
 * a client). Returns null on a 404 rather than throwing, since "not
 * found" is an expected, non-error outcome for callers like
 * getConversationFromB2.
 *
 * @param {object} env
 * @param {string} fileName - the exact key/path used at upload time
 * @returns {Promise<string|null>}
 */
export async function b2DownloadFileByName(env, fileName) {
  const auth = await _authorize(env);
  const url = auth.downloadUrl + '/file/' + env.B2_BUCKET_NAME + '/' +
    encodeURIComponent(fileName).replace(/%2F/g, '/');

  const res = await fetch(url, {
    headers: { Authorization: auth.authorizationToken },
  });

  if (res.status === 404) return null;

  if (!res.ok) {
    const text = await res.text();
    throw new Error('B2 download failed (' + res.status + '): ' + text);
  }

  return res.text();
}
