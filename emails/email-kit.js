// emails/email-kit.js
// Cognita's email design system: colours, type, reusable pieces, and the
// page shell that wraps them. The wording and layout of each individual email
// lives in auth-email-templates.js; this file is only the toolbox.
//
// How it fits together
//  - Every piece (heading(), button(), panel(), details() ...) returns
//    { html, text }. The HTML goes in the email; the text goes in the plain-text
//    twin. Because both come from the same piece, they cannot drift apart.
//  - renderEmail() puts the pieces inside the shell (logo, card, footer) and
//    returns { subject, html, text, headers? }, which is what sendEmail() takes.
//
// Why the HTML looks the way it does (email is not a web page)
//  - Layout is tables with inline styles: the only thing Gmail, Outlook and
//    Apple Mail all render the same way. No flexbox, grid, JavaScript, forms
//    or CSS variables.
//  - 600px wide, single column. Pieces that sit side by side (feature cards)
//    stack on phones through the .stack class.
//  - System fonts only (web fonts are blocked by many mail apps). The stacks
//    match the app: Inter first, then the platform font; a serif stand-in for
//    the app's Fraunces headings.
//  - The button is "bulletproof": a padded link for most apps plus a VML twin
//    so classic Outlook for Windows still draws a proper button.
//  - Images are PNG with fixed width and height, never SVG (Gmail and others
//    drop SVG). The emails still make sense with images switched off: every
//    icon sits next to text that says the same thing.
//  - Dark mode: colours are written for light mode inline; a style block then
//    re-colours the email for Apple Mail, iOS Mail and Outlook.com. Gmail's
//    apps do their own automatic dark mode. Nothing needs dark mode CSS to be
//    readable.
//  - Text that comes from people or from the AI (reminder notes, digest
//    highlights, names) is always escaped and never turned into links. Only
//    our own wording can use links or bold, through md().

// ── Brand ─────────────────────────────────────────────────────

const SITE = 'https://app.cognita.com.ng';

export const BRAND = {
  name: 'Cognita',
  tagline: 'From a thought to something useful',
  // From the public site footer.
  operator: 'Cognita is operated by Veritone Services, Lagos, Nigeria.',
  site: SITE,
  assets: SITE + '/assets/email/',
  contactAddress: 'info@cognita.com.ng',
  contact: 'mailto:info@cognita.com.ng',
  instagram: 'https://www.instagram.com/cognitang',
  x: 'https://x.com/cognitang',
};

// ── Design tokens ─────────────────────────────────────────────
// Light values come from the app (css/shared.css). Dark values are the app's
// dark palette. Body copy is a shade darker than the app's secondary text
// because long email paragraphs need the extra contrast.

export const LIGHT = {
  page: '#f7f7f5',
  card: '#ffffff',
  soft: '#f1f1ee',
  line: '#e6e5e0',
  ink: '#171717',
  body: '#464641',
  muted: '#6c6c67', // the app's #6f6f6a, nudged darker to reach 4.5:1 on the soft panels
  accent: '#a8471f',
  accentSoft: '#f5e6da',
  onAccent: '#ffffff',
  success: '#3f6b5b',
  successSoft: '#e6efeb',
  warn: '#875a14',
  warnSoft: '#f6ecd9',
  danger: '#b3423a',
  dangerSoft: '#f7ece9',
};

export const DARK = {
  page: '#0d0e0e',
  card: '#171918',
  soft: '#202322',
  line: '#2e3130',
  ink: '#f2f2ee',
  body: '#c8c8c2',
  muted: '#9b9b94',
  accent: '#e08a52',
  accentSoft: '#2a2119',
  onAccent: '#1b0f07',
  success: '#8db7a5',
  successSoft: '#18241f',
  warn: '#d0a260',
  warnSoft: '#2a2317',
  danger: '#d78d85',
  dangerSoft: '#241a19',
};

const L = LIGHT;

export const SANS = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";
export const SERIF = "Fraunces, 'Iowan Old Style', Georgia, 'Times New Roman', serif";

// The logo mark PNGs are 81 x 96; shown at a third of that.
const LOGO_W = 27;
const LOGO_H = 32;

// class name, CSS property, token. These drive the dark-mode style block, and
// every coloured element in a piece carries the matching class.
const CLASS_RULES = [
  ['bg-page', 'background-color', 'page'],
  ['bg-card', 'background-color', 'card'],
  ['bg-soft', 'background-color', 'soft'],
  ['bg-line', 'background-color', 'line'],
  ['bg-accent', 'background-color', 'accent'],
  ['bg-accent-soft', 'background-color', 'accentSoft'],
  ['bg-success', 'background-color', 'success'],
  ['bg-success-soft', 'background-color', 'successSoft'],
  ['bg-warn', 'background-color', 'warn'],
  ['bg-warn-soft', 'background-color', 'warnSoft'],
  ['bg-danger', 'background-color', 'danger'],
  ['bg-danger-soft', 'background-color', 'dangerSoft'],
  ['bd', 'border-color', 'line'],
  ['bd-accent', 'border-color', 'accent'],
  ['t-ink', 'color', 'ink'],
  ['t-body', 'color', 'body'],
  ['t-muted', 'color', 'muted'],
  ['t-accent', 'color', 'accent'],
  ['t-success', 'color', 'success'],
  ['t-warn', 'color', 'warn'],
  ['t-danger', 'color', 'danger'],
  ['t-on-accent', 'color', 'onAccent'],
];

