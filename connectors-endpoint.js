// connectors-endpoint.js
// HTTP handlers for connector OAuth. Thin — all real logic lives in
// connectors.js (storage/orchestration) and connector-providers.js
// (per-provider protocol). This file only translates Requests/Responses.

import { requireAuth, describeAuthError } from './auth-middleware.js';
import { resolveAccountWithRole } from './subscription.js';
import { planHasConnectorTools } from './entitlements.js';
import {
  CONNECTOR_PROVIDERS,
  ALLOWED_RETURN_TARGETS,
  startAuth,
  handleCallback,
  consumeOAuthState,
  listConnectedProviders,
  disconnectProvider,
} from './connectors.js';

function _corsJsonHeaders(env) {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': env?.APP_ORIGIN || '*' };
}

function _jsonError(message, status, env) {
  return new Response(JSON.stringify({ error: message }), { status, headers: _corsJsonHeaders(env) });
}

function _isKnownProvider(provider) {
  return CONNECTOR_PROVIDERS.includes(provider);
}

// Maps a resolved returnTo ('account' | 'chat') to the actual page the
// provider's redirect should land on. Centralized here so every exit
// path in handleConnectorCallback below sends the user back to where
// they actually started, instead of always landing on account.html.
function _redirectBase(appOrigin, returnTo) {
  return appOrigin + '/' + (returnTo === 'chat' ? 'app.html' : 'account.html');
}

// Turns a raw error message into a short reason code the frontend can
// key a friendlier message off of, without the frontend needing to know
// anything about GitHub/OAuth error strings itself.
function _classifyFailureReason(message) {
  const text = String(message || '');
  // GitHub's token endpoint returns error=bad_verification_code when the
  // code was already used or the underlying login session (e.g. a
  // device-verification email code) expired before the exchange
  // happened — see connector-providers.js exchangeCodeForToken.
  if (/bad_verification_code/i.test(text)) return 'session_expired';
  // Our own 10-minute OAuth state KV entry expired — same user-facing
  // situation (they took too long partway through), different layer.
  if (/Invalid or expired authorization state/i.test(text)) return 'session_expired';
  return 'error';
}

/**
 * GET /api/connectors/:provider/start
 * Requires auth (this is a normal API call from the logged-in frontend,
 * e.g. a "Connect GitHub" button click) — NOT the provider's redirect.
 * Returns { url } for the frontend to navigate to, rather than issuing
 * the redirect itself, so the frontend can open it in the right way
 * (same tab, popup, etc.) rather than the API silently 302ing.
 */
export async function handleConnectorStart(request, env, provider) {
  if (!_isKnownProvider(provider)) {
    return _jsonError('Unknown connector: ' + provider, 404, env);
  }

  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    const _authErr = describeAuthError(e);
    return _jsonError(_authErr.message, _authErr.status, env);
  }

  // Belt-and-suspenders: chat-endpoint.js already refuses to ever call a
  // connected tool for a plan without connectorTools (connectorToolsEnabled
  // there), so a Free-tier user who somehow reaches this endpoint would
  // just be spending an OAuth round-trip on a connection Cognita will
  // never use. The frontend is expected to lock this entry point before
  // it gets here (see updateConnectorsAvailability in js/app.js), but the
  // real gate has to live here too, since a client-side lock can always
  // be bypassed by calling the API directly.
  let account;
  try {
    account = await resolveAccountWithRole(identity.uid, env);
  } catch (e) {
    console.error('[connectors] account resolution failed:', e.message);
    return _jsonError('Could not verify your plan. Please try again.', 500, env);
  }
  if (!planHasConnectorTools(account.planId)) {
    return _jsonError('Connected apps require Cognita Plus or higher. Upgrade to connect ' + provider + '.', 403, env);
  }

  const url = new URL(request.url);
  const returnTo = url.searchParams.get('returnTo') || 'account';

  try {
    const authUrl = await startAuth(identity.uid, provider, env, returnTo);
    return new Response(JSON.stringify({ url: authUrl }), { status: 200, headers: _corsJsonHeaders(env) });
  } catch (e) {
    console.error('[connectors] start failed for', provider, ':', e.message);
    return _jsonError('Could not start the connection to ' + provider + '. Please try again.', 500, env);
  }
}

