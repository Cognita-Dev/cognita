// emails/auth-email-templates.js
// The look and wording of every email Cognita sends: account emails
// (verify, reset, welcome, password changed) and billing emails (payment
// received, payment failed, subscription cancelled).
// To change the design, colours or text of an email, edit this file only.

const BRAND = {
  name: 'Cognita',
  tagline: 'From a thought to something useful',
  accent: '#a8471f',
  ink: '#171717',
  body: '#4a4a48',
  muted: '#8a8a86',
  page: '#f7f7f5',
  card: '#ffffff',
  border: '#e8e6e1',
  site: 'https://app.cognita.com.ng',
};

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

// A small grey box of "Label ... Value" rows (used for receipts and for
// the "what to do first" list in the welcome email).
function detailsTable(rows) {
  const body = rows
    .map(function (row, i) {
      const divider = i === 0 ? '' : 'border-top:1px solid ' + BRAND.border + ';';
      return (
        '<tr>' +
        '<td valign="top" style="' + divider + 'padding:12px 0;white-space:nowrap;font-family:' + FONT + ';font-size:13px;line-height:20px;color:' + BRAND.muted + ';">' + esc(row[0]) + '</td>' +
        '<td valign="top" align="right" style="' + divider + 'padding:12px 0 12px 16px;word-break:break-word;font-family:' + FONT + ';font-size:14px;line-height:20px;font-weight:600;color:' + BRAND.ink + ';">' + esc(row[1]) + '</td>' +
        '</tr>'
      );
    })
    .join('');

  return (
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 0 0;">' +
    '<tr><td style="background:' + BRAND.page + ';border-radius:12px;padding:4px 18px;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' + body + '</table>' +
    '</td></tr></table>'
  );
}

// One shared layout so every email looks the same. Tables and inline
// styles are used on purpose: that is the only thing every email app
// (Gmail, Outlook, Apple Mail) renders reliably.
function layout({ preheader, heading, greeting, paragraphs, details, buttonLabel, link, showLinkFallback, note }) {
  const paras = paragraphs
    .map(
      (p) =>
        '<p style="margin:0 0 16px 0;font-family:' + FONT + ';font-size:15px;line-height:24px;color:' + BRAND.body + ';">' +
        esc(p) +
        '</p>'
    )
    .join('');

  const detailsHtml = details && details.length ? detailsTable(details) : '';

  const buttonHtml =
    buttonLabel && link
      ? '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 28px 0;">' +
        '<tr><td align="center" bgcolor="' + BRAND.accent + '" style="border-radius:10px;">' +
        '<a href="' + esc(link) + '" style="display:inline-block;padding:14px 32px;font-family:' + FONT + ';font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">' + esc(buttonLabel) + '</a>' +
        '</td></tr></table>'
      : '<div style="height:16px;line-height:16px;font-size:16px;">&nbsp;</div>';

  const fallbackHtml =
    buttonLabel && link && showLinkFallback !== false
      ? '<p style="margin:0 0 4px 0;font-family:' + FONT + ';font-size:13px;line-height:20px;color:' + BRAND.muted + ';">Button not working? Copy this link into your browser:</p>' +
        '<p style="margin:0 0 24px 0;font-family:' + FONT + ';font-size:12px;line-height:18px;word-break:break-all;"><a href="' + esc(link) + '" style="color:' + BRAND.accent + ';text-decoration:underline;">' + esc(link) + '</a></p>'
      : '';

  return (
'<!DOCTYPE html>' +
'<html lang="en"><head>' +
'<meta charset="UTF-8">' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
'<meta name="color-scheme" content="light">' +
'<meta name="supported-color-schemes" content="light">' +
'<title>' + esc(heading) + '</title>' +
'</head>' +
'<body style="margin:0;padding:0;background:' + BRAND.page + ';">' +
// Hidden preview text shown next to the subject in the inbox list.
'<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:' + BRAND.page + ';">' + esc(preheader) + '</div>' +
'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:' + BRAND.page + ';">' +
'<tr><td align="center" style="padding:40px 16px;">' +

  // Wordmark
  '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">' +
  '<tr><td align="center" style="padding:0 0 24px 0;">' +
  '<a href="' + BRAND.site + '" style="text-decoration:none;font-family:' + FONT + ';font-size:30px;font-weight:800;letter-spacing:-1px;color:' + BRAND.ink + ';">cognita</a>' +
  '</td></tr>' +

  // Card
  '<tr><td style="background:' + BRAND.card + ';border:1px solid ' + BRAND.border + ';border-radius:16px;padding:40px 36px;">' +
  '<h1 style="margin:0 0 20px 0;font-family:Georgia,\'Times New Roman\',serif;font-style:italic;font-weight:400;font-size:26px;line-height:32px;letter-spacing:-0.3px;color:' + BRAND.ink + ';">' + esc(heading) + '</h1>' +
  '<p style="margin:0 0 16px 0;font-family:' + FONT + ';font-size:15px;line-height:24px;color:' + BRAND.ink + ';">' + esc(greeting) + '</p>' +
  paras +
  detailsHtml +
  buttonHtml +
  fallbackHtml +

  '<div style="border-top:1px solid ' + BRAND.border + ';padding-top:20px;">' +
  '<p style="margin:0;font-family:' + FONT + ';font-size:13px;line-height:20px;color:' + BRAND.muted + ';">' + esc(note) + '</p>' +
  '</div>' +
  '</td></tr>' +

  // Footer
  '<tr><td align="center" style="padding:24px 8px 0 8px;">' +
  '<p style="margin:0 0 4px 0;font-family:' + FONT + ';font-size:12px;line-height:18px;color:' + BRAND.muted + ';">' + esc(BRAND.name) + '. ' + esc(BRAND.tagline) + '.</p>' +
  '<p style="margin:0;font-family:' + FONT + ';font-size:12px;line-height:18px;color:' + BRAND.muted + ';"><a href="' + BRAND.site + '" style="color:' + BRAND.muted + ';text-decoration:underline;">app.cognita.com.ng</a></p>' +
  '</td></tr>' +
  '</table>' +

'</td></tr></table>' +
'</body></html>'
  );
}

