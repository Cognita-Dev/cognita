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
const THEME_NAMES = ['royal', 'sunset', 'forest', 'midnight', 'coral', 'mono', 'gold', 'ocean', 'purple', 'terracotta', 'blush', 'slate', 'emerald'];
const LAYOUTS = ['bold', 'split', 'centered', 'editorial', 'poster'];

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
    'Write the headline, tagline and call to action yourself and keep text short and punchy. Use ONLY facts the person gave for names, dates, venues, prices, phone numbers, emails, websites and addresses; never invent them. If something essential is missing, still call this tool: the app asks the person for it before the design is made.',
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
      layout: { type: 'string', description: 'Optional; chosen automatically from the content if left out. One of: bold (full-colour, strong left-aligned type), poster (picture-led, giant headline at the bottom, best with image_prompt and little text), split (coloured header over a light information page, best for text-heavy flyers), editorial (light paper, serif headline and a picture window, refined and modern), centered (formal and elegant, best for invitations and certificates).' },
      primary_color: { type: 'string', description: 'Optional hex colour like #0F766E to override the theme background colour.' },
      accent_color: { type: 'string', description: 'Optional hex colour like #F59E0B to override the theme accent colour.' },
      image_prompt: { type: 'string', description: 'Optional English description of a photograph to place in the design (no text in it). Describe one clear subject, mood and lighting; calm negative space is added automatically. Leave out for a clean colour design.' },
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
    const assets = ctx.assets || {};
    const userPhoto = assets.photo || assets.artwork || null;
    const said = String(ctx.userText || '') + ' ' + Object.values(ctx.facts || {}).join(' ');
    const spec = normalizeDesignSpec(scrubInventedFacts(a, said), { hasPhoto: !!userPhoto });
    let bg = userPhoto ? { mime: userPhoto.mime, base64: userPhoto.base64, user: true } : null;
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
      const built = buildDesignSvg(spec, bg, { logo: assets.logo || null });
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

// ── Design requirements validator ───────────────────────────────────────
// Runs BEFORE a design is made. It decides, from the conversation alone
// (no extra model call), whether something the design genuinely depends on
// is missing: a business or event name, a date, a venue, a way to get in
// touch, a price, or an asset only the person owns (logo, photo, artwork).
// If so, chat-endpoint.js pauses and the browser shows a request card; once
// the person answers, the original create_design call continues with the
// answers merged in (applyDesignAnswers), so nothing has to be repeated.
//
// Principles: ask for the fewest things possible, never ask for what the
// conversation already holds, never ask twice, and let generic designs
// (quotes, greetings, thank-yous) through immediately. Facts the model
// invented are never counted as "already known" - only what the person said.

const RX = {
  date: /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\.?\s*\d{0,2}|\b\d{1,2}(?:st|nd|rd|th)\b|\b\d{1,2}\s*(?:of\s+)?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?\b|\b(?:today|tonight|tomorrow|next (?:week|month|year))\b|\b\d{1,2}[\/.-]\d{1,2}(?:[\/.-]\d{2,4})?\b|\b20\d\d\b/i,
  email: /[\w.+-]+@[\w-]+\.[\w.-]+/,
  url: /(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|org|net|ng|co|io|app|edu|info|biz|church|shop|store)\b/i,
  handle: /(?:^|\s)@[A-Za-z0-9_.]{3,}/,
  venue: /\b(?:venue|location|address|held at|taking place at|hosted at|located at|street|st\.|road|rd\.|avenue|ave\.|close|crescent|estate|plaza|hall|hotel|church|cathedral|centre|center|stadium|arena|park|school|university|campus|auditorium|resort|garden|club|lounge|mall|market|lagos|abuja|ibadan|port harcourt|kano|enugu|accra|nairobi|london|new york)\b/i,
  price: /[\u20A6$\u20AC\u00A3]\s?\d|\b\d[\d,.]*\s?(?:naira|ngn|usd|dollars?|k|%|percent)\b|\bfree\b/i,
  priceWord: /\b(?:price|prices|pricing|tickets?|cost|fee|entry|admission|how much|per (?:person|ticket|head))\b/i,
  bookWord: /\b(?:register|registration|book|booking|reserve|reservation|rsvp|sign ?up|enrol+)\b/i,
  online: /\b(?:online|virtual|zoom|webinar|google meet|live ?stream|instagram live|on whatsapp)\b/i,
  invite: /\b(?:invitation|invite|rsvp|wedding|birthday party|baby shower|bridal|engagement|anniversary party|housewarming|graduation|naming ceremony|burial|funeral|memorial|thanksgiving service)\b/i,
  event: /\b(?:event|conference|summit|seminar|workshop|webinar|concert|festival|crusade|revival|service|retreat|meetup|launch|party|tournament|fundraiser|gala|expo|fair|show|screening|training|bootcamp|hackathon|open day|rally|convention|outreach|class(?:es)?)\b/i,
  business: /\b(?:sale|discount|offer|promo(?:tion)?|grand opening|opening|shop|store|salon|barber|restaurant|cafe|bakery|clinic|pharmacy|school|admissions?|enrolment|services?|hiring|vacanc\w+|recruit\w*|brand|company|business|boutique|catering|agency|gym|spa|studio|real estate|for rent|for sale|delivery|menu|product)\b/i,
  generic: /\b(?:quote|quotes|motivational|inspirational|greeting|thank you|thanks|congratulations|congrats|happy birthday|good morning|bible verse|prayer|meme|tip of the day|fun fact|wallpaper|announcement)\b/i,
  logoNo: /\b(?:no logo|without (?:a )?logo|text only|no photo)\b/i,
  logoWord: /\blogo\b/i,
  photoOwn: /\b(?:my|our|the)\s+(?:photo|photos|picture|pictures|pic|image|headshot|portrait|product|products|dish|dishes|food|car|house|property|shoe|shoes|bag|collection|team|staff|speaker|guest|artist|pastor|founder|ceo)\b|\bfeaturing\b|\bwith (?:my|the) (?:photo|picture|face)\b/i,
  artworkOwn: /\b(?:my|our|existing|attached|uploaded|provided)\s+(?:artwork|design|flyer|poster|graphic|key visual|album cover|cover art|banner)\b/i,
  revision: /^\s*(?:make|change|can you (?:make|change)|use|try|add|remove|swap|replace|more|less|bigger|smaller|another|different|redo|update|adjust|tweak|now)\b/i,
  orgWord: /\b(?:church|ministry|school|company|brand|foundation|ngo|academy|university|college|firm|organi[sz]ation|association)\b/i,
};

