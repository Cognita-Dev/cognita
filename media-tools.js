// media-tools.js
// Two tools the chat model can call for pictures and graphic design:
//
//   generate_image  makes a picture from a description (photo, illustration,
//                   painting, logo art, ...). Uses Cloudflare Workers AI, so it
//                   costs nothing beyond the free Workers AI allowance.
//   create_design   makes a finished flyer / poster / invitation / social post /
//                   banner. The model only supplies the TEXT and a few choices
//                   (layout, colours, optional background picture). The layout,
//                   spacing, text wrapping and colour contrast are done here,
//                   in code, so even the small free models produce a clean,
//                   consistent design. The result is an SVG the browser shows
//                   and offers as PNG or SVG.
//
// Like sandbox-tools.js these are NOT connected-app tools: no OAuth, no
// confirmation card. They run inside the Worker (no browser round trip).
// chat-endpoint.js offers them only when the message looks like a picture or
// design request (shouldOfferMedia), so ordinary chats pay no extra tokens.
//
// WHY IMAGES COME FROM A MODEL CHAIN
// Workers AI has several free text-to-image models and they sometimes fail or
// reject a prompt. generateImage() tries them in order and only gives up when
// every one has failed (or the safety filter blocks the prompt, which no other
// model would fix).

import { checkAndIncrement } from './usage.js';

export const MEDIA_TOOL_NAMES = new Set(['generate_image', 'create_design']);
export const MAX_MEDIA_CALLS_PER_TURN = 3;

export function isMediaTool(name) {
  return MEDIA_TOOL_NAMES.has(name);
}

// ── Should the media tools be offered for this message? ─────────────────
// Same idea as sandbox-intent.js: the tools cost tokens, so they are only
// offered when the request needs them. Patterns lean towards "offer".
const MEDIA_INTENT_PATTERNS = [
  { name: 'design-noun', re: /\b(?:flyers?|flier|posters?|brochures?|leaflets?|banners?|billboards?|certificates?|business cards?|invitation cards?|invitations?|invites?|graphic design\w*|social media (?:post|graphic|design)s?|(?:instagram|facebook|whatsapp|linkedin|twitter|x) (?:post|story|status|graphic)s?|cover (?:art|image|photo)|thumbnails?|mock-?ups?)\b/i },
  { name: 'make-image', re: /\b(?:generate|create|make|draw|design|paint|render|illustrate|produce|give me|show me|need|want|get me|send me|can you (?:make|create|draw|generate))\b[^.?!\n]{0,50}\b(?:images?|pictures?|photos?|photographs?|illustrations?|artworks?|art|drawings?|paintings?|wallpapers?|portraits?|logos?|stickers?|avatars?|graphics?|visuals?|sketch(?:es)?|cartoons?|anime|icons?|emblems?)\b/i },
  { name: 'image-of', re: /\b(?:image|picture|photo|illustration|drawing|painting|portrait)s?\s+(?:of|showing|with)\b/i },
  { name: 'draw-verb', re: /\b(?:draw|sketch|paint|illustrate)\s+(?:me\s+)?(?:a|an|the|some)\b/i },
];

export function shouldOfferMedia({ text, hint } = {}) {
  if (hint === true) return { offer: true, reason: 'hint' };
  const t = typeof text === 'string' ? text.slice(0, 20000) : '';
  for (const p of MEDIA_INTENT_PATTERNS) {
    if (p.re.test(t)) return { offer: true, reason: p.name };
  }
  return { offer: false, reason: 'none' };
}

// ── Tool schemas ────────────────────────────────────────────────────────

const DESIGN_KINDS = ['flyer', 'poster', 'invitation', 'social_post', 'story', 'banner'];
const THEME_NAMES = ['royal', 'sunset', 'forest', 'midnight', 'coral', 'mono', 'gold', 'ocean', 'purple'];
const LAYOUTS = ['bold', 'split', 'centered'];

function _fn(name, description, properties, required) {
  return {
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties, required: required || [] } },
  };
}