// Plain-text twin of each email. Sending both HTML and text lowers the
// chance of landing in spam and works in apps that cannot show HTML.
function plainText({ heading, greeting, paragraphs, details, buttonLabel, link, note }) {
  const parts = [heading, '', greeting, '', paragraphs.join('\n\n')];
  if (details && details.length) {
    parts.push('', details.map((r) => r[0] + ': ' + r[1]).join('\n'));
  }
  if (buttonLabel && link) {
    parts.push('', buttonLabel + ':', link);
  }
  parts.push('', note, '', BRAND.name + '. ' + BRAND.tagline + '.');
  return parts.join('\n');
}

function build(subject, content) {
  return { subject, html: layout(content), text: plainText(content) };
}

function hello(name) {
  return name ? 'Hi ' + name + ',' : 'Hi there,';
}

// ══════════════════════════════════════════════════════════════
// Account emails
// ══════════════════════════════════════════════════════════════

export function buildVerifyEmail({ name, link }) {
  return build('Confirm your email for Cognita', {
    heading: 'Confirm your email address',
    greeting: name ? 'Hi ' + name + ',' : 'Hi there,',
    paragraphs: [
      'Welcome to Cognita. Confirm that this is your email address to finish setting up your account.',
    ],
    buttonLabel: 'Confirm email',
    link,
    note: 'If you did not create a Cognita account, you can safely ignore this email.',
    preheader: 'One click to finish setting up your Cognita account.',
  });
}

export function buildResetEmail({ link }) {
  return build('Reset your Cognita password', {
    heading: 'Reset your password',
    greeting: 'Hello,',
    paragraphs: [
      'We received a request to reset the password for your Cognita account. Use the button below to choose a new one.',
      'For your security, this link works once and expires soon.',
    ],
    buttonLabel: 'Choose a new password',
    link,
    note: 'If you did not ask to reset your password, you can safely ignore this email. Your password will stay the same.',
    preheader: 'Choose a new password for your Cognita account.',
  });
}

export function buildWelcomeEmail({ name }) {
  return build('Welcome to Cognita', {
    heading: 'Welcome to Cognita',
    greeting: hello(name),
    paragraphs: [
      'Your account is ready. Cognita helps you think, write and build, from a first rough idea to a finished piece of work.',
      'Three good places to start:',
    ],
    details: [
      ['Write', 'Draft and refine reports, essays and memos.'],
      ['Research', 'Summarise papers and keep your sources organised.'],
      ['Analyse', 'Understand your data and prepare clear results.'],
    ],
    buttonLabel: 'Open Cognita',
    link: BRAND.site + '/app.html',
    showLinkFallback: false,
    note: 'You are receiving this email because you created a Cognita account.',
    preheader: 'Your account is ready. Here is where to start.',
  });
}