function darkCss() {
  const media = CLASS_RULES.map(([c, prop, key]) => '.' + c + '{' + prop + ':' + DARK[key] + ' !important;}').join('');
  // Outlook.com and the Outlook apps mark colours with data-ogsc and
  // backgrounds with data-ogsb instead of using prefers-color-scheme.
  const outlook = CLASS_RULES.map(([c, prop, key]) => {
    const attr = prop === 'background-color' ? '[data-ogsb]' : '[data-ogsc]';
    return attr + ' .' + c + '{' + prop + ':' + DARK[key] + ' !important;}';
  }).join('');
  return (
    '@media (prefers-color-scheme:dark){' + media +
    '.dark-only{display:block !important;max-height:none !important;overflow:visible !important;}' +
    '.light-only{display:none !important;}}' +
    outlook +
    '[data-ogsb] .dark-only{display:block !important;max-height:none !important;}' +
    '[data-ogsb] .light-only{display:none !important;}'
  );
}

// ── Safe text ─────────────────────────────────────────────────

export function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only http(s) and mailto links are allowed. Anything else becomes ''. */
export function safeUrl(value) {
  const s = String(value == null ? '' : value).trim();
  return /^(https?:\/\/|mailto:)\S+$/i.test(s) ? s : '';
}

/**
 * Marks a string as OUR wording, which may use [label](https://link) and
 * **bold**. Plain strings (anything from a user or the AI) are always shown
 * as plain text, so they can never become links.
 */
export function md(source) {
  return { __md: String(source == null ? '' : source) };
}

function mdHtml(source) {
  return esc(source)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|mailto:[^)\s]+)\)/g, (_m, label, href) =>
      '<a href="' + href + '" class="t-accent" style="color:' + L.accent + ';text-decoration:underline;">' + label + '</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function mdText(source) {
  return String(source).replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)').replace(/\*\*([^*]+)\*\*/g, '$1');
}

const inl = (v) => (v && v.__md != null ? mdHtml(v.__md) : esc(v));
const inlText = (v) => (v && v.__md != null ? mdText(v.__md) : String(v == null ? '' : v));

const TBL = 'role="presentation" cellpadding="0" cellspacing="0" border="0"';
const asset = (file) => BRAND.assets + file;

// Tone -> the classes and colours that go with it.
const TONES = {
  accent: { fg: 't-accent', fgc: L.accent, bg: 'bg-accent-soft', bgc: L.accentSoft, bar: 'bg-accent', barc: L.accent },
  success: { fg: 't-success', fgc: L.success, bg: 'bg-success-soft', bgc: L.successSoft, bar: 'bg-success', barc: L.success },
  warn: { fg: 't-warn', fgc: L.warn, bg: 'bg-warn-soft', bgc: L.warnSoft, bar: 'bg-warn', barc: L.warn },
  danger: { fg: 't-danger', fgc: L.danger, bg: 'bg-danger-soft', bgc: L.dangerSoft, bar: 'bg-danger', barc: L.danger },
  neutral: { fg: 't-muted', fgc: L.muted, bg: 'bg-soft', bgc: L.soft, bar: 'bg-line', barc: L.line },
};
const tone = (name) => TONES[name] || TONES.neutral;

// ── Pieces ────────────────────────────────────────────────────
// Each returns { html, text, gap }. `gap` is the space (px) left below it.

/** A small rounded status label, e.g. Paid, Action needed. */
export function statusBadge(label, toneName = 'neutral') {
  const t = tone(toneName);
  return (
    '<table ' + TBL + '><tr><td class="' + t.bg + ' ' + t.fg + '" style="background:' + t.bgc + ';border-radius:999px;padding:5px 12px;' +
    'font-family:' + SANS + ';font-size:12px;line-height:16px;font-weight:600;color:' + t.fgc + ';white-space:nowrap;">' + esc(label) + '</td></tr></table>'
  );
}

/**
 * Top of the card: an icon tile, the kind of email it is, and an optional
 * status badge. The label is real text, so nothing depends on the icon.
 */
