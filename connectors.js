// connectors.js
// Storage layer for third-party connector tokens (GitHub, Google, Facebook,
// Canva). Two separate stores, deliberately never mixed:
//
//   - Firestore (`connectors/{uid}/providers/{provider}`) — the actual
//     access/refresh tokens. Long-lived, per-user, read on demand when a
//     connector tool is invoked.
//
//   - KV (`COGNITA_OAUTH_STATE`) — short-lived (10 min) OAuth transaction
//     state. Exists only to survive the redirect round-trip to the
//     provider and back: it ties the callback to the Firebase uid that
//     started the flow (auth-middleware.js can't run on a provider's
//     redirect — there's no Authorization header on it) and carries
//     Canva's PKCE code_verifier across that same round-trip. One-time
//     use: consumeOAuthState deletes the entry the moment it's read, so a
//     replayed/reused state can never succeed twice.
//
// This file does NOT know how to talk to GitHub/Google/etc. — no
// authorize URLs, no token-exchange requests, no tool schemas. That's
// deliberate: this is pure storage, so it can be built and tested before
// a single provider-specific line of OAuth code exists. The next layer
// (still to be written) imports these functions and adds the actual
// provider integrations on top.

import { fsGet, fsSet, fsDelete } from './firestore-rest.js';
import { buildAuthorizeUrl, exchangeCodeForToken, refreshAccessToken, revokeToken, hasSufficientScope } from './connector-providers.js';

// The only four providers this app knows about. Kept as a single exported
// list so routing, the account-page UI data, and validation all check
// against the same source of truth instead of re-typing provider names.
// Slack and Dropbox were removed (2026) — see project notes; Figma was
// replaced by Facebook (2026-09), see project notes — do not re-add or
// remove a provider name here without also wiring up
// connector-providers.js, a *-tools.js executor, and every frontend
// CONNECTOR_META/CONNECTOR_ORDER.
export const CONNECTOR_PROVIDERS = ['github', 'google', 'facebook', 'canva'];

// Where the OAuth flow should send the user back to after the provider's
// redirect completes. This is the ONLY set of values `returnTo` may ever
// take — it is never a client-supplied URL (see startAuth/handleCallback
// below), specifically to avoid turning this into an open redirect.
export const ALLOWED_RETURN_TARGETS = ['account', 'chat'];

function _assertKnownProvider(provider) {
  if (!CONNECTOR_PROVIDERS.includes(provider)) {
    throw new Error('Unknown connector provider: ' + provider);
  }
}

function _tokenPath(uid, provider) {
  return 'connectors/' + uid + '/providers/' + provider;
}

// ── Firestore: token storage ──────────────────────────────────────────

/**
 * Reads the stored token record for one provider, or null if the user
 * has never connected it (or has since disconnected it).
 * Shape: { accessToken, refreshToken, expiresAt, scope, connectedAt,
 *          providerAccountId }
 * `expiresAt` is an epoch-ms number, or null for tokens that don't expire
 * (GitHub's classic OAuth App tokens never expire, so it's always null
 * there; every other provider here issues expiring tokens).
 */
export async function getConnectorToken(uid, provider, env) {
  _assertKnownProvider(provider);
  return fsGet(_tokenPath(uid, provider), env);
}

/**
 * Writes (or overwrites) a provider's token record. Overwriting is
 * intentional and safe for the "user reconnects the same provider"
 * case — the caller is responsible for revoking the old token with the
 * provider first where that's possible, before calling this with the
 * new one, so an abandoned-but-still-live token is never left behind.
 */