export const TOOLS = [
  _fn('generate_image',
    'Make a picture from a description: photo, illustration, painting, 3D render, logo artwork, wallpaper, character, scene. ' +
    'The picture is shown to the user automatically. Write the prompt in English, rich in visual detail (subject, setting, ' +
    'lighting, colours, mood, camera or art style). Do not ask for words or lettering inside the picture, as image models spell badly; ' +
    'for anything with text (flyers, posters, cards) use create_design instead.',
    {
      prompt: { type: 'string', description: 'Detailed English description of the picture, 20 to 60 words.' },
      style: { type: 'string', description: 'Optional: photo, illustration, painting, 3d, flat, anime, sketch or logo.' },
    }, ['prompt']),

  _fn('create_design',
    'Make a finished graphic design (flyer, poster, invitation, social media post, story or banner) from the text you supply. ' +
    'Layout, spacing and colours are handled for you. The design is shown to the user automatically with PNG and SVG downloads. ' +
    'Write every piece of real copy yourself (headline, details, call to action); never leave placeholders. Keep text short and punchy.',
    {
      kind: { type: 'string', description: 'One of: ' + DESIGN_KINDS.join(', ') + '.' },
      headline: { type: 'string', description: 'Main title, 2 to 8 words.' },
      tagline: { type: 'string', description: 'Optional small label above the headline, e.g. "GRAND OPENING" or "ADMISSIONS OPEN".' },
      subheadline: { type: 'string', description: 'Optional one-line supporting statement.' },
      body: { type: 'string', description: 'Optional short paragraph, under 40 words.' },
      bullets: { type: 'array', items: { type: 'string' }, description: 'Optional list of up to 6 short points (features, services, programme items).' },
      details: { type: 'array', items: { type: 'string' }, description: 'Optional practical info, one per line, e.g. "Date: Saturday 12 July", "Venue: City Hall, Lagos", "Call: 0800 000 0000".' },
      cta: { type: 'string', description: 'Optional call to action button text, e.g. "Register today".' },
      footer: { type: 'string', description: 'Optional small line at the bottom, e.g. website or organiser name.' },
      theme: { type: 'string', description: 'Colour theme: ' + THEME_NAMES.join(', ') + '. Choose to suit the subject.' },
      layout: { type: 'string', description: 'One of: bold (strong left-aligned, default), split (coloured header block over a light page), centered (formal and elegant).' },
      primary_color: { type: 'string', description: 'Optional hex colour like #0F766E to override the theme background colour.' },
      accent_color: { type: 'string', description: 'Optional hex colour like #F59E0B to override the theme accent colour.' },
      image_prompt: { type: 'string', description: 'Optional English description of a background picture to place behind the design (no text in it). Leave out for a clean colour design.' },
    }, ['headline']),
];

export function toolSchemas() {
  return TOOLS;
}

// ── describe / validate ─────────────────────────────────────────────────

function _short(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '\u2026' : t;
}

export function describe(name, args) {
  const a = args || {};
  if (name === 'generate_image') return 'Creating an image: ' + _short(a.prompt, 80);
  if (name === 'create_design') return 'Designing ' + (DESIGN_KINDS.includes(a.kind) ? 'a ' + a.kind.replace('_', ' ') : 'a graphic') + ': ' + _short(a.headline, 60);
  return 'Creating a visual.';
}

export function providerLabelFor(name) {
  return name === 'create_design' ? 'Design' : 'Image';
}

export function validateArgs(name, args) {
  const a = args && typeof args === 'object' ? args : {};
  const required = name === 'generate_image' ? ['prompt'] : ['headline'];
  const missing = required.filter((k) => typeof a[k] !== 'string' || !a[k].trim());
  return missing.length ? { ok: false, missing } : { ok: true };
}

// ── Image generation (Workers AI model chain) ───────────────────────────

const STYLE_HINTS = {
  photo: 'ultra realistic photograph, natural lighting, sharp focus, high detail',
  illustration: 'polished digital illustration, rich colour, clean detail',
  painting: 'detailed painting, expressive brushwork, rich colour',
  '3d': '3D render, soft studio lighting, high detail',
  flat: 'flat vector illustration, bold simple shapes, clean colour palette',
  anime: 'anime style illustration, clean line art, vibrant colour',
  sketch: 'detailed pencil sketch, fine linework, shading',
  logo: 'minimal logo mark, simple geometric shapes, flat colours, centred on a plain background',
};