export function masthead({ icon, label, badge, badgeTone }) {
  const iconCell = icon
    ? '<td width="48" valign="middle" style="width:48px;padding:0 14px 0 0;">' +
      '<img src="' + asset('icon-' + icon + '.png') + '" width="48" height="48" alt="" style="display:block;border:0;outline:none;width:48px;height:48px;">' +
      '</td>'
    : '';
  const badgeCell = badge ? '<td align="right" valign="middle" style="padding-left:12px;">' + statusBadge(badge, badgeTone) + '</td>' : '';
  return {
    gap: 26,
    html:
      '<table ' + TBL + ' width="100%"><tr>' + iconCell +
      '<td valign="middle" class="t-muted" style="font-family:' + SANS + ';font-size:14px;line-height:20px;font-weight:600;color:' + L.muted + ';">' + esc(label) + '</td>' +
      badgeCell + '</tr></table>',
    text: label + (badge ? ' (' + badge + ')' : ''),
  };
}

export function heading(text) {
  return {
    gap: 16,
    html:
      '<h1 class="h1 t-ink" style="margin:0;font-family:' + SERIF + ';font-size:28px;line-height:35px;font-weight:400;letter-spacing:-0.3px;color:' + L.ink + ';">' + esc(text) + '</h1>',
    text: text + '\n' + '='.repeat(Math.min(String(text).length, 60)),
  };
}

/** A section title inside the card. */
export function sectionTitle(text) {
  return {
    gap: 10,
    html: '<h2 class="t-ink" style="margin:0;font-family:' + SANS + ';font-size:16px;line-height:24px;font-weight:600;color:' + L.ink + ';">' + esc(text) + '</h2>',
    text: String(text),
  };
}

/** A paragraph. Pass md('...') for text with links or bold. */
export function para(text, opts = {}) {
  const lead = !!opts.lead;
  const cls = opts.muted ? 't-muted' : 't-body';
  const color = opts.muted ? L.muted : L.body;
  const size = opts.small ? 13 : lead ? 16 : 15;
  const lh = opts.small ? 20 : lead ? 26 : 24;
  return {
    gap: opts.gap == null ? 16 : opts.gap,
    html: '<p class="' + cls + '" style="margin:0;font-family:' + SANS + ';font-size:' + size + 'px;line-height:' + lh + 'px;color:' + color + ';">' + inl(text) + '</p>',
    text: inlText(text),
  };
}

/** Bulletproof button (VML for classic Outlook). Returns null for an unsafe link. */
export function button(label, url, opts = {}) {
  const link = safeUrl(url);
  if (!link) return null;
  const secondary = !!opts.secondary;
  const width = Math.min(420, Math.max(200, Math.round(String(label).length * 9.4) + 72));
  const vml = secondary
    ? '<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="' + esc(link) + '" style="height:46px;v-text-anchor:middle;width:' + width + 'px;" arcsize="17%" strokecolor="' + L.accent + '" strokeweight="1.5pt" fill="f">' +
      '<w:anchorlock/><center style="color:' + L.accent + ';font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">' + esc(label) + '</center></v:roundrect>'
    : '<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="' + esc(link) + '" style="height:48px;v-text-anchor:middle;width:' + width + 'px;" arcsize="17%" stroke="f" fillcolor="' + L.accent + '">' +
      '<w:anchorlock/><center style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;">' + esc(label) + '</center></v:roundrect>';
  const linkStyle = secondary
    ? 'display:inline-block;border:1.5px solid ' + L.accent + ';border-radius:8px;padding:12px 26px;font-family:' + SANS + ';font-size:15px;line-height:20px;font-weight:600;color:' + L.accent + ';text-decoration:none;text-align:center;mso-hide:all;'
    : 'display:inline-block;background:' + L.accent + ';border-radius:8px;padding:14px 32px;font-family:' + SANS + ';font-size:15px;line-height:20px;font-weight:600;color:' + L.onAccent + ';text-decoration:none;text-align:center;mso-hide:all;';
  const linkClass = secondary ? 'btn bd-accent t-accent' : 'btn bg-accent t-on-accent';
  return {
    gap: opts.gap == null ? 12 : opts.gap,
    html:
      '<table ' + TBL + ' class="btn-wrap"><tr><td>' +
      '<!--[if mso]>' + vml + '<![endif]-->' +
      '<!--[if !mso]><!-->' +
      '<a href="' + esc(link) + '" class="' + linkClass + '" style="' + linkStyle + '">' + esc(label) + '</a>' +
      '<!--<![endif]-->' +
      '</td></tr></table>',
    text: label + ':\n' + link,
  };
}

/** Shows a sensitive link as text too, so it can be copied if the button fails. */
export function linkFallback(url) {
  const link = safeUrl(url);
  if (!link) return null;
  return {
    gap: 20,
    html:
      '<p class="t-muted" style="margin:0 0 4px 0;font-family:' + SANS + ';font-size:13px;line-height:20px;color:' + L.muted + ';">Button not working? Paste this address into your browser:</p>' +
      '<p style="margin:0;font-family:' + SANS + ';font-size:12px;line-height:18px;word-break:break-all;">' +
      '<a href="' + esc(link) + '" class="t-accent" style="color:' + L.accent + ';text-decoration:underline;">' + esc(link) + '</a></p>',
    text: 'Button not working? Paste this address into your browser:\n' + link,
  };
}

