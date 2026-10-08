// design-direction.js
//
// Art direction for create_design.
//
// media-tools.js knows HOW to set type, space and pictures. This file decides
// WHAT SHOULD HAPPEN for one particular request, before anything is drawn:
//
//   1. INTENT  what is this piece for? a promotion, an event, practical
//              information, an editorial piece, a single statement (quote,
//              greeting, notice) or a formal occasion.
//   2. TONE    how should it feel? corporate, warm, luxurious, playful, calm
//              or loud. Tone is the brand personality: it drives the type
//              voice and colour relationship.
//   3. FOCAL   what must the eye hit first? the headline, the date, the offer,
//              the picture, or one single statement.
//   4. RECIPE  a composition built for that intent, format, amount of copy
//              and picture situation. Each intent has several recipes and one
//              is picked per brief, so two different requests do not
//              automatically share a visual structure.
//
// The result (the "direction") is a plain object the renderer reads: layout,
// type voice and scale, where the type is anchored, how much air it gets, how
// wide the text column is, whether the date or price is promoted to a second
// focal point, how the two colours relate, which single graphic idea (if any)
// is used, and how the picture is cropped, zoomed and treated.
//
// Everything here is pure and deterministic (no I/O, no randomness): the same
// brief always gets the same direction, so a follow-up such as "make it bluer"
// keeps its composition, while a different brief gets a different one. If
// anything in here throws, media-tools.js falls back to the classic renderer.

export const DESIGN_LAYOUTS = ['bold', 'split', 'centered', 'editorial', 'poster', 'stack', 'frame'];
const DESIGN_KINDS = ['flyer', 'poster', 'invitation', 'social_post', 'story', 'banner'];

// Detail lines look like "Date: Saturday 12 July". These decide which label
// counts as the date or the price, for both this file and the renderer.
export const KEY_FACT_RX = {
  date: /^(?:date|when|day|deadline)$/i,
  price: /^(?:price|cost|ticket|tickets|fee|entry|admission|offer)$/i,
};
const VENUE_LABEL = /^(?:venue|location|address|where)$/i;

// Returns { index, label, value } for the first detail of that kind that is
// short enough to be set as a large second focal line, otherwise null.
export function pickKeyFact(details, which) {
  const re = KEY_FACT_RX[which];
  if (!re || !Array.isArray(details)) return null;
  for (let i = 0; i < details.length; i++) {
    const m = String(details[i]).trim().match(/^([^:]{1,22}):\s*(.+)$/);
    if (m && re.test(m[1].trim()) && m[2].trim().length <= 34) {
      return { index: i, label: m[1].trim().toUpperCase(), value: m[2].trim() };
    }
  }
  return null;
}

// ── Signals ─────────────────────────────────────────────────────────────

