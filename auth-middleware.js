// auth-middleware.js
// Verifies a Firebase ID token server-side using Google's public JWKS.
// This is the ONLY source of truth for "who is making this request."
// Never trust a userId/uid passed in a request body.

const GOOGLE_JWKS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
const FIREBASE_ISSUER_PREFIX = 'https://securetoken.google.com/';

let _certCache = null;
let _certCacheExpiry = 0;
let _lastForcedRefresh = 0;

// Imported CryptoKeys, keyed by certificate text. Importing a key is
// comparatively slow; the same few keys verify every request.
const _keyCache = new Map();

async function _getGoogleCerts(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && _certCache && now < _certCacheExpiry) return _certCache;

  try {
    const res = await fetch(GOOGLE_JWKS_URL);
    if (!res.ok) throw new Error('Could not fetch Google public certs.');
    const certs = await res.json();

    // How long these certs stay valid = max-age MINUS how long Google's
    // cache has already held them (the Age header). Ignoring Age made us
    // keep certs past their real expiry, so after Google rotated its
    // signing keys, tokens signed with a new key were rejected as
    // "unknown signing key" until our cache finally expired.
    const cacheControl = res.headers.get('cache-control') || '';
    const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
    const ageSeconds = parseInt(res.headers.get('age') || '0', 10) || 0;
    const maxAgeMs = maxAgeMatch
      ? Math.max(60, parseInt(maxAgeMatch[1], 10) - ageSeconds) * 1000
      : 3600000;

    _certCache = certs;
    _certCacheExpiry = now + maxAgeMs;
    return certs;
  } catch (e) {
    // A brief network blip reaching Google must not lock every signed-in
    // person out. Keep using the last good certs (they are still valid
    // for verifying signatures) and try again in a minute.
    if (_certCache) {
      _certCacheExpiry = now + 60000;
      return _certCache;
    }
    // No cached certs to fall back on: we genuinely cannot verify anyone
    // right now. This is not the same failure as a bad or missing token —
    // it's Google being unreachable — so callers must be able to tell the
    // two apart and answer 503 (temporary) instead of 401 (rejected).
    const unavailable = new Error('Could not reach Google to verify sign-in credentials.');
    unavailable.isAuthUnavailable = true;
    unavailable.cause = e;
    throw unavailable;
  }
}

function _b64urlToUint8Array(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4));
  const raw = atob(b64 + pad);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function _decodeJwtParts(idToken) {
  const parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Malformed token.');
  const header = JSON.parse(new TextDecoder().decode(_b64urlToUint8Array(parts[0])));
  const payload = JSON.parse(new TextDecoder().decode(_b64urlToUint8Array(parts[1])));
  return { header, payload, signedContent: parts[0] + '.' + parts[1], signature: parts[2] };
}

// Parses a PEM X.509 certificate into a CryptoKey for RS256 verification.
async function _importCertAsPublicKey(pem) {
  const cached = _keyCache.get(pem);
  if (cached) return cached;
  const key = await _importCertAsPublicKeyUncached(pem);
  if (_keyCache.size > 8) _keyCache.clear();
  _keyCache.set(pem, key);
  return key;
}

