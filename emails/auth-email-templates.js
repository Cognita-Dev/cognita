// emails/auth-email-templates.js
// The look and wording of every email Cognita sends: account emails
// (verify, reset, welcome, password changed), billing emails (payment
// received, payment failed, subscription cancelled), reminders and the
// performance digest.
// To change the design, colours or text of an email, edit this file only.
//
// Design notes (why the HTML looks the way it does):
//  - Tables + inline styles: the only layout Gmail, Outlook and Apple Mail
//    all render the same way.
//  - 600px wide, single column, system fonts (web fonts are often blocked).
//  - The button is "bulletproof": a normal link on most apps, plus a VML
//    version so classic Outlook for Windows still shows a rounded button.
//  - Logo and social icons are PNG, not SVG. Gmail and Outlook strip SVG,
//    so an SVG image would simply not appear for many people. The PNGs are
//    made from the brands' official SVG artwork and live in /assets/email/.
//  - Dark mode: colours are set for light mode, then a small style block
//    re-colours the email for apps that support it (Apple Mail, iOS Mail,
//    Outlook.com). Other apps do their own automatic dark mode.
//  - In any text, [label](https://link) becomes a clickable hyperlink.
//  - Optional emails (reminders, digests) pass an unsubscribeUrl. That adds a
//    footer link AND the List-Unsubscribe headers, which give Gmail, Yahoo and
//    Apple Mail their own one-tap "Unsubscribe" button. See emails/unsubscribe.js.

const BRAND = {
  name: 'Cognita',
  tagline: 'From a thought to something useful',
  accent: '#a8471f',
  ink: '#171717',
  body: '#4a4a48',
  muted: '#77776f',
  page: '#f4f3ef',
  card: '#ffffff',
  soft: '#f7f6f2',
  border: '#e8e6e1',
  site: 'https://app.cognita.com.ng',
  assets: 'https://app.cognita.com.ng/assets/email/',
  contact: 'mailto:info@cognita.com.ng',
  instagram: 'https://www.instagram.com/cognitang',
  x: 'https://x.com/cognitang',
};

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
const SERIF = "Georgia, 'Times New Roman', serif";

function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Escapes text, then turns [label](https://...) into a real hyperlink.
function rich(text) {
  return esc(text).replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g,
    (_m, label, href) =>
      '<a href="' + href + '" style="color:' + BRAND.accent + ';text-decoration:underline;">' + label + '</a>'
  );
}

// The plain-text twin shows "label (https://link)" instead.
function stripRich(text) {
  return String(text == null ? '' : text).replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)');
}

// ── Building blocks ───────────────────────────────────────────

// Bold title with a short explanation underneath, separated by hairlines.
// Used for "where to start" style lists.
function itemsList(items) {
  const rows = items
    .map(function (row, i) {
      const divider = i === 0 ? '' : 'border-top:1px solid ' + BRAND.border + ';';
      return (
        '<tr><td class="c-border" style="' + divider + 'padding:14px 0;">' +
        '<div class="t-ink" style="font-family:' + FONT + ';font-size:15px;line-height:22px;font-weight:600;color:' + BRAND.ink + ';">' + esc(row[0]) + '</div>' +
        '<div class="t-body" style="font-family:' + FONT + ';font-size:14px;line-height:21px;color:' + BRAND.body + ';padding-top:2px;">' + esc(row[1]) + '</div>' +
        '</td></tr>'
      );
    })
    .join('');
  return (
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 8px 0;">' +
    '<tr><td class="c-border" style="border-top:1px solid ' + BRAND.border + ';"></td></tr>' + rows +
    '<tr><td class="c-border" style="border-top:1px solid ' + BRAND.border + ';font-size:0;line-height:0;">&nbsp;</td></tr>' +
    '</table>'
  );
}