// Small round bullets drawn with table cells (no images, and no symbols whose
// look changes from font to font). The dot sits in a cell as tall as one line
// of text so it lines up with the first line.
function bulletRows(items, o) {
  const lh = (o && o.lh) || 24;
  const size = (o && o.size) || 15;
  const gap = o && o.gap != null ? o.gap : 6;
  const rows = items
    .map((b, i) => {
      const pad = i === items.length - 1 ? 0 : gap; // no trailing space after the last item
      return (
        '<tr><td width="18" valign="top" style="width:18px;padding:0 0 ' + pad + 'px 0;height:' + lh + 'px;line-height:' + lh + 'px;">' +
        '<table ' + TBL + ' height="' + lh + '"><tr><td valign="middle" height="' + lh + '"><table ' + TBL + '><tr><td class="bg-accent" width="6" height="6" style="width:6px;height:6px;background:' + L.accent + ';border-radius:3px;font-size:0;line-height:0;">&nbsp;</td></tr></table></td></tr></table></td>' +
        '<td class="t-body" valign="top" style="padding:0 0 ' + pad + 'px 0;font-family:' + SANS + ';font-size:' + size + 'px;line-height:' + lh + 'px;color:' + L.body + ';">' + inl(b) + '</td></tr>'
      );
    })
    .join('');
  return '<table ' + TBL + ' width="100%">' + rows + '</table>';
}

export function bullets(items, opts = {}) {
  const list = (items || []).filter((x) => x != null && inlText(x) !== '');
  if (!list.length) return null;
  return {
    gap: opts.gap == null ? 12 : opts.gap,
    html: bulletRows(list, { size: opts.size, lh: opts.lh, gap: opts.rowGap }),
    text: list.map((b) => '- ' + inlText(b)).join('\n'),
  };
}

/**
 * A highlighted note with a coloured edge. Use it for the thing the reader
 * must not miss: a security warning, a payment problem, a good result.
 *   panel({ tone: 'danger', title, body, items })
 */
export function panel({ tone: toneName = 'neutral', title, body, items }) {
  const t = tone(toneName);
  const parts = [];
  if (title) parts.push('<h2 class="t-ink" style="margin:0 0 ' + (body || (items && items.length) ? 6 : 0) + 'px 0;font-family:' + SANS + ';font-size:15px;line-height:22px;font-weight:600;color:' + L.ink + ';">' + esc(title) + '</h2>');
  if (body) parts.push('<p class="t-body" style="margin:0' + (items && items.length ? ' 0 10px 0' : '') + ';font-family:' + SANS + ';font-size:14px;line-height:22px;color:' + L.body + ';">' + inl(body) + '</p>');
  const list = (items || []).filter(Boolean);
  if (list.length) parts.push(bulletRows(list, { size: 14, lh: 22, gap: 6 }));
  const textParts = [];
  if (title) textParts.push(title);
  if (body) textParts.push(inlText(body));
  if (list.length) textParts.push(list.map((b) => '- ' + inlText(b)).join('\n'));
  return {
    gap: 20,
    html:
      '<table ' + TBL + ' width="100%"><tr>' +
      '<td class="' + t.bar + '" width="4" style="width:4px;background:' + t.barc + ';border-radius:10px 0 0 10px;font-size:0;line-height:0;">&nbsp;</td>' +
      '<td class="' + t.bg + '" style="background:' + t.bgc + ';border-radius:0 10px 10px 0;padding:16px 18px;">' + parts.join('') + '</td>' +
      '</tr></table>',
    text: textParts.join('\n'),
  };
}

/**
 * Label and value rows in a soft panel (receipts, account details).
 * rows: [label, value] or [label, value, { break: true }] for long codes.
 * Rows with an empty value are dropped.
 */
export function details(rows, opts = {}) {
  const list = (rows || []).filter((r) => r && r[1] != null && String(r[1]) !== '');
  if (!list.length) return null;
  const body = list
    .map((r, i) => {
      const divider = i === 0 ? '' : 'border-top:1px solid ' + L.line + ';';
      const wrap = r[2] && r[2].break ? 'word-break:break-all;' : 'word-break:break-word;';
      return (
        '<tr>' +
        '<td class="bd t-muted" valign="top" style="' + divider + 'padding:12px 16px 12px 0;font-family:' + SANS + ';font-size:13px;line-height:20px;color:' + L.muted + ';">' + esc(r[0]) + '</td>' +
        '<td class="bd t-ink" valign="top" align="right" style="' + divider + 'padding:12px 0;' + wrap + 'font-family:' + SANS + ';font-size:14px;line-height:20px;font-weight:600;color:' + L.ink + ';">' + esc(r[1]) + '</td>' +
        '</tr>'
      );
    })
    .join('');
  return {
    gap: opts.gap == null ? 20 : opts.gap,
    html:
      '<table ' + TBL + ' width="100%"><tr><td class="bg-soft" style="background:' + L.soft + ';border-radius:10px;padding:4px 20px;">' +
      '<table ' + TBL + ' width="100%">' + body + '</table></td></tr></table>',
    text: list.map((r) => r[0] + ': ' + r[1]).join('\n'),
  };
}

