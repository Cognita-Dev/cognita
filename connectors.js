// connectors.js
// Storage layer for third-party connector tokens (GitHub, Google, Slack,
// Figma, Dropbox, Canva). Two separate stores, deliberately never mixed:
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

// The only six providers this app knows about. Kept as a single exported
// list so routing, the account-page UI data, and validation all check
// against the same source of truth instead of re-typing provider names.
export const CONNECTOR_PROVIDERS = ['github', 'google', 'slack', 'figma', 'dropbox', 'canva'];

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
  return record;
}

/** Removes a provider's token record. Safe to call even if none exists. */
export async function deleteConnectorToken(uid, provider, env) {
  _assertKnownProvider(provider);
  await fsDelete(_tokenPath(uid, provider), env);
  return true;
}

/**
 * Returns which of the six providers this uid has a token stored for,
 * as { github: true|false, google: true|false, ... }. Reads all six in
 * parallel — six small point-reads is cheap and simple, and avoids
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
