// facebook-data-deletion.js
//
// Implements Meta's "Data Deletion Request Callback" contract end to end,
// for BOTH Meta apps this project uses:
//
//   - the "login" app  (Facebook Login for Business — Continue with
//     Facebook, consumer sign-in, no Page/Instagram access)
//   - the "social" app (the existing Facebook/Instagram connector in
//     connectors.js — Page + Instagram publishing/insights)
//
// Meta only ever gives ONE "Data Deletion Callback URL" field per app, but
// nothing stops both apps from pointing at the SAME url — this file's job
// is to figure out, per incoming request, which of the two apps it came
// from (by trying both apps' secrets against the signature) and delete
// only what that app's login/connection actually gave us.
//
// Two small Firestore lookup tables make that possible without ever
// trusting a client-supplied uid:
//
//   fb_login_index/{facebookUserId}     -> { uid, linkedAt }
//     written by handleLinkFacebookLogin, right after a successful
//     "Continue with Facebook" sign-in (see js/auth.js signInWithFacebook).
//
//   fb_connector_index/{facebookUserId} -> { uid, linkedAt }
//     written by connectors.js's saveConnectorToken whenever someone
//     connects the Facebook/Instagram connector, and cleaned up by
//     deleteConnectorToken — see connectors.js.
//
// Neither table stores anything else about the person; they exist purely
// so a Facebook-side user id can be turned back into "which Cognita
// account is this," which is unavoidable because Meta's callback only
// ever gives us the Facebook-side id.

import { fsGet, fsSet, fsDelete } from './firestore-rest.js';
import { deleteConnectorToken } from './connectors.js';
import { requireAuth, describeAuthError } from './auth-middleware.js';

// ── signed_request verification (Meta's documented algorithm) ─────────
// https://developers.facebook.com/docs/facebook-login/guides/advanced/oidc-oauth/signed-request/
// signed_request = "<base64url HMAC-SHA256 signature>.<base64url JSON payload>"
// The signature is computed over the *encoded* payload string (not the
// decoded bytes), keyed with the app secret of whichever app sent it.

function _b64UrlDecodeToBytes(str) {
  let s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4;
  if (pad) s += '='.repeat(4 - pad);
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function _hmacSha256(secret, dataBytes) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, dataBytes);
  return new Uint8Array(sig);
}

function _bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * Tries `signedRequest` against each [appLabel, secret] pair in order and
 * returns { app: appLabel, payload } for whichever one's signature
 * matches, or null if none do (wrong/missing secret, tampered payload, or
 * malformed input). Skips any pair whose secret is falsy, so this still
 * works correctly even before both env secrets exist.
 */
async function _verifySignedRequest(signedRequest, secretsByApp) {
  const parts = String(signedRequest || '').split('.');
  if (parts.length !== 2) return null;
  const [encodedSig, encodedPayload] = parts;

  let sigBytes;
  try {
    sigBytes = _b64UrlDecodeToBytes(encodedSig);
  } catch (_) {
    return null;
  }
  const payloadBytes = new TextEncoder().encode(encodedPayload);

  for (const [appLabel, secret] of secretsByApp) {
    if (!secret) continue;
    const expected = await _hmacSha256(secret, payloadBytes);
    if (!_bytesEqual(expected, sigBytes)) continue;

    let payload;
    try {
      payload = JSON.parse(new TextDecoder().decode(_b64UrlDecodeToBytes(encodedPayload)));
    } catch (_) {
      return null;
    }
    if (payload.algorithm && String(payload.algorithm).toUpperCase() !== 'HMAC-SHA256') continue;
    return { app: appLabel, payload };
  }
  return null;
}

function _corsJsonHeaders(env) {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': env?.APP_ORIGIN || '*' };
}
function _jsonError(message, status, env) {
  return new Response(JSON.stringify({ error: message }), { status, headers: _corsJsonHeaders(env) });
}

function _confirmationCode() {
  return 'fbdel_' + crypto.randomUUID().replace(/-/g, '').slice(0, 20);
}