const NAME_STOP = new Set(['I', "I'm", 'Ive', "I've", 'Please', 'Create', 'Design', 'Make', 'Generate', 'Can', 'Could', 'Need', 'Want', 'Flyer', 'Poster', 'Invitation', 'Banner', 'Instagram', 'Facebook', 'WhatsApp', 'Whatsapp', 'LinkedIn', 'Twitter', 'Story', 'Post', 'Canva', 'Cognita', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December', 'Nigeria', 'Lagos', 'Abuja', 'Africa', 'English', 'Also', 'And', 'The', 'For', 'With', 'Add', 'Use', 'Should', 'Make', 'It', 'This', 'That', 'Thanks', 'Thank', 'Hi', 'Hello', 'Hey', 'Yes', 'No', 'Ok', 'Okay', 'Sure', 'Instagram', 'TikTok', 'YouTube', 'RSVP', 'PM', 'AM', 'PNG', 'PDF', 'SVG', 'AI', 'A4', 'A5', 'Royal', 'Sunset', 'Forest', 'Midnight', 'Coral', 'Mono', 'Gold', 'Ocean', 'Purple']);

function _hasProperName(t) {
  const s = String(t || '');
  if (/["\u201C][^"\u201D]{3,60}["\u201D]/.test(s)) return true;
  const toks = s.split(/\s+/).filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    const w = toks[i].replace(/^[("'\u2018\u201C]+|[).,;:!?"'\u2019\u201D]+$/g, '');
    if (!w || NAME_STOP.has(w)) continue;
    const startOfSentence = i === 0 || /[.!?]$/.test(toks[i - 1]);
    if (startOfSentence) continue;
    if (/^[A-Z][a-z]{2,}/.test(w) || /^[A-Z]{2,6}\d*$/.test(w)) return true;
  }
  return false;
}

function _hasPhone(t) {
  const m = String(t || '').match(/\+?\d[\d\s().-]{7,}\d/g) || [];
  return m.some((x) => {
    const d = x.replace(/\D/g, '');
    return d.length >= 9 && d.length <= 15 && !/^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}$/.test(x.trim());
  });
}

const _digits = (s) => String(s || '').replace(/\D/g, '');

const DESIGN_FIELD_DEFS = {
  name: { type: 'text', placeholder: 'e.g. Greenfield Bakery' },
  when: { type: 'text', label: 'Date & time', placeholder: 'e.g. Saturday 12 July, 4 PM' },
  venue: { type: 'text', label: 'Venue or address', placeholder: 'e.g. City Hall, Marina, Lagos' },
  contact: { type: 'text', placeholder: 'e.g. 0800 000 0000 \u00B7 hello@brand.com' },
  price: { type: 'text', label: 'Price or ticket details', placeholder: 'e.g. \u20A65,000 per ticket' },
  logo: { type: 'image', label: 'Your logo', hint: 'A PNG with a transparent background looks best.', optional: true },
  photo: { type: 'image', label: 'Your photo', hint: 'A clear, well-lit photo of the person or product. It becomes the hero of the design.', optional: true },
  artwork: { type: 'image', label: 'Event artwork', hint: 'Your existing artwork or key visual to build the design around.', optional: true },
};

export const DESIGN_IMAGE_SLOTS = ['logo', 'photo', 'artwork'];
const DESIGN_TEXT_IDS = ['name', 'when', 'venue', 'contact', 'price'];

// Returns null when the design can be made straight away, otherwise the
// request the browser renders as a card:
//   { title, intro, fields: [{ id, type, label, hint?, placeholder?, optional? }] }
// ctx: { userText, lastUserText, facts, skipped, assets, hasPriorMedia, resume }
export function checkDesignRequirements(args, ctx) {
  const c = ctx || {};
  if (c.resume) return null;
  const a = args || {};
  const last = String(c.lastUserText || '');
  // A tweak to a design that already exists ("make it bluer") never re-asks.
  if (c.hasPriorMedia && last.length < 200 && RX.revision.test(last)) return null;

  const facts = c.facts && typeof c.facts === 'object' ? c.facts : {};
  const skipped = new Set(Array.isArray(c.skipped) ? c.skipped : []);
  const assets = c.assets || {};
  const said = String(c.userText || '') + ' ' + Object.values(facts).join(' ');
  const topic = (last + ' ' + [a.headline, a.tagline, a.subheadline, a.body].filter(Boolean).join(' ')).toLowerCase();
  const kind = DESIGN_KINDS.includes(a.kind) ? a.kind : 'flyer';

  const isInvite = kind === 'invitation' || RX.invite.test(topic);
  const isEvent = isInvite || RX.event.test(topic);
  const isBusiness = RX.business.test(topic) || RX.orgWord.test(topic);
  // Quotes, greetings and the like: nothing here depends on facts we lack.
  if (!isEvent && !isBusiness) return null;
  if (RX.generic.test(topic) && !isEvent) return null;

  const have = {
    name: !!facts.name || skipped.has('name') || _hasProperName(said),
    when: !!facts.when || skipped.has('when') || RX.date.test(said),
    venue: !!facts.venue || skipped.has('venue') || RX.venue.test(said) || RX.online.test(said),
    contact: !!facts.contact || skipped.has('contact') || RX.email.test(said) || RX.url.test(said) || RX.handle.test(said) || _hasPhone(said),
    price: !!facts.price || skipped.has('price') || RX.price.test(said),
  };

  const need = [];
  if (!have.name) need.push('name');
  if (isEvent && !have.when) need.push('when');
  if (isEvent && !have.venue) need.push('venue');
  // Invitations only need contact details when the host asked for RSVPs.
  const wantsContact = isInvite ? RX.bookWord.test(topic) : (isEvent || isBusiness);
  if (wantsContact && !have.contact) need.push('contact');
  if (RX.priceWord.test(topic) && !have.price) need.push('price');

  // Assets only the person owns. Asked for when they said so, or (logo only)
  // alongside a card that is already being shown for a branded design.
  const logoMentioned = RX.logoWord.test(last) || RX.logoWord.test(said);
  const noLogo = RX.logoNo.test(said);
  const images = [];
  const photoMentioned = RX.photoOwn.test(last) && !/\b(?:generate|ai|stock)\b/.test(last);
  if (photoMentioned && !assets.photo && !assets.artwork && !skipped.has('photo')) images.push('photo');
  if (RX.artworkOwn.test(last) && !assets.photo && !assets.artwork && !skipped.has('artwork')) images.push('artwork');
  if (!assets.logo && !skipped.has('logo') && !noLogo) {
    if (logoMentioned) images.push('logo');
    else if (need.length && (isBusiness || RX.orgWord.test(topic))) images.push('logo');
  }
  if (!need.length && !images.some((id) => id !== 'logo' || logoMentioned)) return null;

  const ids = need.concat(images).slice(0, 5);
  const noun = kind.replace('_', ' ');
  const nameLabel = isEvent ? 'Event or host name' : 'Business or brand name';
  const contactLabel = RX.bookWord.test(topic) ? 'Phone, email or link to register' : 'Phone, email or website';
  const fields = ids.map((id) => {
    const d = DESIGN_FIELD_DEFS[id];
    const f = { id, type: d.type, label: d.label || '' };
    if (id === 'name') f.label = nameLabel;
    if (id === 'contact') f.label = contactLabel;
    if (d.placeholder) f.placeholder = d.placeholder;
    if (d.hint) f.hint = d.hint;
    if (d.optional) f.optional = true;
    return f;
  });
  const withText = fields.some((f) => f.type === 'text');
  return {
    title: 'A few details to finish your ' + noun,
    intro: withText
      ? 'Add what you have and I\u2019ll build the design around it. Leave anything blank to skip it.'
      : 'Add these and I\u2019ll build the design around them, or skip to continue without.',
    kindLabel: noun.charAt(0).toUpperCase() + noun.slice(1),
    fields,
  };
}

// Merges the card's answers into the original create_design arguments so the
// design is made exactly as first requested, plus the new information.
export function applyDesignAnswers(args, answers) {
  const a = { ...(args || {}) };
  const ans = answers && typeof answers === 'object' ? answers : {};
  const val = (k) => _clean(typeof ans[k] === 'string' ? ans[k] : '', 70);
  let details = (Array.isArray(a.details) ? a.details : []).map((d) => String(d));
  const drop = (re) => { details = details.filter((d) => !re.test(d.trim())); };
  const added = [];

  if (val('when')) { drop(/^(?:date|time|when|day)\b/i); added.push('Date: ' + val('when')); }
  if (val('venue')) { drop(/^(?:venue|location|address|where)\b/i); added.push('Venue: ' + val('venue')); }
  if (val('contact')) {
    drop(/^(?:call|phone|tel|contact|email|e-mail|website|web|whatsapp|rsvp|reach|register)\b/i);
    const v = val('contact');
    const label = RX.email.test(v) && !_hasPhone(v) ? 'Email' : (_hasPhone(v) && !RX.email.test(v) && !RX.url.test(v) ? 'Call' : (RX.url.test(v) && !RX.email.test(v) && !_hasPhone(v) ? 'Web' : 'Contact'));
    added.push(label + ': ' + v);
  }
  if (val('price')) { drop(/^(?:price|cost|ticket|fee|entry|admission)\b/i); added.push('Price: ' + val('price')); }
  a.details = added.concat(details).slice(0, 6);

  const name = val('name');
  if (name && !String(a.headline || '').toLowerCase().includes(name.toLowerCase())) {
    if (!a.tagline) a.tagline = name;
    else a.footer = name + (a.footer ? ' \u00B7 ' + a.footer : '');
  }
  return a;
}

// Contact details are real-world facts. If the model wrote a phone number,
// email or website that the person never gave, it is removed rather than
// printed on a design the person may send out.
export function scrubInventedFacts(args, said) {
  const a = { ...(args || {}) };
  const hay = String(said || '');
  const hayLower = hay.toLowerCase();
  const hayDigits = _digits(hay);
  const real = (v) => {
    const s = String(v);
    const em = s.match(RX.email);
    if (em && !hayLower.includes(em[0].toLowerCase())) return false;
    const um = s.match(RX.url);
    if (um && !em && !hayLower.includes(um[0].toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, ''))) return false;
    if (_hasPhone(s)) {
      const nums = s.match(/\+?\d[\d\s().-]{7,}\d/g) || [];
      if (!nums.every((n) => { const d = _digits(n); return d.length < 9 || hayDigits.includes(d) || hayDigits.includes(d.replace(/^0/, '')); })) return false;
    }
    return true;
  };
  if (Array.isArray(a.details)) a.details = a.details.filter((d) => real(d));
  if (typeof a.footer === 'string' && !real(a.footer)) a.footer = '';
  if (typeof a.body === 'string' && !real(a.body)) a.body = '';
  return a;
}

// Cleans the design-related fields the browser sends with a chat request.
// Sizes are capped; nothing here can grant anything beyond "use this picture".
const _ASSET_MIME = /^image\/(png|jpeg|webp)$/;
const _B64 = /^[A-Za-z0-9+/=]+$/;
export function sanitizeDesignInputs(body) {
  const b = body && typeof body === 'object' ? body : {};
  const assets = {};
  const rawAssets = b.designAssets && typeof b.designAssets === 'object' ? b.designAssets : {};
  for (const slot of DESIGN_IMAGE_SLOTS) {
    const x = rawAssets[slot];
    if (!x || typeof x !== 'object') continue;
    if (!_ASSET_MIME.test(x.mime || '') || typeof x.base64 !== 'string' || x.base64.length > 1800000 || !_B64.test(x.base64)) continue;
    assets[slot] = {
      mime: x.mime, base64: x.base64,
      w: Number.isFinite(x.w) && x.w > 0 && x.w < 10000 ? Math.round(x.w) : 0,
      h: Number.isFinite(x.h) && x.h > 0 && x.h < 10000 ? Math.round(x.h) : 0,
    };
  }
  const facts = {};
  const rawFacts = b.designFacts && typeof b.designFacts === 'object' ? b.designFacts : {};
  for (const id of DESIGN_TEXT_IDS) if (typeof rawFacts[id] === 'string' && rawFacts[id].trim()) facts[id] = _clean(rawFacts[id], 120);
  const all = DESIGN_TEXT_IDS.concat(DESIGN_IMAGE_SLOTS);
  const skipped = (Array.isArray(b.designSkipped) ? b.designSkipped : []).filter((x) => all.includes(x)).slice(0, 10);
  let resume = null;
  const r = b.designResume;
  if (r && typeof r === 'object' && r.args && typeof r.args === 'object') {
    const answers = {};
    const ra = r.answers && typeof r.answers === 'object' ? r.answers : {};
    for (const id of DESIGN_TEXT_IDS) if (typeof ra[id] === 'string' && ra[id].trim()) answers[id] = _clean(ra[id], 120);
    resume = { args: r.args, answers };
  }
  return { assets, facts, skipped, resume };
}

// ── Design: spec cleanup ────────────────────────────────────────────────
// Themes carry a colour story AND a type personality (font: serif|sans) so
// the same layout feels different for a wedding than for a tech launch.

const THEMES = {
  royal:      { primary: '#1E3A8A', accent: '#F59E0B', light: '#F8FAFC', ink: '#0F172A', font: 'sans' },
  sunset:     { primary: '#7C2D12', accent: '#FB923C', light: '#FFF7ED', ink: '#431407', font: 'sans' },
  forest:     { primary: '#14532D', accent: '#FACC15', light: '#F0FDF4', ink: '#052E16', font: 'serif' },
  midnight:   { primary: '#0F172A', accent: '#22D3EE', light: '#F1F5F9', ink: '#020617', font: 'sans' },
  coral:      { primary: '#BE123C', accent: '#FDA4AF', light: '#FFF1F2', ink: '#4C0519', font: 'serif' },
  mono:       { primary: '#111111', accent: '#FFD60A', light: '#FAFAFA', ink: '#111111', font: 'sans' },
  gold:       { primary: '#1C1917', accent: '#D4A017', light: '#FAF7F0', ink: '#1C1917', font: 'serif' },
  ocean:      { primary: '#0C4A6E', accent: '#38BDF8', light: '#F0F9FF', ink: '#082F49', font: 'sans' },
  purple:     { primary: '#4C1D95', accent: '#F0ABFC', light: '#FAF5FF', ink: '#2E1065', font: 'serif' },
  terracotta: { primary: '#9A3B1E', accent: '#F2C879', light: '#FBF4EC', ink: '#3A1A10', font: 'serif' },
  blush:      { primary: '#6B2D45', accent: '#F4B6C2', light: '#FDF3F5', ink: '#3B1626', font: 'serif' },
  slate:      { primary: '#1F2937', accent: '#F97316', light: '#F8FAFC', ink: '#111827', font: 'sans' },
  emerald:    { primary: '#064E3B', accent: '#6EE7B7', light: '#F0FDF9', ink: '#022C22', font: 'sans' },
};

function _hex(v) {
  if (typeof v !== 'string') return null;
  const m = v.trim().match(/^#?([0-9a-f]{6})$/i);
  return m ? '#' + m[1].toUpperCase() : null;
}

function _clean(v, max) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function _rgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function _mix(a, b, t) {
  const A = _rgb(a), B = _rgb(b);
  return '#' + [0, 1, 2].map((i) => Math.max(0, Math.min(255, Math.round(A[i] + (B[i] - A[i]) * t))).toString(16).padStart(2, '0')).join('').toUpperCase();
}

function _lum(hex) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const [r, g, b] = _rgb(hex);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function _contrast(a, b) {
  const l1 = _lum(a), l2 = _lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

// Nudges `fg` toward black/white until it reads on `bg` (used for accent
// colours chosen for decoration that also have to carry small text).
function _ensure(fg, bg, min) {
  let col = fg;
  const target = _lum(bg) > 0.4 ? '#000000' : '#FFFFFF';
  for (let i = 0; i < 14 && _contrast(col, bg) < min; i++) col = _mix(col, target, 0.12);
  return col;
}

function _onColor(bg) {
  return _lum(bg) > 0.42 ? '#111111' : '#FFFFFF';
}

export function designSize(kind) {
  switch (kind) {
    case 'social_post': return { width: 1080, height: 1080 };
    case 'story': return { width: 1080, height: 1920 };
    case 'banner': return { width: 1600, height: 900 };
    default: return { width: 1080, height: 1527 }; // flyer, poster, invitation: A-series proportions
  }
}

// Picks a layout from the kind and how much content there is, when the
// caller did not choose one. Text-heavy flyers get a light information
// page, picture-led posts get a full-bleed poster, formal pieces are centred.
function _autoLayout(kind, hasImage, a) {
  const items = a.bullets.length + a.details.length;
  const words = (a.body ? a.body.split(' ').length : 0) + items * 4;
  if (kind === 'invitation') return 'centered';
  if (kind === 'banner') return 'bold';
  if (kind === 'story') return hasImage ? 'poster' : (words > 22 ? 'bold' : 'poster');
  if (kind === 'social_post') return hasImage ? 'poster' : (words > 30 ? 'bold' : 'poster');
  if (kind === 'poster') return words > 30 ? 'editorial' : 'poster';
  // flyer
  if (items >= 5 || words > 40) return 'split';
  if (words > 14) return 'editorial';
  return hasImage ? 'poster' : 'bold';
}

export function normalizeDesignSpec(a, opts) {
  const hasPhoto = !!(opts && opts.hasPhoto);
  const kind = DESIGN_KINDS.includes(a.kind) ? a.kind : 'flyer';
  const theme = THEMES[String(a.theme || '').toLowerCase()] || THEMES.royal;
  const customPrimary = _hex(a.primary_color);
  const primary = customPrimary || theme.primary;
  const accent = _hex(a.accent_color) || theme.accent;
  const light = customPrimary ? _mix(primary, '#FFFFFF', 0.95) : theme.light;
  const ink = customPrimary ? _mix(primary, '#000000', 0.72) : theme.ink;
  const arr = (v, n, len) => (Array.isArray(v) ? v : []).map((x) => _clean(String(x), len)).filter(Boolean).slice(0, n);
  const bullets = arr(a.bullets, 6, 70);
  const details = arr(a.details, 6, 70);
  const body = _clean(a.body, 320);
  // Photography briefs get art-direction appended so backgrounds are calm
  // and leave room for type instead of fighting it.
  const rawImg = _clean(a.image_prompt, 300);
  const imagePrompt = rawImg && !hasPhoto
    ? rawImg + ', professional editorial photography, soft natural light, uncluttered composition with calm negative space, shallow depth of field, no text, no lettering, no logos, no watermark'
    : '';
  const layoutRaw = String(a.layout || '').toLowerCase();
  const layout = LAYOUTS.includes(layoutRaw) ? layoutRaw : _autoLayout(kind, !!rawImg || hasPhoto, { bullets, details, body });
  return {
    kind,
    layout,
    headline: _clean(a.headline, 90) || 'Your headline',
    tagline: _clean(a.tagline, 40),
    subheadline: _clean(a.subheadline, 120),
    body,
    bullets,
    details,
    cta: _clean(a.cta, 36),
    footer: _clean(a.footer, 80),
    imagePrompt,
    colors: {
      primary, accent, light, ink,
      deep: _mix(primary, '#000000', 0.4),
      mid: _mix(primary, '#FFFFFF', 0.2),
      font: theme.font,
    },
  };
}

// ── Design: SVG composer ────────────────────────────────────────────────
// The composer builds a list of measured "blocks" (tagline, headline, rule,
// details, button ...) and stacks them with an intentional rhythm: hero
// type up top, practical information anchored low, breathing room in
// between. Each layout is a different arrangement of the same blocks.

const FONT_HEAD = "'Arial Black','Helvetica Neue',Arial,sans-serif";
const FONT_BODY = "'Helvetica Neue',Helvetica,Arial,sans-serif";
const FONT_SERIF = "Georgia,'Times New Roman',serif";

function _esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Per-glyph width estimate (fraction of font size) so wrapping is much
// closer to reality than a flat average: narrow i/l/t, wide m/w, caps and
// digits in between. `f` scales for the font family, `sp` is tracking in px.
const _NARROW = new Set("iljtfI.,;:'|!()[] ".split(''));
function _tw(text, size, f, sp) {
  const t = String(text);
  let u = 0;
  for (const ch of t) {
    if (_NARROW.has(ch)) u += 0.29;
    else if ('mwMW@%'.includes(ch)) u += 0.84;
    else if (ch >= 'A' && ch <= 'Z') u += 0.67;
    else if (ch >= '0' && ch <= '9') u += 0.56;
    else u += 0.53;
  }
  return u * size * (f || 1) + (sp || 0) * t.length;
}

function _wrap(text, size, maxW, f, spRatio) {
  const words = String(text).split(' ').filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? cur + ' ' + w : w;
    if (cur && _tw(next, size, f, size * (spRatio || 0)) > maxW) { lines.push(cur); cur = w; } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

// Re-wraps to the narrowest width that keeps the same line count, so the
// lines come out even instead of leaving a one-word orphan on the last line.
function _balance(text, size, maxW, f, spRatio) {
  const base = _wrap(text, size, maxW, f, spRatio);
  if (base.length < 2) return base;
  let lo = maxW * 0.45, hi = maxW;
  for (let i = 0; i < 14; i++) {
    const mid = (lo + hi) / 2;
    if (_wrap(text, size, mid, f, spRatio).length <= base.length) hi = mid; else lo = mid;
  }
  return _wrap(text, size, hi, f, spRatio);
}

// Largest size (down to minSize) at which `text` fits in maxLines lines
// without any single word overflowing the measure.
function _fit(text, startSize, minSize, maxW, maxLines, f, spRatio, balance) {
  let size = startSize;
  const wrapIt = (s) => (balance ? _balance(text, s, maxW, f, spRatio) : _wrap(text, s, maxW, f, spRatio));
  const ok = (ls, s) => ls.length <= maxLines && ls.every((l) => _tw(l, s, f, s * (spRatio || 0)) <= maxW * 1.02);
  let lines = wrapIt(size);
  while (!ok(lines, size) && size > minSize) {
    size = Math.max(minSize, Math.floor(size * 0.93));
    lines = wrapIt(size);
  }
  if (lines.length > maxLines) lines = lines.slice(0, maxLines);
  return { size, lines };
}

// Draws lines inside a box whose TOP edge is `top`, so block heights and
// positions are predictable (baseline is derived from size and leading).
function _lines(lines, x, top, size, o) {
  const lh = o.lh || 1.2;
  const off = size * (0.5 * (lh - 1) + 0.82);
  return lines.map((ln, i) => {
    const fill = typeof o.fill === 'function' ? o.fill(i, lines.length) : o.fill;
    return '<text x="' + x + '" y="' + Math.round(top + off + i * size * lh) +
      '" font-size="' + size + '" font-family="' + o.family + '" font-weight="' + (o.weight || 400) +
      '" fill="' + fill + '"' + (o.anchor && o.anchor !== 'start' ? ' text-anchor="' + o.anchor + '"' : '') +
      (o.style ? ' font-style="' + o.style + '"' : '') +
      (o.spacing ? ' letter-spacing="' + (Math.round(o.spacing * 100) / 100) + '"' : '') +
      (o.opacity ? ' fill-opacity="' + o.opacity + '"' : '') + '>' + _esc(ln) + '</text>';
  }).join('');
}

export function buildDesignSvg(spec, bg, extras) {
  // Type steps down gently until the whole design fits the page.
  let scale = 1;
  let built = null;
  for (let i = 0; i < 9; i++) {
    built = _compose(spec, bg, scale, extras || {});
    if (built.fits) break;
    scale *= 0.93;
  }
  return built;
}

function _stack(blocks, y0, avail, stretch) {
  const bl = blocks.filter(Boolean);
  const gaps = bl.map((b, i) => (i < bl.length - 1 ? (b.gap || 0) : 0));
  const total = bl.reduce((s, b) => s + b.h, 0) + gaps.reduce((s, g) => s + g, 0);
  let k = 1;
  const gs = gaps.reduce((s, g) => s + g, 0);
  // Spare room is shared out between blocks (capped) so the page never
  // has an awkward dead zone, but never so much that it stops feeling tight.
  if (stretch && avail > total && gs > 0) k = Math.min(1.55, 1 + (avail - total) / gs);
  let y = y0;
  let svg = '';
  bl.forEach((b, i) => { svg += b.draw(Math.round(y)); y += b.h + gaps[i] * k; });
  return { svg, h: total };
}

function _total(blocks) {
  const bl = blocks.filter(Boolean);
  return bl.reduce((s, b, i) => s + b.h + (i < bl.length - 1 ? (b.gap || 0) : 0), 0);
}

function _hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h;
}

function _compose(spec, bg, scale, extras) {
  const { width: W, height: H } = designSize(spec.kind);
  const S = (n) => Math.round(n * (W / 1080));
  const c = spec.colors;
  const wide = spec.kind === 'banner';
  const story = spec.kind === 'story';
  let layout = spec.layout;
  if (wide && layout !== 'centered') layout = 'bold';   // banners are always text-left, picture-right
  const centered = layout === 'centered';
  const serif = centered || layout === 'editorial' || c.font === 'serif';
  const anchor = centered ? 'middle' : 'start';

  // Margins follow an 8% grid; stories keep clear of the app UI at top and bottom.
  const margin = S(centered ? 130 : (wide ? 76 : 84));
  const padTop = S(story ? 240 : centered ? 150 : wide ? 62 : 100);
  const padBot = S(story ? 280 : centered ? 150 : wide ? 54 : 76);
  const panelX = wide && !centered ? Math.round(W * 0.6) : W;
  const w = wide && !centered ? panelX - margin - S(48) : W - margin * 2;
  const x0 = centered ? Math.round(W / 2) : margin;
  const left = centered ? Math.round(x0 - w / 2) : x0;
  const align = (bw) => (centered ? Math.round(x0 - bw / 2) : x0);

  // Tones: "dark" text sits on the primary colour, "light" text on the paper colour.
  const darkInk = _onColor(c.primary);
  const accentOnDark = _ensure(c.accent, c.primary, 3.2);
  const dark = { ink: darkInk, label: accentOnDark, sub: accentOnDark, hair: darkInk, btn: c.accent, btnInk: _onColor(c.accent) };
  const lightPrimary = _ensure(c.primary, c.light, 4.5);
  const light = { ink: c.ink, label: lightPrimary, sub: lightPrimary, hair: c.ink, btn: c.primary, btnInk: _onColor(c.primary) };

  // Display type: heavy grotesque in caps, or a bold serif in sentence case.
  const dFam = serif ? FONT_SERIF : FONT_HEAD;
  const dWeight = serif ? 700 : 900;
  const dF = serif ? 1.0 : 1.2;
  const dSpR = serif ? -0.008 : -0.012;
  const dLH = serif ? 1.08 : 1.03;
  const dCase = (t) => (serif ? t : t.toUpperCase());

  const hair = (x, y, ww, tone, op) => '<rect x="' + Math.round(x) + '" y="' + Math.round(y) + '" width="' + Math.round(ww) + '" height="' + Math.max(1, S(2)) + '" fill="' + tone.hair + '" fill-opacity="' + (op || 0.25) + '"/>';
  const href = bg ? 'data:' + bg.mime + ';base64,' + bg.base64 : '';
  // The person's own photos keep their top (faces) when cropped; generated ones centre.
  const pAR = bg && bg.user ? 'xMidYMin slice' : 'xMidYMid slice';
  // Deterministic variety: the same brief always looks the same, different briefs differ.
  const seed = _hash(spec.headline + '|' + spec.kind) % 3;

  // ── Blocks ──────────────────────────────────────────────────────────

  function bTag(tone, pill) {
    if (!spec.tagline) return null;
    const ts = S(wide ? 19 : 24);
    const label = spec.tagline.toUpperCase();
    const sp = ts * 0.2;
    const tw = _tw(label, ts, 1.08, sp);
    const gap = S(wide ? 26 : 44);
    if (pill) {
      const pw = Math.min(w, Math.round(tw + S(52)));
      const ph = Math.round(ts * 2.1);
      return {
        h: ph, gap,
        draw: (y) => {
          const px = align(pw);
          return '<rect x="' + px + '" y="' + y + '" width="' + pw + '" height="' + ph + '" rx="' + Math.round(ph / 2) + '" fill="' + c.accent + '"/>' +
            _lines([label], Math.round(px + pw / 2 + sp / 2), y + (ph - ts * 1.2) / 2, ts, { family: FONT_BODY, weight: 800, fill: _onColor(c.accent), anchor: 'middle', spacing: sp, lh: 1.2 });
        },
      };
    }
    const rl = S(44), gx = S(16);
    const total = tw + rl + gx + (centered ? rl + gx : 0);
    return {
      h: Math.round(ts * 1.3), gap,
      draw: (y) => {
        const sx = centered ? Math.round(x0 - total / 2) : x0;
        const ry = Math.round(y + ts * 0.62);
        let out = '<rect x="' + sx + '" y="' + ry + '" width="' + rl + '" height="' + S(3) + '" fill="' + c.accent + '"/>';
        out += _lines([label], sx + rl + gx, y, ts, { family: FONT_BODY, weight: 700, fill: tone.label, spacing: sp, lh: 1.3 });
        if (centered) out += '<rect x="' + Math.round(sx + rl + gx + tw + gx - sp) + '" y="' + ry + '" width="' + rl + '" height="' + S(3) + '" fill="' + c.accent + '"/>';
        return out;
      },
    };
  }

  function bHead(tone, startSize, maxLines, twoTone) {
    const hs = Math.round(S(startSize) * (0.55 + 0.45 * scale));
    const head = _fit(dCase(spec.headline), hs, S(40), w, maxLines, dF, dSpR, true);
    return {
      h: Math.round(head.lines.length * head.size * dLH), gap: S(wide ? 24 : 38), size: head.size,
      draw: (y) => _lines(head.lines, x0, y, head.size, {
        family: dFam, weight: dWeight, anchor, lh: dLH, spacing: head.size * dSpR,
        fill: (i, n) => (twoTone && n > 1 && i === n - 1 ? tone.sub : tone.ink),
      }),
    };
  }

  function bRule(style, tone) {
    if (style === 'orn') {
      const seg = S(86), d = S(8);
      return {
        h: S(16), gap: S(34),
        draw: (y) => {
          const cy = y + S(8);
          return '<rect x="' + (x0 - d - S(14) - seg) + '" y="' + (cy - 1) + '" width="' + seg + '" height="' + Math.max(1, S(2)) + '" fill="' + c.accent + '"/>' +
            '<rect x="' + (x0 + d + S(14)) + '" y="' + (cy - 1) + '" width="' + seg + '" height="' + Math.max(1, S(2)) + '" fill="' + c.accent + '"/>' +
            '<rect x="' + (x0 - d / 2) + '" y="' + (cy - d / 2) + '" width="' + d + '" height="' + d + '" fill="' + c.accent + '" transform="rotate(45 ' + x0 + ' ' + cy + ')"/>';
        },
      };
    }
    if (style === 'hair') {
      return {
        h: S(5), gap: S(34),
        draw: (y) => hair(left, y + S(2), w, tone, 0.22) + '<rect x="' + left + '" y="' + y + '" width="' + S(90) + '" height="' + S(5) + '" fill="' + c.accent + '"/>',
      };
    }
    return {
      h: S(8), gap: S(wide ? 28 : 46),
      draw: (y) => '<rect x="' + x0 + '" y="' + y + '" width="' + S(110) + '" height="' + S(8) + '" rx="' + S(4) + '" fill="' + c.accent + '"/>',
    };
  }

  function bSub(tone) {
    if (!spec.subheadline) return null;
    const ss = Math.round(S(wide ? 29 : 40) * scale);
    const sub = _fit(spec.subheadline, ss, S(22), w, 3, 1.0, 0, true);
    return {
      h: Math.round(sub.lines.length * sub.size * 1.25), gap: S(wide ? 18 : 28),
      draw: (y) => _lines(sub.lines, x0, y, sub.size, {
        family: serif ? FONT_SERIF : FONT_BODY, weight: serif ? 400 : 600, style: serif ? 'italic' : '',
        fill: tone.sub, anchor, lh: 1.25,
      }),
    };
  }

  function bBody(tone) {
    if (!spec.body) return null;
    const bs = Math.round(S(wide ? 24 : 30) * scale);
    const measure = Math.min(w, S(centered ? 680 : 760));
    const lines = centered ? _balance(spec.body, bs, measure, 1.0, 0) : _wrap(spec.body, bs, measure, 1.0, 0);
    return {
      h: Math.round(lines.length * bs * 1.5), gap: S(wide ? 18 : 36),
      draw: (y) => _lines(lines, x0, y, bs, { family: FONT_BODY, weight: 400, fill: tone.ink, anchor, lh: 1.5, opacity: 0.88 }),
    };
  }

  function bBullets(tone) {
    if (!spec.bullets.length) return null;
    const bs = Math.round(S(wide ? 27 : 34) * scale);
    const lh = 1.3;
    const padY = S(wide ? 11 : 17);
    const ind = centered ? 0 : S(42);
    const items = spec.bullets;
    const colGap = S(48);
    const twoCol = !centered && !wide && items.length >= 4 && items.every((t) => _tw(t, bs, 1.0, 0) < (w - colGap) / 2 - ind);
    const mk = (cx, cy) => '<rect x="' + Math.round(cx - S(7)) + '" y="' + Math.round(cy - S(7)) + '" width="' + S(14) + '" height="' + S(14) + '" rx="' + S(3) + '" fill="' + c.accent + '"/>';

    if (twoCol) {
      const cw = Math.floor((w - colGap) / 2);
      const rows = [];
      for (let i = 0; i < items.length; i += 2) rows.push(items.slice(i, i + 2).map((t) => _wrap(t, bs, cw - ind, 1.0, 0)));
      const rh = rows.map((r) => Math.max(...r.map((l) => l.length)) * bs * lh + padY * 2);
      return {
        h: Math.round(rh.reduce((a, b) => a + b, 0)), gap: S(wide ? 20 : 38),
        draw: (y) => {
          let out = '', cy = y;
          rows.forEach((r, ri) => {
            r.forEach((lines, ci) => {
              const cx = left + ci * (cw + colGap);
              out += mk(cx + S(7), cy + padY + bs * 0.55) + _lines(lines, cx + ind, cy + padY, bs, { family: FONT_BODY, weight: 500, fill: tone.ink, lh });
            });
            cy += rh[ri];
          });
          return out;
        },
      };
    }

    const sepH = centered ? S(30) : 0;
    const rows = items.map((t) => _wrap(t, bs, w - ind, 1.0, 0));
    const rh = rows.map((l) => l.length * bs * lh + padY * 2 + sepH);
    const total = rh.reduce((a, b) => a + b, 0) - sepH;
    return {
      h: Math.round(total), gap: S(wide ? 20 : 38),
      draw: (y) => {
        let out = '', cy = y;
        rows.forEach((lines, i) => {
          if (centered) {
            out += _lines(lines, x0, cy + padY, bs, { family: FONT_BODY, weight: 500, fill: tone.ink, anchor, lh });
            if (i < rows.length - 1) {
              const my = cy + padY * 2 + lines.length * bs * lh + sepH / 2 - padY;
              out += '<rect x="' + (x0 - S(4)) + '" y="' + Math.round(my - S(4)) + '" width="' + S(8) + '" height="' + S(8) + '" fill="' + c.accent + '" transform="rotate(45 ' + x0 + ' ' + Math.round(my) + ')"/>';
            }
          } else {
            if (i > 0) out += hair(left, cy, w, tone, 0.16);
            out += mk(left + S(7), cy + padY + bs * 0.55) + _lines(lines, left + ind, cy + padY, bs, { family: FONT_BODY, weight: 500, fill: tone.ink, lh });
          }
          cy += rh[i];
        });
        return out;
      },
    };
  }

  function bDetails(tone) {
    if (!spec.details.length) return null;
    const ds = Math.round(S(wide ? 25 : 33) * scale);
    const ls = Math.round(S(wide ? 15 : 19) * Math.max(scale, 0.8));
    const lsp = ls * 0.16;
    const rows = spec.details.map((d) => {
      const m = d.match(/^([^:]{1,22}):\s*(.+)$/);
      return m ? { label: m[1].trim().toUpperCase(), value: m[2].trim() } : { label: '', value: d };
    });
    const n = rows.length;
    const lw = (r) => _tw(r.label, ls, 1.08, lsp);

    // Two or three short labelled facts (date / time / venue) sit side by
    // side as columns, the way an event poster would set them.
    const cgap = S(34);
    const cw = Math.floor((w - cgap * (n - 1)) / Math.max(n, 1));
    const colLines = rows.map((r) => _wrap(r.value, ds, cw, 1.0, 0));
    const useCols = n >= 2 && n <= 3 && rows.every((r) => r.label) && colLines.every((l) => l.length <= 2) &&
      rows.every((r) => lw(r) <= cw && r.value.split(' ').every((wd) => _tw(wd, ds, 1.0, 0) <= cw));

    if (useCols) {
      const padT = S(24), labH = ls * 1.3, mid = S(10);
      const maxL = Math.max(...colLines.map((l) => l.length));
      const h = Math.round(padT + labH + mid + maxL * ds * 1.25 + S(8));
      return {
        h, gap: S(wide ? 24 : 42),
        draw: (y) => {
          let out = hair(left, y, w, tone, 0.28) + '<rect x="' + (centered ? Math.round(x0 - S(40)) : left) + '" y="' + Math.round(y - S(1.5)) + '" width="' + S(80) + '" height="' + S(5) + '" fill="' + c.accent + '"/>';
          rows.forEach((r, i) => {
            const cx = left + i * (cw + cgap);
            const tx = centered ? cx + cw / 2 : cx;
            if (i > 0) out += '<rect x="' + Math.round(cx - cgap / 2) + '" y="' + Math.round(y + padT) + '" width="' + Math.max(1, S(2)) + '" height="' + Math.round(h - padT - S(8)) + '" fill="' + tone.hair + '" fill-opacity="0.2"/>';
            out += _lines([r.label], Math.round(tx + (centered ? lsp / 2 : 0)), y + padT, ls, { family: FONT_BODY, weight: 800, fill: tone.label, anchor, spacing: lsp, lh: 1.3 });
            out += _lines(colLines[i], tx, y + padT + labH + mid, ds, { family: FONT_BODY, weight: 700, fill: tone.ink, anchor, lh: 1.25 });
          });
          return out;
        },
      };
    }

    // Otherwise: ruled label / value rows (stacked label-over-value when centred).
    const padY = S(wide ? 12 : 17);
    const labW = centered ? 0 : Math.min(Math.round(w * 0.32), Math.max(0, ...rows.filter((r) => r.label).map(lw)) + S(30));
    const laid = rows.map((r) => {
      const lines = _wrap(r.value, ds, centered || !r.label ? w : w - labW, 1.0, 0);
      const h = centered
        ? (r.label ? ls * 1.3 + S(8) : 0) + lines.length * ds * 1.25 + padY * 2
        : Math.max(lines.length * ds * 1.25, ls * 1.3) + padY * 2;
      return { r, lines, h };
    });
    const total = laid.reduce((a, l) => a + l.h, 0);
    return {
      h: Math.round(total), gap: S(wide ? 24 : 42),
      draw: (y) => {
        let out = '', cy = y;
        laid.forEach(({ r, lines, h }) => {
          out += hair(left, cy, w, tone, 0.24);
          if (centered) {
            let ty = cy + padY;
            if (r.label) { out += _lines([r.label], Math.round(x0 + lsp / 2), ty, ls, { family: FONT_BODY, weight: 800, fill: tone.label, anchor, spacing: lsp, lh: 1.3 }); ty += ls * 1.3 + S(8); }
            out += _lines(lines, x0, ty, ds, { family: FONT_BODY, weight: 600, fill: tone.ink, anchor, lh: 1.25 });
          } else {
            if (r.label) out += _lines([r.label], left, cy + padY + ds * 0.2, ls, { family: FONT_BODY, weight: 800, fill: tone.label, spacing: lsp, lh: 1.3 });
            out += _lines(lines, left + (r.label ? labW : 0), cy + padY, ds, { family: FONT_BODY, weight: 600, fill: tone.ink, lh: 1.25 });
          }
          cy += h;
        });
        out += hair(left, cy, w, tone, 0.24);
        return out;
      },
    };
  }

  function bCta(tone) {
    if (!spec.cta) return null;
    const label = spec.cta.toUpperCase();
    let cs = Math.round(S(wide ? 22 : 30) * Math.max(scale, 0.85));
    const measure = (s) => s * 1.1 * 2 + _tw(label, s, 1.1, s * 0.12) + s * 0.7 + s * 1.1;
    while (measure(cs) > w && cs > S(16)) cs -= 1;
    const tw = _tw(label, cs, 1.1, cs * 0.12);
    const padX = cs * 1.1, aw = cs * 1.1;
    const bw = Math.min(w, Math.round(measure(cs)));
    const bh = Math.round(cs * 2.5);
    return {
      h: bh, gap: S(wide ? 20 : 30),
      draw: (y) => {
        const bx = align(bw);
        const ay = y + bh / 2;
        const ax = bx + padX + tw + cs * 0.7;
        return '<rect x="' + bx + '" y="' + y + '" width="' + bw + '" height="' + bh + '" rx="' + Math.round(bh / 2) + '" fill="' + tone.btn + '"/>' +
          _lines([label], Math.round(bx + padX), y + (bh - cs * 1.2) / 2, cs, { family: FONT_BODY, weight: 800, fill: tone.btnInk, spacing: cs * 0.12, lh: 1.2 }) +
          '<path d="M' + Math.round(ax) + ' ' + Math.round(ay) + ' H' + Math.round(ax + aw) + ' M' + Math.round(ax + aw - cs * 0.4) + ' ' + Math.round(ay - cs * 0.4) + ' L' + Math.round(ax + aw) + ' ' + Math.round(ay) + ' L' + Math.round(ax + aw - cs * 0.4) + ' ' + Math.round(ay + cs * 0.4) + '" fill="none" stroke="' + tone.btnInk + '" stroke-width="' + S(3.5) + '" stroke-linecap="round" stroke-linejoin="round"/>';
      },
    };
  }

  function bFooter(tone) {
    if (!spec.footer) return null;
    const fs = S(wide ? 18 : 22);
    const txt = spec.footer.length <= 36 ? spec.footer.toUpperCase() : spec.footer;
    const lines = _wrap(txt, fs, w, 1.05, 0.08).slice(0, 2);
    const h = Math.round(S(24) + lines.length * fs * 1.4);
    return {
      h,
      draw: (y) => (centered ? hair(x0 - S(40), y, S(80), tone, 0.35) : hair(left, y, w, tone, 0.22)) +
        _lines(lines, x0, y + S(24), fs, { family: FONT_BODY, weight: 600, fill: tone.ink, anchor, lh: 1.4, opacity: 0.8, spacing: fs * 0.08 }),
    };
  }

  // Circular picture for formal pieces (invitations).
  function bMedallion() {
    if (!bg || !centered) return null;
    const r = S(wide ? 105 : 150);
    const h = 2 * (r + S(24));
    return {
      h, gap: S(34),
      draw: (y) => {
        const cy = y + r + S(24);
        return '<clipPath id="med"><circle cx="' + x0 + '" cy="' + cy + '" r="' + r + '"/></clipPath>' +
          '<image href="' + href + '" x="' + (x0 - r) + '" y="' + (cy - r) + '" width="' + 2 * r + '" height="' + 2 * r + '" preserveAspectRatio="' + pAR + '" clip-path="url(#med)"/>' +
          '<circle cx="' + x0 + '" cy="' + cy + '" r="' + (r + S(10)) + '" fill="none" stroke="' + c.accent + '" stroke-width="' + S(4) + '"/>' +
          '<circle cx="' + x0 + '" cy="' + cy + '" r="' + (r + S(24)) + '" fill="none" stroke="' + c.accent + '" stroke-opacity="0.4" stroke-width="' + S(1.5) + '"/>';
      },
    };
  }

  // Picture window for the editorial layout. Without a photo it becomes a
  // single flat shape on a solid field: one idea, no extra ornament.
  function bWindow(wh) {
    return {
      h: wh, gap: S(40),
      draw: (y) => {
        const r = S(30), ox = left, ww = w;
        let out = '<clipPath id="win"><rect x="' + ox + '" y="' + y + '" width="' + ww + '" height="' + wh + '" rx="' + r + '"/></clipPath>';
        if (bg) {
          out += '<image href="' + href + '" x="' + ox + '" y="' + y + '" width="' + ww + '" height="' + wh + '" preserveAspectRatio="' + pAR + '" clip-path="url(#win)"/>';
        } else {
          out += '<g clip-path="url(#win)"><rect x="' + ox + '" y="' + y + '" width="' + ww + '" height="' + wh + '" fill="' + c.primary + '"/>';
          if (seed === 0) out += '<circle cx="' + Math.round(ox + ww * 0.7) + '" cy="' + Math.round(y + wh * 0.5) + '" r="' + Math.round(wh * 0.34) + '" fill="' + c.accent + '"/>';
          else if (seed === 1) {
            const aw = Math.round(wh * 0.52), ax = Math.round(ox + ww * 0.62), ah = Math.round(wh * 0.74), ay = y + wh - ah;
            out += '<path d="M' + ax + ' ' + (y + wh) + ' V' + (ay + aw / 2) + ' A' + aw / 2 + ' ' + aw / 2 + ' 0 0 1 ' + (ax + aw) + ' ' + (ay + aw / 2) + ' V' + (y + wh) + ' Z" fill="' + c.accent + '"/>';
          } else out += '<circle cx="' + Math.round(ox + ww * 0.5) + '" cy="' + (y + wh) + '" r="' + Math.round(wh * 0.52) + '" fill="' + c.accent + '"/>';
          out += '</g>';
        }
        return out;
      },
    };
  }

  // The person's own logo. On a coloured surface it sits on a light plate so
  // a dark logo never disappears; on paper it is placed directly.
  function bLogo(onDark) {
    const lg = extras && extras.logo;
    if (!lg) return null;
    const maxW = S(wide ? 210 : 290), maxH = S(wide ? 76 : 108);
    const ratio = lg.w > 0 && lg.h > 0 ? lg.w / lg.h : 1;
    const bw = Math.round(Math.min(maxW, maxH * ratio));
    const bh = Math.round(bw / ratio);
    const pad = onDark ? S(16) : 0;
    const pw = bw + pad * 2, ph = bh + pad * 2;
    const src = 'data:' + lg.mime + ';base64,' + lg.base64;
    return {
      h: ph, gap: S(wide ? 24 : 40),
      draw: (y) => {
        const px = align(pw);
        return (onDark ? '<rect x="' + px + '" y="' + y + '" width="' + pw + '" height="' + ph + '" rx="' + S(14) + '" fill="' + c.light + '"/>' : '') +
          '<image href="' + src + '" x="' + (px + pad) + '" y="' + (y + pad) + '" width="' + bw + '" height="' + bh + '" preserveAspectRatio="xMidYMid meet"/>';
      },
    };
  }

  // ── Page assembly ───────────────────────────────────────────────────
  // Backgrounds are flat colour with at most one deliberate graphic idea
  // (a cropped letter, a single circle, an arch). No stacked gradients,
  // rings or confetti: restraint is what makes it look designed.
  const defs = [];
  let back = '';
  let content = '';
  let fits = true;

  const bodyTone = layout === 'split' || layout === 'editorial' ? light : dark;
  const footer = bFooter(bodyTone);
  const footTop = H - padBot - (footer ? footer.h : 0);
  const limit = footer ? footTop - S(40) : H - padBot;
  const spacer = (h) => ({ h, gap: 0, draw: () => '' });
  const tonal = _mix(c.primary, darkInk, 0.08);
  const initial = (spec.headline.match(/[A-Za-z0-9]/) || ['A'])[0].toUpperCase();
  const letter = (x, base, size, fill) => '<text x="' + x + '" y="' + base + '" font-size="' + size + '" font-family="' + FONT_HEAD + '" font-weight="900" fill="' + fill + '" text-anchor="end">' + initial + '</text>';
  const solid = '<rect width="' + W + '" height="' + H + '" fill="url(#base)"/>';

  defs.push('<linearGradient id="base" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + c.primary + '"/><stop offset="1" stop-color="' + _mix(c.primary, c.deep, 0.55) + '"/></linearGradient>');
  defs.push('<linearGradient id="shade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + c.deep + '" stop-opacity="0.8"/><stop offset="0.36" stop-color="' + c.deep + '" stop-opacity="0.4"/><stop offset="0.62" stop-color="' + c.deep + '" stop-opacity="0.5"/><stop offset="1" stop-color="' + c.deep + '" stop-opacity="0.95"/></linearGradient>');
  defs.push('<linearGradient id="hshade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + c.deep + '" stop-opacity="0.3"/><stop offset="0.5" stop-color="' + c.deep + '" stop-opacity="0.6"/><stop offset="1" stop-color="' + c.deep + '" stop-opacity="0.92"/></linearGradient>');
  defs.push('<linearGradient id="fade" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + c.deep + '" stop-opacity="0.22"/><stop offset="0.4" stop-color="' + c.deep + '" stop-opacity="0.06"/><stop offset="0.68" stop-color="' + c.deep + '" stop-opacity="0.86"/><stop offset="1" stop-color="' + c.deep + '" stop-opacity="0.97"/></linearGradient>');
  defs.push('<linearGradient id="side" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="' + c.primary + '"/><stop offset="1" stop-color="' + c.primary + '" stop-opacity="0"/></linearGradient>');

  if (layout === 'split') {
    const hero = [bLogo(true), bTag(dark, false), bHead(dark, 112, 4, true), bRule('bar', dark)];
    const heroContent = _total(hero);
    const minHero = Math.round(H * (bg ? 0.46 : 0.36));
    const heroH = Math.min(Math.round(H * 0.62), Math.max(minHero, heroContent + Math.round(padTop * 0.7) + S(78)));
    back += '<rect width="' + W + '" height="' + H + '" fill="' + c.light + '"/><clipPath id="hclip"><rect width="' + W + '" height="' + heroH + '"/></clipPath>';
    if (bg) {
      back += '<image href="' + href + '" width="' + W + '" height="' + heroH + '" preserveAspectRatio="' + pAR + '" clip-path="url(#hclip)"/><rect width="' + W + '" height="' + heroH + '" fill="url(#hshade)"/>';
    } else {
      back += '<rect width="' + W + '" height="' + heroH + '" fill="' + c.primary + '"/><g clip-path="url(#hclip)">' + letter(W + S(24), Math.round(heroH + heroH * 0.14), Math.round(heroH * 1.25), tonal) + '</g>';
    }
    back += '<rect y="' + (heroH - S(12)) + '" width="' + W + '" height="' + S(12) + '" fill="' + c.accent + '"/>';
    const hy = Math.max(Math.round(padTop * 0.6), heroH - S(78) - heroContent);
    content += _stack(hero, hy, 0, false).svg;
    const lower = [bSub(light), bBody(light), bBullets(light), bDetails(light), bCta(light)];
    const ly = heroH + S(66);
    const res = _stack(lower, ly, limit - ly, true);
    content += res.svg;
    fits = hy + heroContent <= heroH - S(60) && ly + res.h <= limit;
  } else if (layout === 'editorial') {
    back += '<rect width="' + W + '" height="' + H + '" fill="' + c.light + '"/><rect width="' + W + '" height="' + S(14) + '" fill="' + c.primary + '"/>';
    const y0 = Math.round(padTop * 0.9);
    const pre = [bLogo(false), bTag(light, false), bHead(light, 104, 4, false), bRule('hair', light)];
    const post = [bSub(light), bBody(light), bBullets(light), bDetails(light), bCta(light)];
    const others = _total(pre) + (pre.filter(Boolean).length ? pre.filter(Boolean).slice(-1)[0].gap : 0) + _total(post) + S(40);
    const wh = Math.min(Math.round(H * 0.36), Math.round(limit - y0 - others));
    const winH = Math.max(wh, S(150));
    const res = _stack([...pre, bWindow(winH), ...post], y0, limit - y0, true);
    content += res.svg;
    fits = wh >= S(150) && y0 + res.h <= limit;
  } else {
    // Single-surface layouts: bold, poster, centered, and the banner variant of bold.
    if (layout === 'centered') {
      const o = S(52);
      back += '<rect width="' + W + '" height="' + H + '" fill="' + c.primary + '"/>' +
        '<rect x="' + o + '" y="' + o + '" width="' + (W - o * 2) + '" height="' + (H - o * 2) + '" fill="none" stroke="' + c.accent + '" stroke-width="' + S(2.5) + '"/>';
    } else if (layout === 'poster') {
      if (bg) {
        back += '<rect width="' + W + '" height="' + H + '" fill="' + c.deep + '"/><image href="' + href + '" width="' + W + '" height="' + H + '" preserveAspectRatio="' + pAR + '"/><rect width="' + W + '" height="' + H + '" fill="url(#fade)"/>';
      } else {
        back += solid;
        if (seed === 0) back += '<circle cx="' + Math.round(W * 0.66) + '" cy="' + Math.round(H * 0.3) + '" r="' + Math.round(W * 0.29) + '" fill="' + c.accent + '"/>';
        else if (seed === 1) {
          const aw = Math.round(W * 0.5), ax = W - margin - aw, ay = Math.round(H * 0.1), ah = Math.round(H * 0.44);
          back += '<path d="M' + ax + ' ' + (ay + ah) + ' V' + (ay + aw / 2) + ' A' + aw / 2 + ' ' + aw / 2 + ' 0 0 1 ' + (ax + aw) + ' ' + (ay + aw / 2) + ' V' + (ay + ah) + ' Z" fill="' + c.accent + '"/>';
        } else back += letter(W + S(12), Math.round(H * 0.52), Math.round(W * 1.1), tonal);
      }
    } else if (bg && !wide) {
      back += '<rect width="' + W + '" height="' + H + '" fill="' + c.deep + '"/><image href="' + href + '" width="' + W + '" height="' + H + '" preserveAspectRatio="' + pAR + '"/><rect width="' + W + '" height="' + H + '" fill="url(#shade)"/>';
    } else {
      back += solid;
      if (wide) {
        if (bg) {
          back += '<clipPath id="pclip"><rect x="' + panelX + '" width="' + (W - panelX) + '" height="' + H + '"/></clipPath><image href="' + href + '" x="' + panelX + '" width="' + (W - panelX) + '" height="' + H + '" preserveAspectRatio="' + pAR + '" clip-path="url(#pclip)"/>' +
            '<rect x="' + (panelX - 1) + '" width="' + S(260) + '" height="' + H + '" fill="url(#side)"/>';
        } else {
          back += '<circle cx="' + Math.round(W * 0.8) + '" cy="' + Math.round(H * 0.5) + '" r="' + Math.round(H * 0.32) + '" fill="' + c.accent + '"/>';
        }
      } else if (seed === 0) back += '<g>' + letter(W + S(30), Math.round(H * 0.97), Math.round(W * 0.92), tonal) + '</g>';
      else if (seed === 1) back += '<rect width="' + S(22) + '" height="' + H + '" fill="' + c.accent + '"/>';
      else back += '<circle cx="' + Math.round(W * 0.92) + '" cy="' + Math.round(H * 0.93) + '" r="' + Math.round(W * 0.42) + '" fill="' + tonal + '"/>';
    }

    const tagPill = layout === 'bold' || layout === 'poster';
    const tag = bTag(dark, tagPill && !centered);
    if (layout === 'centered') {
      const group = [bLogo(true), bMedallion(), tag, bHead(dark, 92, 4, false), bRule('orn', dark), bSub(dark), bBody(dark)];
      const lower = [bBullets(dark), bDetails(dark), bCta(dark)];
      const all = lower.some(Boolean) ? [...group, spacer(S(26)), ...lower] : group;
      const gh = _total(all);
      const y = padTop + Math.max(0, (limit - padTop - gh) * 0.46);
      content += _stack(all, y, 0, false).svg;
      fits = gh <= limit - padTop;
    } else if (layout === 'poster') {
      const hero = [bHead(dark, 150, 4, true), bRule('bar', dark), bSub(dark), bBody(dark)];
      const lower = [bBullets(dark), bDetails(dark), bCta(dark)];
      const all = lower.some(Boolean) ? [...hero, spacer(S(18)), ...lower] : hero;
      const gh = _total(all);
      const y = limit - gh;
      const topB = [bLogo(true), tag];
      content += _stack(topB, padTop, 0, false).svg;
      content += _stack(all, y, 0, false).svg;
      const topH = topB.some(Boolean) ? _total(topB) + S(60) : 0;
      fits = y >= padTop + topH + Math.round(H * (story ? 0.2 : 0.26));
    } else {
      const hero = [bLogo(true), tag, bHead(dark, wide ? 84 : (story ? 128 : 124), wide ? 3 : 4, true), bRule('bar', dark), bSub(dark), bBody(dark)];
      const lower = [bBullets(dark), bDetails(dark), bCta(dark)];
      const hh = _total(hero);
      if (!lower.some(Boolean)) {
        const y = padTop + Math.max(0, (limit - padTop - hh) * 0.34);
        content += _stack(hero, y, 0, false).svg;
        fits = hh <= limit - padTop;
      } else {
        const lh = _total(lower);
        const ly = limit - lh;
        content += _stack(hero, padTop, 0, false).svg;
        content += _stack(lower, ly, 0, false).svg;
        fits = padTop + hh + S(wide ? 24 : 50) <= ly;
      }
    }
  }

  if (footer) content += footer.draw(footTop);

  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + _esc(spec.headline) + '">' +
    '<defs>' + defs.join('') + '</defs>' + back + content + '</svg>';
  return { svg, width: W, height: H, fits };
}
