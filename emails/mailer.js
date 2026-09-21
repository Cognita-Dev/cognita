// emails/mailer.js
// Shared helpers for the newer emails (welcome, password changed, billing):
//   sendEmail   - sends one email through Resend
//   claimOnce   - makes sure the same email is never sent twice
//   releaseClaim - lets an email be retried after a failed send
//
// Needs the Worker secret RESEND_API_KEY (already set up for the
// verification and password reset emails).

const DEFAULT_FROM = 'Cognita <noreply@cognita.com.ng>';

export async function sendEmail(env, to, { subject, html, text }) {
  if (!env.RESEND_API_KEY) throw new Error('Server misconfiguration: RESEND_API_KEY not set.');
  if (!to) throw new Error('No recipient address.');

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

/**
 * Returns true if this is the first time `key` has been claimed, and false
 * if it was claimed before. Pass ttlSeconds to forget the claim after a
 * while, or leave it out to remember it forever.
 * Stored in the existing COGNITA_USAGE KV store under the "mail:" prefix.
 */
export async function claimOnce(env, key, ttlSeconds) {
  if (!env.COGNITA_USAGE) return true; // cannot check, so allow
  const fullKey = 'mail:' + key;
  if ((await env.COGNITA_USAGE.get(fullKey)) !== null) return false;
  const options = ttlSeconds ? { expirationTtl: Math.max(60, ttlSeconds) } : undefined;
  await env.COGNITA_USAGE.put(fullKey, '1', options);
  return true;
}

export async function releaseClaim(env, key) {
  if (!env.COGNITA_USAGE) return;
  try {
    await env.COGNITA_USAGE.delete('mail:' + key);
  } catch (_) { /* best effort */ }
}

/** "21 September 2026, 02:38 WAT" (Lagos time, which is what most users see). */
export function formatLagosDateTime(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return '';
  const date = d.toLocaleDateString('en-GB', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'long', year: 'numeric' });
  const time = d.toLocaleTimeString('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', minute: '2-digit', hour12: false });
  return date + ', ' + time + ' WAT';
}

export function formatLagosDate(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'long', year: 'numeric' });
}

/** 450000 (kobo) becomes "₦4,500.00". */
export function formatNaira(kobo) {
  const n = Number(kobo);
  if (!isFinite(n) || n <= 0) return '';
  return '\u20A6' + (n / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
