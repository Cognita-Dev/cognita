// Eight genuinely different design systems. Each one changes typography, colour,
// structure (rules, numbering, borders, shapes) and poster composition — not just
// the accent colour. Add your own by copying one block and editing it.
//
// `office` fonts are safe system fonts used for editable DOCX/PPTX (Word and
// PowerPoint cannot use web fonts unless you install them). PDF/PNG/HTML always
// use the real embedded fonts.

export const DESIGNS = {
  editorial: {
    name: 'Editorial',
    mood: 'Magazine / long-form. Warm paper, serif headlines, numbered sections.',
    tags: 'report essay story research article memo proposal culture',
    fonts: { head: 'Fraunces', body: 'Inter', mono: 'IBM Plex Mono', hw: 600 },
    office: { head: 'Georgia', body: 'Calibri' },
    c: { bg: '#F3EDE2', ink: '#1A1814', muted: '#6E675B', accent: '#D2461F', accent2: '#1F3A32', accent3: '#E8B04B', card: '#E9E1D2', on: '#FFFFFF' },
    poster: 'stack',
    css: `
.doc{counter-reset:sec}
.doc .cover{border-top:4px solid var(--ink);padding-top:7mm}
.doc h2{counter-increment:sec}
.doc h2::before{content:counter(sec,decimal-leading-zero);display:block;font:500 9pt var(--mono);letter-spacing:.14em;color:var(--accent);margin-bottom:2mm}
.doc h2{border-bottom:1px solid var(--ink);padding-bottom:3mm}
.doc .cover h1{letter-spacing:-.02em;font-style:italic}
.slide h1{font-style:italic;letter-spacing:-.025em}
.slide::after{content:"";position:absolute;left:140px;right:140px;bottom:90px;border-top:1px solid var(--ink);opacity:.35}
.deco{width:520px;height:520px;border-radius:50%;background:var(--accent);opacity:.9}
.slide.section .deco{background:var(--accent3)}
`,
  },
  swiss: {
    name: 'Swiss Grid',
    mood: 'Rational, big type, hard grid. Tech, studios, product, data.',
    tags: 'product data tech startup design studio analytics engineering',
    fonts: { head: 'Space Grotesk', body: 'Inter', mono: 'IBM Plex Mono', hw: 700 },
    office: { head: 'Arial', body: 'Arial' },
    c: { bg: '#FFFFFF', ink: '#0B0B0B', muted: '#6B6B6B', accent: '#E4002B', accent2: '#0B0B0B', accent3: '#E4002B', card: '#F0F0EE', on: '#FFFFFF' },
    poster: 'swiss',
    css: `
.doc .cover{border-top:14px solid var(--accent);padding-top:6mm}
.doc .cover h1{font-size:46pt;letter-spacing:-.04em;line-height:.95}
.doc h2{font-size:15pt;letter-spacing:-.01em;border-top:2px solid var(--ink);padding-top:3mm}
.doc .callout{border-left:0;border-top:4px solid var(--accent)}
.slide h1,.slide h2{letter-spacing:-.045em}
.slide::before{content:"";position:absolute;top:0;left:0;right:0;height:22px;background:var(--accent)}
.slide.section{background:var(--ink)}
.deco{display:none}
`,
  },
  brutal: {
    name: 'Neo-Brutalist',
    mood: 'Loud, chunky borders, offset shadows. Youth, events, launches, indie.',
    tags: 'event launch youth indie festival campaign creative social',
    fonts: { head: 'Space Grotesk', body: 'IBM Plex Mono', mono: 'IBM Plex Mono', hw: 700 },
    office: { head: 'Arial Black', body: 'Courier New' },
    c: { bg: '#FFE94A', ink: '#0B0B0B', muted: '#3B3A28', accent: '#FF4D2E', accent2: '#1D3BFF', accent3: '#FFFFFF', card: '#FFFFFF', on: '#FFFFFF' },
    poster: 'blocks',
    css: `
.doc{font-size:10pt}
.doc .cover h1{text-transform:uppercase;letter-spacing:-.03em;background:var(--accent3);border:3px solid var(--ink);box-shadow:8px 8px 0 var(--ink);padding:5mm 6mm;display:inline-block}
.doc h2{display:inline-block;background:var(--ink);color:var(--bg);padding:1mm 4mm;font-size:14pt;text-transform:uppercase}
.doc .callout,.doc .stat,.doc table{border:3px solid var(--ink);box-shadow:6px 6px 0 var(--ink);background:var(--card)}
.doc .callout{border-left:3px solid var(--ink)}
.doc .stat{padding:4mm}
.slide h1,.slide h2{text-transform:uppercase;letter-spacing:-.03em}
.slide li{background:var(--card);border:4px solid var(--ink);box-shadow:8px 8px 0 var(--ink);padding:14px 26px;list-style:none;margin:0 0 22px}
.slide.section{background:var(--accent2);color:#fff}
.deco{width:420px;height:420px;background:var(--accent);border:6px solid var(--ink);box-shadow:14px 14px 0 var(--ink)}
.v1 .deco{border-radius:50%}
`,
  },
  luxe: {
    name: 'Midnight Luxe',
    mood: 'Dark navy, gold hairlines, high-contrast serif. Premium, finance, hospitality.',
    tags: 'luxury premium finance wealth hotel gala investor annual award',
    fonts: { head: 'Playfair Display', body: 'DM Sans', mono: 'DM Sans', hw: 600 },
    office: { head: 'Cambria', body: 'Calibri' },
    c: { bg: '#0F1626', ink: '#F2EBDD', muted: '#A5A9B5', accent: '#C9A24B', accent2: '#7F8FB8', accent3: '#C9A24B', card: '#182238', on: '#0F1626' },
    poster: 'center',
    css: `
.doc .cover{text-align:center;border-top:1px solid var(--accent);border-bottom:1px solid var(--accent);padding:12mm 0}
.doc .cover h1{font-weight:500;letter-spacing:.01em}
.doc .kicker{letter-spacing:.3em}
.doc h2{font-weight:500;text-align:center;font-size:17pt}
.doc h2::after{content:"";display:block;width:18mm;height:1px;background:var(--accent);margin:3mm auto 0}
.doc .callout{border:1px solid var(--accent);border-left:1px solid var(--accent);text-align:center}
.slide{text-align:center;align-items:center}
.slide ul{display:inline-block;text-align:left}
.slide::before{content:"";position:absolute;inset:48px;border:1px solid var(--accent);opacity:.7}
.slide h1,.slide h2{font-weight:500}
.slide.section{background:var(--card)}
.deco{display:none}
`,
  },
  bauhaus: {
    name: 'Bauhaus Blocks',
    mood: 'Primary-colour geometry, bold shapes, playful structure. Design, education, culture.',
    tags: 'design education art workshop culture course kids museum',
    fonts: { head: 'Syne', body: 'DM Sans', mono: 'DM Sans', hw: 800 },
    office: { head: 'Trebuchet MS', body: 'Calibri' },
    c: { bg: '#F5F1E8', ink: '#141414', muted: '#5B5B55', accent: '#E63B2E', accent2: '#1747B8', accent3: '#F2B705', card: '#ECE5D3', on: '#FFFFFF' },
    poster: 'blocks',
    css: `
.doc .cover{position:relative;padding-left:16mm}
.doc .cover::before{content:"";position:absolute;left:0;top:2mm;bottom:2mm;width:8mm;background:linear-gradient(var(--accent) 0 33%,var(--accent3) 33% 66%,var(--accent2) 66%)}
.doc .cover h1{text-transform:lowercase;letter-spacing:-.03em}
.doc h2{display:flex;align-items:center;gap:4mm}
.doc h2::before{content:"";width:7mm;height:7mm;background:var(--accent2);border-radius:50%;flex:none}
.doc h2:nth-of-type(3n+2)::before{background:var(--accent);border-radius:0}
.doc h2:nth-of-type(3n)::before{background:var(--accent3);border-radius:0;clip-path:polygon(50% 0,100% 100%,0 100%)}
.slide h1,.slide h2{letter-spacing:-.04em}
.deco{width:480px;height:480px;border-radius:50%;background:var(--accent2)}
.v1 .deco{border-radius:0;background:var(--accent);transform:rotate(12deg)}
.v2 .deco{border-radius:0;background:var(--accent3);clip-path:polygon(50% 0,100% 100%,0 100%)}
.slide.section{background:var(--accent2);color:#fff}
.slide.section .deco{background:var(--accent3)}
`,
  },
  botanical: {
    name: 'Botanical',
    mood: 'Soft sage and terracotta, rounded, calm. Wellness, food, sustainability, community.',
    tags: 'wellness food nature sustainability community school nonprofit health care',
    fonts: { head: 'Lora', body: 'Manrope', mono: 'Manrope', hw: 600 },
    office: { head: 'Georgia', body: 'Verdana' },
    c: { bg: '#EEF0E6', ink: '#22301F', muted: '#6A7562', accent: '#B4562F', accent2: '#4C6B4A', accent3: '#D9B26A', card: '#E0E4D2', on: '#FFFFFF' },
    poster: 'center',
    css: `
.doc .cover{background:var(--card);border-radius:8mm;padding:12mm}
.doc .cover h1{font-style:italic}
.doc .callout,.doc .stat{border-radius:5mm;border-left:0}
.doc h2{color:var(--accent2)}
.doc h2::after{content:"";display:block;width:12mm;height:3px;border-radius:2px;background:var(--accent);margin-top:2mm}
.slide{border-radius:0}
.slide li::marker{color:var(--accent)}
.deco{width:560px;height:700px;border-radius:280px 280px 0 0;background:var(--accent2);opacity:.9}
.v1 .deco{background:var(--accent);border-radius:50%;width:520px;height:520px}
.v2 .deco{background:var(--accent3)}
.slide.section{background:var(--accent2);color:#fff}
.slide.section .deco{background:var(--accent3)}
`,
  },
  newsprint: {
    name: 'Newsprint',
    mood: 'Broadsheet. Two columns, heavy rules, condensed drama. Journalism, policy, reports.',
    tags: 'news policy journal brief government law academic whitepaper',
    fonts: { head: 'DM Serif Display', body: 'Lora', mono: 'IBM Plex Mono', hw: 400 },
    office: { head: 'Times New Roman', body: 'Georgia' },
    c: { bg: '#E9E7E2', ink: '#121212', muted: '#5C5C58', accent: '#B3111B', accent2: '#121212', accent3: '#B3111B', card: '#DCDAD3', on: '#FFFFFF' },
    poster: 'stack',
    css: `
.doc{font-size:10pt;line-height:1.55}
.doc .cover{border-top:6px double var(--ink);border-bottom:1px solid var(--ink);padding:6mm 0;text-align:center}
.doc .cover h1{font-size:48pt;line-height:.95;letter-spacing:-.01em}
.doc .kicker{color:var(--accent)}
.doc main{column-count:2;column-gap:9mm;column-rule:1px solid var(--ink)}
.doc main h2,.doc main .stats,.doc main table,.doc main .callout,.doc main .quote{column-span:all}
.doc h2{font-size:18pt;border-top:3px solid var(--ink);padding-top:2mm}
.doc main > p:first-of-type::first-letter{font:400 40pt/0.8 var(--head);float:left;padding:1.5mm 2mm 0 0;color:var(--accent)}
.slide h1,.slide h2{letter-spacing:-.01em}
.slide::before{content:"";position:absolute;top:60px;left:140px;right:140px;border-top:6px double var(--ink)}
.slide.section{background:var(--ink);color:var(--bg)}
.deco{display:none}
`,
  },
  aurora: {
    name: 'Aurora',
    mood: 'Dark gradient, glowing accents, glass cards. AI, SaaS, pitch decks, future-facing.',
    tags: 'ai saas pitch deck startup future platform cloud software product launch',
    fonts: { head: 'Syne', body: 'Manrope', mono: 'IBM Plex Mono', hw: 700 },
    office: { head: 'Segoe UI', body: 'Segoe UI' },
    c: { bg: '#0B0A1F', ink: '#EDEBFF', muted: '#9C99C9', accent: '#7C5CFF', accent2: '#2EE6C5', accent3: '#FF6BCB', card: 'rgba(255,255,255,.07)', on: '#0B0A1F' },
    poster: 'stack',
    css: `
html{background:radial-gradient(1200px 700px at 85% -10%,rgba(124,92,255,.35),transparent 60%),radial-gradient(900px 600px at -10% 110%,rgba(46,230,197,.22),transparent 60%),#0B0A1F}
.doc .cover h1{background:linear-gradient(90deg,var(--ink),var(--accent2));-webkit-background-clip:text;background-clip:text;color:transparent}
.doc .callout,.doc .stat,.doc table{background:var(--card);border:1px solid rgba(255,255,255,.14);border-radius:4mm;border-left:1px solid rgba(255,255,255,.14)}
.doc .stat{padding:4mm}
.doc .stat b{background:linear-gradient(90deg,var(--accent),var(--accent2));-webkit-background-clip:text;background-clip:text;color:transparent}
.doc h2{color:var(--accent2)}
.slide{background:radial-gradient(1100px 700px at 90% 0%,rgba(124,92,255,.38),transparent 60%),radial-gradient(900px 600px at 0% 100%,rgba(46,230,197,.2),transparent 60%),#0B0A1F}
.slide li,.slide .card{background:var(--card);border:1px solid rgba(255,255,255,.14);border-radius:24px;padding:18px 30px;list-style:none;margin:0 0 20px}
.slide.stat .big{background:linear-gradient(90deg,var(--accent),var(--accent2));-webkit-background-clip:text;background-clip:text;color:transparent}
.deco{width:600px;height:600px;border-radius:50%;background:radial-gradient(circle,var(--accent) 0%,transparent 70%);opacity:.55;filter:blur(20px)}
.v1 .deco{background:radial-gradient(circle,var(--accent2) 0%,transparent 70%)}
.v2 .deco{background:radial-gradient(circle,var(--accent3) 0%,transparent 70%)}
`,
  },
};

