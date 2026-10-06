// Local server for browser testing: serves the repo as static files and routes /api/* into the REAL
// worker.js. Only Firestore, the AI provider and Paystack are faked (same harness as the unit tests).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { makeWorld, idToken, ROOT } from './harness.mjs';
import { pathToFileURL } from 'node:url';

const world = makeWorld({ GROQ_API_KEY: 'x' });
const real = globalThis.fetch;
let aiDown = false, failNext = 0, delayMs = 0;
const inner = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(typeof input === 'string' ? input : input.url);
  if (u.host === 'firestore.googleapis.com' && u.pathname.endsWith(':runQuery')) {
    const q = JSON.parse(init.body).structuredQuery; const col = q.from[0].collectionId, field = q.where.fieldFilter.field.fieldPath, val = q.where.fieldFilter.value.stringValue;
    const rows = [...world.docs.entries()].filter(([k, f]) => k.startsWith(col + '/') && f[field] && f[field].stringValue === val).map(([k, f]) => ({ document: { name: 'projects/proj/databases/(default)/documents/' + k, fields: f } }));
    return new Response(JSON.stringify(rows.length ? rows : [{}]), { status: 200 });
  }
  if (u.host === 'api.groq.com' || u.host === 'openrouter.ai') {
    if (aiDown) return new Response('down', { status: 500 });
    const body = JSON.parse(init.body); const sys = body.messages[0].content;
    let text;
    if (sys.startsWith('You mark one short learner answer')) { const ids = [...body.messages[1].content.matchAll(/^- (\w+):/gm)].map((m) => m[1]); const ans = (body.messages[1].content.split('<answer>')[1] || '').split('</answer>')[0].trim(); const good = ans.length > 40; text = JSON.stringify({ met: Object.fromEntries(ids.map((i) => [i, good])), feedback: good ? 'Every point on the list is covered.' : 'Your answer is too short to cover the points. Add each part from the list.' }); }
    else text = 'We have not covered that yet. Let us finish this part first. For now, look again at the example above and try the step once more.';
    return new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: {} }), { status: 200 });
  }
  return inner(input, init);
};
const worker = (await import(pathToFileURL(path.join(ROOT, 'worker.js')).href)).default;
const users = { free: 'free', plus: 'plus', studio: 'studio', admin: 'admin', plus2: 'plus' };
for (const [uid, plan] of Object.entries(users)) {
  world.addUser(uid, uid + '@x.com', uid);
  world.setDoc('accounts/' + uid, { uid, planId: plan === 'admin' ? 'free' : plan, status: plan === 'free' ? 'none' : 'active', periodEnd: new Date(Date.now() + 25 * 86400000).toISOString(), createdAt: new Date().toISOString() });
}
world.setDoc('admins/admin', { role: 'admin' });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/__ctl/')) { // test controls
    if (url.pathname === '/__ctl/ai') aiDown = url.searchParams.get('down') === '1';
    if (url.pathname === '/__ctl/reset') { for (const k of [...world.docs.keys()]) if (k.startsWith('learna_')) world.docs.delete(k); for (const k of [...world.kv.keys()]) world.kv.delete(k); }
    if (url.pathname === '/__ctl/delay') delayMs = +url.searchParams.get('ms') || 0;
    res.end('ok'); return;
  }
  if (url.pathname.startsWith('/api/')) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const uid = url.searchParams.get('as') || req.headers['x-test-user'];
    const h = { ...req.headers }; delete h.host; delete h['content-length']; delete h['x-test-user'];
    if (uid) h.authorization = 'Bearer ' + idToken(uid, uid + '@x.com');
    url.searchParams.delete('as');
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const r = await worker.fetch(new Request('https://api.cognita.com.ng' + url.pathname + url.search, { method: req.method, headers: h, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }), world.env, { waitUntil() {} });
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' }); res.end(Buffer.from(await r.arrayBuffer())); return;
  }
  let p = path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!fs.existsSync(p) && fs.existsSync(p + '.html')) p += '.html';
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' }); res.end(fs.readFileSync(p));
}).listen(8799, () => console.log('ready'));