export async function saveConnectorToken(uid, provider, data, env) {
  _assertKnownProvider(provider);
  const record = {
    accessToken: data.accessToken || null,
    refreshToken: data.refreshToken || null,
    expiresAt: typeof data.expiresAt === 'number' ? data.expiresAt : null,
    scope: data.scope || '',
    connectedAt: data.connectedAt || new Date().toISOString(),
    providerAccountId: data.providerAccountId || null,
  };
  await fsSet(_tokenPath(uid, provider), record, env);

  // Facebook only: keep a Facebook-user-id -> uid reverse index so Meta's
  // Data Deletion Request callback (facebook-data-deletion.js), which is
  // only ever handed the Facebook-side id, can find and erase this
  // person's connector data. Best-effort — a hiccup here must not fail
  // the connection itself; the callback simply finds nothing to delete
  // yet, which it treats as a valid outcome, not an error.
  if (provider === 'facebook' && record.providerAccountId) {
    try {
      await fsSet('fb_connector_index/' + record.providerAccountId, {
        uid,
        linkedAt: record.connectedAt,
      }, env);
    } catch (e) {
      console.error('[connectors] could not write fb_connector_index for uid ' + uid + ':', e.message);
    }
  }

  return record;
}

/**
 * Removes a provider's token record. Safe to call even if none exists.
 * For Facebook specifically, this also removes the matching
 * fb_connector_index entry (see saveConnectorToken above) — reading the
 * existing record first so we know which Facebook user id to clear, since
 * that id is never passed in by callers.
 */
export async function deleteConnectorToken(uid, provider, env) {
  _assertKnownProvider(provider);
  if (provider === 'facebook') {
    try {
      const existing = await getConnectorToken(uid, provider, env);
      if (existing && existing.providerAccountId) {
        await fsDelete('fb_connector_index/' + existing.providerAccountId, env);
      }
    } catch (e) {
      // Non-fatal: the token record itself still gets deleted below even
      // if the index cleanup lookup failed (e.g. a transient Firestore
      // error) — better to leave a stale, harmless index entry than to
      // block disconnecting/deleting the actual token.
      console.error('[connectors] could not clean up fb_connector_index for uid ' + uid + ':', e.message);
    }
  }
  await fsDelete(_tokenPath(uid, provider), env);
  return true;
}

/**
 * Returns which of the four providers this uid has a token stored for,
 * as { github: true|false, google: true|false, ... }. Reads all four in
 * parallel — four small point-reads is cheap and simple, and avoids
 * needing a Firestore subcollection-listing query for a fixed, tiny set
 * of possible providers.
 */
export async function listConnectedProviders(uid, env) {
  const entries = await Promise.all(
    CONNECTOR_PROVIDERS.map(async (provider) => {
      const doc = await getConnectorToken(uid, provider, env);
      return [provider, !!doc];
    })
  );
  return Object.fromEntries(entries);
}

// ── KV: short-lived OAuth transaction state ───────────────────────────

const OAUTH_STATE_TTL_SECONDS = 600; // 10 minutes — generous for a login redirect, short enough to limit replay risk

function _requireOAuthStateKv(env) {
  if (!env.COGNITA_OAUTH_STATE) {
    throw new Error('Server misconfiguration: COGNITA_OAUTH_STATE KV not bound.');
  }
}

