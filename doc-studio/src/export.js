// Exports: PDF / PNG / HTML via headless Chromium (pixel-perfect, real fonts),
// plus native editable DOCX, PPTX and XLSX styled with the chosen design.
import { chromium } from 'playwright';
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType,
  ShadingType, BorderStyle, AlignmentType, LevelFormat,
} from 'docx';
import PptxGenJS from 'pptxgenjs';
import ExcelJS from 'exceljs';
import { renderHtml, POSTER_SIZES, kindOf, normalizeSpec } from './render-html.js';

let browser;
async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || undefined,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    });
  }
  return browser;
}
export async function closeBrowser() { if (browser) await browser.close(); browser = null; }

async function withPage(html, viewport, fn, scale = 1) {
  const b = await getBrowser();
  const ctx = await b.newContext({ viewport, deviceScaleFactor: scale, javaScriptEnabled: true });
  // Rendered pages may only use what is inside the HTML itself (fonts and pictures are inlined as data:).
  // Anything else is refused, so a spec can never make this server fetch a URL.
  await ctx.route('**/*', (route) => (/^(?:data|blob|about):/i.test(route.request().url()) ? route.continue() : route.abort()));
  const page = await ctx.newPage();
  try {
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    return await fn(page);
  } finally {
    await ctx.close();
  }
}