// "Label ... Value" rows in a soft panel (receipts, account details).
function detailsTable(rows) {
  const body = rows
    .map(function (row, i) {
      const divider = i === 0 ? '' : 'border-top:1px solid ' + BRAND.border + ';';
      return (
        '<tr>' +
        '<td class="c-border t-muted" valign="top" style="' + divider + 'padding:12px 0;white-space:nowrap;font-family:' + FONT + ';font-size:13px;line-height:20px;color:' + BRAND.muted + ';">' + esc(row[0]) + '</td>' +
        '<td class="c-border t-ink" valign="top" align="right" style="' + divider + 'padding:12px 0 12px 16px;word-break:break-word;font-family:' + FONT + ';font-size:14px;line-height:20px;font-weight:600;color:' + BRAND.ink + ';">' + esc(row[1]) + '</td>' +
        '</tr>'
      );
    })
    .join('');
  return (
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 8px 0;">' +
    '<tr><td class="bg-soft" style="background:' + BRAND.soft + ';border-radius:10px;padding:4px 20px;">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">' + body + '</table>' +
    '</td></tr></table>'
  );
}

function bulletList(bullets) {
  const rows = bullets
    .map(
      (b) =>
        '<tr>' +
        '<td valign="top" width="20" style="padding:0 0 10px 0;font-family:' + FONT + ';font-size:15px;line-height:24px;color:' + BRAND.accent + ';">&bull;</td>' +
        '<td class="t-body" valign="top" style="padding:0 0 10px 0;font-family:' + FONT + ';font-size:15px;line-height:24px;color:' + BRAND.body + ';">' + esc(b) + '</td>' +
        '</tr>'
    )
    .join('');
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 8px 0;">' + rows + '</table>';
}

// Bulletproof button: VML for classic Outlook, a padded link for everyone else.
function button(label, link) {
  const width = Math.min(360, Math.max(180, label.length * 9 + 64));
  return (
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="btn-wrap" style="margin:28px 0 8px 0;"><tr><td>' +
    '<!--[if mso]>' +
    '<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="' + esc(link) + '" style="height:48px;v-text-anchor:middle;width:' + width + 'px;" arcsize="17%" stroke="f" fillcolor="' + BRAND.accent + '">' +
    '<w:anchorlock/><center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">' + esc(label) + '</center></v:roundrect>' +
    '<![endif]-->' +
    '<!--[if !mso]><!-->' +
    '<a href="' + esc(link) + '" class="btn" style="display:inline-block;background:' + BRAND.accent + ';border-radius:8px;padding:14px 32px;font-family:' + FONT + ';font-size:15px;line-height:20px;font-weight:600;color:#ffffff;text-decoration:none;text-align:center;mso-hide:all;">' + esc(label) + '</a>' +
    '<!--<![endif]-->' +
    '</td></tr></table>'
  );
}

// For sensitive links (verify, reset) we also show the address, as a
// hyperlink, so it can be copied if the button does not work.
function linkFallback(link) {
  return (
    '<p class="t-muted" style="margin:16px 0 0 0;font-family:' + FONT + ';font-size:13px;line-height:20px;color:' + BRAND.muted + ';">' +
    'Button not working? Paste this address into your browser:</p>' +
    '<p style="margin:4px 0 0 0;font-family:' + FONT + ';font-size:12px;line-height:18px;word-break:break-all;">' +
    '<a href="' + esc(link) + '" style="color:' + BRAND.accent + ';text-decoration:underline;">' + esc(link) + '</a></p>'
  );
}

function socialIcon(href, file, alt) {
  return (
    '<a href="' + href + '" style="text-decoration:none;display:inline-block;">' +
    '<img src="' + BRAND.assets + file + '" width="20" height="20" alt="' + esc(alt) + '" style="display:block;border:0;outline:none;width:20px;height:20px;">' +
    '</a>'
  );
}