/**
 * GET /auth/:provider/callback
 * Hit directly by the provider's redirect — there is NO Authorization
 * header here, no Firebase session, nothing. Identity comes entirely
 * from the `state` param, which connectors.handleCallback resolves back
 * to a uid via the one-time KV entry created in handleConnectorStart.
 * Ends in a redirect to the frontend either way (success or failure),
 * never a raw JSON response — the user is mid-browser-navigation, not
 * making an API call. Always redirects to whichever page (account.html
 * or app.html) the flow actually started from — see _redirectBase.
 */
export async function handleConnectorCallback(request, env, provider) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const providerError = url.searchParams.get('error');

  const appOrigin = env.APP_ORIGIN || 'https://app.cognita.com.ng';

  // The provider itself can redirect back with an error instead of a
  // code — e.g. the user clicked "Deny" on the consent screen. That's a
  // normal outcome, not a bug. GitHub still sends `state` on a denial,
  // so peek at it (read-only intent, but consumeOAuthState is one-time-
  // use either way) purely to find out which page to send them back to.
  if (providerError) {
    let returnTo = 'account';
    try {
      const stateData = await consumeOAuthState(state, env);
      if (stateData && stateData.provider === provider && ALLOWED_RETURN_TARGETS.includes(stateData.returnTo)) {
        returnTo = stateData.returnTo;
      }
    } catch (e) {
      // Fall back to account.html — a denial redirect should never itself fail.
    }
    return Response.redirect(_redirectBase(appOrigin, returnTo) + '?connector=' + provider + '&status=denied', 302);
  }

  if (!_isKnownProvider(provider)) {
    return Response.redirect(appOrigin + '/account.html?status=error', 302);
  }

  try {
    const { returnTo } = await handleCallback(provider, code, state, env);
    return Response.redirect(_redirectBase(appOrigin, returnTo) + '?connector=' + provider + '&status=connected', 302);
  } catch (e) {
    console.error('[connectors] callback failed for', provider, ':', e.message);
    const returnTo = e.returnTo || 'account';
    const reason = _classifyFailureReason(e.message);
    return Response.redirect(_redirectBase(appOrigin, returnTo) + '?connector=' + provider + '&status=error&reason=' + reason, 302);
  }
}

/**
 * GET /api/connectors/status
 * Returns which providers the authenticated user currently has
 * connected, e.g. { github: true, google: false, ... }. Used by the
 * account page to render Connect/Disconnect state per provider.
 */
export async function handleConnectorStatus(request, env) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    const _authErr = describeAuthError(e);
    return _jsonError(_authErr.message, _authErr.status, env);
  }

  try {
    const status = await listConnectedProviders(identity.uid, env);
    return new Response(JSON.stringify(status), { status: 200, headers: _corsJsonHeaders(env) });
  } catch (e) {
    console.error('[connectors] status check failed:', e.message);
    return _jsonError('Could not load connector status.', 500, env);
  }
}

/**
 * POST /api/connectors/:provider/disconnect
 */
export async function handleConnectorDisconnect(request, env, provider) {
  if (!_isKnownProvider(provider)) {
    return _jsonError('Unknown connector: ' + provider, 404, env);
  }

  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    const _authErr = describeAuthError(e);
    return _jsonError(_authErr.message, _authErr.status, env);
  }

  try {
    await disconnectProvider(identity.uid, provider, env);
    return new Response(JSON.stringify({ disconnected: provider }), { status: 200, headers: _corsJsonHeaders(env) });
  } catch (e) {
    console.error('[connectors] disconnect failed for', provider, ':', e.message);
    return _jsonError('Could not disconnect ' + provider + '. Please try again.', 500, env);
  }
}
