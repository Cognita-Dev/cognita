// Tool calls written as text must never reach the person, and a readable one is run as the call it was meant to be.
// Pure string checks (MOCKED: no model is called).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripToolLeaks, recoverLeakedCall, findLeaks, hasToolLeak } from '../tool-leak.js';

const NAMES = new Set(['sandbox_offer_file', 'sandbox_run_python', 'generate_image', 'github_create_or_update_file']);

test('the reported leak is removed and recovered as a real call', () => {
  const t = 'The graph has been generated and is ready for download.\n[sandbox_offer_file](path="/workspace/graph.png", title="Graph of 1 2 4 8 16")';
  assert.equal(stripToolLeaks(t, NAMES).trim(), 'The graph has been generated and is ready for download.');
  const r = recoverLeakedCall(t, NAMES, NAMES);
  assert.equal(r.call.name, 'sandbox_offer_file');
  assert.deepEqual(r.call.args, { path: '/workspace/graph.png', title: 'Graph of 1 2 4 8 16' });
  assert.equal(r.text, 'The graph has been generated and is ready for download.');
});

test('other spellings of a text tool call are removed', () => {
  for (const t of [
    'a sandbox_run_python(code="print(\\"x)\\")", timeout=5) b',
    'a <tool_call>{"name":"sandbox_offer_file","arguments":{"path":"/workspace/a.png"}}</tool_call> b',
    'a\n```json\n{"name":"sandbox_offer_file","arguments":{"path":"/workspace/a.png"}}\n```\nb',
    'a `sandbox_offer_file(path="/workspace/a.png")` b',
    'a functions.sandbox_offer_file{"path":"/workspace/a.png"} b',
  ]) {
    assert.ok(hasToolLeak(t, NAMES), t);
    const out = stripToolLeaks(t, NAMES);
    assert.ok(!/sandbox_|tool_call|```/.test(out), JSON.stringify(out));
    assert.ok(/a/.test(out) && /b/.test(out));
  }
});

test('echoed tool-exchange lines are removed', () => {
  assert.equal(stripToolLeaks('Tool call: Running Python.\nResult (step 1): {"ok":true}\nAll done.', NAMES), 'All done.');
});

test('ordinary prose and code are left alone', () => {
  for (const t of [
    'Use generate_image(prompt) in your code',
    '```python\ndef generate_image(prompt=1):\n    pass\n```',
    'See [the docs](https://example.com) and [1] for more.',
    'Plain answer.\n\n\n\nWith blank lines.',
  ]) {
    assert.equal(findLeaks(t, NAMES).length, 0, t);
    assert.equal(stripToolLeaks(t, NAMES), t);
  }
});

test('an unreadable or unoffered call is removed but not run', () => {
  assert.equal(recoverLeakedCall('x [sandbox_offer_file](nonsense without keys)', NAMES, NAMES).call, null);
  const offered = new Set(['generate_image']);
  assert.equal(recoverLeakedCall('x [sandbox_offer_file](path="/workspace/a.png")', offered, NAMES).call, null);
  assert.equal(recoverLeakedCall('x [sandbox_offer_file](path="/workspace/a.png")', offered, NAMES).text, 'x');
});

test('while streaming, a call never shows and the text only ever grows', () => {
  const full = 'Here you go. [sandbox_offer_file](path="/workspace/a.png", title="A (1)") Enjoy.';
  let prev = '';
  for (let i = 1; i <= full.length; i++) {
    const v = stripToolLeaks(full.slice(0, i), NAMES, true);
    assert.ok(!/sandbox_|\]\(/.test(v), JSON.stringify(v));
    assert.ok(v.startsWith(prev.trimEnd()), JSON.stringify([prev, v]));
    prev = v;
  }
  assert.equal(stripToolLeaks(full, NAMES), 'Here you go. Enjoy.');
});