// One shared layout so every email looks the same.
function layout(c) {
  const paras = (c.paragraphs || [])
    .map(
      (p) =>
        '<p class="t-body" style="margin:0 0 16px 0;font-family:' + FONT + ';font-size:15px;line-height:25px;color:' + BRAND.body + ';">' + rich(p) + '</p>'
    )
    .join('');

  const eyebrow = c.eyebrow
    ? '<div style="margin:0 0 14px 0;font-family:' + FONT + ';font-size:12px;line-height:16px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:' + BRAND.accent + ';">' + esc(c.eyebrow) + '</div>'
    : '';

  const hasButton = c.buttonLabel && c.link;
  const reason = c.reason || 'You are receiving this email because of activity on your Cognita account.';
  const unsubscribeHtml = c.unsubscribeUrl
    ? '<p class="t-muted" style="margin:0 0 6px 0;font-family:' + FONT + ';font-size:12px;line-height:19px;color:' + BRAND.muted + ';">Do not want these emails? <a href="' + esc(c.unsubscribeUrl) + '" style="color:' + BRAND.muted + ';text-decoration:underline;">' + esc(c.unsubscribeLabel || 'Unsubscribe') + '</a>.</p>'
    : '';

  return (
'<!DOCTYPE html>' +
'<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><head>' +
'<meta charset="UTF-8">' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
'<meta http-equiv="X-UA-Compatible" content="IE=edge">' +
'<meta name="x-apple-disable-message-reformatting">' +
'<meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no">' +
'<meta name="color-scheme" content="light dark">' +
'<meta name="supported-color-schemes" content="light dark">' +
'<title>' + esc(c.heading) + '</title>' +
'<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->' +
'<style>' +
'  :root{color-scheme:light dark;supported-color-schemes:light dark;}' +
'  body{margin:0;padding:0;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}' +
'  table,td{mso-table-lspace:0pt;mso-table-rspace:0pt;}' +
'  img{-ms-interpolation-mode:bicubic;}' +
'  a{word-break:break-word;}' +
'  @media only screen and (max-width:620px){' +
'    .px{padding-left:24px !important;padding-right:24px !important;}' +
'    .outer{padding:20px 10px !important;}' +
'    .h1{font-size:26px !important;line-height:33px !important;}' +
'    .btn-wrap{width:100% !important;}' +
'    .btn{display:block !important;}' +
'  }' +
'  @media (prefers-color-scheme:dark){' +
'    .bg-page{background:#141413 !important;}' +
'    .bg-card{background:#1f1f1d !important;border-color:#33332f !important;}' +
'    .bg-soft{background:#2a2a27 !important;}' +
'    .c-border{border-color:#3a3a36 !important;}' +
'    .t-ink{color:#f4f3ef !important;}' +
'    .t-body{color:#c9c8c2 !important;}' +
'    .t-muted{color:#9a9990 !important;}' +
'  }' +
'</style>' +
'</head>' +
'<body class="bg-page" style="margin:0;padding:0;background:' + BRAND.page + ';">' +
// Hidden preview text shown next to the subject in the inbox list. The
// trailing junk stops the inbox from pulling in body text after it.
'<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:' + BRAND.page + ';">' + esc(c.preheader) + '&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>' +
'<table role="presentation" class="bg-page" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:' + BRAND.page + ';">' +
'<tr><td align="center" class="outer" style="padding:36px 16px 40px 16px;">' +
'<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->' +
'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">' +

  // Header: mark + wordmark, left-aligned to the card edge
  '<tr><td style="padding:0 4px 20px 4px;">' +
  '<a href="' + BRAND.site + '" style="text-decoration:none;">' +
  '<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>' +
  '<td valign="middle" style="padding-right:10px;"><img src="' + BRAND.assets + 'cognita-mark.png" width="30" height="28" alt="" style="display:block;border:0;width:30px;height:28px;"></td>' +
  '<td valign="middle" class="t-ink" style="font-family:' + FONT + ';font-size:22px;line-height:28px;font-weight:800;letter-spacing:-0.6px;color:' + BRAND.ink + ';">cognita</td>' +
  '</tr></table></a>' +
  '</td></tr>' +

  // Card
  '<tr><td class="bg-card px" style="background:' + BRAND.card + ';border:1px solid ' + BRAND.border + ';border-top:3px solid ' + BRAND.accent + ';border-radius:12px;padding:40px 44px 36px 44px;">' +
  eyebrow +
  '<h1 class="h1 t-ink" style="margin:0 0 22px 0;font-family:' + SERIF + ';font-style:italic;font-weight:400;font-size:30px;line-height:38px;letter-spacing:-0.4px;color:' + BRAND.ink + ';">' + esc(c.heading) + '</h1>' +
  '<p class="t-ink" style="margin:0 0 16px 0;font-family:' + FONT + ';font-size:15px;line-height:25px;color:' + BRAND.ink + ';">' + esc(c.greeting) + '</p>' +
  paras +
  (c.bullets && c.bullets.length ? bulletList(c.bullets) : '') +
  (c.items && c.items.length ? itemsList(c.items) : '') +
  (c.details && c.details.length ? detailsTable(c.details) : '') +
  (hasButton ? button(c.buttonLabel, c.link) : '') +
  (hasButton && c.showLinkFallback ? linkFallback(c.link) : '') +
  (c.note
    ? '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:28px;"><tr>' +
      '<td class="c-border" style="border-top:1px solid ' + BRAND.border + ';padding-top:20px;">' +
      '<p class="t-muted" style="margin:0;font-family:' + FONT + ';font-size:13px;line-height:21px;color:' + BRAND.muted + ';">' + rich(c.note) + '</p>' +
      '</td></tr></table>'
    : '') +
  '</td></tr>' +

  // Footer
  '<tr><td align="center" style="padding:28px 8px 0 8px;">' +
  '<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr>' +
  '<td style="padding:0 10px;">' + socialIcon(BRAND.instagram, 'instagram.png', 'Cognita on Instagram') + '</td>' +
  '<td style="padding:0 10px;">' + socialIcon(BRAND.x, 'x.png', 'Cognita on X') + '</td>' +
  '</tr></table>' +
  '<p class="t-muted" style="margin:18px 0 6px 0;font-family:' + FONT + ';font-size:12px;line-height:19px;color:' + BRAND.muted + ';">' + esc(reason) + '</p>' +
  unsubscribeHtml +
  '<p class="t-muted" style="margin:0 0 6px 0;font-family:' + FONT + ';font-size:12px;line-height:19px;color:' + BRAND.muted + ';">' +
  '<a href="' + BRAND.site + '/privacy.html" style="color:' + BRAND.muted + ';text-decoration:underline;">Privacy Policy</a>' +
  '&nbsp;&nbsp;&middot;&nbsp;&nbsp;' +
  '<a href="' + BRAND.site + '/terms.html" style="color:' + BRAND.muted + ';text-decoration:underline;">Terms of Service</a>' +
  '&nbsp;&nbsp;&middot;&nbsp;&nbsp;' +
  '<a href="' + BRAND.contact + '" style="color:' + BRAND.muted + ';text-decoration:underline;">Contact us</a></p>' +
  '<p class="t-muted" style="margin:0;font-family:' + FONT + ';font-size:12px;line-height:19px;color:' + BRAND.muted + ';">&copy; ' + new Date().getFullYear() + ' ' + esc(BRAND.name) + '. ' + esc(BRAND.tagline) + '.</p>' +
  '</td></tr>' +
  '</table>' +
'<!--[if mso]></td></tr></table><![endif]-->' +
'</td></tr></table>' +
'</body></html>'
  );
}

