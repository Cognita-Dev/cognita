// emails/auth-email-templates.js
// The look and wording of every account email Cognita sends.
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

// One shared layout so every email looks the same. Tables and inline
// styles are used on purpose: that is the only thing every email app
// (Gmail, Outlook, Apple Mail) renders reliably.
function layout({ preheader, heading, greeting, paragraphs, buttonLabel, link, note }) {
  const paras = paragraphs
    .map(
      (p) =>
        '<p style="margin:0 0 16px 0;font-family:' + FONT + ';font-size:15px;line-height:24px;color:' + BRAND.body + ';">' +
        esc(p) +
        '</p>'
    )
    .join('');

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

  // Button
  '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:28px 0 28px 0;">' +
  '<tr><td align="center" bgcolor="' + BRAND.accent + '" style="border-radius:10px;">' +
  '<a href="' + esc(link) + '" style="display:inline-block;padding:14px 32px;font-family:' + FONT + ';font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px;">' + esc(buttonLabel) + '</a>' +
  '</td></tr></table>' +

  // Fallback link
  '<p style="margin:0 0 4px 0;font-family:' + FONT + ';font-size:13px;line-height:20px;color:' + BRAND.muted + ';">Button not working? Copy this link into your browser:</p>' +
  '<p style="margin:0 0 24px 0;font-family:' + FONT + ';font-size:12px;line-height:18px;word-break:break-all;"><a href="' + esc(link) + '" style="color:' + BRAND.accent + ';text-decoration:underline;">' + esc(link) + '</a></p>' +

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
function plainText({ heading, greeting, paragraphs, buttonLabel, link, note }) {
  return [
    heading,
    '',
    greeting,
    '',
    paragraphs.join('\n\n'),
    '',
    buttonLabel + ':',
    link,
    '',
    note,
    '',
    BRAND.name + '. ' + BRAND.tagline + '.',
  ].join('\n');
}

export function buildVerifyEmail({ name, link }) {
  const content = {
    heading: 'Confirm your email address',
    greeting: name ? 'Hi ' + name + ',' : 'Hi there,',
    paragraphs: [
      'Welcome to Cognita. Confirm that this is your email address to finish setting up your account.',
    ],
    buttonLabel: 'Confirm email',
    link,
    note: 'If you did not create a Cognita account, you can safely ignore this email.',
    preheader: 'One click to finish setting up your Cognita account.',
  };
  return {
    subject: 'Confirm your email for Cognita',
    html: layout(content),
    text: plainText(content),
  };
}

export function buildResetEmail({ link }) {
  const content = {
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
  };
  return {
    subject: 'Reset your Cognita password',
    html: layout(content),
    text: plainText(content),
  };
}