// Tried in order. `kind` says how to call it and read its answer.
//   flux   input { prompt, steps }               output { image: base64 }
//   sd     input { prompt, num_steps, w, h }     output raw image bytes
const IMAGE_MODELS = [
  { id: '@cf/black-forest-labs/flux-1-schnell', kind: 'flux' },
  { id: '@cf/bytedance/stable-diffusion-xl-lightning', kind: 'sd' },
  { id: '@cf/lykon/dreamshaper-8-lcm', kind: 'sd' },
  { id: '@cf/stabilityai/stable-diffusion-xl-base-1.0', kind: 'sd' },
];

// Models that failed recently are skipped for a while so one removed model
// costs a single logged line, not a delay on every request. Per isolate only.
const _deadUntil = new Map();
const DEAD_MS = 10 * 60 * 1000;

export function isImageSafetyError(e) {
  const msg = e && e.message ? String(e.message) : '';
  return /\b8007\b|NSFW|safety|flagged/i.test(msg);
}

function _toBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function _mimeOf(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x52 && bytes[1] === 0x49) return 'image/webp';
  return 'image/jpeg';
}

async function _readAllBytes(stream) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const merged = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  return merged;
}

// Turns whatever a Workers AI image model returned into { base64, mime }.
async function _extractImage(response) {
  if (!response) return null;
  if (typeof response === 'string' && response.length > 100) {
    return { base64: response, mime: response.startsWith('iVBOR') ? 'image/png' : 'image/jpeg' };
  }
  if (typeof Response !== 'undefined' && response instanceof Response) {
    return _extractImage(new Uint8Array(await response.arrayBuffer()));
  }
  if (response instanceof ReadableStream) return _extractImage(await _readAllBytes(response));
  if (response instanceof ArrayBuffer) return _extractImage(new Uint8Array(response));
  if (response instanceof Uint8Array) {
    if (response.length < 100) return null;
    return { base64: _toBase64(response), mime: _mimeOf(response) };
  }
  if (typeof response === 'object' && response.image !== undefined) {
    const img = response.image;
    if (typeof img === 'string' && img.length > 100) {
      return { base64: img, mime: img.startsWith('iVBOR') ? 'image/png' : 'image/jpeg' };
    }
    return _extractImage(img);
  }
  return null;
}

function _buildPrompt(prompt, style, classroomSafe) {
  const hint = STYLE_HINTS[String(style || '').toLowerCase()];
  let p = String(prompt).trim();
  if (classroomSafe) {
    // Cloudflare's safety filter sometimes blocks harmless school topics
    // (anatomy, biology, history). Framing the request as a plain textbook
    // illustration greatly reduces those false alarms.
    return 'A clean, simple, family-friendly educational textbook illustration suitable for a school classroom: ' +
      p + '. Fully clothed people only if any, no nudity, no violence. No text overlays.';
  }
  if (hint) p += '. ' + hint;
  return p + '. No text, no watermark, no captions.';
}

/**
 * Makes one picture. Returns { base64, mime, model }. Throws on failure; the
 * error has `.safety = true` when the prompt was blocked by the safety filter.
 */
export async function generateImage(prompt, env, opts = {}) {
  if (!env || !env.AI) throw new Error('Workers AI is not bound.');
  const finalPrompt = _buildPrompt(prompt, opts.style, !!opts.classroomSafe);
  const size = opts.size && opts.size.width && opts.size.height ? opts.size : { width: 1024, height: 1024 };
  let lastError = null;

  for (const model of IMAGE_MODELS) {
    const dead = _deadUntil.get(model.id);
    if (dead && dead > Date.now()) continue;
    try {
      const input = model.kind === 'flux'
        ? { prompt: finalPrompt, steps: 4 }
        : { prompt: finalPrompt, num_steps: 8, width: size.width, height: size.height };
      const response = await env.AI.run(model.id, input);
      const img = await _extractImage(response);
      if (!img) throw new Error('empty image from ' + model.id);
      return { base64: img.base64, mime: img.mime, model: model.id };
    } catch (e) {
      lastError = e;
      if (isImageSafetyError(e)) {
        const err = new Error('The image request was blocked by the safety filter.');
        err.safety = true;
        throw err;
      }
      console.warn('[media] image model failed model=' + model.id + ' msg=' + (e && e.message));
      const m = String(e && e.message || '');
      // A removed or renamed model stays out of the chain for a while.
      if (/not found|no such model|unknown model|deprecated|5007|1000\b/i.test(m)) {
        _deadUntil.set(model.id, Date.now() + DEAD_MS);
      }
    }
  }
  throw lastError || new Error('No image model available.');
}

