// emails/build-assets.mjs
// Regenerates the PNG artwork the emails use, in assets/email/.
//
//   npm install --no-save sharp
//   node emails/build-assets.mjs
//
// You only need to run this if you change an icon, a banner or a brand colour.
// The finished PNGs are committed, so deploying never needs this script.
//
// Why PNG and not SVG? Gmail and several other email apps drop SVG images,
// so an SVG icon would simply not appear for many people. The drawings below
// are written as SVG only because that is the easiest way to draw them; they
// are turned into PNG here, and only the PNG is ever used in an email.
//
// What it makes:
//   icon-<name>.png      a 48px rounded tile with a white line icon, drawn at
//                        3x (144px) so it is sharp on phones. One file works
//                        in light and dark mode because the tile has its own
//                        solid colour.
//   banner-<email>.png   the picture at the top of each email (1200 x 400,
//                        shown at about 600 wide)
//   logo-mark.png        the Cognita "C" for light backgrounds, 96px tall
//   logo-mark-dark.png   the same mark recoloured for dark backgrounds
//
// The existing cognita-mark.png is left alone: the unsubscribe page uses it.

import sharp from 'sharp';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'email');

// Same values as the app (css/shared.css) and emails/email-kit.js.
const TONES = {
  accent: '#a8471f',
  success: '#3f6b5b',
  warn: '#a06a1f',
  danger: '#b3423a',
  stone: '#6f6f6a',
};