async function _importCertAsPublicKeyUncached(pem) {
  const b64 = pem
    .replace('-----BEGIN CERTIFICATE-----', '')
    .replace('-----END CERTIFICATE-----', '')
    .replace(/\s+/g, '');
  const der = _b64urlToUint8Array(b64.replace(/\+/g, '-').replace(/\//g, '_'));

  // The certificate is X.509; WebCrypto can import the SPKI portion directly
  // via the 'spki' format only if we've extracted it — but Cloudflare Workers'
  // crypto.subtle.importKey also accepts raw X.509 certs are NOT directly
  // importable as 'spki'. We extract the public key using the certificate's
  // DER structure is complex to hand-parse; instead we rely on the fact that
  // Google's x509 certs here wrap a standard RSA public key we can extract
  // via the 'x509' shortcut some runtimes support. Cloudflare Workers supports
  // importing 'spki' format directly from these certs' embedded public key,
  // extracted below using a minimal DER walk for the SubjectPublicKeyInfo.
  const spki = _extractSpkiFromCert(der);

  return crypto.subtle.importKey(
    'spki',
    spki,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify']
  );
}

// Minimal DER walker: extracts the SubjectPublicKeyInfo (SPKI) block from an
// X.509 certificate. X.509 certs are SEQUENCE { tbsCertificate, sigAlg, sig }
// and tbsCertificate contains the SPKI as one of its fields. This walks just
// enough structure to find it without a full ASN.1 library.
function _extractSpkiFromCert(der) {
  let pos = 0;

  function readLength() {
    let len = der[pos++];
    if (len & 0x80) {
      const numBytes = len & 0x7f;
      len = 0;
      for (let i = 0; i < numBytes; i++) len = (len << 8) | der[pos++];
    }
    return len;
  }

  function expectTag(tag) {
    if (der[pos] !== tag) throw new Error('Unexpected DER tag while parsing certificate.');
    pos++;
    return readLength();
  }

  // Certificate ::= SEQUENCE
  expectTag(0x30);
  // tbsCertificate ::= SEQUENCE
  const tbsStart = pos;
  const tbsLen = expectTag(0x30);
  const tbsEnd = pos + tbsLen;

  // Walk into tbsCertificate looking for the SPKI SEQUENCE, which is the
  // first field with the tag structure: version[0], serial(INT), sigAlg(SEQ),
  // issuer(SEQ), validity(SEQ), subject(SEQ), subjectPublicKeyInfo(SEQ)
  // We skip fields by tag until we hit the 7th top-level SEQUENCE/context tag
  // that matches SPKI's known shape (SEQUENCE containing an AlgorithmIdentifier
  // SEQUENCE followed by a BIT STRING).
  let fieldCount = 0;
  while (pos < tbsEnd) {
    const tagStart = pos;
    const tag = der[pos];
    pos++;
    const len = readLength();
    const contentStart = pos;

    // version field is context-specific [0], skip it distinctly
    if (tag === 0xa0) { pos = contentStart + len; continue; }

    if (tag === 0x30) {
      fieldCount++;
      // The 6th plain SEQUENCE after version (sigAlg, issuer, validity,
      // subject having been SEQUENCEs too) is subjectPublicKeyInfo.
      // sigAlg=1, issuer=2, validity=3, subject=4 -> SPKI is field 5
      if (fieldCount === 5) {
        return der.slice(tagStart, contentStart + len);
      }
    }
    pos = contentStart + len;
  }

  throw new Error('Could not locate SubjectPublicKeyInfo in certificate.');
}

/**
 * Verifies a Firebase ID token and returns the decoded, verified payload.
 * Throws on any failure — see describeAuthError() below for how callers
 * should turn that failure into an HTTP response.
 *
 * @param {string} idToken - raw Firebase ID token from Authorization header
 * @param {string} projectId - your Firebase project ID (for aud/iss checks)
 * @returns {Promise<{uid: string, email: string|null, emailVerified: boolean, claims: object}>}
 */
export async function verifyFirebaseIdToken(idToken, projectId) {
  if (!idToken || typeof idToken !== 'string') {
    throw new Error('Missing token.');
  }

  const { header, payload, signedContent, signature } = _decodeJwtParts(idToken);

  if (header.alg !== 'RS256') throw new Error('Unexpected token algorithm.');
  if (!header.kid) throw new Error('Token missing key ID.');

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) throw new Error('Token expired.');
  if (payload.iat && payload.iat > now + 300) throw new Error('Token issued in the future.');
  if (payload.aud !== projectId) throw new Error('Token audience mismatch.');
  if (payload.iss !== FIREBASE_ISSUER_PREFIX + projectId) throw new Error('Token issuer mismatch.');
  if (!payload.sub) throw new Error('Token missing subject.');
  if (payload.auth_time && payload.auth_time > now + 300) throw new Error('Invalid auth_time.');

  let certs = await _getGoogleCerts();
  let certPem = certs[header.kid];
  if (!certPem && Date.now() - _lastForcedRefresh > 60000) {
    // Unknown key ID: Google may just have rotated its keys. Re-fetch once
    // (at most once a minute, so a forged kid can't make us hammer Google).
    _lastForcedRefresh = Date.now();
    certs = await _getGoogleCerts(true);
    certPem = certs[header.kid];
  }
  if (!certPem) throw new Error('Unknown signing key — token may be forged or certs rotated.');

  const publicKey = await _importCertAsPublicKey(certPem);
  const signatureBytes = _b64urlToUint8Array(signature);
  const contentBytes = new TextEncoder().encode(signedContent);

  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    publicKey,
    signatureBytes,
    contentBytes
  );

  if (!valid) throw new Error('Invalid token signature.');

  return {
    uid: payload.sub,
    email: payload.email || null,
    emailVerified: !!payload.email_verified,
    claims: payload,
  };
}