const SIGNALS = {
  formal: /\b(?:wedding|bridal|engagement|anniversary|funeral|memorial|burial|obituary|in loving memory|rest in peace|celebration of life|graduation|convocation|naming ceremony|christening|dedication|baby shower|certificate|awards? (?:night|ceremony)|gala dinner|thanksgiving service|ordination|induction|retirement)\b/i,
  message: /\b(?:quotes?|motivational|inspirational|affirmation|proverb|scripture|bible verse|verse of the day|prayer|greetings?|thank you|thanks|congratulations|congrats|happy (?:birthday|anniversary|new year|easter|christmas|sallah|eid|mother|father|women)|good morning|tip of the day|fun fact|reminder|shout-?out|welcome|we(?:'re| are) closed|public holiday)\b/i,
  event: /\b(?:event|conference|summit|seminar|workshop|webinar|concert|festival|crusade|revival|service|retreat|meetup|launch|party|tournament|fundraiser|gala|expo|fair|screening|training|bootcamp|hackathon|open day|rally|convention|outreach|class(?:es)?|masterclass|reunion|camp|crossover|vigil|marathon|movie night|game night)\b/i,
  promo: /\b(?:sale|discounts?|promo|promotion|deals?|clearance|black friday|grand opening|now open|new arrivals?|best price|free delivery|order now|buy|shop now|limited (?:time|offer|stock|edition|slots|seats)|special offer|specials?|bundle|coupon|voucher|cashback|flash sale)\b/i,
  info: /\b(?:hiring|vacanc\w+|recruit\w*|careers?|admissions?|enrol\w*|apply|application|scholarship|programmes?|programs?|courses?|curriculum|services|menu|price list|timetable|schedule|rules|notice|guidelines|requirements|how to|steps|pricing|packages|opening hours|office hours|what we offer)\b/i,
  editorial: /\b(?:awareness|campaign|report|insights?|article|blog|podcast|episode|interview|newsletter|magazine|series|season|edition|issue|essay|documentary|exhibition|portfolio|case study|research|survey|whitepaper|book|album|single|mixtape|review)\b/i,
};
const PCT = /\d\s?%|\bpercent off\b/i;
const QUOTE = /\b(?:quotes?|motivational|inspirational|affirmation|proverb|scripture|bible verse|verse of the day|quote of the day|prayer|wisdom)\b/i;
const SOLEMN = /\b(?:funeral|memorial|burial|obituary|in loving memory|rest in peace|celebration of life|tribute|homegoing|home going|passed away)\b/i;

const TONE_RX = {
  luxury: /\b(?:luxury|luxurious|premium|exclusive|bespoke|couture|fine dining|jewel\w*|boutique|elegant|elegance|prestige|signature|black[- ]tie|champagne|vip|atelier|haute)\b/i,
  corporate: /\b(?:conference|summit|tech|technology|digital|software|ai|artificial intelligence|startup|fintech|webinar|business|professional|b2b|bank|banking|insurance|consult\w*|seminar|leadership|enterprise|corporate|networking|investor|saas|cyber|data|cloud|engineering|developer|hackathon|innovation|finance|accounting|legal)\b/i,
  warm: /\b(?:church|ministry|community|family|fellowship|school|charity|foundation|outreach|thanksgiving|prayer|crusade|revival|worship|gospel|mosque|parish|choir|bible|faith|ngo|orphanage|donation|harvest)\b/i,
  playful: /\b(?:kids?|children|youths?|teens?|teenagers?|party|fun|festival|carnival|fiesta|summer|dj|dance|disco|karaoke|hangout|vibes?|birthday|cartoon|toys?|funfair|games?|ice cream|candy|pizza|burger)\b/i,
  calm: /\b(?:organic|wellness|spa|yoga|farm|garden|nature|natural|eco|sustainab\w*|skincare|beauty|salon|meditation|mindful\w*|herbal|florist|flowers?|bakery|cafe|coffee|tea|ceramics?|candle)\b/i,
  loud: /\b(?:sale|clearance|blowout|flash|gym|fitness|sports?|football|boxing|racing|tournament|mega|hot|extreme|battle|champion\w*|derby|rally|concert|hip ?hop|afrobeats?)\b/i,
};

const INTENT_ORDER = ['formal', 'message', 'event', 'promo', 'info', 'editorial'];
const TONE_ORDER = ['luxury', 'corporate', 'warm', 'playful', 'calm', 'loud'];

// ── Helpers ─────────────────────────────────────────────────────────────

const _str = (v) => (typeof v === 'string' ? v.trim() : '');
const _arr = (v) => (Array.isArray(v) ? v : []).map((x) => String(x == null ? '' : x).trim()).filter(Boolean);
const _clamp = (n, lo, hi, dflt) => (Number.isFinite(Number(n)) && n !== null && n !== '' ? Math.min(hi, Math.max(lo, Number(n))) : dflt);

function _hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  return h;
}

// Counts matches (capped, so one repeated word cannot dominate).
function _hits(text, re) {
  const m = text.match(new RegExp(re.source, 'gi'));
  return m ? Math.min(m.length, 3) : 0;
}

function _facts(a, x) {
  const kind = DESIGN_KINDS.includes(a.kind) ? a.kind : 'flyer';
  const bullets = _arr(a.bullets);
  const details = _arr(a.details);
  const body = _str(a.body);
  const bodyWords = body ? body.split(/\s+/).length : 0;
  const labelled = (re) => details.some((d) => {
    const m = d.match(/^([^:]{1,22}):/);
    return !!m && re.test(m[1].trim());
  });
  const own = [a.tagline, a.headline, a.subheadline, body, a.cta, a.footer].map(_str).concat(bullets, details).join(' ').toLowerCase();
  const items = bullets.length + details.length;
  return {
    kind,
    wide: kind === 'banner',
    story: kind === 'story',
    square: kind === 'social_post',
    headline: _str(a.headline),
    bullets: bullets.length,
    details: details.length,
    items,
    bodyWords,
    words: bodyWords + items * 4,
    hasCta: !!_str(a.cta),
    hasDate: labelled(KEY_FACT_RX.date),
    hasPrice: labelled(KEY_FACT_RX.price),
    hasVenue: labelled(VENUE_LABEL),
    userImage: !!x.userImage,
    hasImage: !!x.userImage || !!_str(a.image_prompt),
    custom: /^#?[0-9a-f]{6}$/i.test(_str(a.primary_color)),
    own,
  };
}

// ── 1. Intent ───────────────────────────────────────────────────────────

function _intent(f, recent) {
  const s = {};
  for (const k of INTENT_ORDER) s[k] = 2 * _hits(f.own, SIGNALS[k]) + _hits(recent, SIGNALS[k]);
  if (PCT.test(f.own)) s.promo += 2;
  if (f.kind === 'invitation') s.formal += 3;
  if (f.hasDate) s.event += 1.5;
  if (f.hasVenue) s.event += 1;
  if (f.hasPrice) s.promo += 1.5;
  if (f.hasCta && !f.hasDate) s.promo += 0.5;
  if (f.bullets >= 3) s.info += 1.5;
  if (!f.items && !f.hasCta && f.bodyWords <= 24) s.message += 1.5;
  if (f.kind === 'poster' && !f.hasCta && !f.hasPrice) s.editorial += 0.75;
  let best = null;
  let top = 0;
  for (const k of INTENT_ORDER) {
    if (s[k] > top) { top = s[k]; best = k; }
  }
  if (best) return best;
  // Nothing in the words: judge by the format and how much copy there is.
  if (f.kind === 'poster') return 'editorial';
  if (f.square || f.story) return f.items ? 'promo' : 'message';
  return f.items >= 3 ? 'info' : 'promo';
}

// ── 2. Tone and energy ──────────────────────────────────────────────────

function _tone(f, recent, theme) {
  const s = {};
  for (const k of TONE_ORDER) s[k] = 2 * _hits(f.own, TONE_RX[k]) + _hits(recent, TONE_RX[k]);
  if (theme === 'gold') s.luxury += 1;
  let best = null;
  let top = 0;
  for (const k of TONE_ORDER) {
    if (s[k] > top) { top = s[k]; best = k; }
  }
  return best;
}

function _energy(intent, tone) {
  let e = { formal: 'calm', editorial: 'calm', info: 'balanced', message: 'balanced', event: 'balanced', promo: 'loud' }[intent] || 'balanced';
  if (tone === 'luxury' || tone === 'calm') e = 'calm';
  else if (tone === 'loud' || tone === 'playful') e = 'loud';
  else if (tone === 'corporate' && e === 'loud') e = 'balanced';
  return e;
}

// ── 3. Focal point ──────────────────────────────────────────────────────

function _focal(intent, f) {
  if (intent === 'message') return 'statement';
  if (intent === 'event') return f.hasDate ? 'date' : 'headline';
  if (intent === 'promo') return f.hasPrice ? 'offer' : 'headline';
  if (intent === 'info') return 'information';
  if (intent === 'editorial') return f.hasImage ? 'image' : 'headline';
  return 'headline';
}

// ── 4. Recipes ──────────────────────────────────────────────────────────
// A recipe is a partial direction. `img` holds the picture settings
// (share = how much of the page the picture gets, radius/bleed/first = how the
// editorial window is cut, zoom/treatment = how a generated picture is cropped
// and graded). The layouts they mean:
//   bold       one colour field, type-led        poster    full-bleed picture, type low
//   split      colour header over info page      stack     picture/colour block over solid type block
//   editorial  paper, picture window, refined    centered  formal, symmetrical

function _promo(T) {
  const { f, calm, dense, img } = T;
  const keyFact = f.hasPrice ? 'price' : 'none';
  if (dense) {
    return [{ layout: 'split', voice: calm ? 'serif' : 'clean', headScale: 0.94, textScale: 0.96, tagStyle: 'rule', ruleStyle: 'bar', keyFact, emphasis: calm ? 'none' : 'lastline' }];
  }
  const v = [];
  if (calm) {
    if (img) {
      v.push({ layout: 'editorial', voice: 'serif', space: 'airy', tagStyle: 'plain', ruleStyle: 'hair', keyFact, emphasis: 'none', headScale: 0.96, img: { radius: 'sharp', bleed: T.pick(['right', 'left', 'none'], 1), share: 0.4, treatment: 'muted' } });
      v.push({ layout: 'stack', voice: 'serif', space: 'airy', tagStyle: 'plain', ruleStyle: 'hair', keyFact, emphasis: 'none', headScale: 0.96, img: { share: 0.56, treatment: 'muted' } });
    } else {
      v.push({ layout: 'bold', voice: 'serif', vAnchor: 'bottom', space: 'airy', inset: 0.06, measure: 0.88, graphic: 'none', tagStyle: 'plain', ruleStyle: 'hair', keyFact, emphasis: 'none', headScale: 1.04 });
      v.push({ layout: 'bold', voice: 'serif', vAnchor: 'middle', space: 'airy', graphic: 'letter', tagStyle: 'plain', ruleStyle: 'hair', keyFact, emphasis: 'none', headScale: 1.0 });
    }
    return v;
  }
  if (img) {
    v.push({ layout: 'frame', voice: 'grotesque', tagStyle: 'pill', ruleStyle: 'bar', keyFact, emphasis: 'lastline', img: { share: 0.42, zoom: 1.04 } });
    v.push({ layout: 'stack', voice: 'grotesque', tagStyle: 'pill', ruleStyle: 'bar', keyFact, scheme: T.inv, img: { share: 0.5, zoom: 1.1 } });
    v.push({ layout: 'poster', voice: 'grotesque', headScale: 1.04, tagStyle: 'pill', ruleStyle: 'bar', keyFact, img: { zoom: 1.08 } });
  } else {
    v.push({ layout: 'bold', voice: 'grotesque', headScale: 1.14, vAnchor: 'top', graphic: T.pick(['letter', 'bar', 'circle'], 2), tagStyle: 'pill', ruleStyle: 'bar', keyFact, scheme: T.inv });
    v.push({ layout: 'bold', voice: 'grotesque', headScale: 1.18, vAnchor: 'bottom', graphic: T.pick(['circle', 'block', 'arch'], 3), tagStyle: 'pill', ruleStyle: 'bar', keyFact, scheme: T.inv });
    v.push({ layout: 'stack', voice: 'grotesque', headScale: 1.0, graphic: T.pick(['arch', 'circle', 'letter'], 4), tagStyle: 'pill', ruleStyle: 'bar', keyFact, scheme: T.inv, img: { share: 0.42 } });
  }
  return v;
}

function _event(T) {
  const { f, tone, calm, loud, dense, img } = T;
  const keyFact = f.hasDate ? 'date' : 'none';
  if (dense) {
    return [{ layout: 'split', voice: 'clean', headScale: 0.96, textScale: 0.96, tagStyle: 'rule', ruleStyle: 'bar', keyFact, emphasis: loud ? 'lastline' : 'none' }];
  }
  const v = [];
  if (tone === 'corporate' || calm) {
    if (img) {
      v.push({ layout: 'editorial', voice: 'clean', space: 'airy', tagStyle: 'rule', ruleStyle: 'hair', keyFact, emphasis: 'none', img: { radius: 'sharp', bleed: T.pick(['right', 'left'], 1), share: 0.34, treatment: 'muted', first: T.pick([false, true], 5) } });
      v.push({ layout: 'stack', voice: 'clean', tagStyle: 'rule', ruleStyle: 'hair', keyFact, emphasis: 'none', img: { share: 0.44, treatment: 'muted' } });
    } else {
      v.push({ layout: 'bold', voice: 'clean', vAnchor: 'bottom', space: 'airy', graphic: 'letter', tagStyle: 'rule', ruleStyle: 'hair', keyFact, emphasis: 'none', headScale: 1.1 });
      v.push({ layout: 'bold', voice: 'clean', vAnchor: 'middle', space: 'airy', inset: 0.07, measure: 0.88, graphic: 'none', tagStyle: 'rule', ruleStyle: 'hair', keyFact, emphasis: 'none', headScale: 1.06 });
    }
    return v;
  }
  if (tone === 'warm') {
    if (img) {
      v.push({ layout: 'stack', voice: 'serif', tagStyle: 'rule', ruleStyle: 'bar', keyFact, emphasis: 'none', img: { share: 0.46 } });
      v.push({ layout: 'editorial', voice: 'serif', tagStyle: 'rule', ruleStyle: 'hair', keyFact, emphasis: 'none', img: { radius: 'soft', share: 0.36 } });
    } else {
      v.push({ layout: 'bold', voice: 'serif', vAnchor: 'middle', space: 'airy', graphic: 'none', tagStyle: 'rule', ruleStyle: 'bar', keyFact, emphasis: 'none', headScale: 1.08 });
      v.push({ layout: 'bold', voice: 'serif', vAnchor: 'bottom', graphic: 'arch', tagStyle: 'rule', ruleStyle: 'bar', keyFact, emphasis: 'none', headScale: 1.0 });
    }
    return v;
  }
  if (img) {
    v.push({ layout: 'frame', voice: 'grotesque', tagStyle: 'pill', ruleStyle: 'bar', keyFact, emphasis: 'lastline', img: { share: 0.42, zoom: 1.04 } });
    v.push({ layout: 'poster', voice: 'grotesque', headScale: 1.1, tagStyle: 'pill', ruleStyle: 'bar', keyFact, img: { zoom: 1.12 } });
    v.push({ layout: 'stack', voice: 'grotesque', tagStyle: 'pill', ruleStyle: 'bar', keyFact, scheme: T.inv, img: { share: 0.5, zoom: 1.1 } });
  } else {
    v.push({ layout: 'bold', voice: 'grotesque', headScale: 1.14, vAnchor: 'bottom', graphic: T.pick(['arch', 'circle', 'block'], 3), tagStyle: 'pill', ruleStyle: 'bar', keyFact, scheme: T.inv });
    v.push({ layout: 'bold', voice: 'grotesque', headScale: 1.12, vAnchor: 'top', graphic: T.pick(['letter', 'circle'], 2), tagStyle: 'pill', ruleStyle: 'bar', keyFact, scheme: T.inv });
  }
  return v;
}

function _info(T) {
  const { f, calm, img } = T;
  const v = [];
  if (f.items >= 3 || f.words > 24) {
    v.push({ layout: 'split', voice: 'clean', headScale: 0.94, tagStyle: 'rule', ruleStyle: 'bar', emphasis: 'none', keyFact: f.hasDate ? 'date' : 'none' });
    if (img) v.push({ layout: 'stack', voice: 'clean', headScale: 0.92, textScale: 0.97, tagStyle: 'rule', ruleStyle: 'hair', emphasis: 'none', img: { share: 0.3, treatment: calm ? 'muted' : 'natural' } });
  } else {
    v.push({ layout: 'bold', voice: 'clean', vAnchor: 'top', headScale: 1.0, graphic: 'none', tagStyle: 'rule', ruleStyle: 'hair', emphasis: 'none' });
    if (img) v.push({ layout: 'editorial', voice: 'clean', tagStyle: 'rule', ruleStyle: 'hair', emphasis: 'none', img: { radius: 'sharp', share: 0.32 } });
  }
  return v;
}

function _editorial(T) {
  const { img, tone } = T;
  const voice = tone === 'corporate' ? 'clean' : T.pick(['serif', 'clean'], 6);
  const v = [];
  if (img) {
    v.push({ layout: 'editorial', voice, space: 'airy', tagStyle: 'plain', ruleStyle: 'hair', emphasis: 'none', headScale: 1.06, img: { radius: 'sharp', bleed: T.pick(['right', 'left', 'right'], 1), share: 0.4, treatment: 'muted', first: T.pick([false, true], 5) } });
    v.push({ layout: 'stack', voice, space: 'airy', tagStyle: 'plain', ruleStyle: 'none', emphasis: 'none', headScale: 1.04, img: { share: 0.58, treatment: 'muted' } });
    v.push({ layout: 'poster', voice: 'clean', headScale: 1.12, tagStyle: 'plain', ruleStyle: 'none', emphasis: 'none', img: { treatment: 'muted' } });
  } else {
    v.push({ layout: 'bold', voice, vAnchor: 'bottom', space: 'airy', inset: 0.06, measure: 0.86, graphic: T.pick(['none', 'letter'], 2), tagStyle: 'plain', ruleStyle: 'hair', emphasis: 'none', headScale: 1.22 });
    v.push({ layout: 'bold', voice, vAnchor: 'middle', space: 'airy', inset: 0.1, measure: 0.8, graphic: 'none', tagStyle: 'plain', ruleStyle: 'none', emphasis: 'none', headScale: 1.16 });
  }
  return v;
}

function _message(T) {
  const { img, tone, loud, isQuote } = T;
  const v = [];
  if (img) {
    const voice = isQuote ? 'serif' : (loud ? 'grotesque' : 'clean');
    const tagStyle = loud ? 'pill' : 'plain';
    v.push({ layout: 'poster', voice, headScale: 1.04, tagStyle, ruleStyle: 'none', emphasis: 'none', img: { zoom: 1.06 } });
    v.push({ layout: 'stack', voice, headScale: 1.06, tagStyle, ruleStyle: 'none', emphasis: 'none', img: { share: 0.58 } });
    return v;
  }
  if (isQuote) {
    v.push({ layout: 'bold', voice: 'serif', vAnchor: 'middle', space: 'airy', inset: 0.04, measure: 0.92, headScale: 1.3, graphic: 'quote', tagStyle: 'plain', ruleStyle: 'none', emphasis: 'none', textScale: 1.1 });
    v.push({ layout: 'bold', voice: 'serif', vAnchor: 'bottom', space: 'airy', headScale: 1.26, graphic: 'quote', tagStyle: 'plain', ruleStyle: 'none', emphasis: 'none', textScale: 1.1 });
    return v;
  }
  if (loud) {
    v.push({ layout: 'bold', voice: 'grotesque', vAnchor: 'bottom', headScale: 1.26, graphic: T.pick(['circle', 'block', 'arch'], 3), tagStyle: 'pill', ruleStyle: 'none', emphasis: 'lastline', scheme: T.inv });
    v.push({ layout: 'stack', voice: 'grotesque', headScale: 1.1, graphic: T.pick(['circle', 'arch', 'letter'], 4), tagStyle: 'pill', ruleStyle: 'none', emphasis: 'lastline', scheme: T.inv, img: { share: 0.46 } });
    return v;
  }
  v.push({ layout: 'bold', voice: 'clean', vAnchor: 'middle', space: 'airy', inset: 0.05, measure: 0.9, headScale: 1.24, graphic: 'none', tagStyle: 'plain', ruleStyle: 'none', emphasis: 'none', textScale: 1.1 });
  v.push({ layout: 'bold', voice: tone === 'warm' ? 'serif' : 'clean', vAnchor: 'bottom', space: 'airy', headScale: 1.22, graphic: T.pick(['letter', 'none'], 2), tagStyle: 'plain', ruleStyle: 'hair', emphasis: 'none', textScale: 1.1 });
  return v;
}

function _formal(T) {
  const { f, img, solemn } = T;
  const v = [{ layout: 'centered', voice: 'serif', space: 'airy', measure: 0.82, headScale: 0.94, tagStyle: solemn ? 'plain' : 'rule', ruleStyle: solemn ? 'none' : 'orn', keyFact: 'none', emphasis: 'none' }];
  if (img && !solemn) {
    v.push({ layout: 'editorial', voice: 'serif', space: 'airy', tagStyle: 'plain', ruleStyle: 'hair', emphasis: 'none', keyFact: f.hasDate ? 'date' : 'none', headScale: 0.98, img: { radius: 'soft', share: 0.4, treatment: 'natural' } });
  }
  return v;
}

const RECIPES = { promo: _promo, event: _event, info: _info, editorial: _editorial, message: _message, formal: _formal };

// ── Tone adjustments ────────────────────────────────────────────────────
// Composition follows the intent; the brand personality follows the tone.
// Formal occasions keep their own carefully balanced recipe.

function _applyTone(d, T) {
  if (T.intent === 'formal') return d;
  const SHAPES = ['circle', 'arch', 'block', 'bar'];
  switch (T.tone) {
    case 'corporate':
      d.voice = 'clean';
      d.emphasis = 'none';
      d.scheme = 'field';
      if (SHAPES.includes(d.graphic)) d.graphic = T.pick(['none', 'letter'], 7);
      d.headScale = Math.min(d.headScale, 1.12);
      break;
    case 'luxury':
      d.voice = 'serif';
      d.emphasis = 'none';
      d.scheme = 'field';
      d.space = 'airy';
      if (d.graphic && d.graphic !== 'quote') d.graphic = 'none';
      d.tagStyle = 'plain';
      d.ruleStyle = d.ruleStyle === 'none' ? 'none' : 'hair';
      d.headScale = Math.min(d.headScale, 1.06) * 0.96;
      d.textScale = Math.min(d.textScale, 1) * 0.97;
      break;
    case 'playful':
      d.voice = 'grotesque';
      if (d.tagStyle === 'plain') d.tagStyle = 'pill';
      d.headScale = Math.min(1.3, d.headScale * 1.04);
      if (d.emphasis === 'none') d.emphasis = 'lastline';
      break;
    case 'warm':
      if (d.layout !== 'split') d.voice = 'serif';
      break;
    case 'calm':
      d.voice = T.pick(['serif', 'clean'], 8);
      d.emphasis = 'none';
      d.scheme = 'field';
      d.space = 'airy';
      if (['circle', 'block', 'bar'].includes(d.graphic)) d.graphic = T.pick(['arch', 'none'], 7);
      break;
    case 'loud':
      d.voice = 'grotesque';
      d.headScale = Math.min(1.3, d.headScale * 1.04);
      d.emphasis = 'lastline';
      break;
    default:
      break;
  }
  return d;
}

// ── Picture plan ────────────────────────────────────────────────────────
// Tells the picture generator where to leave room (so the type has calm
// space to sit on) and tells the renderer which part of the picture to keep.

function _layoutFit(layout, f) {
  if (f.wide) return layout === 'centered' ? 'centered' : 'bold';
  if (f.square && (layout === 'split' || layout === 'editorial' || layout === 'frame')) return f.hasImage ? 'stack' : 'bold';
  return layout;
}

function _picturePlan(d, T) {
  const im = d.image;
  const lowType = d.layout === 'poster' || d.layout === 'split' || (d.layout === 'bold' && d.vAnchor === 'bottom');
  if (d.layout === 'centered') {
    im.brief = 'a single clear subject centred in the frame, calm even space around it';
    im.fy = 'Mid';
  } else if (lowType) {
    im.brief = 'subject placed in the upper half of the frame, calm open space in the lower half';
    im.fy = 'Min';
  } else if (d.layout === 'bold') {
    im.brief = 'subject centred, calm open space above and below';
    im.fy = 'Mid';
  } else {
    im.brief = 'one clear subject, centred, calm even space around it';
    im.fy = 'Mid';
  }
  im.fx = 'Mid';
  if (!im.treatment) im.treatment = T.calm ? 'muted' : 'natural';
  if (!im.zoom) im.zoom = T.loud ? 1.1 : 1;
  if (!T.f.hasImage || T.f.userImage) im.brief = '';
}

// ── Public entry point ──────────────────────────────────────────────────
// args: the create_design arguments (after invented facts were removed).
// ctx:  { userText, userImage, hasLogo }
// Returns the direction object described at the top of this file.

export function deriveDesignDirection(args, ctx) {
  const a = args && typeof args === 'object' ? args : {};
  const x = ctx && typeof ctx === 'object' ? ctx : {};
  const f = _facts(a, x);
  const recent = String(x.userText || '').slice(-700).toLowerCase();
  const forcedRaw = String(a.layout || '').toLowerCase();
  const forced = DESIGN_LAYOUTS.includes(forcedRaw) ? forcedRaw : null;

  const h = _hash(f.headline + '|' + f.kind);
  const rnd = (n, salt) => (Math.imul(h ^ Math.imul(salt + 1, 0x9e3779b1), 2654435761) >>> 0) % n;
  const pick = (arr, salt) => arr[rnd(arr.length, salt)];

  let intent = _intent(f, recent);
  const tone = _tone(f, recent, String(a.theme || '').toLowerCase());
  const solemn = SOLEMN.test(f.own) || SOLEMN.test(recent.slice(-250));
  // A celebratory "invitation" (kids party, concert night) is an event, not a ceremony.
  if (intent === 'formal' && !solemn && (tone === 'playful' || tone === 'loud')) intent = 'event';
  const energy = _energy(intent, tone);
  const focal = _focal(intent, f);

  const T = {
    f, intent, tone, energy, solemn, forced, pick, rnd,
    calm: energy === 'calm',
    loud: energy === 'loud',
    dense: f.items >= 5 || f.words > 40,
    img: f.hasImage,
    isQuote: QUOTE.test(f.own) || QUOTE.test(recent.slice(-250)),
    inv: !f.custom && rnd(2, 11) === 0 ? 'inverse' : 'field',
  };

  // Choose one recipe. A layout the caller asked for for narrows the choice.
  const variants = (RECIPES[intent] || _promo)(T);
  let pool = variants;
  if (forced) {
    const same = variants.filter((v) => v.layout === forced);
    if (same.length) pool = same;
  }
  const r = pool[rnd(pool.length, 0)];

  const d = {
    intent, tone, energy, focal,
    layout: r.layout,
    voice: r.voice || 'grotesque',
    headScale: r.headScale || 1,
    space: r.space || 'balanced',
    inset: r.inset || 0,
    measure: r.measure || 1,
    vAnchor: r.vAnchor || 'top',
    tagStyle: r.tagStyle || null,
    ruleStyle: r.ruleStyle || null,
    keyFact: r.keyFact || 'none',
    scheme: r.scheme || 'field',
    graphic: r.graphic || null,
    emphasis: r.emphasis || 'lastline',
    textScale: r.textScale || 1,
    image: Object.assign({ radius: 'soft', bleed: 'none', first: false, share: 0.36 }, r.img || {}),
  };

  _applyTone(d, T);

  // Guards.
  if (f.custom || d.layout === 'centered') d.scheme = 'field';
  if (!forced && (d.layout === 'poster' || d.layout === 'stack') && (f.items >= 5 || f.words > 36)) {
    d.layout = f.square ? 'bold' : 'split';
  }
  d.layout = forced || _layoutFit(d.layout, f);

  d.headScale = _clamp(d.headScale, 0.7, 1.4, 1);
  d.textScale = _clamp(d.textScale, 0.85, 1.2, 1);
  d.inset = _clamp(d.inset, 0, 0.2, 0);
  d.measure = _clamp(d.measure, 0.6, 1, 1);
  d.image.share = _clamp(d.image.share, 0.26, 0.62, 0.36);

  _picturePlan(d, T);

  d.summary = 'intent=' + intent + ' tone=' + (tone || 'none') + ' energy=' + energy + ' focal=' + focal +
    ' layout=' + d.layout + ' voice=' + d.voice + ' anchor=' + d.vAnchor + ' space=' + d.space +
    ' scheme=' + d.scheme + ' graphic=' + (d.graphic || 'auto') + ' keyFact=' + d.keyFact;
  return d;
}