// Each glyph is drawn on a 24 x 24 grid with a 1.8 stroke.
// `badge` glyphs get a small round badge in the bottom-right corner.
// "currentColor" is the drawing colour (set by the caller).
const GLYPHS = {
  'mail-check': {
    tone: 'accent',
    body:
      '<rect x="2.8" y="5.2" width="17" height="13" rx="2.4"/>' +
      '<path d="M3.4 8l8 5.3L19.4 8"/>',
    badge: '<path d="M15.3 17.7l1.7 1.7 3-3.3"/>',
  },
  lock: {
    tone: 'accent',
    body:
      '<rect x="5" y="10.5" width="14" height="10" rx="2.2"/>' +
      '<path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>' +
      '<circle cx="12" cy="15.2" r="1.1" fill="currentColor" stroke="none"/>' +
      '<path d="M12 16.2v1.7"/>',
  },
  'shield-alert': {
    tone: 'warn',
    body:
      '<path d="M12 3l7.5 2.7v5.6c0 4.5-3.1 8.2-7.5 9.7-4.4-1.5-7.5-5.2-7.5-9.7V5.7L12 3z"/>' +
      '<path d="M12 8.3v4.3"/>' +
      '<circle cx="12" cy="15.6" r="0.95" fill="currentColor" stroke="none"/>',
  },
  'receipt-check': {
    tone: 'success',
    body:
      '<path d="M6.2 3.5h11.6V21l-2.15-1.5L13.5 21 12 19.6 10.5 21l-2.15-1.5L6.2 21V3.5z"/>' +
      '<path d="M9.2 11l2.1 2.1 3.6-3.9"/>',
  },
  'card-alert': {
    tone: 'danger',
    body:
      '<rect x="2.6" y="5.6" width="17" height="12" rx="2.4"/>' +
      '<path d="M2.6 9.8h17"/>' +
      '<path d="M6.2 14.2h3.2"/>',
    badge: '<path d="M17.6 15.2v2.5"/><circle cx="17.6" cy="19.6" r="0.55" fill="BADGE" stroke="none"/>',
  },
  'calendar-x': {
    tone: 'stone',
    body:
      '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/>' +
      '<path d="M3.5 10h17M8 3v4M16 3v4"/>' +
      '<path d="M9.9 13.3l4.2 4.2M14.1 13.3l-4.2 4.2"/>',
  },
  calendar: {
    tone: 'accent',
    body:
      '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/>' +
      '<path d="M3.5 10h17M8 3v4M16 3v4"/>' +
      '<circle cx="8.5" cy="14" r="1" fill="currentColor" stroke="none"/>' +
      '<circle cx="12" cy="14" r="1" fill="currentColor" stroke="none"/>' +
      '<circle cx="15.5" cy="14" r="1" fill="currentColor" stroke="none"/>' +
      '<circle cx="8.5" cy="17.2" r="1" fill="currentColor" stroke="none"/>',
  },
  bell: {
    tone: 'accent',
    body:
      '<path d="M6 16.6V11a6 6 0 0 1 12 0v5.6l1.6 1.7H4.4L6 16.6z"/>' +
      '<path d="M10 20.5a2.2 2.2 0 0 0 4 0"/>',
  },
  chart: {
    tone: 'accent',
    body:
      '<path d="M4.5 20.5h15"/>' +
      '<rect x="6" y="12.2" width="3" height="6.3" rx="0.8"/>' +
      '<rect x="10.5" y="6.8" width="3" height="11.7" rx="0.8"/>' +
      '<rect x="15" y="9.8" width="3" height="8.7" rx="0.8"/>',
  },
  message: {
    tone: 'accent',
    body:
      '<path d="M5.5 4.8h13A2 2 0 0 1 20.5 6.8v8.4a2 2 0 0 1-2 2H11l-4.6 3.3v-3.3H5.5a2 2 0 0 1-2-2V6.8a2 2 0 0 1 2-2z"/>' +
      '<path d="M8 9.5h8M8 12.6h5"/>',
  },
  'file-text': {
    tone: 'accent',
    body:
      '<path d="M7 3.5h7l4.5 4.5v11.3a1.6 1.6 0 0 1-1.6 1.6H7a1.6 1.6 0 0 1-1.6-1.6V5.1A1.6 1.6 0 0 1 7 3.5z"/>' +
      '<path d="M14 3.7V8h4.3"/>' +
      '<path d="M8.6 12.3h6.8M8.6 15.4h6.8M8.6 9.2h2.6"/>',
  },
  clipboard: {
    tone: 'accent',
    body:
      '<rect x="5.5" y="4.8" width="13" height="15.7" rx="2"/>' +
      '<path d="M9 4.8v-.6a1.2 1.2 0 0 1 1.2-1.2h3.6A1.2 1.2 0 0 1 15 4.2v.6"/>' +
      '<path d="M9 10.3h6M9 13.4h6M9 16.5h3.4"/>',
  },
  mic: {
    tone: 'accent',
    body:
      '<rect x="9" y="3.3" width="6" height="11" rx="3"/>' +
      '<path d="M5.8 11.4a6.2 6.2 0 0 0 12.4 0"/>' +
      '<path d="M12 17.6v3M9 20.6h6"/>',
  },
  image: {
    tone: 'accent',
    body:
      '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/>' +
      '<circle cx="9" cy="10" r="1.6"/>' +
      '<path d="M4.2 17.2l4.6-4.4 3.5 3.3 3-2.8 4.5 4.2"/>',
  },
};

/**
 * One glyph as SVG markup on a 24 x 24 grid.
 *   fg: the drawing colour.  bg: the colour behind it (used to cut the badge
 *   out of the drawing).
 */
function glyphSvg(name, fg, bg) {
  const g = GLYPHS[name];
  const badge = g.badge
    ? '<circle cx="17.6" cy="17.6" r="6" fill="' + bg + '" stroke="none"/>' +
      '<circle cx="17.6" cy="17.6" r="4.7" fill="' + fg + '" stroke="none"/>' +
      '<g stroke="' + bg + '" stroke-width="1.7" color="' + bg + '">' + g.badge.replace(/BADGE/g, bg) + '</g>'
    : '';
  return (
    '<g fill="none" stroke="' + fg + '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" color="' + fg + '">' +
    g.body + badge + '</g>'
  );
}

function iconSvg(name) {
  const fill = TONES[GLYPHS[name].tone];
  // 48 x 48 tile; the 24 x 24 glyph is scaled to 28 and centred.
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48">' +
    '<rect width="48" height="48" rx="13" fill="' + fill + '"/>' +
    '<g transform="translate(10 10) scale(1.1667)">' + glyphSvg(name, '#ffffff', fill) + '</g></svg>'
  );
}

