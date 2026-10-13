// tests/studio-server.mjs
// Static server for the browser tests. It serves the repo root and applies the header rules from vercel.json
// (including cleanUrls and the per-path Content-Security-Policy), so tests run under the same policy as production.
// Usage: node tests/studio-server.mjs [port]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const rules = (cfg.headers || []).map((h) => ({ re: new RegExp('^' + h.source + '$'), headers: h.headers }));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm' };

export function start(port = 8765) {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.includes('..')) { res.writeHead(400); res.end(); return; }
    let file = path.join(ROOT, p);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { if (fs.existsSync(file + '.html')) file += '.html'; else if (fs.existsSync(path.join(file, 'index.html'))) file = path.join(file, 'index.html'); }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return; }
    const h = { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' };
    // a probe page under tests/fixtures gets exactly the headers of the production ML frame, so its policy can be tested with real scripts
    const hp = p.startsWith('/tests/fixtures/csp-probe') ? '/studio-ml-frame' : p;
    for (const r of rules) if (r.re.test(hp)) for (const x of r.headers) h[x.key.toLowerCase()] = x.value;
    const st = fs.statSync(file); h['content-length'] = st.size;
    res.writeHead(200, h);
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
if (import.meta.url === 'file://' + process.argv[1]) { const port = Number(process.argv[2]) || 8765; start(port).then(() => console.log('serving', ROOT, 'on', port)); }