/**
 * Convenience wrapper: pulls the Bearer token out of a Request, verifies it,
 * and returns the verified identity — or throws.
 */
export async function requireAuth(request, env) {
  const authHeader = request.headers.get('Authorization') || '';
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) throw new Error('Missing Authorization header.');

  if (!env.FIREBASE_PROJECT_ID) {
    throw new Error('Server misconfiguration: FIREBASE_PROJECT_ID not set.');
  }

  const identity = await verifyFirebaseIdToken(match[1], env.FIREBASE_PROJECT_ID);

  // Backend-side enforcement of "verified email required to use the app".
  // This is the check that actually matters — the frontend redirecting an
  // unverified person to /verify-email.html is just courtesy UX. A request
  // sent straight at this API (curl, devtools, a modified client) with a
  // valid-but-unverified token must still be rejected here.
  //
  // Scoped to the 'password' sign-in provider only: Google verifies the
  // address as a condition of its own OAuth flow, so a Google-signed-in
  // person's token is never unverified in a way this needs to catch, and
  // gating on it too would wrongly block a legitimate Google account if
  // Google ever omitted the claim.
  const signInProvider = identity.claims && identity.claims.firebase
    ? identity.claims.firebase.sign_in_provider
    : null;
  if (signInProvider === 'password' && !identity.emailVerified) {
    const e = new Error('Please verify your email address before continuing.');
    e.isEmailUnverified = true;
    throw e;
  }

  return identity;
}

/**
 * Turns an error thrown by requireAuth() / requireAdmin() / requireSuperAdmin()
 * into the HTTP status and message an endpoint should send back.
 *
 * - isAuthUnavailable (set above): we could not reach Google to check the
 *   token at all. The person may well be validly signed in — we just don't
 *   know yet — so this is a 503, not a 401, and it must never be treated
 *   as "log this person out" on the client.
 * - isEmailUnverified (set above, in requireAuth): the token is valid and
 *   belongs to a real, signed-in person — they just haven't confirmed
 *   their email/password account yet. 403, with a distinct `code` so a
 *   caller could special-case it if it ever needs to.
 * - isForbidden (set by admin-auth.js): the person is who they say they
 *   are, they're just not allowed to do this. 403.
 * - anything else: the token itself was missing, expired, or invalid. 401.
 *
 * Every endpoint that calls requireAuth/requireAdmin/requireSuperAdmin
 * should route its catch block through this instead of hardcoding a status.
 */
export function describeAuthError(e) {
  if (e && e.isAuthUnavailable) {
    return {
      status: 503,
      message: 'We could not check your sign-in status because of a temporary problem on our end. Please try again in a moment.',
    };
  }
  if (e && e.isEmailUnverified) {
    return {
      status: 403,
      code: 'email_not_verified',
      message: e.message || 'Please verify your email address before continuing.',
    };
  }
  if (e && e.isForbidden) {
    return { status: 403, message: (e.message || 'You do not have permission to do this.') };
  }
  return { status: 401, message: 'Not authenticated: ' + (e && e.message ? e.message : 'please sign in again.') };
}
