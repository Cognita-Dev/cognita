// firestore-rest.js
// Lightweight Firestore REST client for Cloudflare Workers.
// Uses a service account JWT (signed with FIREBASE_PRIVATE_KEY) to get an
// OAuth token, then talks to the Firestore REST API directly.
// No official Firebase Admin SDK dependency — Workers runtime can't run it.

let _tokenCache = null;
let _tokenExpiry = 0;

function _b64urlEncode(obj) {
  const json = typeof obj === 'string' ? obj : JSON.stringify(obj);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function _b64urlToBytes(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const raw = atob(b64 + pad);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

async function _signServiceAccountJwt(clientEmail, privateKeyPem) {
  const pemBody = privateKeyPem
    .replace(/\\n/g, '\n')
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '');

  const keyBytes = _b64urlToBytes(pemBody.replace(/\+/g, '-').replace(/\//g, '_'));
  // Standard base64 (not url-safe) is what PEM bodies use — decode plainly.
  const rawBytes = Uint8Array.from(atob(pemBody), c => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    rawBytes,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const now = Math.floor(Date.now() / 1000);
  const header = _b64urlEncode({ alg: 'RS256', typ: 'JWT' });
  const payload = _b64urlEncode({
    iss: clientEmail,
    sub: clientEmail,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
    scope: 'https://www.googleapis.com/auth/datastore',
  });

  const signInput = header + '.' + payload;
  const sigBytes = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    cryptoKey,
    new TextEncoder().encode(signInput)
  );

  let binary = '';
  const sigArr = new Uint8Array(sigBytes);
  for (let i = 0; i < sigArr.length; i++) binary += String.fromCharCode(sigArr[i]);
  const sig = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  return signInput + '.' + sig;
}

async function _getAccessToken(env) {
  const now = Date.now();
  if (_tokenCache && now < _tokenExpiry) return _tokenCache;

  if (!env.FIREBASE_CLIENT_EMAIL || !env.FIREBASE_PRIVATE_KEY) {
    throw new Error('Server misconfiguration: Firebase service account not set.');
  }

  const jwt = await _signServiceAccountJwt(env.FIREBASE_CLIENT_EMAIL, env.FIREBASE_PRIVATE_KEY);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('Firebase token exchange failed: ' + text.slice(0, 200));
  }

  const data = await res.json();
  _tokenCache = data.access_token;
  _tokenExpiry = now + (data.expires_in - 120) * 1000; // refresh 2 min early
  return _tokenCache;
}

function _fsDecodeValue(v) {
  if (!v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return parseInt(v.integerValue, 10);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(_fsDecodeValue);
  if ('mapValue' in v) return _fsDecodeFields(v.mapValue.fields || {});
  return null;
}

function _fsDecodeFields(fields) {
  const out = {};
  for (const key in fields) out[key] = _fsDecodeValue(fields[key]);
  return out;
}

function _fsEncodeValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map(_fsEncodeValue) } };
  if (typeof v === 'object') return { mapValue: { fields: _fsEncodeFields(v) } };
  throw new Error('Unsupported Firestore value type: ' + typeof v);
}

function _fsEncodeFields(obj) {
  const out = {};
  for (const key in obj) out[key] = _fsEncodeValue(obj[key]);
  return out;
}

function _baseUrl(env) {
  return 'https://firestore.googleapis.com/v1/projects/' + env.FIREBASE_PROJECT_ID + '/databases/(default)/documents/';
}

/** Reads one document. Returns null if it doesn't exist. */
export async function fsGet(path, env) {
  const token = await _getAccessToken(env);
  const res = await fetch(_baseUrl(env) + path, {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('Firestore GET ' + path + ' failed (' + res.status + '): ' + text.slice(0, 200));
  }
  const json = await res.json();
  return json.fields ? _fsDecodeFields(json.fields) : {};
}

/** Overwrites (or creates) a document with the given fields. */
export async function fsSet(path, data, env) {
  const token = await _getAccessToken(env);
  const res = await fetch(_baseUrl(env) + path, {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields: _fsEncodeFields(data) }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('Firestore SET ' + path + ' failed (' + res.status + '): ' + text.slice(0, 200));
  }
  return true;
}

/** Merges fields into an existing document (only updates the given field names). */
export async function fsUpdate(path, data, env) {
  const token = await _getAccessToken(env);
  const fieldPaths = Object.keys(data).map(k => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
  const res = await fetch(_baseUrl(env) + path + '?' + fieldPaths, {
    method: 'PATCH',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ fields: _fsEncodeFields(data) }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('Firestore UPDATE ' + path + ' failed (' + res.status + '): ' + text.slice(0, 200));
  }
  return true;
}

/**
 * Runs a structured query against a collection, filtered to documents where
 * fieldName == value, ordered by orderByField descending, limited to
 * limitCount results. Used for "my resources" style listings.
 */
export async function fsQuery(collectionId, fieldName, value, orderByField, limitCount, env) {
  const token = await _getAccessToken(env);

  const structuredQuery = {
    from: [{ collectionId }],
    where: {
      fieldFilter: {
        field: { fieldPath: fieldName },
        op: 'EQUAL',
        value: _fsEncodeValue(value),
      },
    },
    limit: limitCount || 50,
  };

  if (orderByField) {
    structuredQuery.orderBy = [{ field: { fieldPath: orderByField }, direction: 'DESCENDING' }];
  }

  const queryUrl = 'https://firestore.googleapis.com/v1/projects/' + env.FIREBASE_PROJECT_ID +
    '/databases/(default)/documents:runQuery';

  const res = await fetch(queryUrl, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ structuredQuery }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('Firestore QUERY ' + collectionId + ' failed (' + res.status + '): ' + text.slice(0, 200));
  }

  const rows = await res.json();
  return rows
    .filter((r) => r.document)
    .map((r) => _fsDecodeFields(r.document.fields || {}));
}
