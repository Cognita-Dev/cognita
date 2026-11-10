// Skills: the optional rule blocks load only when a request needs them (skills.js).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildChatSystemPrompt, chatPromptInfo } from '../prompts.js';
import { selectSkills, SKILL_NAMES, UI_RULES, MEDIA_RULES, DOC_RULES, SANDBOX_DOC_HELPER } from '../skills.js';

const now = new Date('2026-11-10T10:00:00Z');
const all = { hasTools: true, hasSandbox: true, hasMedia: true, hasWeb: true, hasDocs: false, now };

test('no skills option = everything loaded, same as before skills existed', () => {
  const p = buildChatSystemPrompt(all);
  assert.ok(p.includes(UI_RULES) && p.includes(MEDIA_RULES) && p.includes(SANDBOX_DOC_HELPER));
  assert.equal(buildChatSystemPrompt({ ...all, skills: null }), p);
  assert.equal(buildChatSystemPrompt({ ...all, skills: SKILL_NAMES }), p);
  const d = buildChatSystemPrompt({ ...all, hasDocs: true, skills: null });
  assert.ok(d.includes(DOC_RULES));
});

test('an empty skill list leaves out every optional block and is much smaller', () => {
  const full = buildChatSystemPrompt(all);
  const lean = buildChatSystemPrompt({ ...all, skills: [] });
  assert.ok(!lean.includes(UI_RULES) && !lean.includes(MEDIA_RULES) && !lean.includes(SANDBOX_DOC_HELPER));
  assert.ok(lean.includes('Session details'), 'session block kept');
  assert.ok(lean.includes('web_search'), 'web rules stay core');
  assert.ok(lean.length < full.length * 0.7, 'lean ' + lean.length + ' vs full ' + full.length);
});

test('each skill adds only its own block, in a fixed order', () => {
  const only = (s, extra = {}) => buildChatSystemPrompt({ ...all, ...extra, skills: s });
  assert.ok(only(['rich-components']).includes(UI_RULES) && !only(['rich-components']).includes(MEDIA_RULES));
  assert.ok(only(['design-media']).includes(MEDIA_RULES) && !only(['design-media']).includes(UI_RULES));
  assert.ok(only(['office-files']).includes(SANDBOX_DOC_HELPER));
  assert.ok(only(['create-document'], { hasDocs: true }).includes(DOC_RULES));
  assert.ok(!only(['design-media'], { hasDocs: true }).includes(DOC_RULES));
  // same skills in any order give the same prompt
  assert.equal(only(['rich-components', 'design-media']), only(['rich-components', 'design-media']));
  // static start is shared, so provider caching still works
  const a = only([]), b = only(['rich-components']);
  assert.ok(b.startsWith(a.split('\n\nSession details')[0]));
});

test('the start of the prompt does not change with skills (cache-friendly)', () => {
  const plain = buildChatSystemPrompt({ now, skills: [] }).split('\n\nSession details')[0];
  const rich = buildChatSystemPrompt({ now, skills: ['rich-components'] });
  assert.ok(rich.startsWith(plain));
});

test('router: plain chat loads nothing, requests load what they need', () => {
  assert.deepEqual(selectSkills({ userTexts: ['hi'] }), []);
  assert.deepEqual(selectSkills({ userTexts: ['thanks!'] }), []);
  assert.ok(selectSkills({ userTexts: ['Make me a monthly budget plan'] }).includes('rich-components'));
  assert.ok(selectSkills({ userTexts: ['compare iPhone and Samsung in a table'] }).includes('rich-components'));
  const w = selectSkills({ userTexts: ['write my CV and give it as a Word file'] });
  assert.ok(w.includes('office-files') && w.includes('create-document'));
  const m = selectSkills({ userTexts: ['design a flyer for my church event'] });
  assert.ok(m.includes('design-media'));
  assert.ok(selectSkills({ userTexts: ['generate an image of a lion'] }).includes('design-media'));
  const order = selectSkills({ userTexts: ['make a poster, a pdf report and a budget plan'] });
  assert.deepEqual(order, SKILL_NAMES.filter((n) => order.includes(n)));
});

test('router: words that merely contain a trigger do not load a skill', () => {
  assert.ok(!selectSkills({ userTexts: ['explain photosynthesis'] }).includes('design-media'));
  assert.ok(!selectSkills({ userTexts: ['tell me about profiles'] }).includes('office-files'));
  assert.ok(selectSkills({ userTexts: ['create a logo'] }).includes('design-media'));
});

test('router: a short follow-up keeps skills from the last three messages', () => {
  const s = selectSkills({ userTexts: ['yes do it', 'make a poster for my shop', 'hello'] });
  assert.ok(s.includes('design-media'));
  assert.deepEqual(selectSkills({ userTexts: ['ok', 'hello', 'hi', 'make a poster'] }), []);
});

test('router: an earlier component answer keeps rich-components for patch follow-ups', () => {
  const history = [
    { role: 'user', content: 'ok' },
    { role: 'assistant', content: 'Here.\n\n```cognita-ui\n[{"id":"a","type":"card"}]\n```' },
    { role: 'user', content: 'change the last number to 5' },
  ];
  assert.ok(selectSkills({ userTexts: ['change the last number to 5'], history }).includes('rich-components'));
});

test('router: the marker the app adds to earlier component answers also counts', () => {
  const history = [{ role: 'assistant', content: 'Done.\n\n[Components already shown on screen (ids): "sales-table"]' }];
  assert.ok(selectSkills({ userTexts: ['make row 2 bigger'], history }).includes('rich-components'));
});

test('router fails open when there is nothing to judge', () => {
  assert.equal(selectSkills({ userTexts: [] }), null);
  assert.equal(selectSkills({ userTexts: ['   '] }), null);
  assert.equal(selectSkills({ userTexts: [{ type: 'image' }] }), null);
  assert.equal(selectSkills({}), null);
});

test('chatPromptInfo reports skills and a smaller size', () => {
  const full = chatPromptInfo({ hasSandbox: true, hasMedia: true });
  const lean = chatPromptInfo({ hasSandbox: true, hasMedia: true, skills: [] });
  assert.ok(lean.variant.includes('+skills[]'));
  assert.ok(lean.approxTokens < full.approxTokens - 1000, lean.approxTokens + ' vs ' + full.approxTokens);
});
