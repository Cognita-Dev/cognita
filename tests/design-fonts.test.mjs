// tests/design-fonts.test.mjs: real typefaces are embedded in built-in designs (no hosting, no outside requests).
import test from 'node:test';
import assert from 'node:assert/strict';
import { fontFaceStyle, EMBEDDED_FAMILIES } from '../design-fonts.js';
import * as media from '../media-tools.js';

const run = async (args, userText = '') => {
  const r = await media.execute('create_design', args, { uid: 'u', plan: { limits: { imageGenPerDay: 0, visionPerDay: 0 } }, env: {}, userText });
  assert.ok(r.ok, r.modelResult);
  return r.media.svg;
};
const faces = (svg) => (svg.match(/@font-face/g) || []).length;

test('four families are bundled', () => {
  assert.deepEqual([...EMBEDDED_FAMILIES].sort(), ['CgHead', 'CgRound', 'CgSans', 'CgSerif']);
});

test('fontFaceStyle embeds only the faces the SVG uses, picked like a browser would', () => {
  const svg = '<svg><defs></defs><text font-family="\'CgSans\',Arial" font-weight="700" fill="#000">x</text>' +
    '<text font-family="\'CgSerif\',Georgia" font-weight="400" font-style="italic" fill="#000">y</text></svg>';
  const css = fontFaceStyle(svg);
  assert.equal(faces(css), 2);
  assert.match(css, /font-family:'CgSans';font-weight:800/); // 700 asked, nearest heavier face is 800
  assert.match(css, /font-family:'CgSerif';font-weight:400;font-style:italic/);
  assert.equal(fontFaceStyle('<svg><text font-family="Arial" font-weight="400">z</text></svg>'), '');
});

test('the naira sign pulls in Inter when the chosen face lacks it', () => {
  const plain = '<svg><text font-family="\'CgRound\',\'CgHead\'" font-weight="700">Price</text></svg>';
  const naira = '<svg><text font-family="\'CgRound\',\'CgHead\'" font-weight="700">₦1,000</text></svg>';
  assert.equal(faces(fontFaceStyle(plain)), 1);
  assert.equal(faces(fontFaceStyle(naira)), 2);
});

test('built designs carry their fonts, stay small, and make no outside requests', async () => {
  const svg = await run({ kind: 'flyer', headline: 'Mega Weekend Sale', details: ['Date: Saturday', 'Price: ₦5,000'], cta: 'Shop now', seed: 11 }, 'sale flyer');
  assert.ok(faces(svg) >= 2, 'fonts embedded');
  assert.ok(svg.includes("'CgHead'") || svg.includes("'CgSans'"));
  assert.ok(svg.length < 200 * 1024, 'size ' + svg.length);
  assert.ok(!/(?:href|src)=["']https?:/.test(svg) && !/url\(\s*["']?https?:/.test(svg), 'no outside URLs');
  assert.ok(!/<script/i.test(svg));
});

test('every voice renders: serif, clean, heavy and round', async () => {
  const seen = new Set();
  const briefs = [
    ['church thanksgiving service', { kind: 'poster', headline: 'Night of Thanksgiving', details: ['Date: Friday'] }],
    ['tech summit conference', { kind: 'flyer', headline: 'Lagos Tech Summit', details: ['Date: 4 December'] }],
    ['mega sale clearance', { kind: 'flyer', headline: 'Mega Sale', details: ['Price: ₥5,000'] }],
    ['kids birthday party fun', { kind: 'social_post', headline: 'Kids Fun Party', details: ['Date: Saturday'] }],
  ];
  for (const [text, a] of briefs) {
    for (let seed = 1; seed <= 6; seed++) {
      const svg = await run({ ...a, seed }, text);
      for (const f of ['CgSans', 'CgHead', 'CgRound', 'CgSerif']) if (svg.includes("font-family:'" + f + "'")) seen.add(f);
    }
  }
  assert.ok(seen.has('CgSans'), 'sans');
  assert.ok(seen.has('CgSerif'), 'serif');
  assert.ok(seen.size >= 3, 'got ' + [...seen]);
});

test('long headlines and long words still get a design', async () => {
  const svg = await run({ kind: 'social_post', headline: 'Congratulations Oluwaseyifunmilayo', tagline: 'WELL DONE', seed: 4 }, 'congratulations greeting');
  assert.ok(svg.startsWith('<svg') && svg.includes('Oluwaseyifunmilayo'));
});
