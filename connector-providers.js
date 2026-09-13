// connector-providers.js
// The ONLY module that knows each provider's specific OAuth quirks —
// authorize URL shape, token endpoint, whether it wants JSON or
// form-encoded, Basic-auth vs body credentials, and whether refresh
// tokens exist at all. Everything above this file (connectors-endpoint.js)
// talks to all four providers through the same three functions:
// buildAuthorizeUrl, exchangeCodeForToken, refreshAccessToken.
//
// Scopes are intentionally hardcoded here, not passed in from the
// frontend — a scope list is a security decision, not a UI preference.

// Maps each provider to its Client ID / Secret env var names, matching
// exactly what was pushed via `wrangler secret put`.
const ENV_VARS = {
  github: { id: 'GITHUB_CLIENT_ID', secret: 'GITHUB_CLIENT_SECRET' },
  google: { id: 'GOOGLE_CLIENT_ID', secret: 'GOOGLE_CLIENT_SECRET' },
  figma: { id: 'FIGMA_CLIENT_ID', secret: 'FIGMA_CLIENT_SECRET' },
  canva: { id: 'CANVA_CLIENT_ID', secret: 'CANVA_CLIENT_SECRET' },
};

function _creds(provider, env) {
  const vars = ENV_VARS[provider];
  const id = env[vars.id];
  const secret = env[vars.secret];
  if (!id || !secret) {
    throw new Error('Server misconfiguration: ' + vars.id + '/' + vars.secret + ' not set.');
  }
  return { id, secret };
}

function _redirectUri(provider, env) {
  // All four callbacks live at the same shape on this Worker — see
  // worker.js routing. WORKER_ORIGIN must be set to the Worker's own
  // deployed URL (not APP_ORIGIN, which is the frontend).
  const origin = env.WORKER_ORIGIN || 'https://cognita.cognitai.workers.dev';
  return origin + '/auth/' + provider + '/callback';
}

function _form(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v))
    .join('&');
}

function _basicAuthHeader(id, secret) {
  return 'Basic ' + btoa(id + ':' + secret);
}

// ── Per-provider scopes ─────────────────────────────────────────────
// Keep these as narrow as the actual features need — see the scope
// discussion for Figma and Canva. Widening a scope later is a small,
// visible change here; requesting broad scopes up front is not
// reversible for users who already granted them.
const SCOPES = {
  github: 'repo', // full read/write on public AND private repos — see hasSufficientScope() below
  google: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/calendar.events',
  figma: 'file_read',
  canva: 'folder:permission:read design:content:read design:content:write asset:read profile:read design:meta:read asset:write folder:read',
};

// ── Scope sufficiency check ─────────────────────────────────────────
// Only meaningful for GitHub right now. Tokens issued before the scope
// changed from 'public_repo' to 'repo' still work but can't see private
// repos — this lets getValidToken() (connectors.js) detect that and
// force a reconnect instead of quietly returning an incomplete result.
// GitHub returns granted scopes as a comma-separated string, e.g.
// "repo,gist" — split defensively in case of stray spaces.
export function hasSufficientScope(provider, storedScope) {
  if (provider !== 'github') return true; // not implemented for the other three yet
  const granted = (storedScope || '').split(',').map((s) => s.trim());
  return granted.includes('repo');
}

// ── 1. Authorize URL (redirect the user here) ──────────────────────

/**
 * Builds the URL to send the user's browser to, to start the provider's
 * consent screen. `state` is always required (CSRF protection, see
 * connectors.js createOAuthState). `codeChallenge` is only used for
 * Canva; harmless to pass undefined for the other three.
 */