// Plain-text twin of each email. Sending both HTML and text lowers the
// chance of landing in spam and works in apps that cannot show HTML.
function plainText(c) {
  const parts = [c.heading, '', c.greeting, '', (c.paragraphs || []).map(stripRich).join('\n\n')];
  if (c.bullets && c.bullets.length) parts.push('', c.bullets.map((b) => '- ' + b).join('\n'));
  if (c.items && c.items.length) parts.push('', c.items.map((r) => r[0] + ': ' + r[1]).join('\n'));
  if (c.details && c.details.length) parts.push('', c.details.map((r) => r[0] + ': ' + r[1]).join('\n'));
  if (c.buttonLabel && c.link) parts.push('', c.buttonLabel + ':', c.link);
  if (c.note) parts.push('', stripRich(c.note));
  parts.push('', '--', BRAND.name + '. ' + BRAND.tagline + '.');
  if (c.unsubscribeUrl) parts.push((c.unsubscribeLabel || 'Unsubscribe') + ': ' + c.unsubscribeUrl);
  parts.push('Privacy: ' + BRAND.site + '/privacy.html  Terms: ' + BRAND.site + '/terms.html');
  parts.push('Instagram: ' + BRAND.instagram + '  X: ' + BRAND.x);
  return parts.join('\n');
}