// ── Execution ───────────────────────────────────────────────────────────
// Returns { ok, modelResult, media }.
//   modelResult  what the model reads (a plain string)
//   media        what the browser shows: { kind, ... }  (only when ok)

const SHOWN_NOTE =
  ' It is already shown to the user, with download buttons. Do not paste image data, links or markdown images. ' +
  'Reply in one or two plain sentences about what you made and offer one concrete tweak. Do not mention tools or models.';

export async function execute(name, args, ctx) {
  const { uid, plan, env } = ctx;
  const a = args || {};
  const limit = plan && plan.limits ? plan.limits.imageGenPerDay : 0;

  if (name === 'generate_image') {
    const quota = await checkAndIncrement(uid, 'imageGen', limit, env);
    if (!quota.allowed) {
      return { ok: false, modelResult: 'Error: the user has reached today\'s picture limit for their plan (' + quota.limit + ' per day). Tell them plainly and that it resets at midnight UTC.' };
    }
    try {
      const img = await generateImage(a.prompt, env, { style: a.style });
      console.log('[media] generate_image ok model=' + img.model);
      return {
        ok: true,
        modelResult: 'The image was generated successfully.' + SHOWN_NOTE,
        media: { kind: 'image', mime: img.mime, content: img.base64, alt: _short(a.prompt, 160) },
      };
    } catch (e) {
      if (e && e.safety) {
        return { ok: false, modelResult: 'Error: the image was blocked by the safety filter. Tell the user briefly, and offer to try a different description.' };
      }
      console.error('[media] generate_image failed:', e && e.message);
      return { ok: false, modelResult: 'Error: the image service could not make this picture right now. Tell the user plainly and suggest trying again in a moment.' };
    }
  }

  if (name === 'create_design') {
    const spec = normalizeDesignSpec(a);
    let bg = null;
    let bgNote = '';
    if (spec.imagePrompt) {
      // A background picture counts as one image for the daily allowance.
      const quota = await checkAndIncrement(uid, 'imageGen', limit, env);
      if (!quota.allowed) {
        bgNote = ' (No background picture was added because the user has reached today\'s picture limit; the design is colour only. Mention this briefly.)';
      } else {
        try {
          const size = designSize(spec.kind);
          bg = await generateImage(spec.imagePrompt, env, { style: 'photo', size: { width: Math.min(1024, size.width), height: Math.min(1024, size.height) } });
        } catch (e) {
          console.warn('[media] design background failed:', e && e.message);
          bgNote = ' (The background picture could not be made, so the design is colour only. Mention this briefly.)';
        }
      }
    }
    try {
      const built = buildDesignSvg(spec, bg);
      console.log('[media] create_design ok kind=' + spec.kind + ' layout=' + spec.layout + ' bg=' + !!bg);
      return {
        ok: true,
        modelResult: 'The design was created successfully.' + bgNote + SHOWN_NOTE,
        media: { kind: 'design', title: spec.headline, width: built.width, height: built.height, svg: built.svg, alt: _short(spec.headline + ' ' + spec.kind, 160) },
      };
    } catch (e) {
      console.error('[media] create_design failed:', e && e.message);
      return { ok: false, modelResult: 'Error: the design could not be built. Tell the user plainly and offer to try again.' };
    }
  }

  return { ok: false, modelResult: 'Error: unknown media tool.' };
}

// ── Design: spec cleanup ────────────────────────────────────────────────

const THEMES = {
  royal:    { primary: '#1E3A8A', accent: '#F59E0B', light: '#F8FAFC', ink: '#0F172A' },
  sunset:   { primary: '#7C2D12', accent: '#FB923C', light: '#FFF7ED', ink: '#431407' },
  forest:   { primary: '#14532D', accent: '#FACC15', light: '#F0FDF4', ink: '#052E16' },
  midnight: { primary: '#0F172A', accent: '#22D3EE', light: '#F1F5F9', ink: '#020617' },
  coral:    { primary: '#BE123C', accent: '#FDA4AF', light: '#FFF1F2', ink: '#4C0519' },
  mono:     { primary: '#111111', accent: '#FFD60A', light: '#FAFAFA', ink: '#111111' },
  gold:     { primary: '#1C1917', accent: '#D4A017', light: '#FAF7F0', ink: '#1C1917' },
  ocean:    { primary: '#0C4A6E', accent: '#38BDF8', light: '#F0F9FF', ink: '#082F49' },
  purple:   { primary: '#4C1D95', accent: '#F0ABFC', light: '#FAF5FF', ink: '#2E1065' },
};

