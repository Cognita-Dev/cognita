// connectors-endpoint.js
// HTTP handlers for connector OAuth. Thin — all real logic lives in
// connectors.js (storage/orchestration) and connector-providers.js
// (per-provider protocol). This file only translates Requests/Responses.

import { requireAuth } from './auth-middleware.js';
import {
  CONNECTOR_PROVIDERS,
  ALLOWED_RETURN_TARGETS,
  startAuth,
  handleCallback,
  consumeOAuthState,
  listConnectedProviders,
  disconnectProvider,
} from './connectors.js';

// Where each returnTo value sends the user back to. Both pages accept
// ?connector=<provider>&status=<connected|denied|error> and show a
// one-line result banner — see account.html / app.html.
const RETURN_PAGES = { account: '/account.html', chat: '/app.html' };

function _corsJsonHeaders(env) {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': env?.APP_ORIGIN || '*' };
}

function _jsonError(message, status, env) {
  return new Response(JSON.stringify({ error: message }), { status, headers: _corsJsonHeaders(env) });
}

function _isKnownProvider(provider) {
  return CONNECTOR_PROVIDERS.includes(provider);
}

/**
 * GET /api/connectors/:provider/start?returnTo=account|chat
 * Requires auth (this is a normal API call from the logged-in frontend,
 * e.g. a "Connect GitHub" button click) — NOT the provider's redirect.
 * Returns { url } for the frontend to navigate to, rather than issuing
 * the redirect itself, so the frontend can open it in the right way
 * (same tab, popup, etc.) rather than the API silently 302ing.
 *
 * `returnTo` is validated against an allowlist, never trusted as a raw
 * URL — account.html sends returnTo=account, app.html sends
 * returnTo=chat, and anything else (missing, mistyped, tampered with)
 * quietly falls back to "account". This is what account.html/app.html
 * being different pages with different "where do I send you back"
 * needs actually maps to server-side.
 */
export async function handleConnectorStart(request, env, provider) {
  if (!_isKnownProvider(provider)) {
    return _jsonError('Unknown connector: ' + provider, 404, env);
  }

  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    return _jsonError('Not authenticated: ' + e.message, 401, env);
  }

  const url = new URL(request.url);
  const requestedReturnTo = url.searchParams.get('returnTo');
  const returnTo = ALLOWED_RETURN_TARGETS.includes(requestedReturnTo) ? requestedReturnTo : 'account';

  try {
    const authorizeUrl = await startAuth(identity.uid, provider, env, returnTo);
    return new Response(JSON.stringify({ url: authorizeUrl }), { status: 200, headers: _corsJsonHeaders(env) });
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
 * to a uid (and a returnTo destination) via the one-time KV entry
 * created in handleConnectorStart. Ends in a redirect to the frontend
 * either way (success or failure), never a raw JSON response — the user
 * is mid-browser-navigation, not making an API call.
 *
 * This is the "B: failure reaches our callback" half of error handling
 * (see project notes on OAuth error classes). It covers: the provider
 * itself reporting an error/denial, a missing/expired/reused state, and
 * a token-exchange failure. It CANNOT do anything about failures that
 * never reach this route at all — e.g. a provider's own login/consent
 * screen erroring out before it redirects anywhere (that's class "A",
 * and has to be fixed in the provider's own app configuration).
 */
export async function handleConnectorCallback(request, env, provider) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const providerError = url.searchParams.get('error');

  const appOrigin = env.APP_ORIGIN || 'https://cognitai.vercel.app';

  if (!_isKnownProvider(provider)) {
    return Response.redirect(appOrigin + '/account.html?status=error', 302);
  }

  // The provider itself can redirect back with an error instead of a
  // code — e.g. the user clicked "Deny"/"Cancel" on the consent screen,
  // or the provider hit its own error (invalid_scope, server_error,
  // etc). That first case is a normal outcome, not a bug; the rest are
  // still failures WE can present cleanly since we did reach our own
  // callback. Either way, try to recover the returnTo destination that
  // was captured when the flow started, so the user lands back where
  // they clicked "Connect" from rather than always on account.html.
  if (providerError) {
    console.warn('[connectors] provider-side error for', provider, ':', providerError,
      url.searchParams.get('error_description') || '');
    const returnTo = await _peekReturnTo(provider, state, env);
    const status = providerError === 'access_denied' ? 'denied' : 'error';
    return Response.redirect(RETURN_PAGES[returnTo] ? appOrigin + RETURN_PAGES[returnTo] + '?connector=' + provider + '&status=' + status
      : appOrigin + '/account.html?connector=' + provider + '&status=' + status, 302);
  }

  try {
    const { returnTo } = await handleCallback(provider, code, state, env);
    const page = RETURN_PAGES[returnTo] || RETURN_PAGES.account;
    return Response.redirect(appOrigin + page + '?connector=' + provider + '&status=connected', 302);
  } catch (e) {
    // Covers: missing/invalid/expired/replayed state, state/provider
    // mismatch, and any token-exchange failure (bad code, provider API
    // error, malformed response) — connectors.js/connector-providers.js
    // throw on all of these, never return a partially-saved token.
    console.error('[connectors] callback failed for', provider, ':', e.message);
    return Response.redirect(appOrigin + '/account.html?connector=' + provider + '&status=error', 302);
  }
}

// Best-effort recovery of the returnTo destination for a callback that's
// erroring out before handleCallback would normally consume the state
// (e.g. the provider sent `error=` instead of `code=`). Consumes the
// state exactly like a real callback would — a provider error redirect
// still has to burn the one-time state token, since it was already
// spent on this OAuth attempt. Never throws; missing/invalid state here
// just means "we can't tell where to send them back, use account.html."
async function _peekReturnTo(provider, state, env) {
  if (!state) return 'account';
  try {
    const stateData = await consumeOAuthState(state, env);
    if (stateData && stateData.provider === provider && ALLOWED_RETURN_TARGETS.includes(stateData.returnTo)) {
      return stateData.returnTo;
    }
  } catch (e) {
    // Swallow — this is a best-effort UX nicety, not a security check.
  }
  return 'account';
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
    return _jsonError('Not authenticated: ' + e.message, 401, env);
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
    return _jsonError('Not authenticated: ' + e.message, 401, env);
  }

  try {
    await disconnectProvider(identity.uid, provider, env);
    return new Response(JSON.stringify({ disconnected: provider }), { status: 200, headers: _corsJsonHeaders(env) });
  } catch (e) {
    console.error('[connectors] disconnect failed for', provider, ':', e.message);
    return _jsonError('Could not disconnect ' + provider + '. Please try again.', 500, env);
  }
}