// ── POST /auth/facebook/data-deletion ──────────────────────────────────
// Meta calls this directly (server-to-server, form-encoded body, no
// Authorization header — it can't run through auth-middleware.js, which
// is exactly why this needs its own signature check instead).
export async function handleFacebookDataDeletion(request, env) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed.', { status: 405 });
  }

  const rawBody = await request.text();
  const signedRequest = new URLSearchParams(rawBody).get('signed_request');
  if (!signedRequest) return _jsonError('Missing signed_request.', 400, env);

  const verified = await _verifySignedRequest(signedRequest, [
    ['login', env.FACEBOOK_LOGIN_APP_SECRET],
    ['social', env.FACEBOOK_CLIENT_SECRET],
  ]);
  if (!verified) {
    console.warn('[facebook-data-deletion] signed_request did not verify against any known app secret.');
    return _jsonError('Invalid signed_request.', 400, env);
  }

  const fbUserId = verified.payload && verified.payload.user_id;
  if (!fbUserId) return _jsonError('signed_request is missing user_id.', 400, env);

  let uid = null;
  try {
    if (verified.app === 'social') {
      const idxDoc = await fsGet('fb_connector_index/' + fbUserId, env);
      if (idxDoc && idxDoc.uid) {
        uid = idxDoc.uid;
        // Deletes the stored Facebook/Instagram connector token AND its
        // fb_connector_index entry — see connectors.js deleteConnectorToken.
        await deleteConnectorToken(uid, 'facebook', env);
      }
    } else {
      const idxDoc = await fsGet('fb_login_index/' + fbUserId, env);
      if (idxDoc && idxDoc.uid) {
        uid = idxDoc.uid;
        await fsDelete('fb_login_index/' + fbUserId, env);
      }
    }
  } catch (e) {
    console.error('[facebook-data-deletion] deletion failed:', e.message);
    return _jsonError('Could not process this deletion right now. Please try again.', 500, env);
  }

  // No matching index entry just means: nothing of theirs was stored on
  // our side under that Facebook id (already disconnected, or they never
  // completed the flow that would have linked it). That's still a
  // legitimate "there is nothing left to delete" outcome, not an error —
  // Meta expects 200 + a confirmation code either way.
  const code = _confirmationCode();
  const nowIso = new Date().toISOString();
  try {
    await fsSet('data_deletion_requests/' + code, {
      app: verified.app,
      fbUserId,
      uid: uid || null,
      status: 'completed',
      requestedAt: nowIso,
      completedAt: nowIso,
    }, env);
  } catch (e) {
    // Non-fatal: the deletion itself already happened above. Losing the
    // confirmation-code record only affects the optional status page.
    console.error('[facebook-data-deletion] could not record confirmation code:', e.message);
  }

  return new Response(JSON.stringify({
    url: (env.APP_ORIGIN || 'https://app.cognita.com.ng') + '/data-deletion-status.html?id=' + code,
    confirmation_code: code,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

// ── GET /api/data-deletion-status/:code ────────────────────────────────
// Public, unauthenticated — this is the page a person lands on after
// tapping the confirmation link/code Meta shows them. There is nothing
// sensitive in the record (no tokens, no profile data), so no auth is
// required to read it, matching what Meta's own reviewers expect to be
// able to check without a Cognita login.
export async function handleDataDeletionStatus(request, env, code) {
  if (!code) return _jsonError('Missing confirmation code.', 400, env);
  let doc;
  try {
    doc = await fsGet('data_deletion_requests/' + code, env);
  } catch (e) {
    return _jsonError('Could not look up that request right now. Please try again.', 500, env);
  }
  if (!doc) return _jsonError('No deletion request was found for that confirmation code.', 404, env);
  return new Response(JSON.stringify({
    status: doc.status || 'completed',
    requestedAt: doc.requestedAt || null,
    completedAt: doc.completedAt || null,
  }), { status: 200, headers: _corsJsonHeaders(env) });
}

// ── POST /api/auth/link-facebook ───────────────────────────────────────
// Called once by the frontend right after Auth.signInWithFacebook()
// resolves (see js/auth.js). Requires a valid Firebase session — the uid
// it records always comes from the verified token, never from the
// request body, so a person can only ever link their OWN account.
export async function handleLinkFacebookLogin(request, env) {
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
  } catch (_) {
    return _jsonError('Invalid request body.', 400, env);
  }
  const fbUserId = String(body?.fbUserId || '').trim();
  if (!fbUserId) return _jsonError('fbUserId is required.', 400, env);

  try {
    await fsSet('fb_login_index/' + fbUserId, {
      uid: identity.uid,
      linkedAt: new Date().toISOString(),
    }, env);
  } catch (e) {
    console.error('[facebook-data-deletion] could not save login index:', e.message);
    return _jsonError('Could not save that right now. Please try again.', 500, env);
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: _corsJsonHeaders(env) });
}