async function makeIcons() {
  for (const name of Object.keys(GLYPHS)) {
    const file = path.join(OUT, 'icon-' + name + '.png');
    await sharp(Buffer.from(iconSvg(name)), { density: 288 })
      .resize(144, 144)
      .png({ compressionLevel: 9, palette: true, quality: 95 })
      .toFile(file);
    console.log('wrote', 'icon-' + name + '.png');
  }
}

// ── Banners ───────────────────────────────────────────────────
// A paper document in the middle with the email's icon on it, two round
// "chips" with other icons beside it, all on the email's status colour.
// `doc` picks what is drawn on the paper: lines, chart, calendar or receipt.
const BANNERS = {
  verify: { tone: 'accent', main: 'mail-check', chips: ['lock', 'message'], doc: 'lines' },
  reset: { tone: 'accent', main: 'lock', chips: ['shield-alert', 'mail-check'], doc: 'lines' },
  welcome: { tone: 'accent', main: 'message', chips: ['file-text', 'clipboard'], doc: 'lines' },
  'password-changed': { tone: 'warn', main: 'shield-alert', chips: ['lock', 'mail-check'], doc: 'lines' },
  receipt: { tone: 'success', main: 'receipt-check', chips: ['calendar', 'chart'], doc: 'receipt' },
  'payment-failed': { tone: 'danger', main: 'card-alert', chips: ['calendar', 'receipt-check'], doc: 'failed' },
  cancelled: { tone: 'stone', main: 'calendar-x', chips: ['receipt-check', 'message'], doc: 'calendar' },
  reminder: { tone: 'accent', main: 'bell', chips: ['calendar', 'message'], doc: 'calendar' },
  digest: { tone: 'accent', main: 'chart', chips: ['message', 'image'], doc: 'chart' },
};

function paper(doc, c) {
  const line = '#ece7e0';
  const bar = (x, y, w, h, fill, r) => '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + (r == null ? h / 2 : r) + '" fill="' + fill + '"/>';
  if (doc === 'chart') {
    return (
      bar(478, 318, 244, 4, line) +
      bar(492, 240, 40, 78, c, 6).replace('fill="' + c + '"', 'fill="' + c + '" opacity=".45"') +
      bar(548, 196, 40, 122, c, 6) +
      bar(604, 222, 40, 96, c, 6).replace('fill="' + c + '"', 'fill="' + c + '" opacity=".7"') +
      bar(660, 170, 40, 148, c, 6).replace('fill="' + c + '"', 'fill="' + c + '" opacity=".45"')
    );
  }
  if (doc === 'calendar') {
    let s = '';
    for (let j = 0; j < 3; j++) {
      for (let i = 0; i < 6; i++) {
        const hot = i === 3 && j === 1;
        s += '<circle cx="' + (496 + i * 42) + '" cy="' + (206 + j * 44) + '" r="' + (hot ? 15 : 9) + '" fill="' + (hot ? c : line) + '"/>';
      }
    }
    return s;
  }
  if (doc === 'receipt' || doc === 'failed') {
    const mark = doc === 'failed'
      ? '<path d="M694 270v13" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round"/><circle cx="694" cy="292" r="3" fill="#fff"/>'
      : '<path d="M684 281l7 7 13-14" fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>';
    return (
      bar(478, 184, 244, 12, line) +
      bar(478, 212, 170, 12, line) +
      '<rect x="478" y="246" width="244" height="2" fill="' + line + '"/>' +
      bar(478, 268, 130, 26, c, 8) +
      '<circle cx="694" cy="281" r="19" fill="' + c + '"/>' + mark
    );
  }
  return (
    bar(478, 186, 244, 12, line) +
    bar(478, 214, 244, 12, c).replace('fill="' + c + '"', 'fill="' + c + '" opacity=".35"') +
    bar(478, 242, 210, 12, line) +
    bar(478, 270, 244, 12, line) +
    bar(478, 298, 150, 12, line)
  );
}

