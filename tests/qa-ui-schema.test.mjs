// QA: validateUi/validatePatch idempotence + fuzz over all registered component types (pure logic, MOCKED data).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateUi, validatePatch, applyPatch, UI_TYPES } from '../ui-schema.js';

let seed = 1337; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
const junk = () => {
  const pool = [null, undefined, 0, -1, 1e9, NaN, '', 'x', '<script>alert(1)</script>', '<img src=x onerror=alert(1)>', 'javascript:alert(1)',
    '日本語🎉', 'a'.repeat(5000), [], {}, [1, 2, 3], { a: { b: { c: {} } } }, true, false];
  return pool[Math.floor(rnd() * pool.length)];
};
const deep = (n) => { let o = { v: 1 }; for (let i = 0; i < n; i++) o = { x: [o], items: [o], tabs: [o] }; return o; };
const fuzzNode = (type) => {
  const n = { type, id: 'n' + Math.floor(rnd() * 1e6) };
  const keys = ['title', 'label', 'text', 'rows', 'columns', 'items', 'tabs', 'sections', 'values', 'series', 'data', 'fields', 'href', 'url', 'steps', 'children', 'state', 'variant', 'code', 'language'];
  for (const k of keys) if (rnd() < 0.6) n[k] = rnd() < 0.15 ? Array.from({ length: 400 }, junk) : junk();
  if (rnd() < 0.2) n.items = [deep(40)];
  return n;
};

test('every component type: validateUi is idempotent and never throws (fuzz)', () => {
  assert.ok(UI_TYPES.length >= 20, 'expected >=20 types, got ' + UI_TYPES.length);
  for (const type of UI_TYPES) for (let i = 0; i < 60; i++) {
    const raw = { blocks: [fuzzNode(type), fuzzNode(type)] };
    let once, twice;
    assert.doesNotThrow(() => { once = validateUi(raw); twice = validateUi(once); }, type);
    if (JSON.stringify(twice) !== JSON.stringify(once)) assert.fail('not idempotent: ' + type + '\nonce : ' + JSON.stringify(once).slice(0, 400) + '\ntwice: ' + JSON.stringify(twice).slice(0, 400));
  }
});

test('validatePatch idempotent for every op and never throws', () => {
  for (const op of ['create', 'replace', 'update', 'append', 'remove', 'set_state']) for (const type of UI_TYPES) for (let i = 0; i < 15; i++) {
    const raw = { op, target: 'n1', node: fuzzNode(type), props: { rows: [[1, 2]], tabs: [{ title: 'a' }], sections: [{ title: 's' }], items: [1], data: [1], values: [1] }, state: { sort: 1 } };
    let once, twice;
    assert.doesNotThrow(() => { once = validatePatch(raw); twice = once ? validatePatch(once) : once; }, op + type);
    if (JSON.stringify(twice) !== JSON.stringify(once)) assert.fail('patch not idempotent: ' + op + ' ' + type + '\nonce : ' + JSON.stringify(once).slice(0, 400) + '\ntwice: ' + JSON.stringify(twice).slice(0, 400));
    assert.doesNotThrow(() => applyPatch(validateUi({ blocks: [fuzzNode(type)] }) , once || raw));
  }
});

test('no javascript:/script survives as a link or raw html field', () => {
  const out = JSON.stringify(validateUi({ blocks: [{ type: 'callout', text: '<script>x</script>', href: 'javascript:alert(1)' }] }));
  assert.ok(!/javascript:/i.test(out), out);
});

test('components written with flat props (no "props" wrapper) are kept, not dropped', () => {
  const flat = [
    { type: 'table', title: 'Budget', columns: ['Item', 'Cost'], rows: [['Flour', '$200']] },
    { type: 'bar_chart', title: 'Spend', labels: ['A', 'B'], values: [1, 2] },
    { type: 'form', title: 'Orders', fields: [{ name: 'n', label: 'Name', type: 'text' }] },
    { type: 'callout', variant: 'warning', title: 'Legal', content: 'Check rules' },
  ];
  const out = validateUi(flat);
  assert.deepEqual(out.map((b) => b.type), ['table', 'bar_chart', 'form', 'callout']);
  assert.equal(JSON.stringify(validateUi(out)), JSON.stringify(out), 'second validation must not change anything');
  const wrapped = validateUi([{ type: 'table', props: { title: 'T', columns: ['a'], rows: [['1']] } }]);
  assert.equal(wrapped.length, 1);
});
