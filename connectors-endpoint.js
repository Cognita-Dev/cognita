// connectors-endpoint.js
// HTTP handlers for connector OAuth. Thin — all real logic lives in
// connectors.js (storage/orchestration) and connector-providers.js
// (per-provider protocol). This file only translates Requests/Responses.

import { requireAuth } from './auth-middleware.js';
import {
  CONNECTOR_PROVIDERS,
  startAuth,
  handleCallback,
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
    return _jsonError('Not authenticated: ' + e.message, 401, env);
  }

  try {
    const url = await startAuth(identity.uid, provider, env);
    return new Response(JSON.stringify({ url }), { status: 200, headers: _corsJsonHeaders(env) });
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
 * making an API call.
 */
export async function handleConnectorCallback(request, env, provider) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const providerError = url.searchParams.get('error');

  const appOrigin = env.APP_ORIGIN || 'https://cognitai.vercel.app';

  // The provider itself can redirect back with an error instead of a
  // code — e.g. the user clicked "Deny" on the consent screen. That's a
  // normal outcome, not a bug; just send them back without a code param.
  if (providerError) {
    return Response.redirect(appOrigin + '/account.html?connector=' + provider + '&status=denied', 302);
  }

  if (!_isKnownProvider(provider)) {
    return Response.redirect(appOrigin + '/account.html?status=error', 302);
  }

  try {
    await handleCallback(provider, code, state, env);
    return Response.redirect(appOrigin + '/account.html?connector=' + provider + '&status=connected', 302);
  } catch (e) {
    console.error('[connectors] callback failed for', provider, ':', e.message);
    return Response.redirect(appOrigin + '/account.html?connector=' + provider + '&status=error', 302);
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