/** A large figure with a status badge, for a receipt's amount. */
export function amountHero({ badge, badgeTone = 'success', amount, caption }) {
  return {
    gap: 20,
    html:
      '<table ' + TBL + ' width="100%"><tr><td class="bg-soft" style="background:' + L.soft + ';border-radius:12px;padding:22px 22px 20px 22px;">' +
      (badge ? '<div style="margin:0 0 14px 0;">' + statusBadge(badge, badgeTone) + '</div>' : '') +
      '<div class="amt t-ink" style="font-family:' + SERIF + ';font-size:40px;line-height:46px;font-weight:400;letter-spacing:-0.6px;color:' + L.ink + ';">' + esc(amount) + '</div>' +
      (caption ? '<div class="t-muted" style="margin-top:6px;font-family:' + SANS + ';font-size:14px;line-height:21px;color:' + L.muted + ';">' + esc(caption) + '</div>' : '') +
      '</td></tr></table>',
    text: (badge ? badge.toUpperCase() + '\n' : '') + amount + (caption ? '\n' + caption : ''),
  };
}

/**
 * A short sequence of stages drawn as a segmented bar, with a label and value
 * under each. nodes: [{ label, value, state: 'done' | 'now' | 'next', tone }]
 * "done" and "now" are filled in the node's tone; "next" is left empty.
 */
export function timeline(nodes) {
  const list = (nodes || []).filter((n) => n && n.label);
  if (!list.length) return null;
  const n = list.length;
  const cells = list
    .map((node, i) => {
      const t = tone(node.tone || 'accent');
      const filled = node.state !== 'next';
      const barClass = filled ? t.bar : 'bg-line';
      const barColor = filled ? t.barc : L.line;
      const padL = i === 0 ? 0 : 3;
      const padR = i === n - 1 ? 0 : 3;
      return (
        '<td class="tl-cell" width="' + Math.floor(100 / n) + '%" valign="top" style="width:' + Math.floor(100 / n) + '%;padding:0 ' + padR + 'px 0 ' + padL + 'px;">' +
        '<table ' + TBL + ' width="100%"><tr><td class="' + barClass + '" height="4" style="height:4px;background:' + barColor + ';border-radius:2px;font-size:0;line-height:0;">&nbsp;</td></tr></table>' +
        '<div class="t-muted" style="padding-top:10px;font-family:' + SANS + ';font-size:12px;line-height:17px;color:' + L.muted + ';">' + esc(node.label) + '</div>' +
        (node.value ? '<div class="t-ink" style="padding-top:2px;font-family:' + SANS + ';font-size:13px;line-height:19px;font-weight:600;color:' + L.ink + ';word-break:break-word;">' + esc(node.value) + '</div>' : '') +
        '</td>'
      );
    })
    .join('');
  return {
    gap: 22,
    html: '<table ' + TBL + ' width="100%"><tr>' + cells + '</tr></table>',
    text: list.map((node) => node.label + (node.value ? ': ' + node.value : '')).join('\n'),
  };
}

/** Numbered steps. Only use this when the order matters. items: [[title, description]] */
export function steps(items) {
  const list = (items || []).filter((r) => r && r[0]);
  if (!list.length) return null;
  const rows = list
    .map(
      (r, i) =>
        '<tr><td width="40" valign="top" style="width:40px;padding:0 0 16px 0;">' +
        '<table ' + TBL + '><tr><td class="bg-accent-soft t-accent" align="center" valign="middle" width="28" height="28" style="width:28px;height:28px;background:' + L.accentSoft + ';border-radius:14px;font-family:' + SANS + ';font-size:13px;line-height:28px;font-weight:700;color:' + L.accent + ';">' + (i + 1) + '</td></tr></table></td>' +
        '<td valign="top" style="padding:0 0 16px 0;">' +
        '<div class="t-ink" style="font-family:' + SANS + ';font-size:15px;line-height:24px;font-weight:600;color:' + L.ink + ';">' + inl(r[0]) + '</div>' +
        (r[1] ? '<div class="t-body" style="padding-top:1px;font-family:' + SANS + ';font-size:14px;line-height:22px;color:' + L.body + ';">' + inl(r[1]) + '</div>' : '') +
        '</td></tr>'
    )
    .join('');
  return {
    gap: 4,
    html: '<table ' + TBL + ' width="100%">' + rows + '</table>',
    text: list.map((r, i) => (i + 1) + '. ' + inlText(r[0]) + (r[1] ? '\n   ' + inlText(r[1]) : '')).join('\n'),
  };
}