const hex = (c) => String(c).replace('#', '').slice(0, 6).toUpperCase();
// colours like rgba(...) (Aurora card) are not valid in Office files → fall back to a solid.
const solid = (c, fallback) => (/^#[0-9a-f]{6}$/i.test(c) ? hex(c) : hex(fallback));

// ───────────────────────── PDF / PNG ─────────────────────────
async function toPdf(spec) {
  const { html, kind } = renderHtml(spec);
  const size = kind === 'slides' ? { w: 1920, h: 1080 } : kind === 'poster' ? (() => { const [w, h] = POSTER_SIZES[String(spec.size || 'portrait').toLowerCase()] || POSTER_SIZES.portrait; return { w, h }; })() : null;
  return withPage(html, { width: size?.w || 794, height: size?.h || 1123 }, (p) =>
    p.pdf({ printBackground: true, preferCSSPageSize: true }));
}

async function toPng(spec, slideIndex = 0) {
  const { html, kind } = renderHtml(spec);
  if (kind === 'slides') return withPage(html, { width: 1920, height: 1080 }, async (p) => (await p.locator('.slide').nth(slideIndex)).screenshot(), 1);
  if (kind === 'poster') {
    const [w, h] = POSTER_SIZES[String(spec.size || 'portrait').toLowerCase()] || POSTER_SIZES.portrait;
    return withPage(html, { width: w, height: h }, (p) => p.locator('.poster').screenshot(), 2);
  }
  return withPage(html, { width: 794, height: 1123 }, (p) => p.screenshot({ fullPage: true }), 2);
}

async function slidePngs(spec) {
  const { html } = renderHtml(spec);
  return withPage(html, { width: 1920, height: 1080 }, async (p) => {
    const out = [];
    const n = await p.locator('.slide').count();
    for (let i = 0; i < n; i++) out.push(await p.locator('.slide').nth(i).screenshot());
    return out;
  });
}

// ───────────────────────── DOCX ─────────────────────────
function runs(text, base) {
  const out = [];
  String(text ?? '').split(/(\*\*.+?\*\*|\*.+?\*)/g).filter(Boolean).forEach((t) => {
    if (t.startsWith('**')) out.push(new TextRun({ ...base, text: t.slice(2, -2), bold: true }));
    else if (t.startsWith('*')) out.push(new TextRun({ ...base, text: t.slice(1, -1), italics: true }));
    else out.push(new TextRun({ ...base, text: t }));
  });
  return out;
}

async function toDocx(spec) {
  const { design: d } = renderHtml(spec);
  const ink = solid(d.c.ink, '#111111');
  const dark = /^#([0-7])/i.test(d.c.bg) && d.id !== 'brutal'; // dark designs: keep Word pages white, flip ink
  const text = dark ? '1A1A1A' : ink;
  const accent = solid(d.c.accent, '#B4562F');
  const muted = dark ? '666666' : solid(d.c.muted, '#666666');
  const card = dark ? 'F1F1F1' : solid(d.c.card, '#EEEEEE');
  const H = d.office.head;
  const B = d.office.body;
  const none = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
  const children = [];
  if (spec.kicker) children.push(new Paragraph({ spacing: { after: 80 }, children: [new TextRun({ text: spec.kicker.toUpperCase(), font: B, size: 17, bold: true, color: accent, characterSpacing: 40 })] }));
  children.push(new Paragraph({ spacing: { after: 120 }, children: runs(spec.title || 'Untitled', { font: H, size: 68, bold: true, color: text }) }));
  if (spec.subtitle) children.push(new Paragraph({ spacing: { after: 120 }, children: runs(spec.subtitle, { font: B, size: 28, color: muted }) }));
  const meta = [spec.author, spec.date, spec.org].filter(Boolean).join('  ·  ');
  if (meta) children.push(new Paragraph({ spacing: { after: 280 }, border: { bottom: { style: BorderStyle.SINGLE, size: 12, color: accent, space: 8 } }, children: [new TextRun({ text: meta, font: B, size: 18, color: muted })] }));

  for (const b of spec.blocks || []) {
    if (b.type === 'h2') children.push(new Paragraph({ spacing: { before: 360, after: 120 }, keepNext: true, children: runs(b.text, { font: H, size: 36, bold: true, color: text }) }));
    else if (b.type === 'h3') children.push(new Paragraph({ spacing: { before: 240, after: 80 }, keepNext: true, children: runs(b.text, { font: H, size: 26, bold: true, color: accent }) }));
    else if (b.type === 'p') children.push(new Paragraph({ spacing: { after: 140, line: 330 }, children: runs(b.text, { font: B, size: 21, color: text }) }));
    else if (b.type === 'list') (b.items || []).forEach((it) => children.push(new Paragraph({ spacing: { after: 70 }, numbering: { reference: b.ordered ? 'num' : 'bul', level: 0 }, children: runs(it, { font: B, size: 21, color: text }) })));
    else if (b.type === 'quote') {
      children.push(new Paragraph({ spacing: { before: 200, after: 60 }, indent: { left: 360 }, border: { left: { style: BorderStyle.SINGLE, size: 24, color: accent, space: 12 } }, children: runs(b.text, { font: H, size: 32, italics: true, color: text }) }));
      if (b.by) children.push(new Paragraph({ spacing: { after: 200 }, indent: { left: 360 }, children: [new TextRun({ text: '— ' + b.by, font: B, size: 18, color: muted })] }));
    } else if (b.type === 'callout') {
      children.push(new Paragraph({ spacing: { before: 160, after: 160 }, shading: { type: ShadingType.CLEAR, fill: card }, border: { left: { style: BorderStyle.SINGLE, size: 24, color: accent, space: 10 } }, indent: { left: 200, right: 200 }, children: [...(b.title ? [new TextRun({ text: b.title + '  ', font: B, size: 21, bold: true, color: accent })] : []), ...runs(b.text, { font: B, size: 21, color: text })] }));
    } else if (b.type === 'stats') {
      const items = b.items || [];
      children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, borders: { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none }, rows: [new TableRow({ children: items.map((i) => new TableCell({ borders: { top: { style: BorderStyle.SINGLE, size: 18, color: accent }, bottom: none, left: none, right: none }, margins: { top: 100, bottom: 100, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: String(i.value), font: H, size: 56, bold: true, color: accent })] }), new Paragraph({ children: [new TextRun({ text: i.label, font: B, size: 18, color: muted })] })] })) })] }));
      children.push(new Paragraph({ spacing: { after: 120 }, children: [] }));
    } else if (b.type === 'table') {
      const th = (c) => new TableCell({ shading: { type: ShadingType.CLEAR, fill: accent }, children: [new Paragraph({ children: [new TextRun({ text: String(c), font: B, size: 18, bold: true, color: 'FFFFFF' })] })] });
      const td = (c, i) => new TableCell({ shading: { type: ShadingType.CLEAR, fill: i % 2 ? card : 'FFFFFF' }, children: [new Paragraph({ children: runs(String(c), { font: B, size: 19, color: text }) })] });
      children.push(new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [new TableRow({ tableHeader: true, children: (b.head || []).map(th) }), ...(b.rows || []).map((r, i) => new TableRow({ children: r.map((c) => td(c, i)) }))] }));
      children.push(new Paragraph({ spacing: { after: 120 }, children: [] }));
    } else if (b.type === 'columns') (b.paragraphs || []).forEach((p) => children.push(new Paragraph({ spacing: { after: 140, line: 330 }, children: runs(p, { font: B, size: 21, color: text }) })));
    else if (b.type === 'divider') children.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: muted, space: 4 } }, children: [] }));
  }

  const doc = new Document({
    creator: spec.author || 'doc-studio', title: spec.title || '',
    numbering: { config: ['bul', 'num'].map((ref) => ({ reference: ref, levels: [{ level: 0, format: ref === 'bul' ? LevelFormat.BULLET : LevelFormat.DECIMAL, text: ref === 'bul' ? '•' : '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 270 } } } }] })) },
    sections: [{ properties: { page: { margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } }, children }],
  });
  return Packer.toBuffer(doc);
}

// ───────────────────────── PPTX (editable, native shapes) ─────────────────────────
async function toPptx(spec) {
  const { design: d } = renderHtml(spec);
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE'; // 13.33 x 7.5 in
  pptx.title = spec.title || 'Deck';
  const bg = solid(d.c.bg, '#FFFFFF');
  const ink = solid(d.c.ink, '#111111');
  const muted = solid(d.c.muted, '#777777');
  const accent = solid(d.c.accent, '#B4562F');
  const accent2 = solid(d.c.accent2, '#333333');
  const card = solid(d.c.card, '#EEEEEE');
  const on = solid(d.c.on, '#FFFFFF');
  const H = d.office.head;
  const B = d.office.body;
  const slides = spec.slides || [];
  const total = slides.length;
  slides.forEach((s, i) => {
    const lay = s.layout || (i === 0 ? 'title' : 'bullets');
    const sl = pptx.addSlide();
    sl.background = { color: lay === 'section' ? accent : bg };
    const fg = lay === 'section' ? on : ink;
    const sub = lay === 'section' ? on : muted;
    // vary decoration per slide so consecutive slides don't look cloned
    const k = i % 3;
    if (lay !== 'section') {
      const shape = d.id === 'bauhaus' ? [pptx.ShapeType.ellipse, pptx.ShapeType.rect, pptx.ShapeType.triangle][k] : d.id === 'swiss' || d.id === 'newsprint' || d.id === 'luxe' ? pptx.ShapeType.rect : pptx.ShapeType.ellipse;
      if (d.id === 'swiss') sl.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.33, h: 0.15, fill: { color: accent }, line: { color: accent } });
      else if (d.id === 'luxe') sl.addShape(pptx.ShapeType.rect, { x: 0.35, y: 0.35, w: 12.63, h: 6.8, fill: { type: 'none' }, line: { color: accent, width: 1 } });
      else if (d.id === 'newsprint') sl.addShape(pptx.ShapeType.rect, { x: 1, y: 0.42, w: 11.33, h: 0.04, fill: { color: ink }, line: { color: ink } });
      else sl.addShape(shape, { x: [10.3, -0.9, 9.4][k], y: [-0.9, 5.6, 6.0][k], w: 3.2, h: 3.2, fill: { color: [accent, accent2, accent][k], transparency: 82 }, line: { type: 'none' } });
    }
    if (lay === 'title' || lay === 'closing') {
      if (s.kicker) sl.addText(s.kicker.toUpperCase(), { x: 1, y: 1.7, w: 11, h: 0.4, fontFace: B, fontSize: 14, bold: true, color: accent, charSpacing: 4 });
      sl.addText(s.title, { x: 1, y: 2.2, w: 11.3, h: 2.6, fontFace: H, fontSize: 60, bold: true, color: fg, valign: 'top', fit: 'shrink' });
      if (s.subtitle) sl.addText(s.subtitle, { x: 1, y: 4.9, w: 10.5, h: 1.1, fontFace: B, fontSize: 24, color: sub, valign: 'top' });
      if (s.meta) sl.addText(s.meta, { x: 1, y: 6.3, w: 10, h: 0.4, fontFace: B, fontSize: 14, color: sub });
    } else if (lay === 'section') {
      sl.addText(s.kicker || String(i + 1).padStart(2, '0'), { x: 1, y: 2.2, w: 6, h: 0.5, fontFace: B, fontSize: 18, bold: true, color: fg });
      sl.addText(s.title, { x: 1, y: 2.8, w: 11, h: 1.8, fontFace: H, fontSize: 54, bold: true, color: fg, valign: 'top', fit: 'shrink' });
      if (s.subtitle) sl.addText(s.subtitle, { x: 1, y: 4.7, w: 10, h: 1, fontFace: B, fontSize: 22, color: fg });
    } else if (lay === 'stat') {
      sl.addText(String(s.value), { x: 1, y: 1.4, w: 11, h: 2.8, fontFace: H, fontSize: 130, bold: true, color: accent, fit: 'shrink' });
      sl.addText(s.title || s.label || '', { x: 1, y: 4.3, w: 11, h: 1, fontFace: H, fontSize: 36, bold: true, color: fg });
      if (s.text) sl.addText(s.text, { x: 1, y: 5.3, w: 10, h: 1, fontFace: B, fontSize: 20, color: sub, valign: 'top' });
    } else if (lay === 'quote') {
      sl.addText(s.text, { x: 1.1, y: 1.6, w: 11, h: 3.8, fontFace: H, fontSize: 38, italic: true, color: fg, valign: 'middle', fit: 'shrink' });
      if (s.by) sl.addText('— ' + s.by, { x: 1.1, y: 5.6, w: 10, h: 0.5, fontFace: B, fontSize: 16, color: accent, bold: true });
    } else if (lay === 'split') {
      sl.addText(s.title, { x: 0.8, y: 1.2, w: 5.4, h: 2.2, fontFace: H, fontSize: 38, bold: true, color: fg, valign: 'top', fit: 'shrink' });
      if (s.text) sl.addText(s.text, { x: 0.8, y: 3.5, w: 5.4, h: 2.5, fontFace: B, fontSize: 18, color: sub, valign: 'top' });
      (s.items || []).slice(0, 4).forEach((it, j) => {
        const y = 1.0 + j * 1.5;
        sl.addShape(pptx.ShapeType.rect, { x: 6.8, y, w: 5.8, h: 1.3, fill: { color: card }, line: { type: 'none' } });
        sl.addText([{ text: typeof it === 'string' ? it : it.title, options: { bold: true, fontFace: H, fontSize: 20, color: fg, breakLine: true } }, { text: it.text || '', options: { fontFace: B, fontSize: 14, color: sub } }], { x: 7.0, y: y + 0.1, w: 5.4, h: 1.1, valign: 'middle' });
      });
    } else {
      sl.addText(s.title, { x: 0.9, y: 0.7, w: 11.5, h: 1.2, fontFace: H, fontSize: 42, bold: true, color: fg, valign: 'top', fit: 'shrink' });
      if (s.text) sl.addText(s.text, { x: 0.9, y: 1.9, w: 11, h: 0.8, fontFace: B, fontSize: 20, color: sub, valign: 'top' });
      sl.addText((s.bullets || []).map((b) => ({ text: b, options: { bullet: { code: '25A0' }, breakLine: true, paraSpaceAfter: 12 } })), { x: 0.9, y: s.text ? 2.8 : 2.1, w: 11.2, h: 4, fontFace: B, fontSize: 26, color: fg, valign: 'top', fit: 'shrink' });
    }
    if (lay !== 'title' && lay !== 'closing') sl.addText(`${String(i + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}`, { x: 11, y: 6.95, w: 1.9, h: 0.3, align: 'right', fontFace: B, fontSize: 11, color: sub });
    if (s.notes) sl.addNotes(s.notes);
  });
  return pptx.write({ outputType: 'nodebuffer' });
}

// Pixel-perfect deck: each slide rendered by Chromium with real fonts, placed as a full-bleed image.
async function toPptxImage(spec) {
  const pngs = await slidePngs(spec);
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pngs.forEach((buf, i) => {
    const sl = pptx.addSlide();
    sl.addImage({ data: 'image/png;base64,' + buf.toString('base64'), x: 0, y: 0, w: 13.333, h: 7.5 });
    const n = (spec.slides || [])[i]?.notes;
    if (n) sl.addNotes(n);
  });
  return pptx.write({ outputType: 'nodebuffer' });
}

// ───────────────────────── XLSX ─────────────────────────
async function toXlsx(spec) {
  const { design: d } = renderHtml(spec);
  const wb = new ExcelJS.Workbook();
  wb.creator = spec.author || 'doc-studio';
  const accent = 'FF' + solid(d.c.accent, '#B4562F');
  const card = 'FF' + solid(d.c.card, '#EEEEEE');
  const ink = 'FF' + (/^#([0-7])/i.test(d.c.ink) ? solid(d.c.ink, '#111') : '111111');
  const on = 'FF' + solid(d.c.on, '#FFFFFF');
  const white = /^#([0-7])/i.test(d.c.bg) ? 'FFFFFFFF' : 'FF' + solid(d.c.bg, '#FFFFFF');
  for (const sh of spec.sheets || []) {
    const ws = wb.addWorksheet(String(sh.name || 'Sheet').slice(0, 31), { views: [{ state: 'frozen', ySplit: 1 }] });
    const cols = (sh.columns || []).map((c) => (typeof c === 'string' ? { header: c } : c));
    ws.columns = cols.map((c) => ({ header: c.header, key: c.header, width: c.width || Math.max(12, Math.min(48, String(c.header).length + 6)), style: c.format ? { numFmt: c.format } : {} }));
    const hr = ws.getRow(1);
    hr.height = 28;
    hr.eachCell((cell) => {
      cell.font = { name: d.office.head, bold: true, color: { argb: on }, size: 11 };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: accent } };
      cell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
    });
    (sh.rows || []).forEach((r, i) => {
      const row = ws.addRow(r.map((v) => (typeof v === 'string' && v.startsWith('=') ? { formula: v.slice(1) } : v)));
      row.height = 22;
      row.eachCell({ includeEmpty: true }, (cell) => {
        cell.font = { name: d.office.body, size: 11, color: { argb: ink } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: i % 2 ? card : white } };
        cell.alignment = { vertical: 'middle', indent: 1 };
        cell.border = { bottom: { style: 'thin', color: { argb: 'FFD9D9D9' } } };
      });
    });
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: Math.max(1, cols.length) } };
    ws.properties.tabColor = { argb: accent };
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ───────────────────────── preview + bundle ─────────────────────────
// A small JPEG of the first page / slide / poster, for showing in a chat message.
export async function renderPreview(spec, maxWidth = 1000) {
  const { html, kind } = renderHtml(spec);
  let w = 794;
  let h = 1123;
  if (kind === 'slides') { w = 1920; h = 1080; }
  else if (kind === 'poster') [w, h] = POSTER_SIZES[String(spec.size || 'portrait').toLowerCase()] || POSTER_SIZES.portrait;
  else if (kind === 'sheet') { w = 1123; h = 794; }
  const scale = Math.min(2, maxWidth / w);
  return withPage(html, { width: w, height: h }, async (p) => {
    if (kind === 'slides') return p.locator('.slide').first().screenshot({ type: 'jpeg', quality: 74 });
    if (kind === 'poster') return p.locator('.poster').screenshot({ type: 'jpeg', quality: 78 });
    return p.screenshot({ type: 'jpeg', quality: 74, clip: { x: 0, y: 0, width: w, height: h } });
  }, scale);
}

// Which files a kind of content is delivered as when the caller does not say.
export const DEFAULT_FORMATS = {
  document: ['pdf', 'docx'],
  slides: ['pptx', 'pdf'],
  poster: ['png', 'pdf'],
  sheet: ['xlsx'],
};
// Which formats make sense for which kind (a poster has no Word version, a sheet cannot be a slide deck).
export const KIND_FORMATS = {
  document: ['pdf', 'docx', 'png', 'html'],
  slides: ['pptx', 'pptx-image', 'pdf', 'png'],
  poster: ['png', 'pdf'],
  sheet: ['xlsx', 'pdf'],
};

export function fileStem(spec, kind) {
  return String(spec.title || spec.headline || kind).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || kind;
}

/** Renders one spec to several formats plus a preview picture. Returns { kind, design, preview, files }. */
export async function renderBundle(input, formats) {
  const spec = normalizeSpec(input);
  const kind = kindOf(spec);
  const allowed = KIND_FORMATS[kind] || ['pdf'];
  let wanted = (Array.isArray(formats) && formats.length ? formats : DEFAULT_FORMATS[kind] || ['pdf']).filter((f) => allowed.includes(f));
  if (!wanted.length) wanted = DEFAULT_FORMATS[kind] || ['pdf'];
  wanted = [...new Set(wanted)];
  const { design } = renderHtml(spec);
  const stem = fileStem(spec, kind);
  const files = [];
  for (const f of wanted) {
    const buf = await exportAs(spec, f);
    const meta = FORMATS[f];
    files.push({ format: f, name: `${stem}${f === 'pptx-image' ? '-image' : ''}.${meta.ext}`, mime: meta.mime.split(';')[0], size: buf.length, content: buf.toString('base64') });
  }
  const preview = await renderPreview(spec);
  return { kind, design: { id: design.id, name: design.name }, preview: { mime: 'image/jpeg', content: preview.toString('base64') }, files };
}

// ───────────────────────── dispatcher ─────────────────────────
export const FORMATS = {
  html: { mime: 'text/html; charset=utf-8', ext: 'html' },
  pdf: { mime: 'application/pdf', ext: 'pdf' },
  png: { mime: 'image/png', ext: 'png' },
  docx: { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' },
  pptx: { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: 'pptx' },
  'pptx-image': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', ext: 'pptx' },
  xlsx: { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' },
};

export async function exportAs(input, format, opts = {}) {
  const spec = normalizeSpec(input);
  switch (format) {
    case 'html': return Buffer.from(renderHtml(spec).html);
    case 'pdf': return Buffer.from(await toPdf(spec));
    case 'png': return Buffer.from(await toPng(spec, opts.slide || 0));
    case 'docx': return Buffer.from(await toDocx(spec));
    case 'pptx': return Buffer.from(await toPptx(spec));
    case 'pptx-image': return Buffer.from(await toPptxImage(spec));
    case 'xlsx': return await toXlsx(spec);
    default: throw new Error('Unknown format: ' + format);
  }
}
