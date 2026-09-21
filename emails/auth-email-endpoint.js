// emails/auth-email-endpoint.js
// Sends Cognita's account emails (verify email, reset password) from our
// own domain instead of Firebase's default sender.
//
// How it works:
//   1. Firebase creates the secure one-time code, but does NOT email it.
//   2. We wrap that code in a link on our own domain.
//   3. We send the branded email through Resend.
//
// Needs one secret on the Worker: RESEND_API_KEY.

import { verifyFirebaseIdToken, describeAuthError } from '../auth-middleware.js';
import { getGoogleAccessToken } from '../firestore-rest.js';
import { buildVerifyEmail, buildResetEmail } from './auth-email-templates.js';

const IDENTITY_SCOPE = 'https://www.googleapis.com/auth/identitytoolkit';
const DEFAULT_FROM = 'Cognita <noreply@cognita.com.ng>';

function _headers(env) {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': env?.APP_ORIGIN || '*' };
}
function _ok(body, env) {
  return new Response(JSON.stringify(body), { status: 200, headers: _headers(env) });
}
function _err(message, status, env) {
  return new Response(JSON.stringify({ error: message }), { status, headers: _headers(env) });
}

async function _sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// One email per address per minute. Uses the existing usage KV store.
async function _onCooldown(env, key) {
  if (!env.COGNITA_USAGE) return false;
  return (await env.COGNITA_USAGE.get(key)) !== null;
}
async function _startCooldown(env, key, seconds) {
  if (!env.COGNITA_USAGE) return;
  await env.COGNITA_USAGE.put(key, '1', { expirationTtl: Math.max(60, seconds) });
}

// Stops one visitor from hammering the reset form: 20 requests per hour per IP.
async function _ipAllowed(request, env) {
  if (!env.COGNITA_USAGE) return true;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const hour = new Date().toISOString().slice(0, 13);
  const key = 'authmail:ip:' + ip + ':' + hour;
  const used = parseInt((await env.COGNITA_USAGE.get(key)) || '0', 10);
  if (used >= 20) return false;
  await env.COGNITA_USAGE.put(key, String(used + 1), { expirationTtl: 3700 });
  return true;
}

// Asks Firebase for a one-time code without letting Firebase send anything.
async function _createActionCode(env, requestType, email) {
  const token = await getGoogleAccessToken(env, IDENTITY_SCOPE);
  const res = await fetch(
    'https://identitytoolkit.googleapis.com/v1/projects/' + env.FIREBASE_PROJECT_ID + '/accounts:sendOobCode',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestType, email, returnOobLink: true }),
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const e = new Error('Identity Toolkit sendOobCode failed (' + res.status + '): ' + text.slice(0, 200));
    e.userNotFound = text.includes('EMAIL_NOT_FOUND');
    throw e;
  }
  const data = await res.json();
  let code = data.oobCode;
  if (!code && data.oobLink) {
    try { code = new URL(data.oobLink).searchParams.get('oobCode'); } catch (_) {}
  }
  if (!code) throw new Error('Firebase did not return an action code.');
  return code;
}

function _actionLink(env, mode, code) {
  const origin = (env.APP_ORIGIN || 'https://app.cognita.com.ng').replace(/\/+$/, '');
  return origin + '/auth/action?mode=' + mode + '&oobCode=' + encodeURIComponent(code) + '&lang=en';
}

async function _sendWithResend(env, to, { subject, html, text }) {
  if (!env.RESEND_API_KEY) throw new Error('Server misconfiguration: RESEND_API_KEY not set.');
  const payload = {
    from: env.MAIL_FROM || DEFAULT_FROM,
    to: [to],
    subject,
    html,
    text,
  };
  if (env.MAIL_REPLY_TO) payload.reply_to = env.MAIL_REPLY_TO;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('Resend failed (' + res.status + '): ' + body.slice(0, 300));
  }
}

/** POST /api/auth/send-verification  (signed-in person, needs Bearer token) */
export async function handleSendVerificationEmail(request, env) {
  let identity;
  try {
    const match = (request.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!match) throw new Error('Missing Authorization header.');
    // Deliberately NOT requireAuth(): that rejects people whose email is
    // still unverified, and those are exactly the people who need this.
    identity = await verifyFirebaseIdToken(match[1], env.FIREBASE_PROJECT_ID);
  } catch (e) {
    const { status, message } = describeAuthError(e);
    return _err(message, status, env);
  }

  if (!identity.email) return _err('This account has no email address.', 400, env);
  if (identity.emailVerified) return _ok({ ok: true, alreadyVerified: true }, env);

  const cooldownKey = 'authmail:verify:' + identity.uid;
  if (await _onCooldown(env, cooldownKey)) {
    return _err('Please wait a minute before asking for another email.', 429, env);
  }

  try {
    const code = await _createActionCode(env, 'VERIFY_EMAIL', identity.email);
    const name = (identity.claims && identity.claims.name) || '';
    const message = buildVerifyEmail({ name, link: _actionLink(env, 'verifyEmail', code) });
    await _sendWithResend(env, identity.email, message);
    await _startCooldown(env, cooldownKey, 60);
    return _ok({ ok: true }, env);
  } catch (e) {
    console.error('[auth-email] verification send failed:', e.message);
    return _err('We could not send the email right now. Please try again in a moment.', 502, env);
  }
}

/** POST /api/auth/send-password-reset  body: { email }  (no sign-in needed) */
export async function handleSendPasswordReset(request, env) {
  let body;
  try {
    body = await request.json();
  } catch (_) {
    return _err('Invalid request.', 400, env);
  }

  const email = String((body && body.email) || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return _err('Enter a valid email address.', 400, env);
  }

  if (!(await _ipAllowed(request, env))) {
    return _err('Too many requests. Please try again later.', 429, env);
  }

  // Same answer whether or not the account exists, so nobody can use this
  // form to find out who has a Cognita account.
  const cooldownKey = 'authmail:reset:' + (await _sha256Hex(email));
  if (await _onCooldown(env, cooldownKey)) return _ok({ ok: true }, env);

  try {
    const code = await _createActionCode(env, 'PASSWORD_RESET', email);
    const message = buildResetEmail({ link: _actionLink(env, 'resetPassword', code) });
    await _sendWithResend(env, email, message);
    await _startCooldown(env, cooldownKey, 60);
    return _ok({ ok: true }, env);
  } catch (e) {
    if (e.userNotFound) return _ok({ ok: true }, env);
    console.error('[auth-email] reset send failed:', e.message);
    return _err('We could not send the email right now. Please try again in a moment.', 502, env);
  }
}
