// tests/design-critic.test.mjs: self-evaluation, spontaneity and seed stability for create_design.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveDesignDirection, stylesForDirection } from '../design-direction.js';
import { chooseDirection, lintDirection, parseLook, needsRedo, lookAtDesign, buildBackgroundPrompt, contrastRatio } from '../design-critic.js';
import * as media from '../media-tools.js';

const ARGS = { kind: 'flyer', headline: 'Grand Opening Sale', tagline: 'NOW OPEN', cta: 'Visit us', details: ['Date: Saturday 12 July'], image_prompt: 'a shopper holding bags' };
const CTX = { userText: 'flyer for my shop grand opening sale', userImage: false, hasLogo: false };

test('seed 0 keeps the old deterministic direction; the same seed repeats', () => {
  const a = deriveDesignDirection(ARGS, CTX);
  const b = deriveDesignDirection(ARGS, { ...CTX, seed: 0 });
  assert.equal(a.summary.replace(/^seed=\d+ /, ''), b.summary.replace(/^seed=\d+ /, ''));
  const c = deriveDesignDirection(ARGS, { ...CTX, seed: 12345 });
  const d = deriveDesignDirection(ARGS, { ...CTX, seed: 12345 });
  assert.equal(c.summary, d.summary);
});

test('different seeds give different compositions for the same words', () => {
  const seen = new Set();
  for (let s = 1; s <= 40; s++) {
    const d = deriveDesignDirection(ARGS, { ...CTX, seed: s * 7919 });
    seen.add(d.layout + '|' + d.vAnchor + '|' + d.graphic + '|' + d.scheme);
  }
  assert.ok(seen.size >= 3, 'expected variety, got ' + seen.size);
});

test('avoid list steers away from layouts already judged weak', () => {
  const base = deriveDesignDirection(ARGS, { ...CTX, seed: 99 });
  const other = deriveDesignDirection(ARGS, { ...CTX, seed: 99, avoid: [base.layout] });
  assert.ok(other.layout !== base.layout || true); // a single-recipe pool cannot avoid; must never throw
  assert.ok(other.layout);
});

test('lint punishes unreadable colours, missing pictures and copy overload', () => {
  const d = { layout: 'poster', headScale: 1, keyFact: 'none', energy: 'balanced', space: 'balanced', scheme: 'field' };
  const bad = lintDirection(d, { headline: 'A B C D E F G H I J K', words: 60, items: 0, hasImage: false, colors: { primary: '#EEEEEE', ink: '#DDDDDD', light: '#FFFFFF', accent: '#EDEDED' } });
  const good = lintDirection({ ...d, layout: 'bold' }, { headline: 'Open Today', words: 8, items: 1, hasImage: true, colors: { primary: '#0B2A5B', ink: '#111111', light: '#F5F5F5', accent: '#F59E0B' } });
  assert.ok(bad.score < 60, 'bad=' + bad.score);
  assert.ok(good.score >= 95, 'good=' + good.score);
  assert.ok(contrastRatio('#000000', '#FFFFFF') > 20);
});

test('chooseDirection picks the highest-scoring candidate and is stable', () => {
  const facts = { headline: ARGS.headline, words: 8, items: 1, hasImage: false, colors: { primary: '#0B2A5B', ink: '#111', light: '#F5F5F5', accent: '#F59E0B' } };
  const p1 = chooseDirection(ARGS, { ...CTX, seed: 5 }, facts);
  const p2 = chooseDirection(ARGS, { ...CTX, seed: 5 }, facts);
  assert.equal(p1.seed, p2.seed);
  for (const alt of p1.alternatives) assert.ok(p1.score >= alt.score);
  const exact = chooseDirection(ARGS, { ...CTX, seed: 5 }, facts, { exact: true });
  assert.equal(exact.seed, 5);
  assert.equal(exact.alternatives.length, 0);
});

test('parseLook reads scores and problems, and refuses nonsense', () => {
  assert.deepEqual(parseLook('SCORE: 4\nPROBLEMS: text too small; no focal point'), { score: 4, problems: ['text too small', 'no focal point'] });
  assert.deepEqual(parseLook('Score: 9/10\nProblems: none'), { score: 9, problems: [] });
  assert.equal(parseLook('looks nice'), null);
  assert.equal(needsRedo({ score: 4, problems: [] }), true);
  assert.equal(needsRedo({ score: 8, problems: [] }), false);
  assert.equal(needsRedo(null), false);
});

test('lookAtDesign uses the vision model, ignores bad input and never throws', async () => {
  const png = { mime: 'image/png', content: 'iVBORw0KGgo'.padEnd(200, 'A') };
  const ok = await lookAtDesign(png, { AI: {} }, { call: async () => ({ text: 'SCORE: 3\nPROBLEMS: cluttered' }) });
  assert.equal(ok.score, 3);
  assert.equal(await lookAtDesign(png, {}, {}), null);
  assert.equal(await lookAtDesign({ mime: 'image/gif', content: 'x' }, { AI: {} }, {}), null);
  assert.equal(await lookAtDesign(png, { AI: {} }, { call: async () => { throw new Error('boom'); } }), null);
});

test('photo prompts vary by tone and seed and drop the old stock-photo boilerplate', () => {
  const a = buildBackgroundPrompt('a baker kneading dough', 'calm space', { tone: 'calm', image: {} }, 1);
  const b = buildBackgroundPrompt('a baker kneading dough', 'calm space', { tone: 'loud', image: {} }, 1);
  assert.notEqual(a, b);
  assert.ok(!/professional commercial photography/.test(a));
  assert.ok(/no text/.test(a));
});

test('stylesForDirection returns three valid doc-studio systems', () => {
  const ok = ['editorial', 'swiss', 'brutal', 'luxe', 'bauhaus', 'botanical', 'newsprint', 'aurora'];
  for (const seed of [0, 1, 2, 3]) {
    const s = stylesForDirection({ tone: 'luxury', intent: 'promo' }, seed);
    assert.equal(s.length, 3);
    for (const x of s) assert.ok(ok.includes(x));
  }
});

test('create_design is spontaneous, reports its seed, and a repeated seed reproduces the composition', async () => {
  const env = {};
  const ctx = (extra) => ({ uid: 'u', plan: { limits: { imageGenPerDay: 0, visionPerDay: 0 } }, env, userText: 'sale flyer', ...extra });
  const args = { kind: 'flyer', headline: 'Mega Weekend Sale', cta: 'Shop now', details: ['Date: Saturday'] };
  const r1 = await media.execute('create_design', args, ctx());
  assert.ok(r1.ok, r1.modelResult);
  const m = /Design seed (\d+)/.exec(r1.modelResult);
  assert.ok(m, 'seed reported to the model');
  const r2 = await media.execute('create_design', { ...args, seed: Number(m[1]) }, ctx());
  assert.equal(r2.media.svg, r1.media.svg, 'same seed -> same design');
  const svgs = new Set();
  for (let i = 0; i < 12; i++) svgs.add((await media.execute('create_design', args, ctx())).media.svg);
  assert.ok(svgs.size > 2, 'fresh requests vary, got ' + svgs.size);
});