export function buildAuthorizeUrl(provider, env, { state, codeChallenge }) {
  const { id } = _creds(provider, env);
  const redirectUri = _redirectUri(provider, env);
  const scope = SCOPES[provider];

  if (provider === 'github') {
    return 'https://github.com/login/oauth/authorize?' + _form({
      client_id: id, redirect_uri: redirectUri, scope, state,
    });
  }

  if (provider === 'google') {
    return 'https://accounts.google.com/o/oauth2/v2/auth?' + _form({
      client_id: id, redirect_uri: redirectUri, response_type: 'code', scope, state,
      // access_type=offline + prompt=consent are both required to reliably
      // get a refresh_token back — without prompt=consent, Google only
      // issues one on a user's very first-ever authorization, silently
      // omitting it on every reconnect after that.
      access_type: 'offline', prompt: 'consent',
    });
  }

  if (provider === 'figma') {
    return 'https://www.figma.com/oauth?' + _form({
      client_id: id, redirect_uri: redirectUri, scope, state, response_type: 'code',
    });
  }

  if (provider === 'canva') {
    return 'https://www.canva.com/api/oauth/authorize?' + _form({
      client_id: id, redirect_uri: redirectUri, response_type: 'code', scope, state,
      code_challenge_method: 's256', code_challenge: codeChallenge,
    });
  }

  throw new Error('Unknown connector provider: ' + provider);
}

// ── 2. Exchange an authorization code for tokens ───────────────────

/**
 * Normalizes every provider's token response into the same shape:
 * { accessToken, refreshToken, expiresAt (epoch ms or null), scope,
 *   providerAccountId }. Throws on any non-2xx or malformed response —
 * callers must treat that as "connection failed, don't save anything."
 */
export async function exchangeCodeForToken(provider, env, { code, codeVerifier }) {
  const { id, secret } = _creds(provider, env);
  const redirectUri = _redirectUri(provider, env);
  const now = Date.now();

  if (provider === 'github') {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_id: id, client_secret: secret, code, redirect_uri: redirectUri }),
    });
    const data = await _mustJson(res, 'github');
    if (data.error) throw new Error('github_oauth_error:' + data.error + ': ' + data.error_description);
    return {
      accessToken: data.access_token,
      refreshToken: null, // classic GitHub OAuth Apps issue non-expiring tokens
      expiresAt: null,
      scope: data.scope || '',
      providerAccountId: null,
    };
  }

  if (provider === 'google') {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: _form({
        grant_type: 'authorization_code', code, client_id: id, client_secret: secret, redirect_uri: redirectUri,
      }),
    });
    const data = await _mustJson(res, 'google');
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || null,
      expiresAt: now + (data.expires_in || 3600) * 1000,
      scope: data.scope || '',
      providerAccountId: null,
    };
  }

  if (provider === 'figma') {
    const res = await fetch('https://www.figma.com/api/oauth/token?' + _form({
      client_id: id, client_secret: secret, redirect_uri: redirectUri, code, grant_type: 'authorization_code',
    }), { method: 'POST' });
    const data = await _mustJson(res, 'figma');
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || null,
      expiresAt: now + (data.expires_in || 3600) * 1000,
      scope: SCOPES.figma,
      providerAccountId: data.user_id || null,
    };
  }

  if (provider === 'canva') {
    const res = await fetch('https://api.canva.com/rest/v1/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: _basicAuthHeader(id, secret),
      },
      body: _form({
        grant_type: 'authorization_code', code, code_verifier: codeVerifier, redirect_uri: redirectUri,
      }),
    });
    const data = await _mustJson(res, 'canva');
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || null,
      expiresAt: now + (data.expires_in || 14400) * 1000,
      scope: data.scope || '',
      providerAccountId: null,
    };
  }

  throw new Error('Unknown connector provider: ' + provider);
}

// ── 3. Refresh an access token ──────────────────────────────────────

/**
 * Returns the same normalized shape as exchangeCodeForToken. Throws if
 * the provider has no refresh token to use, or if the provider rejects
 * the refresh (revoked/expired) — callers (connectors.js getValidToken)
 * must treat any throw here as "this connection needs to be redone,"
 * never retry silently.
 */
