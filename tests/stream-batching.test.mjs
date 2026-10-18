// The live text streamer must not redo the whole reply for every few characters (that made CPU grow with the square
// of the reply length and a runaway reply hit the Worker CPU limit). It works in batches now; nothing may be lost.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { _makeTurnStreamer } from '../chat-endpoint.js';

const names = new Set(['sandbox_run_python', 'sandbox_write_file', 'create_design']);
const collect = () => { const ev = []; return { ev, emit: (type, d) => ev.push([type, d]) }; };
const textOf = (ev) => ev.filter(([t]) => t === 'text').map(([, d]) => d.t).join('');
const feed = (s, text, n) => { for (let i = 0; i < text.length; i += n) s.onText(text.slice(i, i + n)); };

test('every character of a plain reply still reaches the browser', () => {
  const { ev, emit } = collect();
  const s = _makeTurnStreamer(emit, names);
  const text = 'Here is the plan. First we gather the data, then we clean it, then we chart it. '.repeat(40).trim();
  feed(s, text, 3);
  s.finish();
  assert.equal(textOf(ev), text);
});

test('batching sends far fewer frames than chunks', () => {
  const { ev, emit } = collect();
  const s = _makeTurnStreamer(emit, names);
  feed(s, 'word '.repeat(2000), 4);
  s.finish();
  assert.ok(ev.filter(([t]) => t === 'text').length < 200, 'frames: ' + ev.length);
});

test('the first piece is shown at once, not held back', () => {
  const { ev, emit } = collect();
  const s = _makeTurnStreamer(emit, names);
  s.onText('Hello there');
  assert.equal(textOf(ev), 'Hello there');
});

test('a component block streams and the prose around it is kept', () => {
  const { ev, emit } = collect();
  const s = _makeTurnStreamer(emit, names);
  const block = [{ type: 'callout', props: { title: 'Note', content: 'Check the dates.' } }];
  const text = 'Before the block. '.repeat(15) + '\n\n```cognita-ui\n' + JSON.stringify(block) + '\n```\n\n' + 'After the block. '.repeat(15);
  feed(s, text, 5);
  s.finish();
  const shown = textOf(ev);
  assert.ok(shown.includes('Before the block.') && shown.includes('After the block.'));
  assert.ok(!shown.includes('cognita-ui') && !shown.includes('"callout"'), 'raw component JSON must never show as text');
  assert.ok(ev.some(([t, d]) => t === 'ui' && d.ui && d.ui.length === 1 && d.ui[0].type === 'callout'));
});

test('a tool call written as text is never shown, even when it arrives in pieces', () => {
  const { ev, emit } = collect();
  const s = _makeTurnStreamer(emit, names);
  const text = 'Rebuilding the slide now.\nsandbox_run_python({"code": "print(1)"})\n';
  feed(s, text, 4);
  s.finish();
  assert.ok(!textOf(ev).includes('sandbox_run_python'));
  assert.ok(textOf(ev).includes('Rebuilding the slide now.'));
});

test('reset drops queued text so a retried turn starts clean', () => {
  const { ev, emit } = collect();
  const s = _makeTurnStreamer(emit, names);
  s.onText('first');
  s.onText(' second');   // queued, not yet processed
  s.reset();
  s.onText('Fresh start');
  s.finish();
  assert.ok(ev.some(([t]) => t === 'text_reset'));
  assert.equal(textOf(ev.slice(ev.findIndex(([t]) => t === 'text_reset') + 1)), 'Fresh start');
});

test('a long reply stays cheap (it used to cost about 0.7 s of CPU)', () => {
  const { emit } = collect();
  const s = _makeTurnStreamer(emit, names);
  const text = 'The proposal sets out how the call centre will be staffed, trained and measured. '.repeat(200);
  const c0 = process.cpuUsage();
  feed(s, text, 4);
  s.finish();
  const c = process.cpuUsage(c0);
  const ms = (c.user + c.system) / 1000;
  assert.ok(ms < 300, 'cpu ms: ' + ms);
});
