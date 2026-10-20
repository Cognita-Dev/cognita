// Self-hosted server: serves the browser studio and the render/export API.
//   npm start  →  http://localhost:3333
//
// Production (called by Cognita's Worker):
//   DOCSTUDIO_TOKEN   shared secret. When set, /api/render and /api/export need "Authorization: Bearer <token>".
//   DOCSTUDIO_UI=off  do not serve the browser studio (recommended on a public host).
//   MAX_CONCURRENT    how many renders may run at once (default 2; Chromium is heavy).
//   RENDER_TIMEOUT_MS give up on one render after this long (default 45000).
//   PORT              default 3333.
import express from 'express';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { DESIGNS } from './src/designs.js';
import { renderHtml, kindOf, normalizeSpec } from './src/render-html.js';
import { exportAs, renderBundle, fileStem, FORMATS } from './src/export.js';
import { sanitizeSpec } from './src/sanitize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = process.env.DOCSTUDIO_TOKEN || '';
const UI = String(process.env.DOCSTUDIO_UI || 'on').toLowerCase() !== 'off';
const MAX_CONCURRENT = Math.max(1, Number(process.env.MAX_CONCURRENT) || 2);
const RENDER_TIMEOUT_MS = Math.max(5000, Number(process.env.RENDER_TIMEOUT_MS) || 45000);

export const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '25mb' }));
if (UI) app.use(express.static(path.join(__dirname, 'public')));

// ── auth ────────────────────────────────────────────────────────────────
function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}
function requireToken(req, res, next) {
  if (!TOKEN) return next(); // local use: no token configured
  const m = /^Bearer\s+(.+)$/i.exec(req.get('authorization') || '');
  if (m && safeEqual(m[1], TOKEN)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

// ── a small queue so a burst cannot start dozens of Chromium pages ─────────
let running = 0;
const waiting = [];
function acquire() {
  if (running < MAX_CONCURRENT) { running++; return Promise.resolve(); }
  return new Promise((resolve) => waiting.push(resolve));
}
function release() {
  const next = waiting.shift();
  if (next) next(); else running--;
}
async function limited(fn) {
  await acquire();
  try {
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Rendering took too long')), RENDER_TIMEOUT_MS); });
    try { return await Promise.race([fn(), timeout]); } finally { clearTimeout(timer); }
  } finally { release(); }
}

// ── public, read-only ───────────────────────────────────────────────────
app.get('/api/health', (_req, res) => res.json({ ok: true, name: 'doc-studio', designs: Object.keys(DESIGNS).length, busy: running, queued: waiting.length }));

app.get('/api/designs', (_req, res) => {
  res.json(Object.entries(DESIGNS).map(([id, d]) => ({ id, name: d.name, mood: d.mood, tags: d.tags, colors: d.c, fonts: d.fonts })));
});

if (UI) {
  app.get('/api/prompt', (_req, res) => {
    res.type('text/plain').send(fs.readFileSync(path.join(__dirname, 'AI-PROMPT.md'), 'utf8'));
  });

  app.get('/api/examples', (_req, res) => {
    const dir = path.join(__dirname, 'examples');
    res.json(Object.fromEntries(fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => [f.replace('.json', ''), JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))])));
  });

  // Live preview (self-contained HTML for an <iframe srcdoc>)
  app.post('/api/preview', (req, res) => {
    try {
      const { html, kind, design } = renderHtml(sanitizeSpec(req.body.spec || {}), { preview: true });
      res.json({ html, kind, design: design.id, name: design.name });
    } catch (e) {
      res.status(400).json({ error: String(e.message || e) });
    }
  });
}

// ── rendering (token protected) ─────────────────────────────────────────
// Export one format: { spec, format, slide? }  →  the file
app.post('/api/export', requireToken, async (req, res) => {
  try {
    const { spec: raw = {}, format = 'pdf', slide } = req.body;
    if (!FORMATS[format]) return res.status(400).json({ error: 'Unknown format' });
    const spec = normalizeSpec(sanitizeSpec(raw));
    const buf = await limited(() => exportAs(spec, format, { slide: Number(slide) || 0 }));
    res.setHeader('Content-Type', FORMATS[format].mime);
    res.setHeader('Content-Disposition', `attachment; filename="${fileStem(spec, kindOf(spec))}.${FORMATS[format].ext}"`);
    res.send(buf);
  } catch (e) {
    console.error('[export]', e && e.message);
    res.status(500).json({ error: String((e && e.message) || e) });
  }
});

// Cognita's entry point: { spec, formats? }  →  { kind, design, preview, files:[{format,name,mime,size,content(base64)}] }
app.post('/api/render', requireToken, async (req, res) => {
  const t0 = Date.now();
  try {
    const { spec: raw, formats } = req.body || {};
    const spec = sanitizeSpec(raw);
    const out = await limited(() => renderBundle(spec, formats));
    console.log(`[render] kind=${out.kind} design=${out.design.id} files=${out.files.map((f) => f.format).join(',')} ms=${Date.now() - t0}`);
    res.json(out);
  } catch (e) {
    const bad = /spec must be/.test(String(e && e.message));
    console.error('[render]', e && e.message);
    res.status(bad ? 400 : 500).json({ error: String((e && e.message) || e) });
  }
});

const port = process.env.PORT || 3333;
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  app.listen(port, () => console.log(`doc-studio running → http://localhost:${port}${TOKEN ? ' (token required for export)' : ''}`));
}

// Bad JSON / oversized bodies get a JSON answer, not an HTML error page.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err && (err.status || err.statusCode) >= 400 && (err.status || err.statusCode) < 600 ? (err.status || err.statusCode) : 400;
  res.status(status).json({ error: status === 413 ? 'Request too large' : 'Bad request' });
});
