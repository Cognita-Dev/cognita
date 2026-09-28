// emails/unsubscribe.js
// Everything about "unsubscribe" in one place:
//   buildUnsubscribeUrl   - makes the private link that goes into an email
//   unsubscribeHeaders    - the two email headers that give Gmail, Yahoo and
//                           Apple Mail their built-in "Unsubscribe" button
//   handleEmailUnsubscribe- the page and action behind that link
//
// How it works
//  1. Each optional email (reminders, digests) carries a link like
//       https://api.cognita.com.ng/api/email/unsubscribe?t=<token>
//     The token is signed, so it cannot be forged or edited, and needs no
//     login. It says "this person, this kind of email".
//  2. Opening the link (GET) only shows a page with an "Unsubscribe" button.
//     It changes nothing. That matters because some security scanners open
//     every link in an email, and they must not unsubscribe people by accident.
//  3. Pressing the button (POST) does the unsubscribe.
//  4. Gmail / Yahoo / Apple Mail's own Unsubscribe button POSTs straight to
//     the same link (RFC 8058 "one-click"), so it works without a page.
//
// Kinds of email that can be unsubscribed from:
//   reminders - reminder emails      (emailPrefs/{uid}.remindersEmail)
//   digest    - performance digests  (insightsSchedules/{uid}.deliverEmail)
//
// No new Worker secret is needed: the signing key is derived from the same
// secret the download links already use.

import { fsGet, fsUpdate } from '../firestore-rest.js';
import { setReminderEmailAllowed } from './email-prefs.js';

const CATEGORIES = {
  reminders: {
    label: 'reminder emails',
    what: 'Cognita will stop emailing you when a reminder is due.',
    stillGets: 'Reminders can still reach you as app notifications, if you have those turned on.',
    back: 'Turn reminder emails back on',
  },
  digest: {
    label: 'performance digest emails',
    what: 'Cognita will stop emailing you your performance digests.',
    stillGets: 'You can still read every digest any time from Insights in Cognita.',
    back: 'Turn digest emails back on',
  },
};

const SITE = 'https://app.cognita.com.ng';
const ASSETS = SITE + '/assets/email/';

// ── Signed tokens ─────────────────────────────────────────────

function _secret(env) {
  return 'unsubscribe:' + (env.B2_APPLICATION_KEY || env.FIREBASE_PROJECT_ID || 'cognita-unsubscribe');
}

