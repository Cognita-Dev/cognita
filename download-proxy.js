// download-proxy.js
//
// Lets the browser download a generated file through a URL on our own
// Worker domain (e.g. https://cognita.cognitai.workers.dev/api/resources/
// .../file) instead of navigating straight to Backblaze B2's own download
// URL, which used to end up visible in the address bar.
//
// A plain browser navigation (which is what an <a href> click does) can't
// carry an Authorization header, so the proxy route can't reuse the normal
// requireAuth() check. Instead, the JSON "/download" endpoints below mint a
// short-lived, signed token that says exactly which resource + format the
// bearer may fetch; the "/file" proxy route verifies that signature and
// expiry, re-checks it against the real resource, and only then streams
// the bytes back — with our own domain in front the whole time.
//
// No new Worker secret needs to be configured: the signing key is derived
// from B2_APPLICATION_KEY, which every deployment already has set.

const TOKEN_SECRET_FALLBACK = 'cognita-download-proxy';

function _signingSecret(env) {
  return env.B2_APPLICATION_KEY || env.FIREBASE_PROJECT_ID || TOKEN_SECRET_FALLBACK;
}

async function _hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

function _bytesToB64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function _b64UrlToBytes(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const binary = atob(b64 + pad);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Signs a short-lived download token. `payload` should fully identify
 * what the token grants access to (scope + resourceId + format). The
 * proxy route re-verifies all of it against the real resource before
 * serving any bytes, so a token can never be reused to fetch a
 * different resource or format than the one it was minted for.
 *
 * @param {object} env
 * @param {object} payload - e.g. { scope: 'resource', resourceId, format }
 * @param {number} ttlSeconds - how long the token stays valid
 * @returns {Promise<string>}
 */
export async function signDownloadToken(env, payload, ttlSeconds) {
  const body = { ...payload, exp: Date.now() + (ttlSeconds || 3600) * 1000 };
  const bodyB64 = _bytesToB64Url(new TextEncoder().encode(JSON.stringify(body)));
  const key = await _hmacKey(_signingSecret(env));
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(bodyB64));
  const sigB64 = _bytesToB64Url(new Uint8Array(sig));
  return bodyB64 + '.' + sigB64;
}

/**
 * Verifies a token produced by signDownloadToken(). Throws if the
 * signature doesn't match, the token is malformed, or it has expired.
 *
 * @param {object} env
 * @param {string} token
 * @returns {Promise<object>} the original payload passed to signDownloadToken
 */
export async function verifyDownloadToken(env, token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error('Malformed download token.');
  }
  const [bodyB64, sigB64] = parts;

  const key = await _hmacKey(_signingSecret(env));
  const expectedSig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(bodyB64));
  const expectedSigB64 = _bytesToB64Url(new Uint8Array(expectedSig));

  if (expectedSigB64 !== sigB64) {
    throw new Error('Invalid download token.');
  }

  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(_b64UrlToBytes(bodyB64)));
  } catch (e) {
    throw new Error('Malformed download token.');
  }

  if (!payload.exp || Date.now() > payload.exp) {
    throw new Error('This download link has expired.');
  }

  return payload;
}