function _randomToken() {
  // 32 random bytes, base64url-encoded — unguessable and URL-safe with no
  // padding, so it can go straight into a query string.
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Starts an OAuth transaction: generates a random `state`, stores it in
 * KV alongside the uid/provider (and anything provider-specific the
 * caller passes in `extra`, e.g. Canva's PKCE code_verifier), and
 * returns the state string to embed in the authorize URL.
 *
 * @param {string} uid - Firebase uid of the user starting the connection
 * @param {string} provider - one of CONNECTOR_PROVIDERS
 * @param {object} [extra] - provider-specific data to carry across the
 *   redirect, e.g. { codeVerifier } for Canva's PKCE flow
 */
export async function createOAuthState(uid, provider, env, extra = {}) {
  _assertKnownProvider(provider);
  _requireOAuthStateKv(env);

  const state = _randomToken();
  const value = { uid, provider, createdAt: Date.now(), ...extra };

  await env.COGNITA_OAUTH_STATE.put('oauthstate:' + state, JSON.stringify(value), {
    expirationTtl: OAUTH_STATE_TTL_SECONDS,
  });

  return state;
}

/**
 * Consumes an OAuth state token: reads it, deletes it immediately (so it
 * can never be used a second time), and returns the stored value. Returns
 * null if the state doesn't exist or has expired — callers MUST treat
 * that as "reject this callback," never as "proceed anyway."
 *
 * Does NOT verify that `provider` matches what the caller expected —
 * that check belongs to the caller (the callback route already knows
 * which provider's callback URL was hit; compare it against
 * `result.provider` and reject on mismatch).
 */
export async function consumeOAuthState(state, env) {
  _requireOAuthStateKv(env);
  if (!state || typeof state !== 'string') return null;

  const key = 'oauthstate:' + state;
  const raw = await env.COGNITA_OAUTH_STATE.get(key);
  if (!raw) return null;

  // Delete before returning, not after — if two requests somehow race on
  // the same state, only one should ever get a non-null result back.
  await env.COGNITA_OAUTH_STATE.delete(key);

  try {
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

// ── PKCE (Canva only, per Canva's OAuth requirements) ─────────────────

/**
 * Generates a PKCE code_verifier: a random string 43-128 chars long from
 * the unreserved URL-safe character set, per RFC 7636. 32 random bytes
 * base64url-encoded (~43 chars) satisfies this comfortably.
 */
export function generateCodeVerifier() {
  return _randomToken();
}

/**
 * Derives the S256 code_challenge from a code_verifier: base64url(SHA-256
 * (verifier)). This is what goes in the authorize URL; the raw verifier
 * itself is never sent until the token-exchange step, and only over a
 * direct server-to-server HTTPS request.
 */
export async function generateCodeChallenge(codeVerifier) {
  const bytes = new TextEncoder().encode(codeVerifier);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const digestBytes = new Uint8Array(digest);
  let binary = '';
  for (let i = 0; i < digestBytes.length; i++) binary += String.fromCharCode(digestBytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ── Orchestration: ties storage + PKCE + provider protocol together ──
// Everything below is what connectors-endpoint.js actually calls. It
// never talks to fsGet/fsSet, KV, or connector-providers.js directly —
// this file is the only seam between "an HTTP route fired" and "a token
// got read, refreshed, or written."

/**
 * Starts a connector's OAuth flow for an already-authenticated uid.
 * Returns the URL to redirect the user's browser to.
 *
 * @param {string} returnTo - one of ALLOWED_RETURN_TARGETS, captured at
 *   the moment the flow starts (e.g. "chat" if the user opened the
 *   Connected Apps modal from app.html, "account" from account.html) and
 *   carried inside the signed/validated OAuth state so the callback can
 *   send them back to where they started. Never a raw URL — see
 *   handleCallback below for why.
 */
export async function startAuth(uid, provider, env, returnTo = 'account') {
  _assertKnownProvider(provider);
  const safeReturnTo = ALLOWED_RETURN_TARGETS.includes(returnTo) ? returnTo : 'account';

  let codeVerifier;
  let codeChallenge;
  if (provider === 'canva') {
    codeVerifier = generateCodeVerifier();
    codeChallenge = await generateCodeChallenge(codeVerifier);
  }

  const state = await createOAuthState(uid, provider, env, {
    returnTo: safeReturnTo,
    ...(codeVerifier ? { codeVerifier } : {}),
  });
  return buildAuthorizeUrl(provider, env, { state, codeChallenge });
}

/**
 * Handles a provider's redirect back to /auth/:provider/callback.
 * Validates `state` (rejects missing/expired/mismatched-provider —
 * see consumeOAuthState's one-time-use guarantee), exchanges the code,
 * and persists the resulting token. Returns the uid that was connected
 * and the allowlisted returnTo destination that was captured when the
 * flow started, so the route handler knows who to redirect, where to
 * send them, and what to log.
 *
 * Throws on any failure. Callers must not redirect the user to a
 * "connected!" page unless this resolves successfully.
 *
 * Diagnostic logging here is deliberately non-secret: uid, provider, and
 * providerAccountId (where the provider gives us one) only — never the
 * access/refresh token itself. This is what lets a security review of
 * "did user A really get bound to user A's own token" happen from logs
 * alone, without ever having a token pass through log output.
 */
export async function handleCallback(provider, code, state, env) {
  _assertKnownProvider(provider);

  const stateData = await consumeOAuthState(state, env);
  if (!stateData) {
    const e = new Error('Invalid or expired authorization state — please try connecting again.');
    e.returnTo = 'account'; // no state to read a returnTo from
    throw e;
  }
  const returnTo = ALLOWED_RETURN_TARGETS.includes(stateData.returnTo) ? stateData.returnTo : 'account';

  if (stateData.provider !== provider) {
    // Someone hit provider A's callback URL with a state minted for
    // provider B — either a bug in the redirect URI configuration or a
    // deliberate mismatch attempt. Reject outright either way.
    const e = new Error('State/provider mismatch.');
    e.returnTo = returnTo;
    throw e;
  }
  if (!code) {
    const e = new Error('Missing authorization code.');
    e.returnTo = returnTo;
    throw e;
  }

  try {
    const tokenData = await exchangeCodeForToken(provider, env, { code, codeVerifier: stateData.codeVerifier });
    await saveConnectorToken(stateData.uid, provider, tokenData, env);

    console.log(
      '[connectors] token stored — provider=' + provider +
      ' uid=' + stateData.uid +
      ' providerAccountId=' + (tokenData.providerAccountId || 'n/a')
    );

    return { uid: stateData.uid, returnTo };
  } catch (e) {
    e.returnTo = returnTo; // preserve so the caller can send the user back to where they started, even on failure
    throw e;
  }
}

// Refresh a bit before the actual expiry, not exactly at it — avoids a
// request landing in the few-second window where the token is technically
// still valid by timestamp but the provider has already started rejecting it.
const EXPIRY_SAFETY_MARGIN_MS = 60_000;

/**
 * Returns a currently-valid access token for uid/provider, transparently
 * refreshing first if needed. Throws if there's no connection at all, or
 * if refresh fails (revoked/expired refresh token) — either case means
 * "the user needs to reconnect," and callers (the tool-execution layer)
 * must surface that distinctly rather than as a generic error, and should
 * delete the now-useless local record via disconnectProvider so the UI
 * stops showing this as connected.
 */
export async function getValidToken(uid, provider, env) {
  _assertKnownProvider(provider);

  const record = await getConnectorToken(uid, provider, env);
  if (!record || !record.accessToken) {
    throw new Error('NOT_CONNECTED');
  }

  const isExpired = typeof record.expiresAt === 'number' && Date.now() > record.expiresAt - EXPIRY_SAFETY_MARGIN_MS;
  if (!isExpired) {
    if (!hasSufficientScope(provider, record.scope)) {
      // Old connection, old scope (e.g. GitHub's 'public_repo' before it
      // became 'repo') — treat exactly like an expired/revoked token so
      // the existing reconnect messaging in connector-tools.js kicks in.
      throw new Error('NEEDS_RECONNECT');
    }
    return record.accessToken;
  }

  // Expired and no way to refresh (GitHub never expires so never reaches
  // here at all).
  if (!record.refreshToken) {
    throw new Error('NEEDS_RECONNECT');
  }

  let refreshed;
  try {
    refreshed = await refreshAccessToken(provider, env, record.refreshToken);
  } catch (e) {
    throw new Error('NEEDS_RECONNECT');
  }

  await saveConnectorToken(uid, provider, {
    ...refreshed,
    connectedAt: record.connectedAt, // preserve original connection date
    providerAccountId: refreshed.providerAccountId || record.providerAccountId,
  }, env);

  return refreshed.accessToken;
}

/**
 * Disconnects a provider: best-effort revokes the token with the
 * provider (failure here is swallowed — see revokeToken's own comment),
 * then always deletes the local Firestore record regardless of whether
 * the revoke succeeded. "Disconnected in Cognita" must be true even if
 * the provider's revoke endpoint is down.
 */
export async function disconnectProvider(uid, provider, env) {
  _assertKnownProvider(provider);

  const record = await getConnectorToken(uid, provider, env);
  if (record && record.accessToken) {
    try {
      await revokeToken(provider, env, record.accessToken);
    } catch (e) {
      console.warn('[connectors] revoke failed for', provider, '— deleting local record anyway:', e.message);
    }
  }

  await deleteConnectorToken(uid, provider, env);
  return true;
}