function build(subject, content) {
  const message = { subject, html: layout(content), text: plainText(content) };
  // Only https links qualify for one-click unsubscribe.
  if (content.unsubscribeUrl && /^https:\/\//.test(content.unsubscribeUrl)) {
    message.headers = {
      'List-Unsubscribe': '<' + content.unsubscribeUrl + '>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    };
  }
  return message;
}

function hello(name) {
  return name ? 'Hi ' + name + ',' : 'Hi there,';
}

const HELP = 'Need a hand? [Contact us](' + BRAND.contact + ') and we will help.';

// ══════════════════════════════════════════════════════════════
// Account emails
// ══════════════════════════════════════════════════════════════

export function buildVerifyEmail({ name, link }) {
  return build('Confirm your email for Cognita', {
    eyebrow: 'Account',
    heading: 'Confirm your email address',
    greeting: hello(name),
    paragraphs: [
      'Welcome to Cognita. Confirm that this is your email address to finish setting up your account.',
    ],
    buttonLabel: 'Confirm email address',
    link,
    showLinkFallback: true,
    note: 'Did not sign up for Cognita? You can safely ignore this email and no account will be set up.',
    preheader: 'One tap to finish setting up your Cognita account.',
    reason: 'You are receiving this email because someone used this address to sign up for Cognita.',
  });
}

export function buildResetEmail({ link }) {
  return build('Reset your Cognita password', {
    eyebrow: 'Security',
    heading: 'Reset your password',
    greeting: 'Hello,',
    paragraphs: [
      'We received a request to reset the password for your Cognita account. Use the button below to choose a new one.',
      'For your security, this link works once and expires soon.',
    ],
    buttonLabel: 'Choose a new password',
    link,
    showLinkFallback: true,
    note: 'Did not ask for this? You can ignore this email. Your password will stay the same.',
    preheader: 'Choose a new password for your Cognita account.',
    reason: 'You are receiving this email because a password reset was requested for your Cognita account.',
  });
}

export function buildWelcomeEmail({ name }) {
  return build('Welcome to Cognita', {
    eyebrow: 'Welcome',
    heading: 'Your account is ready',
    greeting: hello(name),
    paragraphs: [
      'Welcome to Cognita. It helps you think, write and build, from a first rough idea to a finished piece of work.',
      'Here are three good places to start:',
    ],
    items: [
      ['Write', 'Draft and refine reports, essays and memos.'],
      ['Research', 'Summarise papers and keep your sources organised.'],
      ['Analyse', 'Understand your data and prepare clear results.'],
    ],
    buttonLabel: 'Open Cognita',
    link: BRAND.site + '/app.html',
    note: HELP,
    preheader: 'Your account is ready. Here is where to start.',
    reason: 'You are receiving this email because you created a Cognita account.',
  });
}

export function buildPasswordChangedEmail({ name, email, when }) {
  const details = [];
  if (email) details.push(['Account', email]);
  if (when) details.push(['Changed', when]);
  return build('Your Cognita password was changed', {
    eyebrow: 'Security',
    heading: 'Your password was changed',
    greeting: hello(name),
    paragraphs: [
      'The password for your Cognita account was just changed. If this was you, there is nothing more to do. You may need to sign in again on your other devices.',
      'If you did not make this change, reset your password now and choose one you have not used anywhere else.',
    ],
    details,
    buttonLabel: 'Reset your password',
    link: BRAND.site + '/login.html',
    note: 'Cognita will never ask for your password by email. ' + HELP,
    preheader: 'The password for your Cognita account was changed.',
    reason: 'You are receiving this security notice because your Cognita password changed.',
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
    eyebrow: 'Receipt',
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
    note: 'Keep this email as your receipt. Something look wrong? [Contact us](' + BRAND.contact + ') and quote the reference above.',
    preheader: renewal ? 'Your Cognita subscription was renewed.' : 'Your payment was successful.',
    reason: 'You are receiving this receipt because a payment was made on your Cognita account.',
  });
}

export function buildPaymentFailedEmail({ name, planName }) {
  return build('We could not process your Cognita payment', {
    eyebrow: 'Billing',
    heading: 'Your payment did not go through',
    greeting: hello(name),
    paragraphs: [
      'We were unable to process the latest payment for your ' + planName + ' plan.',
      'You have a short grace period before your account moves to the free plan. Open your account to review your subscription and try again.',
    ],
    details: [['Plan', planName]],
    buttonLabel: 'Review your subscription',
    link: BRAND.site + '/account.html',
    note: 'Already sorted this out? You can ignore this email. ' + HELP,
    preheader: 'The latest payment for your Cognita plan did not go through.',
    reason: 'You are receiving this billing notice because a payment on your Cognita account failed.',
  });
}

export function buildSubscriptionCancelledEmail({ name, planName, accessUntilText }) {
  const until = accessUntilText || 'the end of your current billing period';
  return build('Your Cognita subscription was cancelled', {
    eyebrow: 'Billing',
    heading: 'Your subscription was cancelled',
    greeting: hello(name),
    paragraphs: [
      'Your ' + planName + ' subscription has been cancelled and will not renew.',
      'You keep full access until ' + until + '. After that, your account moves to Cognita Starter, the free plan.',
    ],
    buttonLabel: 'Resubscribe',
    link: BRAND.site + '/pricing.html',
    note: 'Changed your mind? You can resubscribe at any time.',
    preheader: 'You keep access until ' + until + '.',
    reason: 'You are receiving this email because a subscription on your Cognita account was cancelled.',
  });
}

// ══════════════════════════════════════════════════════════════
// Reminders and digests
// ══════════════════════════════════════════════════════════════

export function buildReminderEmail({ title, whenText, notes, url, unsubscribeUrl }) {
  const paragraphs = [whenText];
  if (notes) paragraphs.push(notes);
  return build(title + ' \u2014 Cognita reminder', {
    eyebrow: 'Reminder',
    heading: title,
    greeting: 'This is your reminder.',
    paragraphs,
    buttonLabel: 'Open your reminders',
    link: url,
    note: 'You can edit or turn off reminders any time from the Reminders view in Cognita.',
    preheader: whenText,
    reason: 'You are receiving this email because you set a reminder in Cognita.',
    unsubscribeUrl,
    unsubscribeLabel: 'Unsubscribe from reminder emails',
  });
}

export function buildInsightsDigestEmail({ name, periodLabel, highlights, pdfUrl, unsubscribeUrl }) {
  const points = (highlights || []).map((h) => String(h)).filter(Boolean).slice(0, 6);
  const paragraphs = [
    periodLabel
      ? 'Your performance digest for ' + periodLabel + ' is ready. It covers what worked, what did not, and what to try next.'
      : 'Your performance digest is ready. It covers what worked, what did not, and what to try next.',
  ];
  if (points.length) paragraphs.push('The highlights:');
  return build('Your latest Cognita performance digest', {
    eyebrow: 'Insights',
    heading: 'Your performance digest',
    greeting: hello(name),
    paragraphs,
    bullets: points,
    buttonLabel: 'Download the full report',
    link: pdfUrl,
    note: 'The report is a PDF. This download link is private to you and works for 7 days, after which you can open it again from Insights in Cognita.',
    preheader: points[0] || 'Your performance digest is ready to download.',
    reason: 'You are receiving this email because you turned on emailed performance digests in Cognita.',
    unsubscribeUrl,
    unsubscribeLabel: 'Unsubscribe from digest emails',
  });
}
