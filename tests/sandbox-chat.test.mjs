import { test, eq, ok, summary, callWorker } from './harness.mjs';
const UID = 'uid_bob_1', EMAIL = 'bob@example.com';
const b64 = (n) => Buffer.alloc(n, 65).toString('base64');

console.log('\nPOST /api/files/:id (save a sandbox file)');
await test('needs sign-in', async (w) => {
  const r = await callWorker(w, 'POST', '/api/files/conv1', { body: { filename: 'a.csv', content: b64(10) } });
  eq(r.status, 401);
});
await test('rejects a type that is not allowed', async (w) => {
  w.addUser(UID, EMAIL);
  const r = await callWorker(w, 'POST', '/api/files/conv1', { uid: UID, email: EMAIL, body: { filename: 'virus.exe', content: b64(10) } });
  eq(r.status, 400);
});
await test('rejects a path-style name', async (w) => {
  w.addUser(UID, EMAIL);
  const r = await callWorker(w, 'POST', '/api/files/conv1', { uid: UID, email: EMAIL, body: { filename: '../../x', content: b64(10) } });
  eq(r.status, 400);
});
await test('rejects a file over the free limit (2 MB)', async (w) => {
  w.addUser(UID, EMAIL);
  const r = await callWorker(w, 'POST', '/api/files/conv1', { uid: UID, email: EMAIL, body: { filename: 'big.csv', content: b64(3 * 1024 * 1024) } });
  eq(r.status, 413);
});
await test('rejects bad content and empty content', async (w) => {
  w.addUser(UID, EMAIL);
  let r = await callWorker(w, 'POST', '/api/files/conv1', { uid: UID, email: EMAIL, body: { filename: 'a.csv', content: '***' } });
  eq(r.status, 400);
  r = await callWorker(w, 'POST', '/api/files/conv1', { uid: UID, email: EMAIL, body: { filename: 'a.csv', content: '' } });
  eq(r.status, 400);
});
await test('rejects an invalid conversation id', async (w) => {
  w.addUser(UID, EMAIL);
  const r = await callWorker(w, 'POST', '/api/files/bad%20id!', { uid: UID, email: EMAIL, body: { filename: 'a.csv', content: b64(10) } });
  eq(r.status, 400);
});
await test('usage reports code runs and limits', async (w) => {
  w.addUser(UID, EMAIL);
  const r = await callWorker(w, 'GET', '/api/usage', { uid: UID, email: EMAIL });
  eq(r.status, 200);
  ok(r.json.limits && r.json.limits.artifactMaxMB === 2, 'limits missing: ' + r.text.slice(0, 200));
  ok('sandboxRuns' in (r.json.usage || r.json), 'sandboxRuns missing');
});
process.exit(summary() ? 1 : 0);
