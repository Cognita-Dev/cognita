// Turns a content spec (JSON) + a design system into one self-contained HTML file.
// HTML/CSS is the layout engine: that is what gives real typographic and layout freedom.
import { resolveDesign } from './designs.js';
import { fontCss } from './fonts.js';
import { cleanImage } from './sanitize.js';

export const POSTER_SIZES = {
  a4: [794, 1123], a3: [1123, 1587], square: [1080, 1080],
  portrait: [1080, 1350], story: [1080, 1920], landscape: [1920, 1080],
};

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>');
const list = (a) => (Array.isArray(a) ? a : []);

// ── tiny Markdown → blocks, so you can paste plain Markdown too ───────────
export function markdownToBlocks(md) {
  const blocks = [];
  let para = [];
  let items = null;
  const flush = () => {
    if (para.length) blocks.push({ type: 'p', text: para.join(' ') });
    para = [];
    if (items) blocks.push({ type: 'list', items, ordered: items.ordered }), (items = null);
  };
  let title = '';
  for (const raw of String(md).split('\n')) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flush(); continue; }
    if ((m = line.match(/^#\s+(.*)/)) && !title) { flush(); title = m[1]; continue; }
    if ((m = line.match(/^#{1,2}\s+(.*)/))) { flush(); blocks.push({ type: 'h2', text: m[1] }); continue; }
    if ((m = line.match(/^#{3,}\s+(.*)/))) { flush(); blocks.push({ type: 'h3', text: m[1] }); continue; }
    if ((m = line.match(/^>\s?(.*)/))) { flush(); blocks.push({ type: 'quote', text: m[1] }); continue; }
    if ((m = line.match(/^\s*([-*]|\d+\.)\s+(.*)/))) {
      if (!items) { flush(); items = []; items.ordered = /\d/.test(m[1]); }
      items.push(m[2]);
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return { title, blocks };
}

function block(b) {
  switch (b.type) {
    case 'h2': return `<h2>${inline(b.text)}</h2>`;
    case 'h3': return `<h3>${inline(b.text)}</h3>`;
    case 'p': return `<p>${inline(b.text)}</p>`;
    case 'list': {
      const t = b.ordered ? 'ol' : 'ul';
      return `<${t}>${list(b.items).map((i) => `<li>${inline(i)}</li>`).join('')}</${t}>`;
    }
    case 'quote': return `<blockquote class="quote"><p>${inline(b.text)}</p>${b.by ? `<cite>${esc(b.by)}</cite>` : ''}</blockquote>`;
    case 'stats': return `<div class="stats">${list(b.items).map((i) => `<div class="stat"><b>${esc(i.value)}</b><span>${esc(i.label)}</span></div>`).join('')}</div>`;
    case 'callout': return `<aside class="callout">${b.title ? `<strong>${inline(b.title)}</strong>` : ''}<p>${inline(b.text)}</p></aside>`;
    case 'table': return `<table><thead><tr>${list(b.head).map((h) => `<th>${inline(h)}</th>`).join('')}</tr></thead><tbody>${list(b.rows).map((r) => `<tr>${list(r).map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    case 'columns': return `<div class="twocol">${list(b.paragraphs).map((p) => `<p>${inline(p)}</p>`).join('')}</div>`;
    case 'image': return `<figure><img src="${esc(b.src)}" alt="${esc(b.alt || '')}">${b.caption ? `<figcaption>${inline(b.caption)}</figcaption>` : ''}</figure>`;
    case 'divider': return '<hr>';
    default: return '';
  }
}

function docHtml(spec) {
  const meta = [spec.author, spec.date, spec.org].filter(Boolean).map(esc).join(' &nbsp;·&nbsp; ');
  return `<article class="doc">
<header class="cover">${spec.kicker ? `<div class="kicker">${esc(spec.kicker)}</div>` : ''}<h1>${inline(spec.title || 'Untitled')}</h1>${spec.subtitle ? `<p class="sub">${inline(spec.subtitle)}</p>` : ''}${meta ? `<div class="meta">${meta}</div>` : ''}</header>
<main>${list(spec.blocks).map(block).join('\n')}</main></article>`;
}

function slidesHtml(spec) {
  const slides = list(spec.slides);
  const total = slides.length;
  return slides.map((s, i) => {
    const lay = s.layout || (i === 0 ? 'title' : 'bullets');
    const v = `v${i % 3}`;
    const num = lay === 'title' || lay === 'closing' ? '' : `<div class="num">${String(i + 1).padStart(2, '0')} / ${String(total).padStart(2, '0')}</div>`;
    let inner = '';
    if (lay === 'title' || lay === 'closing') {
      inner = `${s.kicker ? `<div class="kicker">${esc(s.kicker)}</div>` : ''}<h1>${inline(s.title)}</h1>${s.subtitle ? `<p class="lead">${inline(s.subtitle)}</p>` : ''}${s.meta ? `<div class="meta">${esc(s.meta)}</div>` : ''}`;
    } else if (lay === 'section') {
      inner = `<div class="kicker">${esc(s.kicker || String(i + 1).padStart(2, '0'))}</div><h2>${inline(s.title)}</h2>${s.subtitle ? `<p class="lead">${inline(s.subtitle)}</p>` : ''}`;
    } else if (lay === 'stat') {
      inner = `<div class="big">${esc(s.value)}</div><h2>${inline(s.title || s.label || '')}</h2>${s.text ? `<p class="lead">${inline(s.text)}</p>` : ''}`;
    } else if (lay === 'quote') {
      inner = `<blockquote>${inline(s.text)}</blockquote>${s.by ? `<cite>${esc(s.by)}</cite>` : ''}`;
    } else if (lay === 'split') {
      inner = `<div class="cols"><div><h2>${inline(s.title)}</h2>${s.text ? `<p class="lead">${inline(s.text)}</p>` : ''}</div><div class="cards">${list(s.items).map((it) => `<div class="card"><b>${inline(typeof it === 'string' ? it : it.title)}</b>${it.text ? `<span>${inline(it.text)}</span>` : ''}</div>`).join('')}</div></div>`;
    } else {
      inner = `<h2>${inline(s.title)}</h2>${s.text ? `<p class="lead">${inline(s.text)}</p>` : ''}<ul>${list(s.bullets).map((b) => `<li>${inline(b)}</li>`).join('')}</ul>`;
    }
    return `<section class="slide ${lay} ${v}"><i class="deco"></i><div class="inner">${inner}</div>${num}</section>`;
  }).join('\n');
}

function posterHtml(spec, d) {
  const comp = ['stack', 'swiss', 'center', 'blocks'].includes(spec.layout) ? spec.layout : d.poster;
  const details = list(spec.details).map((x) => {
    const m = String(x).match(/^([^:]{1,24}):\s*(.+)$/);
    return m ? `<li><span>${esc(m[1])}</span>${inline(m[2])}</li>` : `<li>${inline(x)}</li>`;
  }).join('');
  // Optional pictures. Only inline data: images are accepted (see sanitize.js); anything else is ignored,
  // so a poster can never make the renderer fetch a URL.
  const photo = cleanImage(spec.image);
  const logo = cleanImage(spec.logo);
  return `<div class="poster p-${comp}${photo ? ' has-photo' : ''}"><i class="deco"></i><i class="deco b"></i>
${photo ? `<div class="bgphoto" style="background-image:url('${photo}')"></div><i class="scrim"></i>` : ''}
${logo ? `<img class="plogo" src="${logo}" alt="">` : ''}
<div class="p-top"><span class="kicker">${esc(spec.kicker || '')}</span><span class="kicker">${esc(spec.date || '')}</span></div>
<h1>${inline(spec.headline || spec.title || 'Headline')}</h1>
${spec.subheadline ? `<p class="lead">${inline(spec.subheadline)}</p>` : ''}
<ul class="details">${details}</ul>
${spec.cta ? `<div class="cta">${inline(spec.cta)}</div>` : ''}
${spec.footer ? `<div class="foot">${inline(spec.footer)}</div>` : ''}</div>`;
}

function sheetHtml(spec) {
  return list(spec.sheets).map((sh) => `<section class="sheet"><h2>${esc(sh.name)}</h2><table><thead><tr>${list(sh.columns).map((c) => `<th>${esc(typeof c === 'string' ? c : c.header)}</th>`).join('')}</tr></thead><tbody>${list(sh.rows).map((r) => `<tr>${list(r).map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></section>`).join('');
}

const BASE_CSS = `
*{box-sizing:border-box}
html{background:var(--bg)}
body{margin:0;font-family:var(--body),system-ui,sans-serif;color:var(--ink);-webkit-print-color-adjust:exact;print-color-adjust:exact;text-rendering:optimizeLegibility}
h1,h2,h3{font-family:var(--head),serif;font-weight:var(--hw);margin:0}
.kicker{font:600 8.5pt var(--mono),monospace;letter-spacing:.16em;text-transform:uppercase;color:var(--accent)}
/* ---------- document ---------- */
.doc{max-width:174mm;margin:0 auto;font-size:10.5pt;line-height:1.62}
.doc .cover{margin-bottom:9mm;padding-bottom:6mm}
.doc .cover h1{font-size:40pt;line-height:1.02;margin:4mm 0 3mm}
.doc .sub{font-size:14pt;color:var(--muted);margin:0 0 4mm;line-height:1.35}
.doc .meta{font:500 8.5pt var(--mono),monospace;letter-spacing:.08em;color:var(--muted);text-transform:uppercase}
.doc h2{font-size:20pt;line-height:1.15;margin:10mm 0 3.5mm;break-after:avoid}
.doc h3{font-size:13pt;margin:6mm 0 2mm;break-after:avoid}
.doc p{margin:0 0 3.5mm;orphans:3;widows:3}
.doc ul,.doc ol{margin:0 0 4mm;padding-left:6mm}.doc li{margin-bottom:1.6mm}
.doc li::marker{color:var(--accent)}
.doc .quote{margin:7mm 0;padding:0 0 0 7mm;border-left:1.4mm solid var(--accent);break-inside:avoid}
.doc .quote p{font:italic var(--hw) 17pt/1.35 var(--head),serif;margin:0 0 2mm}
.doc cite{font:500 8.5pt var(--mono),monospace;color:var(--muted);font-style:normal;letter-spacing:.06em}
.doc .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(38mm,1fr));gap:5mm;margin:6mm 0;break-inside:avoid}
.doc .stat{border-top:1.2mm solid var(--accent);padding-top:3mm}
.doc .stat b{display:block;font:var(--hw) 28pt/1 var(--head),serif;color:var(--accent);margin-bottom:1.5mm}
.doc .stat span{font-size:9.5pt;color:var(--muted)}
.doc .callout{background:var(--card);border-left:1.4mm solid var(--accent);padding:5mm 6mm;margin:6mm 0;break-inside:avoid}
.doc .callout p{margin:1mm 0 0}
.doc table{width:100%;border-collapse:collapse;margin:5mm 0;font-size:9.5pt;break-inside:avoid}
.doc th{text-align:left;font:600 8pt var(--mono),monospace;letter-spacing:.1em;text-transform:uppercase;color:var(--accent);border-bottom:1.5px solid var(--ink);padding:2.5mm 3mm}
.doc td{padding:2.5mm 3mm;border-bottom:1px solid color-mix(in srgb,var(--ink) 18%,transparent)}
.doc .twocol{column-count:2;column-gap:8mm}
.doc figure{margin:6mm 0;break-inside:avoid}.doc img{max-width:100%}.doc figcaption{font-size:8.5pt;color:var(--muted);margin-top:2mm}
.doc hr{border:0;border-top:1px solid var(--muted);margin:8mm 0;opacity:.5}
/* ---------- slides ---------- */
.slide{width:1920px;height:1080px;position:relative;overflow:hidden;padding:120px 150px;display:flex;flex-direction:column;justify-content:center;page-break-after:always;break-after:page;background:var(--bg);color:var(--ink)}
.slide .inner{position:relative;z-index:2;max-width:1500px}
.slide .kicker{font-size:26px;margin-bottom:26px}
.slide h1{font-size:150px;line-height:.96;letter-spacing:-.03em}
.slide h2{font-size:88px;line-height:1.04;letter-spacing:-.02em;margin-bottom:38px}
.slide .lead{font-size:44px;line-height:1.35;color:var(--muted);margin:30px 0 0;max-width:1300px}
.slide .meta{font:500 26px var(--mono),monospace;margin-top:56px;color:var(--muted)}
.slide ul{margin:0;padding-left:50px}.slide li{font-size:48px;line-height:1.3;margin-bottom:22px}.slide li::marker{color:var(--accent)}
.slide .num{position:absolute;bottom:50px;right:150px;font:500 22px var(--mono),monospace;color:var(--muted);z-index:2}
.slide.stat .big{font:var(--hw) 380px/.9 var(--head),serif;color:var(--accent);letter-spacing:-.04em}
.slide.quote blockquote{font:italic var(--hw) 78px/1.22 var(--head),serif;margin:0;max-width:1400px}
.slide.quote cite{display:block;margin-top:40px;font:500 28px var(--mono),monospace;color:var(--accent);font-style:normal}
.slide.section{background:var(--accent);color:var(--on)}.slide.section .kicker,.slide.section .lead,.slide.section .num{color:var(--on);opacity:.85}
.slide .cols{display:grid;grid-template-columns:1fr 1fr;gap:100px;align-items:center}
.slide .cards{display:grid;gap:24px}.slide .card{background:var(--card);padding:28px 34px}
.slide .card b{display:block;font:var(--hw) 40px var(--head),serif}.slide .card span{display:block;font-size:30px;color:var(--muted);margin-top:8px}
.deco{position:absolute;z-index:1;display:block}
.slide .deco{right:-120px;top:-120px;background:var(--accent);width:420px;height:420px;border-radius:50%;opacity:.12}
.v1 .deco{right:auto;left:-140px;top:auto;bottom:-140px}.v2 .deco{right:140px;top:auto;bottom:-220px}
.poster .deco.b{display:none}
/* ---------- posters (sized in container-width units so any size works) ---------- */
.poster{container-type:size;position:relative;overflow:hidden;background:var(--bg);color:var(--ink);padding:6cqw;display:flex;flex-direction:column}
.poster>*{position:relative;z-index:2}.poster .deco{position:absolute;z-index:1}
.poster .p-top{display:flex;justify-content:space-between;gap:4cqw}
.poster .kicker{font-size:2.2cqw}
.poster h1{font-size:13cqw;line-height:.92;letter-spacing:-.035em;margin:3cqw 0 2cqw}
.poster .lead{font-size:3.2cqw;line-height:1.3;color:var(--muted);margin:0;max-width:80%}
.poster .details{list-style:none;margin:auto 0 0;padding:0;display:grid;gap:1.4cqw}
.poster .details li{font-size:3cqw;line-height:1.25}.poster .details span{display:block;font:600 1.7cqw var(--mono),monospace;letter-spacing:.16em;text-transform:uppercase;color:var(--accent);margin-bottom:.3cqw}
.poster .cta{margin-top:3cqw;align-self:flex-start;background:var(--accent);color:var(--on);font:700 3cqw var(--head),serif;padding:1.6cqw 3.4cqw;border-radius:99cqw}
.poster .foot{margin-top:3cqw;font-size:1.9cqw;color:var(--muted)}
.p-stack .deco{width:62cqw;height:62cqw;right:-18cqw;top:-18cqw;border-radius:50%;background:var(--accent);opacity:.95;z-index:0}
.p-stack h1{margin-top:18cqw}
.p-swiss{border-top:2.4cqw solid var(--accent);padding-top:4cqw}
.p-swiss .deco{display:none}
.p-swiss .details{margin:0 0 0;grid-template-columns:1fr 1fr;border-top:.5cqw solid var(--ink);padding-top:2.4cqw}
.p-swiss h1{margin-top:auto;font-size:17cqw;order:5}.p-swiss .lead{order:6;margin-top:2cqw}.p-swiss .cta{order:7}.p-swiss .foot{order:8}
.p-center{text-align:center;align-items:center;border:0}
.p-center::before{content:"";position:absolute;inset:3cqw;border:.35cqw solid var(--accent);z-index:1}
.p-center .p-top{width:100%;justify-content:center;gap:6cqw}
.p-center h1{font-size:10.5cqw;margin:auto 0 3cqw;line-height:1}.p-center .lead{margin:0 auto}
.p-center .details{margin:6cqw 0 0;text-align:center}.p-center .cta{align-self:center}
.p-center .deco{display:none}
.p-blocks .deco{width:52cqw;height:52cqw;border-radius:50%;background:var(--accent2);right:-6cqw;top:12cqw;opacity:1;z-index:0}
.p-blocks .deco.b{display:block;width:36cqw;height:36cqw;border-radius:0;background:var(--accent);right:-10cqw;bottom:-6cqw;transform:rotate(14deg);left:auto;top:auto;z-index:0}
.p-blocks h1{margin-top:auto;font-size:14cqw;text-transform:lowercase}
.p-blocks .details{margin-top:3cqw}
/* ---------- poster picture + logo (optional) ----------
   The picture fills the page; a fade into the design's own background colour keeps the type readable
   on any photo. The headline block is pushed to the bottom, over the faded area. */
.poster>.bgphoto{position:absolute;inset:0;z-index:0;background-size:cover;background-position:center}
.poster>.scrim{position:absolute;inset:0;z-index:1;pointer-events:none}
.poster.has-photo>.deco{display:none}
.poster.has-photo>.scrim{background:linear-gradient(180deg,rgba(0,0,0,.42) 0,rgba(0,0,0,0) 20%,rgba(0,0,0,0) 34%,color-mix(in srgb,var(--bg) 82%,transparent) 58%,var(--bg) 78%,var(--bg) 100%)}
.poster.has-photo .p-top .kicker{color:#fff;text-shadow:0 .2cqw 1.4cqw rgba(0,0,0,.55)}
.poster.has-photo h1{margin-top:auto!important;order:0!important;font-size:min(13cqw,11.5cqh)}
.poster.has-photo .lead,.poster.has-photo .cta,.poster.has-photo .foot{order:0!important}
.poster.has-photo .details{order:0!important;margin-top:3cqw!important;border-top:0!important;padding-top:0!important;grid-template-columns:1fr 1fr}
.poster.has-photo.p-center .details{grid-template-columns:1fr}
.poster>.plogo{align-self:flex-start;height:7cqw;max-width:34cqw;object-fit:contain;object-position:left center;margin-bottom:2.4cqw;position:relative;z-index:3}
.p-center>.plogo{align-self:center;object-position:center}
.poster.has-photo>.plogo{background:rgba(255,255,255,.92);padding:1.2cqw 1.8cqw;border-radius:1.4cqw;box-sizing:content-box}
/* ---------- sheet preview ---------- */
.sheet{padding:24px 40px;font-size:14px}.sheet table{border-collapse:collapse;width:100%}.sheet h2{font-size:28px;margin-bottom:14px}
.sheet th{background:var(--accent);color:var(--on);text-align:left;padding:10px 14px}.sheet td{padding:9px 14px;border-bottom:1px solid color-mix(in srgb,var(--ink) 18%,transparent)}
.sheet tbody tr:nth-child(even){background:var(--card)}
`;

export function kindOf(spec) {
  if (spec.kind) return spec.kind;
  if (spec.slides) return 'slides';
  if (spec.sheets) return 'sheet';
  if (spec.headline && !spec.blocks) return 'poster';
  return 'document';
}

// A spec may carry `markdown` instead of `blocks`. Every exporter (PDF, Word, ...) needs the blocks,
// so this turns the Markdown into blocks (and takes the title from its first # heading) up front.
export function normalizeSpec(input) {
  const spec = { ...input };
  if (spec.markdown && !spec.blocks) {
    const m = markdownToBlocks(spec.markdown);
    spec.title = spec.title || m.title;
    spec.blocks = m.blocks;
  }
  return spec;
}

export function renderHtml(input, { preview = false } = {}) {
  const spec = normalizeSpec(input);
  const kind = kindOf(spec);
  const d = resolveDesign(spec);
  const f = d.fonts;
  const vars = `:root{--bg:${d.c.bg};--ink:${d.c.ink};--muted:${d.c.muted};--accent:${d.c.accent};--accent2:${d.c.accent2};--accent3:${d.c.accent3};--card:${d.c.card};--on:${d.c.on};--head:'${f.head}';--body:'${f.body}';--mono:'${f.mono}';--hw:${f.hw}}`;

  let body = '';
  let page = '';
  let extra = '';
  if (kind === 'slides') {
    body = slidesHtml(spec);
    page = '@page{size:1920px 1080px;margin:0}';
    if (preview) extra = '<script>function fit(){document.querySelectorAll(".slide").forEach(s=>{s.style.zoom=Math.min(1,(innerWidth-40)/1920);s.style.margin="0 auto 14px"})}fit();addEventListener("resize",fit)</script>';
  } else if (kind === 'poster') {
    const [w, h] = POSTER_SIZES[String(spec.size || 'portrait').toLowerCase()] || POSTER_SIZES.portrait;
    body = posterHtml(spec, d);
    page = `@page{size:${w}px ${h}px;margin:0}.poster{width:${w}px;height:${h}px}`;
    if (preview) extra = `<script>function fit(){const p=document.querySelector(".poster");p.style.zoom=Math.min(1,(innerWidth-40)/${w});p.style.margin="0 auto"}fit();addEventListener("resize",fit)</script>`;
  } else if (kind === 'sheet') {
    body = sheetHtml(spec);
    page = '@page{size:A4 landscape;margin:12mm}';
  } else {
    body = docHtml(spec);
    page = '@page{size:A4;margin:20mm 18mm}';
    if (preview) extra = '<style>body{padding:14mm 16mm}</style>';
  }

  const html = `<!doctype html><html lang="${esc(spec.lang || 'en')}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(spec.title || spec.headline || 'Document')}</title>
<style>${fontCss(f.head, f.body, f.mono)}${vars}${page}${BASE_CSS}${d.css}${spec.css || ''}</style>${extra}</head><body>${body}</body></html>`;
  return { html, kind, design: d };
}