function _hex(v) {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^#?([0-9a-f]{6})$/i);
  return m ? '#' + m[1].toUpperCase() : null;
}

function _clean(v, max) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

export function designSize(kind) {
  switch (kind) {
    case 'social_post': return { width: 1080, height: 1080 };
    case 'story': return { width: 1080, height: 1920 };
    case 'banner': return { width: 1600, height: 900 };
    default: return { width: 1080, height: 1527 }; // flyer, poster, invitation: A-series proportions
  }
}

export function normalizeDesignSpec(a) {
  const kind = DESIGN_KINDS.includes(a.kind) ? a.kind : 'flyer';
  const theme = THEMES[String(a.theme || '').toLowerCase()] || THEMES.royal;
  const primary = _hex(a.primary_color) || theme.primary;
  const accent = _hex(a.accent_color) || theme.accent;
  const arr = (v, n, len) => (Array.isArray(v) ? v : []).map((x) => _clean(String(x), len)).filter(Boolean).slice(0, n);
  const layoutRaw = String(a.layout || '').toLowerCase();
  const layout = LAYOUTS.includes(layoutRaw) ? layoutRaw : (kind === 'invitation' ? 'centered' : 'bold');
  return {
    kind,
    layout,
    headline: _clean(a.headline, 90) || 'Your headline',
    tagline: _clean(a.tagline, 40),
    subheadline: _clean(a.subheadline, 120),
    body: _clean(a.body, 320),
    bullets: arr(a.bullets, 6, 70),
    details: arr(a.details, 6, 70),
    cta: _clean(a.cta, 36),
    footer: _clean(a.footer, 80),
    imagePrompt: _clean(a.image_prompt, 300),
    colors: { primary, accent, light: theme.light, ink: theme.ink },
  };
}

// ── Design: SVG composer ────────────────────────────────────────────────

const FONT_HEAD = "'Arial Black','Helvetica Neue',Arial,sans-serif";
const FONT_BODY = "'Helvetica Neue',Arial,sans-serif";
const FONT_SERIF = "Georgia,'Times New Roman',serif";

function _esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _lum(hex) {
  const n = parseInt(hex.slice(1), 16);
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255);
}

function _onColor(bg) {
  return _lum(bg) > 0.42 ? '#111111' : '#FFFFFF';
}

