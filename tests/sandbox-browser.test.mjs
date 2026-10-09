import { test, eq, ok, summary, load } from './harness.mjs';
const ent = await load('entitlements.js');
const tools = await load('sandbox-tools.js');
const prov = await load('sandbox-provider.js');
const br = await load('browser-rendering.js');

console.log('\nPlan gating for the cloud browser');
await test('only studio and admin may use it', async () => {
  eq(ent.planHasRemoteBrowser('free'), false); eq(ent.planHasRemoteBrowser('plus'), false);
  eq(ent.planHasRemoteBrowser('studio'), true); eq(ent.planHasRemoteBrowser('admin'), true);
  eq(ent.planHasRemoteBrowser('nonsense'), false);
});
await test('every plan has a numeric allowance', async () => {
  for (const id of ['free', 'plus', 'studio', 'admin']) ok(Number.isFinite(ent.getPlan(id).limits.browserRemotePerDay), id);
});

console.log('\nTool offering');
const names = (caps) => tools.toolsForCapabilities(caps).map((t) => t.function.name);
await test('browser provider offers the local test, never the cloud tool', async () => {
  const n = names(prov.PROVIDERS.browser.capabilities);
  ok(n.includes('sandbox_browser_test')); ok(!n.includes('sandbox_browser_fetch'));
});
await test('cloud tool appears only when its capability is added', async () => {
  const caps = new Set(prov.PROVIDERS.browser.capabilities); caps.add(prov.CAPS.BROWSER_REMOTE);
  ok(names(caps).includes('sandbox_browser_fetch'));
});
await test('remote linux provider does not offer the local test', async () => {
  ok(!names(prov.PROVIDERS.remote.capabilities).includes('sandbox_browser_test'));
});

console.log('\nArgument checks');
const v = (n, a) => tools.validateSandboxArgs(n, a);
await test('test needs exactly one of path/html', async () => {
  ok(!v('sandbox_browser_test', {}).ok); ok(!v('sandbox_browser_test', { path: '/workspace/a.html', html: '<p>x' }).ok);
  ok(v('sandbox_browser_test', { path: '/workspace/a.html' }).ok); ok(v('sandbox_browser_test', { html: '<p>x</p>' }).ok);
});
await test('test rejects path escape and bad types', async () => {
  ok(!v('sandbox_browser_test', { path: '../../etc/passwd' }).ok);
  ok(!v('sandbox_browser_test', { html: '<p>', width: 'wide' }).ok);
  ok(!v('sandbox_browser_test', { html: '<p>', selectors: 'h1' }).ok);
  ok(!v('sandbox_browser_test', { html: 'x'.repeat(10_000_000) }).ok);
});
await test('cloud tool blocks private and odd addresses', async () => {
  for (const u of ['http://example.com', 'https://localhost/x', 'https://127.0.0.1/', 'https://10.0.0.5/', 'https://[::1]/', 'https://user:pw@example.com/', 'https://example.com:8443/', 'https://intranet.local/', 'https://2130706433/', 'https://nodot/', 'ftp://example.com', 'not a url', ''])
    ok(!v('sandbox_browser_fetch', { url: u }).ok, u);
  ok(v('sandbox_browser_fetch', { url: 'https://example.com/page' }).ok);
});
await test('cloud tool mode and selector rules', async () => {
  ok(!v('sandbox_browser_fetch', { url: 'https://example.com', mode: 'screenshot' }).ok);
  ok(!v('sandbox_browser_fetch', { url: 'https://example.com', mode: 'elements' }).ok);
  ok(v('sandbox_browser_fetch', { url: 'https://example.com', mode: 'elements', selectors: ['h1'] }).ok);
  ok(!v('sandbox_browser_fetch', { url: 'https://example.com', html: '<p>' }).ok);
});

console.log('\nCloud browser module (fetch is faked)');
const env = { CF_BROWSER_ACCOUNT_ID: 'abcdef1234567890', CF_BROWSER_API_TOKEN: 'tok' };
const realFetch = globalThis.fetch;
const fake = (status, body, headers) => { globalThis.fetch = async (url, init) => { fake.last = { url, init }; return new Response(JSON.stringify(body), { status, headers }); }; };
await test('not configured does not call Cloudflare', async () => {
  let called = false; globalThis.fetch = async () => { called = true; return new Response('{}'); };
  const r = await br.renderRemote({ url: 'https://example.com' }, {}); ok(!r.ok); ok(!called);
});
await test('success sends the bearer token and returns text', async () => {
  fake(200, { success: true, result: '# Hello' });
  const r = await br.renderRemote({ url: 'https://example.com' }, env);
  ok(r.ok); eq(r.stdout, '# Hello');
  ok(fake.last.url.endsWith('/browser-rendering/markdown')); eq(fake.last.init.headers.Authorization, 'Bearer tok');
});
await test('elements mode returns measurements', async () => {
  fake(200, { success: true, result: [{ selector: 'h1', results: [{ text: 'Hi', top: 1, left: 2, width: 3, height: 4, html: '<h1>Hi</h1>' }] }] });
  const r = await br.renderRemote({ html: '<h1>Hi</h1>', mode: 'elements', selectors: ['h1'] }, env);
  ok(r.ok); ok(r.stdout.includes('"width":3')); ok(!r.stdout.includes('<h1>'), 'raw html leaked into elements output');
});
await test('429 gives a friendly busy message', async () => {
  fake(429, { success: false }, { 'retry-after': '30' });
  const r = await br.renderRemote({ url: 'https://example.com' }, env); ok(!r.ok); eq(r.exitCode, 429); ok(r.stderr.includes('30'));
});
await test('401 never leaks the token or Cloudflare text', async () => {
  fake(401, { success: false, errors: [{ message: 'Invalid token tok' }] });
  const r = await br.renderRemote({ url: 'https://example.com' }, env); ok(!r.ok); ok(!JSON.stringify(r).includes('tok'));
});
await test('network failure and bad JSON are handled', async () => {
  globalThis.fetch = async () => { throw new Error('boom'); };
  ok(!(await br.renderRemote({ url: 'https://example.com' }, env)).ok);
  globalThis.fetch = async () => new Response('<html>', { status: 200 });
  ok(!(await br.renderRemote({ url: 'https://example.com' }, env)).ok);
});
await test('huge output is capped; oversize html and bad account id refused', async () => {
  fake(200, { success: true, result: 'x'.repeat(100000) });
  const r = await br.renderRemote({ url: 'https://example.com' }, env); ok(r.stdout.length < 13000);
  ok(!(await br.renderRemote({ html: 'x'.repeat(300000) }, env)).ok);
  ok(!(await br.renderRemote({ url: 'https://example.com' }, { ...env, CF_BROWSER_ACCOUNT_ID: '../x' })).ok);
});
globalThis.fetch = realFetch;

console.log('\nFallback field handling');
await test('fallback is kept by normalizeResult but hidden from the model', async () => {
  const n = tools.normalizeResult({ exitCode: 1, stderr: 'x', fallback: { html: '<p>x</p>', selectors: ['p', 5], reason: 'r' } });
  eq(n.fallback.html, '<p>x</p>'); eq(n.fallback.selectors.length, 1);
  ok(!tools.resultForModel(n).includes('<p>x</p>'));
  ok(!tools.normalizeResult({ exitCode: 0, fallback: 'nope' }).fallback);
});
summary();