export function buildPasswordChangedEmail({ name, email, when }) {
  const details = [];
  if (email) details.push(['Account', email]);
  if (when) details.push(['Changed', when]);
  return build('Your Cognita password was changed', {
    heading: 'Your password was changed',
    greeting: hello(name),
    paragraphs: [
      'The password for your Cognita account was just changed. If this was you, there is nothing more to do. You may need to sign in again on your other devices.',
      'If you did not make this change, reset your password now and use a password you have not used anywhere else.',
    ],
    details,
    buttonLabel: 'Reset your password',
    link: BRAND.site + '/login.html',
    showLinkFallback: false,
    note: 'Cognita will never ask for your password by email.',
    preheader: 'The password for your Cognita account was changed.',
  });
}

// ══════════════════════════════════════════════════════════════
// Billing emails
// ══════════════════════════════════════════════════════════════

export function buildPaymentReceiptEmail({ name, planName, amountText, dateText, periodEndText, reference, renewal }) {
  const details = [['Plan', planName]];
  if (amountText) details.push(['Amount', amountText]);
  if (dateText) details.push(['Date', dateText]);
  if (periodEndText) details.push(['Valid until', periodEndText]);
  if (reference) details.push(['Reference', reference]);

  return build(renewal ? 'Your Cognita subscription was renewed' : 'Your Cognita payment receipt', {
    heading: renewal ? 'Subscription renewed' : 'Payment received',
    greeting: hello(name),
    paragraphs: [
      renewal
        ? 'Your ' + planName + ' subscription has been renewed. Thank you for staying with us.'
        : 'Thank you. Your payment was successful and your ' + planName + ' plan is now active.',
    ],
    details,
    buttonLabel: 'View your account',
    link: BRAND.site + '/account.html',
    showLinkFallback: false,
    note: 'Keep this email as your receipt. If anything looks wrong, please contact us.',
    preheader: renewal ? 'Your Cognita subscription was renewed.' : 'Your payment was successful.',
  });
}

export function buildPaymentFailedEmail({ name, planName }) {
  return build('We could not process your Cognita payment', {
    heading: 'Payment did not go through',
    greeting: hello(name),
    paragraphs: [
      'We were unable to process the latest payment for your ' + planName + ' plan.',
      'You have a short grace period before your account moves to the free plan. Open your account to review your subscription.',
    ],
    details: [['Plan', planName]],
    buttonLabel: 'Open your account',
    link: BRAND.site + '/account.html',
    showLinkFallback: false,
    note: 'If you have already sorted this out, you can ignore this email.',
    preheader: 'The latest payment for your Cognita plan did not go through.',
  });
}

// ══════════════════════════════════════════════════════════════
// Reminders
// ══════════════════════════════════════════════════════════════

export function buildReminderEmail({ title, whenText, notes, url }) {
  const paragraphs = [whenText];
  if (notes) paragraphs.push(notes);
  return build(title + ' \u2014 Cognita reminder', {
    heading: title,
    greeting: 'Reminder:',
    paragraphs,
    buttonLabel: 'Open Reminders',
    link: url,
    showLinkFallback: false,
    note: 'You are getting this because you set a reminder in Cognita. Manage or turn off reminders any time from the Reminders view.',
    preheader: whenText,
  });
}

export function buildSubscriptionCancelledEmail({ name, planName, accessUntilText }) {
  const until = accessUntilText || 'the end of your current billing period';
  return build('Your Cognita subscription was cancelled', {
    heading: 'Subscription cancelled',
    greeting: hello(name),
    paragraphs: [
      'Your ' + planName + ' subscription has been cancelled and will not renew.',
      'You keep full access until ' + until + '. After that, your account moves to Cognita Starter, the free plan.',
    ],
    buttonLabel: 'Resubscribe',
    link: BRAND.site + '/pricing.html',
    showLinkFallback: false,
    note: 'Changed your mind? You can resubscribe at any time.',
    preheader: 'You keep access until ' + until + '.',
  });
}