// Average glyph width as a fraction of font size. Slightly generous so text
// never runs past its box.
function _wrap(text, size, maxW, factor) {
  const words = String(text).split(' ').filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? cur + ' ' + w : w;
    if (next.length * size * factor > maxW && cur) { lines.push(cur); cur = w; } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

// Largest size (down to minSize) at which `text` fits in maxLines lines.
function _fit(text, startSize, minSize, maxW, maxLines, factor) {
  let size = startSize;
  let lines = _wrap(text, size, maxW, factor);
  while (lines.length > maxLines && size > minSize) {
    size = Math.max(minSize, Math.floor(size * 0.92));
    lines = _wrap(text, size, maxW, factor);
  }
  if (lines.length > maxLines) lines = lines.slice(0, maxLines);
  return { size, lines };
}

function _textLines(lines, x, y, size, o) {
  const lh = o.lh || 1.2;
  let out = '';
  lines.forEach((ln, i) => {
    out += '<text x="' + x + '" y="' + Math.round(y + i * size * lh) +
      '" font-size="' + size + '" font-family="' + o.family + '" font-weight="' + (o.weight || 400) +
      '" fill="' + o.fill + '"' + (o.anchor ? ' text-anchor="' + o.anchor + '"' : '') +
      (o.spacing ? ' letter-spacing="' + o.spacing + '"' : '') +
      (o.opacity ? ' fill-opacity="' + o.opacity + '"' : '') + '>' + _esc(ln) + '</text>';
  });
  return out;
}

export function buildDesignSvg(spec, bg) {
  // Body text shrinks in steps until the whole design fits the page.
  let scale = 1;
  let built = null;
  for (let i = 0; i < 6; i++) {
    built = _compose(spec, bg, scale);
    if (built.fits) break;
    scale *= 0.9;
  }
  return built;
}

function _compose(spec, bg, scale) {
  const { width: W, height: H } = designSize(spec.kind);
  const unit = W / 1080;               // everything is designed at 1080 wide
  const S = (n) => Math.round(n * unit);
  const c = spec.colors;
  const layout = spec.layout;
  const margin = S(layout === 'centered' ? 110 : 90);
  const maxW = W - margin * 2;
  const centered = layout === 'centered';
  const anchor = centered ? 'middle' : 'start';
  const tx = centered ? W / 2 : margin;
  const wide = spec.kind === 'banner';   // banners have little height: tighter sizes
  const bodySize = Math.round(S(34) * scale * (wide ? 0.8 : 1));

  const defs = [];
  const parts = [];
  const isSplit = layout === 'split';
  const headBlockH = isSplit ? Math.round(H * (wide ? 0.62 : 0.46)) : H;
  const headFill = c.primary;
  const headInk = _onColor(headFill);
  const pageFill = isSplit ? c.light : c.primary;
  const pageInk = isSplit ? '#1F2937' : headInk;

  // ── Background ──
  parts.push('<rect width="' + W + '" height="' + H + '" fill="' + pageFill + '"/>');
  if (bg) {
    const href = 'data:' + bg.mime + ';base64,' + bg.base64;
    const clipH = isSplit ? headBlockH : H;
    defs.push('<clipPath id="bgclip"><rect width="' + W + '" height="' + clipH + '"/></clipPath>');
    parts.push('<image href="' + href + '" width="' + W + '" height="' + clipH + '" preserveAspectRatio="xMidYMid slice" clip-path="url(#bgclip)"/>');
    defs.push('<linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + headFill + '" stop-opacity="0.78"/><stop offset="1" stop-color="' + headFill + '" stop-opacity="0.94"/></linearGradient>');
    parts.push('<rect width="' + W + '" height="' + clipH + '" fill="url(#shade)"/>');
  } else if (!isSplit) {
    // Quiet depth without a picture: two soft accent shapes.
    parts.push('<circle cx="' + Math.round(W * 0.92) + '" cy="' + Math.round(H * 0.07) + '" r="' + S(260) + '" fill="' + c.accent + '" fill-opacity="0.16"/>');
    parts.push('<circle cx="' + Math.round(W * 0.05) + '" cy="' + Math.round(H * 0.97) + '" r="' + S(300) + '" fill="' + c.accent + '" fill-opacity="0.10"/>');
  }
  if (isSplit) {
    if (!bg) {
      parts.push('<rect width="' + W + '" height="' + headBlockH + '" fill="' + headFill + '"/>');
      parts.push('<circle cx="' + Math.round(W * 0.9) + '" cy="' + Math.round(headBlockH * 0.2) + '" r="' + S(220) + '" fill="' + c.accent + '" fill-opacity="0.18"/>');
    }
    parts.push('<rect y="' + (headBlockH - S(10)) + '" width="' + W + '" height="' + S(10) + '" fill="' + c.accent + '"/>');
  }
  if (centered) {
    const inset = S(44);
    parts.push('<rect x="' + inset + '" y="' + inset + '" width="' + (W - inset * 2) + '" height="' + (H - inset * 2) + '" fill="none" stroke="' + c.accent + '" stroke-width="' + S(4) + '"/>');
    parts.push('<rect x="' + (inset + S(14)) + '" y="' + (inset + S(14)) + '" width="' + (W - (inset + S(14)) * 2) + '" height="' + (H - (inset + S(14)) * 2) + '" fill="none" stroke="' + c.accent + '" stroke-opacity="0.45" stroke-width="' + S(1.5) + '"/>');
  }

  // Everything from here on is page content. For the centered layout the
  // whole block is moved down at the end so short designs sit mid-page.
  const contentIdx = parts.length;
  const footerParts = [];
  let y = isSplit ? S(wide ? 60 : 110) : S(wide ? 80 : 150);

  // ── Tagline pill ──
  if (spec.tagline) {
    const tsize = S(wide ? 24 : 28);
    const label = spec.tagline.toUpperCase();
    const pillW = Math.min(maxW, Math.round(label.length * tsize * 0.72 + S(56)));
    const pillH = Math.round(tsize * 1.9);
    const px = centered ? Math.round((W - pillW) / 2) : margin;
    parts.push('<rect x="' + px + '" y="' + y + '" width="' + pillW + '" height="' + pillH + '" rx="' + Math.round(pillH / 2) + '" fill="' + c.accent + '"/>');
    parts.push('<text x="' + (px + pillW / 2) + '" y="' + Math.round(y + pillH / 2 + tsize * 0.35) + '" font-size="' + tsize + '" font-family="' + FONT_BODY + '" font-weight="700" letter-spacing="' + S(2) + '" fill="' + _onColor(c.accent) + '" text-anchor="middle">' + _esc(label) + '</text>');
    y += pillH + S(wide ? 30 : 50);
  }

  // ── Headline ──
  const headFont = centered ? FONT_SERIF : FONT_HEAD;
  const headFactor = centered ? 0.58 : 0.66;
  const hStart = S(wide ? 96 : (spec.kind === 'social_post' ? 104 : 118));
  const hMaxLines = wide ? 3 : 4;
  const head = _fit(centered ? spec.headline : spec.headline.toUpperCase(), hStart, S(44), maxW, hMaxLines, headFactor);
  y += head.size;
  parts.push(_textLines(head.lines, tx, y, head.size, { family: headFont, weight: centered ? 700 : 900, fill: headInk, anchor, lh: 1.08 }));
  y += (head.lines.length - 1) * head.size * 1.08;

  // Accent rule
  y += S(wide ? 24 : 40);
  const ruleW = S(150);
  parts.push('<rect x="' + (centered ? Math.round((W - ruleW) / 2) : margin) + '" y="' + y + '" width="' + ruleW + '" height="' + S(9) + '" rx="' + S(4) + '" fill="' + c.accent + '"/>');
  y += S(wide ? 36 : 60);

  // ── Everything below sits on the "page" colour ──
  if (isSplit) y = Math.max(y, headBlockH + S(wide ? 40 : 80));

  if (spec.subheadline) {
    const ss = Math.round(S(42) * scale * (wide ? 0.75 : 1));
    const sub = _fit(spec.subheadline, ss, S(26), maxW, 3, 0.52);
    y += sub.size;
    parts.push(_textLines(sub.lines, tx, y, sub.size, { family: FONT_BODY, weight: 700, fill: isSplit ? c.primary : c.accent, anchor, lh: 1.22 }));
    y += (sub.lines.length - 1) * sub.size * 1.22 + S(wide ? 22 : 38);
  }

  if (spec.body) {
    const lines = _wrap(spec.body, bodySize, maxW, 0.5);
    y += bodySize;
    parts.push(_textLines(lines, tx, y, bodySize, { family: FONT_BODY, weight: 400, fill: pageInk, anchor, lh: 1.42, opacity: isSplit ? 0.92 : 0.94 }));
    y += (lines.length - 1) * bodySize * 1.42 + S(wide ? 22 : 40);
  }

  if (spec.bullets.length) {
    const bs = Math.round(S(36) * scale * (wide ? 0.8 : 1));
    const indent = centered ? 0 : S(46);
    for (const item of spec.bullets) {
      const lines = _wrap(item, bs, maxW - indent, 0.5);
      y += bs;
      if (centered) {
        parts.push(_textLines(lines, tx, y, bs, { family: FONT_BODY, weight: 500, fill: pageInk, anchor, lh: 1.3 }));
      } else {
        parts.push('<circle cx="' + (margin + S(14)) + '" cy="' + Math.round(y - bs * 0.32) + '" r="' + S(10) + '" fill="' + c.accent + '"/>');
        parts.push(_textLines(lines, margin + indent, y, bs, { family: FONT_BODY, weight: 500, fill: pageInk, lh: 1.3 }));
      }
      y += (lines.length - 1) * bs * 1.3 + S(wide ? 14 : 26);
    }
    y += S(10);
  }

  // ── Details card (practical info) ──
  if (spec.details.length) {
    const ds = Math.round(S(34) * scale * (wide ? 0.8 : 1));
    const pad = S(34);
    const rows = spec.details.map((d) => {
      const m = d.match(/^([^:]{1,22}):\s*(.+)$/);
      return m ? { label: m[1].trim(), value: m[2].trim() } : { label: '', value: d };
    });
    const laid = rows.map((r) => {
      const full = r.label ? r.label + ': ' + r.value : r.value;
      return { r, lines: _wrap(full, ds, maxW - pad * 2 - S(40), 0.54) };
    });
    const cardH = pad * 2 + laid.reduce((a, l) => a + l.lines.length * ds * 1.3 + S(12), 0) - S(12);
    const cardFill = isSplit ? '#FFFFFF' : '#FFFFFF';
    parts.push('<rect x="' + margin + '" y="' + Math.round(y) + '" width="' + maxW + '" height="' + Math.round(cardH) + '" rx="' + S(26) + '" fill="' + cardFill + '"' + (isSplit ? ' stroke="' + c.accent + '" stroke-width="' + S(3) + '"' : ' fill-opacity="0.96"') + '/>');
    parts.push('<rect x="' + margin + '" y="' + Math.round(y + S(20)) + '" width="' + S(10) + '" height="' + Math.round(cardH - S(40)) + '" rx="' + S(5) + '" fill="' + c.accent + '"/>');
    let cy = y + pad;
    for (const l of laid) {
      cy += ds;
      const x0 = margin + pad + S(20);
      if (l.r.label) {
        // First line carries the bold label; wrapped lines continue plain.
        const first = l.lines[0];
        const labelText = l.r.label + ':';
        const rest = first.startsWith(labelText) ? first.slice(labelText.length).trim() : first;
        parts.push('<text x="' + x0 + '" y="' + Math.round(cy) + '" font-size="' + ds + '" font-family="' + FONT_BODY + '" fill="#1F2937"><tspan font-weight="800" fill="' + c.primary + '">' + _esc(labelText) + '</tspan><tspan font-weight="500" dx="' + S(10) + '">' + _esc(rest) + '</tspan></text>');
        l.lines.slice(1).forEach((ln, i) => {
          parts.push(_textLines([ln], x0, cy + (i + 1) * ds * 1.3, ds, { family: FONT_BODY, weight: 500, fill: '#1F2937' }));
        });
      } else {
        parts.push(_textLines(l.lines, x0, cy, ds, { family: FONT_BODY, weight: 500, fill: '#1F2937', lh: 1.3 }));
      }
      cy += (l.lines.length - 1) * ds * 1.3 + S(12);
    }
    y += cardH + S(wide ? 24 : 40);
  }

  // ── Call to action button ──
  if (spec.cta) {
    const cs = Math.round(S(38) * (wide ? 0.8 : 1));
    const label = spec.cta.toUpperCase();
    const bw = Math.min(maxW, Math.round(label.length * cs * 0.7 + S(110)));
    const bh = Math.round(cs * 2.2);
    const bx = centered ? Math.round((W - bw) / 2) : margin;
    parts.push('<rect x="' + bx + '" y="' + Math.round(y) + '" width="' + bw + '" height="' + bh + '" rx="' + Math.round(bh / 2) + '" fill="' + c.accent + '"/>');
    parts.push('<text x="' + (bx + bw / 2) + '" y="' + Math.round(y + bh / 2 + cs * 0.35) + '" font-size="' + cs + '" font-family="' + FONT_BODY + '" font-weight="800" letter-spacing="' + S(1.5) + '" fill="' + _onColor(c.accent) + '" text-anchor="middle">' + _esc(label) + '</text>');
    y += bh + S(wide ? 20 : 30);
  }

  // ── Footer, pinned to the bottom ──
  const footerSize = S(wide ? 24 : 28);
  const footerY = H - S(centered ? 100 : 70);
  if (spec.footer) {
    const fl = _wrap(spec.footer, footerSize, maxW, 0.54).slice(0, 2);
    footerParts.push(_textLines(fl, tx, footerY - (fl.length - 1) * footerSize * 1.3, footerSize, { family: FONT_BODY, weight: 600, fill: pageInk, anchor, lh: 1.3, opacity: 0.85, spacing: S(0.5) }));
  }

  const limit = footerY - footerSize * 2.2;
  const bottom = spec.footer ? limit : H - S(centered ? 120 : 60);
  const fits = y <= bottom;
  const dy = centered && fits ? Math.round((bottom - y) * 0.45) : 0;
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + _esc(spec.headline) + '">' +
    (defs.length ? '<defs>' + defs.join('') + '</defs>' : '') +
    parts.slice(0, contentIdx).join('') +
    '<g transform="translate(0 ' + dy + ')">' + parts.slice(contentIdx).join('') + '</g>' +
    footerParts.join('') + '</svg>';
  return { svg, width: W, height: H, fits };
}