/** Title and short description, in hairline-separated rows. items: [[title, description]] */
export function featureList(items) {
  const list = (items || []).filter((r) => r && r[0]);
  if (!list.length) return null;
  const rows = list
    .map((r, i) => {
      const divider = i === 0 ? '' : 'border-top:1px solid ' + L.line + ';';
      return (
        '<tr><td class="bd" style="' + divider + 'padding:14px 0;">' +
        '<div class="t-ink" style="font-family:' + SANS + ';font-size:15px;line-height:22px;font-weight:600;color:' + L.ink + ';">' + inl(r[0]) + '</div>' +
        '<div class="t-body" style="padding-top:2px;font-family:' + SANS + ';font-size:14px;line-height:22px;color:' + L.body + ';">' + inl(r[1]) + '</div></td></tr>'
      );
    })
    .join('');
  return {
    gap: 20,
    html: '<table ' + TBL + ' width="100%">' + rows + '</table>',
    text: list.map((r) => '- ' + inlText(r[0]) + ': ' + inlText(r[1])).join('\n'),
  };
}

/** Two-up cards that stack on phones. items: [[title, description]] */
export function featureCards(items) {
  const list = (items || []).filter((r) => r && r[0]);
  if (!list.length) return null;
  const card = (r) =>
    '<table ' + TBL + ' width="100%"><tr><td class="bg-soft" style="background:' + L.soft + ';border-radius:10px;padding:16px 16px 14px 16px;">' +
    '<div class="t-ink" style="font-family:' + SANS + ';font-size:15px;line-height:22px;font-weight:600;color:' + L.ink + ';">' + inl(r[0]) + '</div>' +
    '<div class="t-body" style="padding-top:4px;font-family:' + SANS + ';font-size:14px;line-height:21px;color:' + L.body + ';">' + inl(r[1]) + '</div></td></tr></table>';
  let rows = '';
  for (let i = 0; i < list.length; i += 2) {
    const a = list[i];
    const b = list[i + 1];
    rows +=
      '<tr>' +
      '<td class="stack" width="50%" valign="top" style="width:50%;padding:0 6px 12px 0;">' + card(a) + '</td>' +
      '<td class="stack" width="50%" valign="top" style="width:50%;padding:0 0 12px 6px;">' + (b ? card(b) : '') + '</td>' +
      '</tr>';
  }
  return {
    gap: 8,
    html: '<table ' + TBL + ' width="100%">' + rows + '</table>',
    text: list.map((r) => '- ' + inlText(r[0]) + ': ' + inlText(r[1])).join('\n'),
  };
}

/** A person's own words (a reminder's notes). Always plain text. */
export function quote(text) {
  const value = String(text == null ? '' : text).trim();
  if (!value) return null;
  return {
    gap: 20,
    html:
      '<table ' + TBL + ' width="100%"><tr>' +
      '<td class="bg-line" width="3" style="width:3px;background:' + L.line + ';font-size:0;line-height:0;">&nbsp;</td>' +
      '<td class="t-body" style="padding:2px 0 2px 16px;font-family:' + SERIF + ';font-size:17px;line-height:27px;color:' + L.body + ';white-space:pre-line;word-break:break-word;">' + esc(value) + '</td>' +
      '</tr></table>',
    text: value.split('\n').map((l) => '> ' + l).join('\n'),
  };
}

/** Several short findings, each with its own coloured edge (digest highlights). */
export function callouts(items, toneName = 'accent') {
  const list = (items || []).filter((x) => x != null && String(x).trim() !== '');
  if (!list.length) return null;
  const t = tone(toneName);
  const rows = list
    .map(
      (x, i) =>
        '<tr><td class="' + t.bar + '" width="3" style="width:3px;background:' + t.barc + ';border-radius:2px;font-size:0;line-height:0;">&nbsp;</td>' +
        '<td class="t-ink" style="padding:1px 0 1px 14px;font-family:' + SANS + ';font-size:15px;line-height:24px;color:' + L.ink + ';word-break:break-word;">' + esc(x) + '</td></tr>' +
        (i < list.length - 1 ? '<tr><td colspan="2" height="14" style="height:14px;font-size:0;line-height:0;">&nbsp;</td></tr>' : '')
    )
    .join('');
  return {
    gap: 22,
    html: '<table ' + TBL + ' width="100%">' + rows + '</table>',
    text: list.map((x) => '- ' + String(x)).join('\n'),
  };
}

