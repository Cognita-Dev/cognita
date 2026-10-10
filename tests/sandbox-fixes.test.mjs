// Tests for the sandbox start-up and error-message fixes.
// Run: node tests/sandbox-fixes.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, eq, ok, summary, load } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tools = await load('sandbox-tools.js');
const frame = fs.readFileSync(path.join(root, 'sandbox-frame.html'), 'utf8');
const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));

const failed = (stderr) => ({ ok: false, exitCode: 127, stdout: '', stderr });
const msgFor = (stderr) => tools.resultForModel(failed(stderr), false);

console.log('\nWhat the model is told when Python cannot start');
for (const s of [
  'Python did not finish starting: nothing happened for 45 seconds (last step: Starting Python (2/3 core)).',
  'Python stopped downloading: no data arrived for 30 seconds.',
  'Cognita could not reach the Python server (pyodide.cognita.com.ng or cdn.jsdelivr.net).',
  'Cognita could not download Python. The Python server answered with an error (404).',
  'Python could not start: boom\nThis device or browser may not support running Python here.',
]) {
  await test('python unavailable hint: ' + s.slice(0, 40), async () => ok(/Python is NOT available/.test(msgFor(s))));
}
await test('an ordinary Python error does not trigger the hint', async () => ok(!/NOT available/.test(msgFor('Traceback...\nZeroDivisionError: division by zero'))));

console.log('\nWhat the model is told when JavaScript code uses Node or browser features');
for (const s of [
  "ReferenceError: document is not defined",
  "ReferenceError: Can't find variable: document",
  "ReferenceError: require is not defined",
  "ReferenceError: Can't find variable: process",
  "TypeError: window is not defined",
]) {
  await test('js hint: ' + s, async () => ok(/error in the code, not a problem with the device/.test(msgFor(s))));
}
await test('js hint is not added for an unrelated error', async () => ok(!/error in the code/.test(msgFor('Error: boom'))));
await test('js hint is not added when the run succeeded', async () => ok(!/error in the code/.test(tools.resultForModel({ ok: true, exitCode: 0, stdout: 'ReferenceError: document is not defined', stderr: '' }, false))));

console.log('\nJavaScript error text (Safari lists only stack frames, with no message)');
const fnSrc = frame.match(/function describeJsError\(e\) \{[\s\S]*?\n\}\n/);
await test('describeJsError exists in the frame', async () => ok(!!fnSrc));
const describeJsError = fnSrc ? (0, eval)('(' + fnSrc[0].replace(/^function describeJsError/, 'function') + ')') : null;
await test('Safari-style error keeps its message', async () => {
  const out = describeJsError({ name: 'ReferenceError', message: "Can't find variable: document", stack: 'anonymous@\n@blob:null/a8c69d30-0a3e-4e7d-b75b-7ef048bb2393:30:60' });
  ok(out.startsWith("ReferenceError: Can't find variable: document"), out);
  ok(!/blob:/.test(out), 'blob address should be trimmed: ' + out);
});
await test('Chrome-style error does not repeat the message', async () => {
  const out = describeJsError({ name: 'Error', message: 'boom', stack: 'Error: boom\n    at x (sandbox:1:1)' });
  eq(out.split('boom').length - 1, 1);
});
await test('thrown strings and objects are readable', async () => {
  ok(/plain/.test(describeJsError('plain')));
  ok(/42/.test(describeJsError({ code: 42 })));
});

console.log('\nStart-up logic in the frame');
await test('both servers are listed, own host first', async () => {
  const m = frame.match(/var PY_BASES = \[\s*'([^']+)',\s*'([^']+)'\s*\]/);
  ok(m, 'PY_BASES not found');
  eq(m[1], 'https://pyodide.cognita.com.ng/v0.29.5/');
  eq(m[2], 'https://cdn.jsdelivr.net/pyodide/v0.29.5/full/');
});
await test('the download guard exists and is wired into boot()', async () => {
  ok(/function guardDownloads\(inner\)/.test(frame));
  ok(/loading = guardDownloads\(inner\)/.test(frame));
});
await test('the 45 s page watchdog is longer than the 30 s download stall', async () => {
  const stall = Number((frame.match(/var STALL_MS = (\d+);/) || [])[1]);
  const watch = Number((frame.match(/\}, (\d+)\);\s*\}\s*function onMsg/) || [])[1]);
  ok(stall > 0 && watch > stall, stall + ' vs ' + watch);
});

console.log('\nSecurity headers (vercel.json)');
const rule = (src) => vercel.headers.find((h) => h.source.startsWith(src));
const csp = (r) => r.headers.find((h) => h.key === 'Content-Security-Policy').value;
await test('sandbox frame may load only the two Python hosts', async () => {
  const c = csp(rule('/sandbox-frame'));
  const hosts = (c.match(/https:\/\/[a-z0-9.-]+/g) || []).filter((h, i, a) => a.indexOf(h) === i).sort();
  eq(hosts.join(','), 'https://cdn.jsdelivr.net,https://pyodide.cognita.com.ng');
  ok(/default-src 'none'/.test(c) && /frame-ancestors 'self'/.test(c));
});
await test('diagnostic page has its own policy and is excluded from the global one', async () => {
  const g = vercel.headers[0].source;
  ok(g.includes('sandbox-check'), g);
  const c = csp(rule('/sandbox-check'));
  ok(/frame-ancestors 'none'/.test(c) && /frame-src 'self'/.test(c));
});
await test('diagnostic page file exists and is served (not in .vercelignore)', async () => {
  ok(fs.existsSync(path.join(root, 'sandbox-check.html')));
  ok(!/sandbox-check/.test(fs.readFileSync(path.join(root, '.vercelignore'), 'utf8')));
});

process.exit(summary() ? 1 : 0);