async function _hmacKey(env) {
  return crypto.subtle.importKey('raw', new TextEncoder().encode(_secret(env)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function _b64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function _fromB64url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Deliberately has no expiry: an unsubscribe link in an old email must keep
// working (the law expects at least 30 days, and people open old emails).
async function signUnsubscribeToken(env, uid, category) {
  const body = _b64url(new TextEncoder().encode(JSON.stringify({ u: uid, c: category })));
  const sig = await crypto.subtle.sign('HMAC', await _hmacKey(env), new TextEncoder().encode(body));
  return body + '.' + _b64url(new Uint8Array(sig));
}

export async function verifyUnsubscribeToken(env, token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('Malformed token.');
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await _hmacKey(env), _fromB64url(parts[1]), new TextEncoder().encode(parts[0]));
  } catch (_) {
    ok = false;
  }
  if (!ok) throw new Error('Bad signature.');
  const payload = JSON.parse(new TextDecoder().decode(_fromB64url(parts[0])));
  if (!payload.u || !CATEGORIES[payload.c]) throw new Error('Bad payload.');
  return { uid: payload.u, category: payload.c };
}

// ── Links and headers for emails ──────────────────────────────

export async function buildUnsubscribeUrl(env, uid, category) {
  const origin = env.WORKER_ORIGIN || 'https://api.cognita.com.ng';
  return origin + '/api/email/unsubscribe?t=' + encodeURIComponent(await signUnsubscribeToken(env, uid, category));
}

/** The two headers that switch on the mail app's own "Unsubscribe" button. */
export function unsubscribeHeaders(url) {
  return {
    'List-Unsubscribe': '<' + url + '>',
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  };
}

// ── The action itself ─────────────────────────────────────────

async function applyChoice(env, uid, category, subscribed) {
  if (category === 'reminders') {
    await setReminderEmailAllowed(env, uid, subscribed);
    return;
  }
  if (category === 'digest') {
    const path = 'insightsSchedules/' + uid;
    const schedule = await fsGet(path, env);
    // No schedule means no digest emails are being sent, so nothing to do.
    if (schedule) await fsUpdate(path, { deliverEmail: !!subscribed, updatedAt: new Date().toISOString() }, env);
  }
}

// ── The page ──────────────────────────────────────────────────

function esc(v) {
  return String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function page({ title, heading, paragraphs, form, tone }) {
  const paras = paragraphs.map((p) => '<p>' + p + '</p>').join('');
  return (
'<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
'<meta name="viewport" content="width=device-width, initial-scale=1">' +
'<meta name="robots" content="noindex, nofollow"><meta name="color-scheme" content="light dark">' +
'<title>' + esc(title) + '</title>' +
'<style>' +
':root{--bg:#f4f3ef;--card:#fff;--ink:#171717;--body:#4a4a48;--muted:#77776f;--line:#e8e6e1;--accent:#a8471f;--ok:#2f7a4d}' +
'@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1f1f1d;--ink:#f4f3ef;--body:#c9c8c2;--muted:#9a9990;--line:#33332f;--ok:#67c58a}}' +
'*{box-sizing:border-box}body{margin:0;min-height:100vh;background:var(--bg);color:var(--body);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;display:flex;flex-direction:column;align-items:center;padding:36px 16px}' +
'.wrap{width:100%;max-width:520px}.brand{display:flex;align-items:center;gap:10px;margin:0 4px 20px;color:var(--ink);font-weight:800;font-size:22px;letter-spacing:-.6px;text-decoration:none}' +
'.brand img{width:30px;height:28px}' +
'.card{background:var(--card);border:1px solid var(--line);border-top:3px solid var(--accent);border-radius:12px;padding:36px 32px}' +
'h1{margin:0 0 16px;font:italic 400 28px/1.25 Georgia,"Times New Roman",serif;letter-spacing:-.4px;color:var(--ink)}' +
'h1.ok::before{content:"\\2713";display:inline-block;margin-right:10px;font-style:normal;font-family:-apple-system,Segoe UI,Arial,sans-serif;color:var(--ok)}' +
'p{margin:0 0 14px;font-size:15px}p.small{font-size:13px;color:var(--muted)}' +
'button{appearance:none;border:0;cursor:pointer;font-family:inherit;font-size:15px;line-height:20px;font-weight:600;padding:14px 28px;border-radius:8px;background:var(--accent);color:#fff;margin-top:8px}' +
'button:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:2px}' +
'button.link{background:none;color:var(--accent);padding:0;margin:0;font-weight:500;text-decoration:underline;text-underline-offset:3px}' +
'a{color:var(--accent)}.foot{margin:22px 4px 0;font-size:12px;color:var(--muted);text-align:center}' +
'@media (max-width:480px){.card{padding:28px 22px}button.main{width:100%}}' +
'</style></head><body><div class="wrap">' +
'<a class="brand" href="' + SITE + '"><img src="' + ASSETS + 'cognita-mark.png" alt="">cognita</a>' +
'<div class="card"><h1' + (tone === 'ok' ? ' class="ok"' : '') + '>' + esc(heading) + '</h1>' + paras + (form || '') + '</div>' +
'<p class="foot"><a href="' + SITE + '/privacy.html" style="color:inherit">Privacy Policy</a> &middot; <a href="mailto:info@cognita.com.ng" style="color:inherit">Contact us</a></p>' +
'</div></body></html>'
  );
}

function html(body, status) {
  return new Response(body, {
    status: status || 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex',
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src " + ASSETS + "; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

function postForm(token, action, label, cls) {
  return (
    '<form method="POST" action="?t=' + esc(encodeURIComponent(token)) + '">' +
    '<input type="hidden" name="action" value="' + action + '">' +
    '<button type="submit" class="' + cls + '">' + esc(label) + '</button></form>'
  );
}

const invalidPage = () =>
  html(page({
    title: 'Link not valid',
    heading: 'This link is not valid',
    paragraphs: [
      'The unsubscribe link may be incomplete. Try opening it again from the original email, or [contact us] and we will take care of it for you.'.replace('[contact us]', '<a href="mailto:info@cognita.com.ng">contact us</a>'),
    ],
  }), 400);

/**
 * GET  /api/email/unsubscribe?t=TOKEN  -> confirmation page (changes nothing)
 * POST /api/email/unsubscribe?t=TOKEN  -> unsubscribes
 *        body "List-Unsubscribe=One-Click" : sent by Gmail / Yahoo / Apple Mail
 *        body "action=unsubscribe|resubscribe" : the buttons on our page
 */
export async function handleEmailUnsubscribe(request, env) {
  const token = new URL(request.url).searchParams.get('t');
  let who;
  try {
    who = await verifyUnsubscribeToken(env, token);
  } catch (_) {
    if (request.method === 'POST') return new Response('Invalid link.', { status: 400 });
    return invalidPage();
  }
  const cat = CATEGORIES[who.category];

  if (request.method === 'GET') {
    return html(page({
      title: 'Unsubscribe from ' + cat.label,
      heading: 'Unsubscribe from ' + cat.label + '?',
      paragraphs: [esc(cat.what), esc(cat.stillGets), '<span class="small">Account emails such as password resets and receipts are not affected, because you need those to keep your account safe.</span>'],
      form: postForm(token, 'unsubscribe', 'Unsubscribe', 'main'),
    }));
  }

  if (request.method !== 'POST') return new Response('Method not allowed.', { status: 405, headers: { Allow: 'GET, POST' } });

  let action = 'unsubscribe';
  let oneClick = false;
  try {
    const form = await request.formData();
    if (form.get('List-Unsubscribe') === 'One-Click') oneClick = true;
    if (form.get('action') === 'resubscribe') action = 'resubscribe';
  } catch (_) { /* no readable body: treat as a plain unsubscribe */ }

  try {
    await applyChoice(env, who.uid, who.category, action === 'resubscribe');
  } catch (e) {
    console.error('[unsubscribe] failed:', e.message);
    if (oneClick) return new Response('Could not process the request.', { status: 500 });
    return html(page({
      title: 'Something went wrong',
      heading: 'We could not save that',
      paragraphs: ['Your choice was not saved, and nothing has changed. Please try again in a moment.'],
      form: postForm(token, action, action === 'resubscribe' ? cat.back : 'Try unsubscribing again', 'main'),
    }), 500);
  }

  if (oneClick) return new Response('OK', { status: 200 });

  if (action === 'resubscribe') {
    return html(page({
      title: 'Emails turned back on',
      heading: 'Emails turned back on',
      tone: 'ok',
      paragraphs: ['You will receive ' + esc(cat.label) + ' again. You can unsubscribe any time from the link at the bottom of those emails.'],
    }));
  }
  return html(page({
    title: 'Unsubscribed',
    heading: 'You are unsubscribed',
    tone: 'ok',
    paragraphs: [esc(cat.what), 'Changed your mind?'],
    form: postForm(token, 'resubscribe', cat.back, 'link'),
  }));
}
