// Long sandbox tasks: the per-request call and round ceilings, the saved-trace size, and the shortening of old results.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { MAX_SANDBOX_CALLS_PER_TURN, sanitizeTrace, makeTraceEntry, appendExchange, shrinkOldResults } from '../sandbox-tools.js';

// 1. A real task (write, run, fix, run, check, per file) needs far more than 12 calls.
assert.ok(MAX_SANDBOX_CALLS_PER_TURN >= 40, 'call ceiling is too low for multi-round work');

// 2. The round ceiling is derived from the call ceiling, so it can never end a task before the call ceiling does.
const src = fs.readFileSync(new URL('../chat-endpoint.js', import.meta.url), 'utf8');
const m = /const MAX_AGENT_ROUNDS_SANDBOX = sandboxTools\.MAX_SANDBOX_CALLS_PER_TURN \+ (\d+);/.exec(src);
assert.ok(m && Number(m[1]) >= 10, 'round ceiling must be the call ceiling plus headroom for retries');

// 3. The trace the browser sends back keeps every step of a long task, in order.
const trace = [];
for (let n = 1; n <= MAX_SANDBOX_CALLS_PER_TURN + 10; n++) {
  trace.push(makeTraceEntry({ n, kind: 'sbx', assistantText: '', description: 'step ' + n, resultText: 'result ' + n, tool: 'sandbox_run_python', files: [], offered: null }));
}
const kept = sanitizeTrace(trace);
assert.equal(kept.length, trace.length, 'no step of a long task may be dropped on resume');
assert.deepEqual(kept.map((e) => e.n), trace.map((e) => e.n));

// 4. Old results are shortened for the model; the newest ones and the import note survive; the input is untouched.
const big = 'x'.repeat(20000);
let msgs = [{ role: 'user', content: 'Build me a report' }];
for (let n = 1; n <= 10; n++) {
  const e = makeTraceEntry({ n, kind: 'sbx', assistantText: 'Running.', description: 'step ' + n, resultText: big, blob: n === 1 ? big : null, tool: 'sandbox_run_python', files: [], offered: null });
  msgs = appendExchange(msgs, e);
}
const before = JSON.stringify(msgs);
const shrunk = shrinkOldResults(msgs);
assert.equal(JSON.stringify(msgs), before, 'input must not be changed');
const results = shrunk.filter((x) => x.role === 'user' && /Result \(step \d+\)/.test(x.content));
assert.equal(results.length, 10);
assert.ok(results[0].content.length < 2500, 'oldest result is shortened');
assert.ok(results[0].content.includes('source_step=1'), 'the import note is kept so the full text can still be used');
assert.ok(results[0].content.includes('Continue the task'), 'the continue instruction is kept');
assert.ok(results[5].content.length < 2500, 'a middle result is shortened');
assert.equal(results[9].content.length, msgs.filter((x) => /Result \(step 10\)/.test(x.content))[0].content.length, 'newest result is whole');
assert.equal(results[6].content.length > 19000, true, 'the four newest results are whole');
// the request for ten steps is now far smaller than the full replay
assert.ok(JSON.stringify(shrunk).length < JSON.stringify(msgs).length / 2);
// small or few results are left exactly as they are
const few = appendExchange([{ role: 'user', content: 'hi' }], makeTraceEntry({ n: 1, kind: 'sbx', assistantText: '', description: 'd', resultText: big, tool: 'sandbox_run_python', files: [], offered: null }));
assert.equal(shrinkOldResults(few), few);

console.log('sandbox rounds tests ok');
