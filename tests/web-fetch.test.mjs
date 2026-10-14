import assert from 'node:assert/strict';
import { fetchPublicText, previewForModel, MAX_BYTES } from '../web-fetch.js';
import { validateSandboxArgs, SANDBOX_TOOL_NAMES, toolsForCapabilities } from '../sandbox-tools.js';
import { CAPS } from '../sandbox-provider.js';

const mk = (status, body, headers = {}) => new Response(body, { status, headers });
let calls = [];
const fake = (map) => async (url) => { calls.push(url); const r = map[url]; if (!r) throw new Error('unreachable'); return typeof r === 'function' ? r() : r; };

// blocked addresses never reach the network
for (const u of ['http://example.com', 'https://localhost/x', 'https://127.0.0.1/', 'https://10.0.0.5/', 'https://[::1]/', 'https://user:pw@example.com/', 'https://example.com:8443/', 'https://intranet/', 'https://a.internal/', 'not a url']) {
  calls = [];
  const r = await fetchPublicText(u, fake({}));
  assert.equal(r.ok, false, u);
  assert.equal(calls.length, 0, u);
}
// plain page
let r = await fetchPublicText('https://example.com/a', fake({ 'https://example.com/a': () => mk(200, '<h1>Hi</h1>', { 'content-type': 'text/html; charset=utf-8' }) }));
assert.ok(r.ok && r.text === '<h1>Hi</h1>' && r.contentType === 'text/html');
assert.ok(previewForModel(r).includes('Fetched https://example.com/a'));
// redirect to a private address is refused, redirect to a public one is followed
r = await fetchPublicText('https://example.com/r', fake({ 'https://example.com/r': () => mk(302, '', { location: 'https://127.0.0.1/secret' }) }));
assert.equal(r.ok, false); assert.match(r.error, /not allowed/);
r = await fetchPublicText('https://example.com/r', fake({
  'https://example.com/r': () => mk(301, '', { location: '/final' }),
  'https://example.com/final': () => mk(200, 'ok', { 'content-type': 'text/plain' }),
}));
assert.ok(r.ok && r.url === 'https://example.com/final');
// redirect loop
r = await fetchPublicText('https://example.com/l', fake({ 'https://example.com/l': () => mk(302, '', { location: '/l' }) }));
assert.equal(r.ok, false); assert.match(r.error, /too many/);
// binary types, status codes
r = await fetchPublicText('https://example.com/p', fake({ 'https://example.com/p': () => mk(200, 'x', { 'content-type': 'application/pdf' }) }));
assert.equal(r.ok, false); assert.match(r.error, /not a text page/);
for (const [st, re] of [[404, /not found/], [403, /refused/], [429, /limiting/], [500, /error/]]) {
  r = await fetchPublicText('https://example.com/s', fake({ 'https://example.com/s': () => mk(st, 'x', { 'content-type': 'text/html' }) }));
  assert.equal(r.ok, false); assert.match(r.error, re);
}
// size cap
r = await fetchPublicText('https://example.com/big', fake({ 'https://example.com/big': () => mk(200, 'a'.repeat(MAX_BYTES + 5000), { 'content-type': 'text/csv' }) }));
assert.ok(r.ok && r.truncated && r.bytes === MAX_BYTES && r.text.length === MAX_BYTES);
// network failure is a clean error
r = await fetchPublicText('https://example.com/down', fake({}));
assert.equal(r.ok, false); assert.match(r.error, /could not be reached/);
// tool registration and validation
assert.ok(SANDBOX_TOOL_NAMES.has('sandbox_web_fetch'));
assert.ok(toolsForCapabilities(new Set([CAPS.WEB_FETCH])).some((t) => t.function.name === 'sandbox_web_fetch'));
assert.ok(!toolsForCapabilities(new Set([CAPS.FILES])).some((t) => t.function.name === 'sandbox_web_fetch'));
assert.equal(validateSandboxArgs('sandbox_web_fetch', { url: 'https://example.com' }).ok, true);
assert.equal(validateSandboxArgs('sandbox_web_fetch', { url: 'https://192.168.1.1/' }).ok, false);
assert.equal(validateSandboxArgs('sandbox_web_fetch', {}).ok, false);
// the read cap never exceeds what sandbox_import_from_tool keeps, so a saved file is never silently cut
import { MAX_IMPORT_CHARS } from '../sandbox-tools.js';
assert.ok(MAX_BYTES <= MAX_IMPORT_CHARS, 'web read cap must not exceed the import limit');
// a page that declares its encoding inside the HTML (no charset in the header) is decoded correctly
const latin = new Uint8Array([...Buffer.from('<meta charset="windows-1252"><p>caf'), 0xe9, ...Buffer.from('</p>')]);
r = await fetchPublicText('https://example.com/old', fake({ 'https://example.com/old': () => mk(200, latin, { 'content-type': 'text/html' }) }));
assert.ok(r.ok && r.text.includes('café'), 'meta charset is honoured');
// an unknown charset label falls back to UTF-8 instead of failing
r = await fetchPublicText('https://example.com/x', fake({ 'https://example.com/x': () => mk(200, 'ok', { 'content-type': 'text/plain; charset=nonsense-9' }) }));
assert.ok(r.ok && r.text === 'ok');
// a redirect to a blocked address is refused
r = await fetchPublicText('https://example.com/r', fake({ 'https://example.com/r': () => mk(302, '', { location: 'https://127.0.0.1/admin' }) }));
assert.equal(r.ok, false);
console.log('web-fetch tests ok');
