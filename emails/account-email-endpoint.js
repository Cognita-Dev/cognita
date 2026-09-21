// emails/account-email-endpoint.js
// Two account emails:
//   Welcome           POST /api/auth/send-welcome            (signed in)
//   Password changed  POST /api/auth/notify-password-changed (after a reset)
//
// The server decides whether each email is really due. The browser only
// asks. That keeps anyone from using these addresses to send email to
// people who did nothing.

import { verifyFirebaseIdToken, describeAuthError } from '../auth-middleware.js';
import { lookupUser, firstName } from './firebase-users.js';
import { sendEmail, claimOnce, releaseClaim, formatLagosDateTime } from './mailer.js';
import { buildWelcomeEmail, buildPasswordChangedEmail } from './auth-email-templates.js';

// Only accounts created in the last 7 days get a welcome email. This stops
// people who signed up long before this feature existed from receiving one.
const WELCOME_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// A password change only triggers the notice if it happened in the last 10 minutes.
const PASSWORD_CHANGE_WINDOW_MS = 10 * 60 * 1000;

function _headers(env) {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': env?.APP_ORIGIN || '*' };
}
function _ok(body, env) {
  return new Response(JSON.stringify(body), { status: 200, headers: _headers(env) });
}
function _err(message, status, env) {
  return new Response(JSON.stringify({ error: message }), { status, headers: _headers(env) });
}

/** POST /api/auth/send-welcome  (needs the signed-in person's token) */
export async function handleSendWelcomeEmail(request, env) {
  let identity;
  try {
    const match = (request.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
    if (!match) throw new Error('Missing Authorization header.');
    identity = await verifyFirebaseIdToken(match[1], env.FIREBASE_PROJECT_ID);
  } catch (e) {
    const { status, message } = describeAuthError(e);
    return _err(message, status, env);
  }

  try {
    // Ask Firebase directly. The token can be a few minutes out of date
    // right after someone verifies their email, Firebase itself is not.
    const user = await lookupUser(env, { uid: identity.uid });
    if (!user || !user.email) return _ok({ sent: false, final: true, reason: 'no_email' }, env);

    if (!user.emailVerified) return _ok({ sent: false, final: false, reason: 'unverified' }, env);

    if (!user.createdAt || Date.now() - user.createdAt > WELCOME_WINDOW_MS) {
      return _ok({ sent: false, final: true, reason: 'not_new' }, env);
    }

    const claimKey = 'welcome:' + user.uid;
    if (!(await claimOnce(env, claimKey))) {
      return _ok({ sent: false, final: true, reason: 'already_sent' }, env);
    }

    try {
      await sendEmail(env, user.email, buildWelcomeEmail({ name: firstName(user.displayName) }));
    } catch (e) {
      await releaseClaim(env, claimKey); // allow a retry on the next visit
      throw e;
    }
    return _ok({ sent: true, final: true }, env);
  } catch (e) {
    console.error('[account-email] welcome failed:', e.message);
    return _err('Could not send the welcome email right now.', 502, env);
  }
}

// Allows 30 requests per hour from one IP address.
async function _ipAllowed(request, env) {
  if (!env.COGNITA_USAGE) return true;
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const hour = new Date().toISOString().slice(0, 13);
  const key = 'authmail:notify-ip:' + ip + ':' + hour;
  const used = parseInt((await env.COGNITA_USAGE.get(key)) || '0', 10);
  if (used >= 30) return false;
  await env.COGNITA_USAGE.put(key, String(used + 1), { expirationTtl: 3700 });
  return true;
}

/**
 * POST /api/auth/notify-password-changed   body: { email }
 * Called by the reset page right after a new password is saved. The person
 * is not signed in at that point, so instead of trusting the request we
 * check with Firebase that this account's password really changed in the
 * last few minutes, and we send at most one email per change.
 */
export async function handlePasswordChangedNotice(request, env) {
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

  try {
    const user = await lookupUser(env, { email });
    // Same quiet answer for every case where nothing should be sent.
    if (!user || !user.email) return _ok({ ok: true }, env);
    if (!user.passwordUpdatedAt) {
      console.warn('[account-email] Firebase gave no password change time, no notice sent.');
      return _ok({ ok: true }, env);
    }
    if (Date.now() - user.passwordUpdatedAt > PASSWORD_CHANGE_WINDOW_MS) return _ok({ ok: true }, env);

    const claimKey = 'pwchanged:' + user.uid + ':' + user.passwordUpdatedAt;
    if (!(await claimOnce(env, claimKey, 24 * 60 * 60))) return _ok({ ok: true }, env);

    try {
      await sendEmail(
        env,
        user.email,
        buildPasswordChangedEmail({
          name: firstName(user.displayName),
          email: user.email,
          when: formatLagosDateTime(user.passwordUpdatedAt),
        })
      );
    } catch (e) {
      await releaseClaim(env, claimKey);
      throw e;
    }
    return _ok({ ok: true }, env);
  } catch (e) {
    console.error('[account-email] password notice failed:', e.message);
    return _err('Could not send the email right now.', 502, env);
  }
}
