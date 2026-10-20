// Cleans a content spec before it is rendered. doc-studio is called by Cognita's Worker with JSON the
// AI model wrote, so nothing in the spec may be able to reach the network, inject CSS or markup, or
// make the renderer do unbounded work. The renderers escape all text; this closes the other doors:
//   - `css` (raw stylesheet) is dropped
//   - colours must be plain hex / rgb() values
//   - fonts must be one of the bundled families
//   - pictures must be small inline data: images (png, jpeg, webp, gif). No URLs, ever.
//   - sizes and counts are capped
import { FONT_FAMILIES } from './fonts.js';

export const LIMITS = {
  text: 20000,       // characters in one string
  blocks: 600,
  slides: 60,
  sheets: 8,
  rows: 2000,
  columns: 40,
  items: 60,
  image: 6 * 1024 * 1024, // characters in one data: URI
};

const POSTER_SIZE_IDS = ['a4', 'a3', 'square', 'portrait', 'story', 'landscape']; // keep in step with POSTER_SIZES in render-html.js
const COLOR_KEYS = new Set(['bg', 'ink', 'muted', 'accent', 'accent2', 'accent3', 'card', 'on']);
const FONT_KEYS = new Set(['head', 'body', 'mono']);
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = /^rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(?:,\s*(?:0|1|0?\.\d+)\s*)?\)$/i;
const DATA_IMAGE = /^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;

export function cleanColor(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return HEX.test(s) || RGB.test(s) ? s : null;
}

export function cleanImage(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return s.length <= LIMITS.image && DATA_IMAGE.test(s) ? s : null;
}

const str = (v, max = LIMITS.text) => (typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const arr = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);

function cleanBlock(b) {
  if (!b || typeof b !== 'object') return null;
  const t = str(b.type, 20);
  switch (t) {
    case 'h2': case 'h3': case 'p':
      return { type: t, text: str(b.text) };
    case 'list':
      return { type: 'list', ordered: !!b.ordered, items: arr(b.items, LIMITS.items).map((x) => str(x, 2000)) };
    case 'quote':
      return { type: 'quote', text: str(b.text, 2000), by: str(b.by, 200) };
    case 'stats':
      return { type: 'stats', items: arr(b.items, 6).map((i) => ({ value: str(i && i.value, 40), label: str(i && i.label, 120) })) };
    case 'callout':
      return { type: 'callout', title: str(b.title, 200), text: str(b.text, 3000) };
    case 'table':
      return {
        type: 'table',
        head: arr(b.head, LIMITS.columns).map((x) => str(x, 200)),
        rows: arr(b.rows, LIMITS.rows).map((r) => arr(r, LIMITS.columns).map((x) => str(x, 1000))),
      };
    case 'columns':
      return { type: 'columns', paragraphs: arr(b.paragraphs, 20).map((x) => str(x, 4000)) };
    case 'image': {
      const src = cleanImage(b.src);
      return src ? { type: 'image', src, alt: str(b.alt, 300), caption: str(b.caption, 500) } : null;
    }
    case 'divider':
      return { type: 'divider' };
    default:
      return null;
  }
}

function cleanSlide(s) {
  const o = s && typeof s === 'object' ? s : {};
  return {
    layout: ['title', 'section', 'bullets', 'stat', 'quote', 'split', 'closing'].includes(o.layout) ? o.layout : undefined,
    kicker: str(o.kicker, 200), title: str(o.title, 400), subtitle: str(o.subtitle, 800), meta: str(o.meta, 300),
    text: str(o.text, 1500), by: str(o.by, 200), value: str(o.value, 40), label: str(o.label, 200), notes: str(o.notes, 4000),
    bullets: arr(o.bullets, 12).map((x) => str(x, 600)),
    items: arr(o.items, 8).map((it) => (typeof it === 'string' ? str(it, 400) : { title: str(it && it.title, 300), text: str(it && it.text, 600) })),
  };
}

function cleanSheet(sh) {
  const o = sh && typeof sh === 'object' ? sh : {};
  return {
    name: str(o.name, 31) || 'Sheet',
    columns: arr(o.columns, LIMITS.columns).map((c) => (typeof c === 'string'
      ? str(c, 200)
      : { header: str(c && c.header, 200), format: str(c && c.format, 60), width: Number.isFinite(c && c.width) ? Math.max(6, Math.min(80, c.width)) : undefined })),
    rows: arr(o.rows, LIMITS.rows).map((r) => arr(r, LIMITS.columns).map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : str(v, 2000)))),
  };
}

export function sanitizeSpec(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('spec must be an object');
  const s = input;
  const out = {};
  for (const k of ['kind', 'design', 'kicker', 'title', 'subtitle', 'author', 'date', 'org', 'seed', 'headline', 'subheadline', 'cta', 'footer', 'markdown']) {
    if (s[k] != null) out[k] = str(s[k]);
  }
  if (out.kind && !['document', 'slides', 'poster', 'sheet'].includes(out.kind)) delete out.kind;
  if (s.lang && /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})?$/.test(s.lang)) out.lang = s.lang;
  if (s.size && POSTER_SIZE_IDS.includes(String(s.size).toLowerCase())) out.size = String(s.size).toLowerCase();
  if (['stack', 'swiss', 'center', 'blocks'].includes(s.layout)) out.layout = s.layout;

  if (s.colors && typeof s.colors === 'object') {
    out.colors = {};
    for (const [k, v] of Object.entries(s.colors)) {
      const c = COLOR_KEYS.has(k) ? cleanColor(v) : null;
      if (c) out.colors[k] = c;
    }
  }
  if (s.fonts && typeof s.fonts === 'object') {
    out.fonts = {};
    for (const [k, v] of Object.entries(s.fonts)) {
      if (FONT_KEYS.has(k) && FONT_FAMILIES.includes(v)) out.fonts[k] = v;
    }
  }
  const image = cleanImage(s.image);
  if (image) out.image = image;
  const logo = cleanImage(s.logo);
  if (logo) out.logo = logo;

  out.details = arr(s.details, 8).map((x) => str(x, 300));
  if (s.blocks != null) out.blocks = arr(s.blocks, LIMITS.blocks).map(cleanBlock).filter(Boolean);
  if (s.slides != null) out.slides = arr(s.slides, LIMITS.slides).map(cleanSlide);
  if (s.sheets != null) out.sheets = arr(s.sheets, LIMITS.sheets).map(cleanSheet);
  // `css` is intentionally never copied.
  return out;
}
