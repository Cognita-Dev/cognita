// Self-hosted server: serves the browser studio and the render/export API.
//   npm start  →  http://localhost:3333
import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { DESIGNS } from './src/designs.js';
import { renderHtml, kindOf } from './src/render-html.js';
import { exportAs, FORMATS } from './src/export.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/designs', (_req, res) => {
  res.json(Object.entries(DESIGNS).map(([id, d]) => ({ id, name: d.name, mood: d.mood, colors: d.c, fonts: d.fonts })));
});

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
    const { html, kind, design } = renderHtml(req.body.spec || {}, { preview: true });
    res.json({ html, kind, design: design.id, name: design.name });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// Export: { spec, format, slide? }
app.post('/api/export', async (req, res) => {
  try {
    const { spec = {}, format = 'pdf', slide } = req.body;
    if (!FORMATS[format]) return res.status(400).json({ error: 'Unknown format' });
    const buf = await exportAs(spec, format, { slide: Number(slide) || 0 });
    const base = String(spec.title || spec.headline || kindOf(spec)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'document';
    res.setHeader('Content-Type', FORMATS[format].mime);
    res.setHeader('Content-Disposition', `attachment; filename="${base}.${FORMATS[format].ext}"`);
    res.send(buf);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e.message || e) });
  }
});

const port = process.env.PORT || 3333;
app.listen(port, () => console.log(`doc-studio running → http://localhost:${port}`));