export async function refreshAccessToken(provider, env, refreshTokenValue) {
  if (!refreshTokenValue) {
    throw new Error('No refresh token available for ' + provider + ' — reconnect required.');
  }

  const { id, secret } = _creds(provider, env);
  const now = Date.now();

  if (provider === 'google') {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: _form({ grant_type: 'refresh_token', refresh_token: refreshTokenValue, client_id: id, client_secret: secret }),
    });
    const data = await _mustJson(res, 'google');
    return {
      accessToken: data.access_token,
      // Google does not re-issue a refresh_token on refresh — keep the one we had.
      refreshToken: refreshTokenValue,
      expiresAt: now + (data.expires_in || 3600) * 1000,
      scope: data.scope || '',
      providerAccountId: null,
    };
  }

  if (provider === 'figma') {
    const res = await fetch('https://www.figma.com/api/oauth/refresh?' + _form({
      client_id: id, client_secret: secret, refresh_token: refreshTokenValue,
    }), { method: 'POST' });
    const data = await _mustJson(res, 'figma');
    return {
      accessToken: data.access_token,
      refreshToken: refreshTokenValue, // Figma refresh doesn't rotate the refresh token itself
      expiresAt: now + (data.expires_in || 3600) * 1000,
      scope: SCOPES.figma,
      providerAccountId: null,
    };
  }

  if (provider === 'canva') {
    const res = await fetch('https://api.canva.com/rest/v1/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: _basicAuthHeader(id, secret),
      },
      body: _form({ grant_type: 'refresh_token', refresh_token: refreshTokenValue }),
    });
    const data = await _mustJson(res, 'canva');
    return {
      accessToken: data.access_token,
      // Canva DOES rotate the refresh token on every refresh — the old
      // one becomes invalid, so the new value must always be saved.
      refreshToken: data.refresh_token,
      expiresAt: now + (data.expires_in || 14400) * 1000,
      scope: data.scope || '',
      providerAccountId: null,
    };
  }

  if (provider === 'github') {
    throw new Error('GitHub classic OAuth App tokens do not expire — refresh should never be called for this provider.');
  }

  throw new Error('Unknown connector provider: ' + provider);
}

// ── 4. Revoke a token (best-effort, called on disconnect) ──────────
// Not every provider has a clean single-call revoke; where one exists,
// disconnectProvider() in connectors.js calls this before deleting the
// local record, so an old token can't be replayed by whoever last had
// the browser session. Failures here are swallowed by the caller — a
// revoke failing should never block the user from disconnecting locally.

export async function revokeToken(provider, env, token) {
  if (provider === 'google') {
    await fetch('https://oauth2.googleapis.com/revoke?' + _form({ token }), { method: 'POST' });
    return;
  }
  if (provider === 'canva') {
    const { id, secret } = _creds(provider, env);
    await fetch('https://api.canva.com/rest/v1/oauth/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Authorization: _basicAuthHeader(id, secret) },
      body: _form({ token }),
    });
    return;
  }
  if (provider === 'github') {
    const { id, secret } = _creds(provider, env);
    await fetch('https://api.github.com/applications/' + id + '/grant', {
      method: 'DELETE',
      headers: {
        Authorization: _basicAuthHeader(id, secret),
        'Content-Type': 'application/json',
        'User-Agent': 'cognita-app',
      },
      body: JSON.stringify({ access_token: token }),
    });
    return;
  }
  // Figma has no documented single-call revoke endpoint — deleting the
  // local record is all that's possible; the token remains valid
  // provider-side until it naturally expires.
}

async function _mustJson(res, provider) {
  const text = await res.text().catch(() => '');
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(provider + '_non_json_response: ' + text.slice(0, 200));
  }
  if (!res.ok) {
    throw new Error(provider + '_' + res.status + ': ' + text.slice(0, 200));
  }
  return data;
}