/** A calendar-page tile with the time beside it (reminders). */
export function dateTile({ month, day, weekday, headline, sub }) {
  return {
    gap: 22,
    html:
      '<table ' + TBL + ' width="100%"><tr>' +
      '<td width="76" valign="top" style="width:76px;padding-right:18px;">' +
      '<table ' + TBL + ' width="76"><tr><td class="bg-accent t-on-accent" align="center" style="background:' + L.accent + ';border-radius:10px 10px 0 0;padding:5px 0;font-family:' + SANS + ';font-size:12px;line-height:16px;font-weight:600;color:' + L.onAccent + ';">' + esc(month) + '</td></tr>' +
      '<tr><td class="bg-soft bd" align="center" style="background:' + L.soft + ';border:1px solid ' + L.line + ';border-top:0;border-radius:0 0 10px 10px;padding:6px 0 8px 0;">' +
      '<div class="t-ink" style="font-family:' + SERIF + ';font-size:32px;line-height:36px;color:' + L.ink + ';">' + esc(day) + '</div>' +
      (weekday ? '<div class="t-muted" style="font-family:' + SANS + ';font-size:12px;line-height:16px;color:' + L.muted + ';">' + esc(weekday) + '</div>' : '') +
      '</td></tr></table></td>' +
      '<td valign="middle">' +
      '<div class="t-ink" style="font-family:' + SANS + ';font-size:18px;line-height:26px;font-weight:600;color:' + L.ink + ';">' + esc(headline) + '</div>' +
      (sub ? '<div class="t-muted" style="padding-top:2px;font-family:' + SANS + ';font-size:14px;line-height:21px;color:' + L.muted + ';">' + esc(sub) + '</div>' : '') +
      '</td></tr></table>',
    text: [headline, sub].filter(Boolean).join('\n'),
  };
}

export function divider() {
  return {
    gap: 20,
    html: '<table ' + TBL + ' width="100%"><tr><td class="bg-line" height="1" style="height:1px;background:' + L.line + ';font-size:0;line-height:0;">&nbsp;</td></tr></table>',
    text: '',
  };
}

/** A quiet closing note under a hairline. */
export function note(text) {
  return {
    gap: 0,
    html:
      '<table ' + TBL + ' width="100%"><tr><td class="bd" style="border-top:1px solid ' + L.line + ';padding-top:18px;">' +
      '<p class="t-muted" style="margin:0;font-family:' + SANS + ';font-size:13px;line-height:21px;color:' + L.muted + ';">' + inl(text) + '</p></td></tr></table>',
    text: inlText(text),
  };
}

// ── Shell ─────────────────────────────────────────────────────

function socialIcon(href, file, alt) {
  return (
    '<a href="' + esc(href) + '" style="text-decoration:none;display:inline-block;">' +
    '<img src="' + asset(file) + '" width="20" height="20" alt="' + esc(alt) + '" style="display:block;border:0;outline:none;width:20px;height:20px;"></a>'
  );
}

function footerLink(href, label) {
  return '<a href="' + esc(href) + '" class="t-muted" style="color:' + L.muted + ';text-decoration:underline;">' + esc(label) + '</a>';
}

/**
 * Wraps pieces in the shell and returns a message ready for sendEmail().
 *   subject, preheader     the inbox line and the preview text after it
 *   title                  the page title (also read by screen readers)
 *   blocks                 pieces from above; null and empty ones are skipped
 *   reason                 "why you got this email"
 *   unsubscribe            { url, label } for optional emails only
 */
