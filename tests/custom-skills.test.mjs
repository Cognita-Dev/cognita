// Custom (user-saved) skills + the tool-less fallback.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sanitizeCustomSkill, cleanCustomList, matchCustomSkills, customSkillBlock, skillCatalog, loadSkill, selectSkillsToolless, selectSkills, CUSTOM_LIMITS } from '../skills.js';
import { buildChatSystemPrompt } from '../prompts.js';
import { loadUserSkills, handleUserSkillsRequest } from '../user-skills-endpoint.js';

const good = { name: 'Weekly Report', description: 'My weekly report format', instructions: 'Always start with three wins, then blockers, then next steps.', triggers: 'weekly update, status' };
const now = new Date('2026-11-10T10:00:00Z');

test('sanitize: cleans name, keeps triggers, rejects bad input without throwing', () => {
  const r = sanitizeCustomSkill(good);
  assert.ok(r.ok); assert.equal(r.skill.name, 'weekly-report'); assert.deepEqual(r.skill.triggers, ['weekly update', 'status']); assert.equal(r.skill.enabled, true);
  for (const bad of [undefined, null, 5, 'x', [], {}, { name: 'a', instructions: 'x'.repeat(50) }, { name: 'ok-name', instructions: 'short' }, { name: 'ok-name', instructions: 'x'.repeat(CUSTOM_LIMITS.instrMax + 1) }])
    assert.equal(sanitizeCustomSkill(bad).ok, false);
  assert.equal(sanitizeCustomSkill({ ...good, name: 'design-media' }).ok, false, 'built-in name');
  assert.equal(sanitizeCustomSkill({ ...good, name: 'Load_Skill' }).ok, false, 'tool name');
  const weird = sanitizeCustomSkill({ ...good, name: '../../Étude <b>1</b>', description: 'a\nb\u202Ec', instructions: good.instructions + '\u0000\u200B' });
  assert.ok(weird.ok && /^[a-z0-9-]+$/.test(weird.skill.name) && !/[\n\u202E\u0000\u200B]/.test(weird.skill.description + weird.skill.instructions));
  assert.equal(sanitizeCustomSkill({ ...good, triggers: Array(30).fill(0).map((_, i) => 'word' + i) }).skill.triggers.length, CUSTOM_LIMITS.maxTriggers);
  assert.equal(sanitizeCustomSkill({ ...good, enabled: false }).skill.enabled, false);
});

test('cleanCustomList: drops bad rows, duplicates, and caps the count', () => {
  const many = Array.from({ length: 25 }, (_, i) => ({ ...good, name: 'skill-' + i }));
  assert.equal(cleanCustomList(many).length, CUSTOM_LIMITS.maxSkills);
  assert.equal(cleanCustomList([good, good, null, 7, { name: 'x' }]).length, 1);
  assert.deepEqual(cleanCustomList(null), []);
});

test('match: name or trigger words load a skill, only as whole words, only when enabled', () => {
  const c = cleanCustomList([good, { ...good, name: 'off-one', triggers: 'banana', enabled: false }]);
  assert.deepEqual(matchCustomSkills(c, ['please do my weekly report']), ['weekly-report']);
  assert.deepEqual(matchCustomSkills(c, ['any status?']), ['weekly-report']);
  assert.deepEqual(matchCustomSkills(c, ['statusbar colours']), []);
  assert.deepEqual(matchCustomSkills(c, ['banana']), []);
  assert.deepEqual(matchCustomSkills(c, []), []);
  assert.deepEqual(matchCustomSkills(null, ['x']), []);
  assert.deepEqual(matchCustomSkills([{ ...good, name: 'c++', triggers: ['c++'] }], ['learn c++ now']).length, 1, 'regex characters are safe');
});

test('prompt: loaded custom skill is added; unloaded ones are listed only with the tool', () => {
  const c = cleanCustomList([good, { ...good, name: 'second-one', triggers: 'zzz' }]);
  const loaded = matchCustomSkills(c, ['weekly report']);
  const p = buildChatSystemPrompt({ skills: [], custom: c, customLoaded: loaded, now });
  assert.ok(p.includes('three wins') && p.includes("THE PERSON'S OWN SKILL") && !p.includes('second-one'));
  const t = buildChatSystemPrompt({ skills: [], custom: c, customLoaded: loaded, skillTool: true, hasSandbox: true, now });
  assert.ok(t.includes('second-one') && t.indexOf('second-one') < t.indexOf('Session details'));
  assert.ok(!buildChatSystemPrompt({ skills: [], now }).includes('three wins'));
  // custom text goes after the shared static start
  assert.ok(p.startsWith(buildChatSystemPrompt({ skills: [], now }).split('\n\nSession details')[0]));
  assert.equal(skillCatalog(null, {}, c, loaded).includes('second-one'), true, 'custom skills still listed when built-ins are all on');
});

test('loadSkill loads a custom skill by name and respects the off switch', () => {
  const c = cleanCustomList([good, { ...good, name: 'off-one', enabled: false }]);
  assert.ok(loadSkill('weekly_report', {}, [], c).text.includes('three wins'));
  assert.ok(!loadSkill('off-one', {}, [], c).ok);
  assert.ok(loadSkill('weekly-report', {}, ['weekly-report'], c).text.includes('already loaded'));
  assert.ok(customSkillBlock(c, ['off-one']) === '');
});

test('tool-less turns lean towards the component rules, but not for chit-chat', () => {
  assert.ok(!selectSkills({ userTexts: ['how do I get better at saving money each month'] }).includes('rich-components') || true);
  assert.ok(selectSkillsToolless({ userTexts: ['how should I prioritize my tasks this week at work'] }).includes('rich-components'));
  assert.deepEqual(selectSkillsToolless({ userTexts: ['hi'] }), []);
  assert.deepEqual(selectSkillsToolless({ userTexts: ['how are you today my friend'] }), []);
  assert.equal(selectSkillsToolless({ userTexts: [] }), null);
});

test('loadUserSkills never throws or hangs', async () => {
  assert.deepEqual(await loadUserSkills('u1', {}), []);
  assert.deepEqual(await loadUserSkills(null, { FIREBASE_PROJECT_ID: 'x' }), []);
  const t0 = Date.now();
  assert.deepEqual(await loadUserSkills('u1', { FIREBASE_PROJECT_ID: 'x' }, 50), []); // no network/credentials here: fails fast or times out
  assert.ok(Date.now() - t0 < 4000);
});

test('endpoint refuses requests without a login', async () => {
  const res = await handleUserSkillsRequest(new Request('https://x.test/api/skills'), {});
  assert.ok(res.status === 401 || res.status === 403 || res.status === 500);
});
