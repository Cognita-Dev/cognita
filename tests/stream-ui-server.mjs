// Local server for browser-testing the live chat stream (typewriter, text_reset, Generative UI).
// Serves the repo as static files and answers /api/chat with a CONTROLLED, MOCKED SSE stream
// that a test sets through POST /__script. Nothing here talks to a real AI provider.
//   PORT=8801 node tests/stream-ui-server.mjs &   then   python3 tests/stream-ui.e2e.py
//
// A script is a list of steps: { wait: ms } | { event: 'text', data: {...} } | { raw: '...' }.
// The `done` payload is whatever the script sends, exactly like the real Worker.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };
let script = [];
let hits = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/__script' && req.method === 'POST') {
    const chunks = []; for await (const c of req) chunks.push(c);
    script = JSON.parse(Buffer.concat(chunks).toString() || '[]');
    res.end('ok'); return;
  }
  if (url.pathname === '/__hits') { res.end(String(hits)); return; }
  if (url.pathname === '/api/usage' || url.pathname === '/api/account') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ planId: 'free', used: 0, limit: 20, remainingToday: 20, usage: { messages: { used: 0, limit: 20, remaining: 20 } }, limits: { messagesPerDay: 20 } })); return;
  }
  if (url.pathname === '/api/chat') {
    for await (const _ of req) { /* drain the request body */ }
    hits++;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const step of script) {
      if (res.destroyed) return;
      if (step.wait) { await sleep(step.wait); continue; }
      if (step.raw != null) { res.write(step.raw); continue; }
      res.write('event: ' + step.event + '\ndata: ' + JSON.stringify(step.data || {}) + '\n\n');
    }
    res.end(); return;
  }
  if (url.pathname.startsWith('/api/')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); return; }
  let p = path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!fs.existsSync(p) && fs.existsSync(p + '.html')) p += '.html';
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' });
  res.end(fs.readFileSync(p));
}).listen(+process.env.PORT || 8801, () => console.log('ready'));