export function renderEmail({ subject, preheader, title, blocks, reason, unsubscribe }) {
  const parts = (blocks || []).filter((b) => b && b.html);
  const unsubUrl = unsubscribe && safeUrl(unsubscribe.url);
  const unsubLabel = (unsubscribe && unsubscribe.label) || 'Unsubscribe';
  const why = reason || 'You are receiving this email because of activity on your Cognita account.';
  const year = new Date().getFullYear();

  const rows = parts
    .map((b, i) => '<tr><td style="padding:0 0 ' + (i === parts.length - 1 ? 0 : b.gap == null ? 20 : b.gap) + 'px 0;">' + b.html + '</td></tr>')
    .join('');

  const html =
'<!DOCTYPE html>' +
'<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office"><head>' +
'<meta charset="UTF-8">' +
'<meta name="viewport" content="width=device-width, initial-scale=1.0">' +
'<meta http-equiv="X-UA-Compatible" content="IE=edge">' +
'<meta name="x-apple-disable-message-reformatting">' +
'<meta name="format-detection" content="telephone=no,address=no,email=no,date=no,url=no">' +
'<meta name="color-scheme" content="light dark">' +
'<meta name="supported-color-schemes" content="light dark">' +
'<title>' + esc(title || subject) + '</title>' +
'<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->' +
'<style>' +
'  :root{color-scheme:light dark;supported-color-schemes:light dark;}' +
'  body{margin:0;padding:0;-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%;}' +
'  table,td{mso-table-lspace:0pt;mso-table-rspace:0pt;}' +
'  img{-ms-interpolation-mode:bicubic;}' +
'  a{word-break:break-word;}' +
'  .dark-only{display:none;max-height:0;overflow:hidden;mso-hide:all;}' +
'  @media only screen and (max-width:620px){' +
'    .outer{padding:16px 10px 28px 10px !important;}' +
'    .px{padding:28px 22px 26px 22px !important;}' +
'    .h1{font-size:25px !important;line-height:32px !important;}' +
'    .amt{font-size:34px !important;line-height:40px !important;}' +
'    .btn-wrap{width:100% !important;}' +
'    .btn{display:block !important;}' +
'    .stack{display:block !important;width:100% !important;padding:0 0 12px 0 !important;}' +
'  }' +
darkCss() +
'</style>' +
'</head>' +
'<body class="bg-page" style="margin:0;padding:0;background:' + L.page + ';">' +
// Hidden preview text shown after the subject in the inbox list. The trailing
// characters stop the inbox pulling in body text after it.
'<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:' + L.page + ';">' + esc(preheader || '') + '&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;</div>' +
'<div role="article" aria-roledescription="email" aria-label="' + esc(title || subject) + '" lang="en">' +
'<table ' + TBL + ' class="bg-page" width="100%" style="background:' + L.page + ';">' +
'<tr><td align="center" class="outer" style="padding:32px 16px 44px 16px;">' +
'<!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->' +
'<table ' + TBL + ' width="100%" style="max-width:600px;">' +

  // Header: logo mark and wordmark. The dark mark swaps in where dark mode is supported.
  '<tr><td style="padding:0 6px 18px 6px;">' +
  '<a href="' + BRAND.site + '" style="text-decoration:none;">' +
  '<table ' + TBL + '><tr>' +
  '<td valign="middle" style="padding-right:9px;">' +
  '<img class="light-only" src="' + asset('logo-mark.png') + '" width="' + LOGO_W + '" height="' + LOGO_H + '" alt="" style="display:block;border:0;width:' + LOGO_W + 'px;height:' + LOGO_H + 'px;">' +
  '<img class="dark-only" src="' + asset('logo-mark-dark.png') + '" width="' + LOGO_W + '" height="' + LOGO_H + '" alt="" style="display:block;border:0;width:' + LOGO_W + 'px;height:' + LOGO_H + 'px;">' +
  '</td>' +
  '<td valign="middle" class="t-ink" style="font-family:' + SANS + ';font-size:22px;line-height:28px;font-weight:800;letter-spacing:-0.6px;color:' + L.ink + ';">cognita</td>' +
  '</tr></table></a>' +
  '</td></tr>' +

  // Card
  '<tr><td class="bg-card bd px" style="background:' + L.card + ';border:1px solid ' + L.line + ';border-radius:14px;padding:36px 40px 34px 40px;">' +
  '<table ' + TBL + ' width="100%">' + rows + '</table>' +
  '</td></tr>' +

  // Footer
  '<tr><td align="center" style="padding:26px 12px 0 12px;">' +
  '<table ' + TBL + ' align="center"><tr>' +
  '<td style="padding:0 9px;">' + socialIcon(BRAND.instagram, 'instagram.png', 'Cognita on Instagram') + '</td>' +
  '<td style="padding:0 9px;">' + socialIcon(BRAND.x, 'x.png', 'Cognita on X') + '</td>' +
  '</tr></table>' +
  '<p class="t-muted" style="margin:16px 0 6px 0;font-family:' + SANS + ';font-size:12px;line-height:19px;color:' + L.muted + ';">' + esc(why) + '</p>' +
  (unsubUrl
    ? '<p class="t-muted" style="margin:0 0 6px 0;font-family:' + SANS + ';font-size:12px;line-height:19px;color:' + L.muted + ';">Do not want these emails? ' + footerLink(unsubUrl, unsubLabel) + '.</p>'
    : '') +
  '<p class="t-muted" style="margin:0 0 6px 0;font-family:' + SANS + ';font-size:12px;line-height:19px;color:' + L.muted + ';">' +
  footerLink(BRAND.site + '/privacy.html', 'Privacy Policy') + '&nbsp;&nbsp;&middot;&nbsp;&nbsp;' +
  footerLink(BRAND.site + '/terms.html', 'Terms of Service') + '&nbsp;&nbsp;&middot;&nbsp;&nbsp;' +
  footerLink(BRAND.contact, 'Contact us') + '</p>' +
  '<p class="t-muted" style="margin:0;font-family:' + SANS + ';font-size:12px;line-height:19px;color:' + L.muted + ';">&copy; ' + year + ' ' + esc(BRAND.name) + '. ' + esc(BRAND.operator) + '</p>' +
  '</td></tr>' +

'</table>' +
'<!--[if mso]></td></tr></table><![endif]-->' +
'</td></tr></table>' +
'</div>' +
'</body></html>';

  const textBody = parts.map((b) => b.text).filter((t) => t && String(t).trim() !== '').join('\n\n');
  const textLines = [BRAND.name, '', textBody, '', '--', BRAND.operator, why];
  if (unsubUrl) textLines.push(unsubLabel + ': ' + unsubUrl);
  textLines.push('Privacy: ' + BRAND.site + '/privacy.html  Terms: ' + BRAND.site + '/terms.html  Contact: ' + BRAND.contactAddress);
  textLines.push('Instagram: ' + BRAND.instagram + '  X: ' + BRAND.x);

  const message = { subject, html, text: textLines.join('\n') };
  // Only https links qualify for one-click unsubscribe (RFC 8058).
  if (unsubUrl && /^https:\/\//i.test(unsubUrl)) {
    message.headers = {
      'List-Unsubscribe': '<' + unsubUrl + '>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    };
  }
  return message;
}