function bannerSvg({ tone, main, chips, doc }) {
  const c = TONES[tone];
  const at = (name, cx, cy, size, fg, bg) =>
    '<g transform="translate(' + (cx - size / 2) + ' ' + (cy - size / 2) + ') scale(' + size / 24 + ')">' + glyphSvg(name, fg, bg) + '</g>';
  return (
    '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="400" viewBox="0 0 1200 400">' +
    '<rect width="1200" height="400" fill="' + c + '"/>' +
    '<circle cx="70" cy="440" r="240" fill="#fff" opacity=".08"/>' +
    '<circle cx="1150" cy="-30" r="220" fill="#fff" opacity=".08"/>' +
    '<circle cx="1040" cy="400" r="110" fill="#fff" opacity=".06"/>' +
    '<circle cx="600" cy="200" r="178" fill="none" stroke="#fff" stroke-opacity=".3" stroke-width="2" stroke-dasharray="3 9" stroke-linecap="round"/>' +
    // chips
    '<circle cx="318" cy="262" r="60" fill="#fff"/>' + at(chips[0], 318, 262, 58, c, '#ffffff') +
    '<circle cx="884" cy="146" r="60" fill="#fff"/>' + at(chips[1], 884, 146, 58, c, '#ffffff') +
    '<circle cx="236" cy="124" r="9" fill="#fff" opacity=".55"/>' +
    '<circle cx="980" cy="300" r="12" fill="#fff" opacity=".4"/>' +
    // paper
    '<rect x="450" y="58" width="300" height="296" rx="24" fill="#000" opacity=".14"/>' +
    '<rect x="450" y="46" width="300" height="296" rx="24" fill="#fff"/>' +
    '<rect x="478" y="74" width="74" height="74" rx="19" fill="' + c + '"/>' +
    at(main, 515, 111, 46, '#ffffff', c) +
    '<rect x="570" y="92" width="150" height="14" rx="7" fill="#ece7e0"/>' +
    '<rect x="570" y="118" width="98" height="12" rx="6" fill="#f3efe9"/>' +
    '<g transform="translate(0 -6)">' + paper(doc, c) + '</g>' +
    '</svg>'
  );
}

async function makeBanners() {
  for (const [name, spec] of Object.entries(BANNERS)) {
    const file = path.join(OUT, 'banner-' + name + '.png');
    await sharp(Buffer.from(bannerSvg(spec)), { density: 72 })
      .png({ compressionLevel: 9, palette: true, quality: 90, colours: 48, dither: 0 })
      .toFile(file);
    console.log('wrote', 'banner-' + name + '.png');
  }
}

// ── Logo ──────────────────────────────────────────────────────

async function makeMarks() {
  const src = path.join(OUT, 'cognita-mark.png');
  const { data, info } = await sharp(src).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info;

  // The mark is an orange "C" with a tiny open-book line drawing in its
  // opening. At header size (about 30px) the book turns into grey fuzz, so the
  // small-size logo keeps just the "C". The full mark stays available as
  // cognita-mark.png.
  const isOrange = (r, b) => r > 110 && r > b + 50;
  const light = Buffer.from(data);
  const dark = Buffer.from(data);
  let x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (!isOrange(data[i], data[i + 2])) {
        light[i + 3] = 0;
        dark[i + 3] = 0;
        continue;
      }
      dark[i] = 0xe0; dark[i + 1] = 0x8a; dark[i + 2] = 0x52; // the app's dark-mode accent
      if (data[i + 3] > 40) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  const box = { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
  for (const [buf, name] of [[light, 'logo-mark.png'], [dark, 'logo-mark-dark.png']]) {
    await sharp(buf, { raw: { width: w, height: h, channels: 4 } })
      .extract(box)
      .resize({ height: 96 })
      .png({ compressionLevel: 9 })
      .toFile(path.join(OUT, name));
  }
}

await makeIcons();
await makeBanners();
await makeMarks();