export const DESIGN_IDS = Object.keys(DESIGNS);

function hash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

// design: explicit id, or "auto" → matches keywords in the content, then falls back
// to a stable hash of title+seed so different documents get different looks.
export function pickDesign(spec) {
  const id = String(spec.design || 'auto').toLowerCase();
  if (DESIGNS[id]) return id;
  const text = JSON.stringify(spec).toLowerCase().slice(0, 4000);
  let best = null;
  let top = 0;
  for (const k of DESIGN_IDS) {
    const score = DESIGNS[k].tags.split(' ').reduce((n, t) => n + (text.includes(t) ? 1 : 0), 0);
    if (score > top) { top = score; best = k; }
  }
  if (best) return best;
  return DESIGN_IDS[hash(String(spec.title || spec.headline || '') + String(spec.seed || '')) % DESIGN_IDS.length];
}

// Palette overrides: spec.colors = { accent, bg, ink, ... } (hex strings)
export function resolveDesign(spec) {
  const id = pickDesign(spec);
  const base = DESIGNS[id];
  const c = { ...base.c };
  for (const [k, v] of Object.entries(spec.colors || {})) if (k in c && typeof v === 'string') c[k] = v;
  const fonts = { ...base.fonts };
  for (const [k, v] of Object.entries(spec.fonts || {})) if (k in fonts && typeof v === 'string') fonts[k] = v;
  return { id, ...base, c, fonts };
}
