// studio/library-data.js
// Built-in content that ships with Studio: filter presets, SVG stickers, emoji, text presets, caption styles, backgrounds, templates.
// Everything here is generated or tiny, so there is no stock-media service and nothing to download.

// Filters are parameter sets over the clip colour controls plus three extra tone values (sepia, gray, hue).
export const FILTERS = [
  { id: 'none', label: 'None', adjust: {}, swatch: '#bdbdb6' },
  { id: 'warm', label: 'Warm', adjust: { temperature: 28, saturation: 8, contrast: 6 }, swatch: '#e9a96b' },
  { id: 'cool', label: 'Cool', adjust: { temperature: -28, saturation: 4, contrast: 4 }, swatch: '#7aa6d6' },
  { id: 'vivid', label: 'Vivid', adjust: { saturation: 38, contrast: 14, brightness: 4 }, swatch: '#e8553b' },
  { id: 'fade', label: 'Faded', adjust: { contrast: -16, brightness: 8, saturation: -14 }, swatch: '#cfc7bd' },
  { id: 'mono', label: 'Mono', adjust: { contrast: 10 }, gray: 1, swatch: '#777' },
  { id: 'noir', label: 'Noir', adjust: { contrast: 36, brightness: -10, vignette: 40 }, gray: 1, swatch: '#222' },
  { id: 'sepia', label: 'Sepia', adjust: { contrast: 4 }, sepia: 0.9, swatch: '#a67c52' },
  { id: 'sunset', label: 'Sunset', adjust: { temperature: 40, tint: 10, saturation: 22, contrast: 8 }, hue: -8, swatch: '#f08a4b' },
  { id: 'teal', label: 'Teal and orange', adjust: { temperature: 16, tint: -8, contrast: 20, saturation: 18 }, hue: 6, swatch: '#2e7d8a' },
  { id: 'soft', label: 'Soft glow', adjust: { brightness: 10, contrast: -10, saturation: 6, blur: 0.6 }, swatch: '#f4e4d6' },
  { id: 'punch', label: 'Punch', adjust: { contrast: 28, sharpen: 30, saturation: 14 }, swatch: '#b43f1b' },
];
export const filterById = (id) => FILTERS.find((f) => f.id === id) || FILTERS[0];

// Stickers: each draws into a 100x100 box and takes one colour.
const S = (inner) => (c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${inner.replace(/\{c\}/g, c)}</svg>`;
export const STICKERS = [
  { id: 'arrow', label: 'Arrow', svg: S('<path d="M8 40h52V18l34 32-34 32V60H8z" fill="{c}"/>') },
  { id: 'star', label: 'Star', svg: S('<path d="M50 6l12.9 28.6 31.1 3.4-23.2 21 6.6 30.5L50 74.8 22.6 89.5l6.6-30.5L6 38l31.1-3.4z" fill="{c}"/>') },
  { id: 'heart', label: 'Heart', svg: S('<path d="M50 90C14 62 6 40 6 28 6 15 16 8 27 8c10 0 19 6 23 15C54 14 63 8 73 8c11 0 21 7 21 20 0 12-8 34-44 62z" fill="{c}"/>') },
  { id: 'check', label: 'Tick', svg: S('<circle cx="50" cy="50" r="46" fill="{c}"/><path d="M27 52l16 16 31-34" fill="none" stroke="#fff" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>') },
  { id: 'cross', label: 'Cross', svg: S('<circle cx="50" cy="50" r="46" fill="{c}"/><path d="M32 32l36 36M68 32L32 68" stroke="#fff" stroke-width="10" stroke-linecap="round"/>') },
  { id: 'bubble', label: 'Speech', svg: S('<path d="M14 10h72a8 8 0 0 1 8 8v46a8 8 0 0 1-8 8H48L28 92V72H14a8 8 0 0 1-8-8V18a8 8 0 0 1 8-8z" fill="{c}"/>') },
  { id: 'sparkle', label: 'Sparkle', svg: S('<path d="M50 4c4 26 20 42 46 46-26 4-42 20-46 46-4-26-20-42-46-46C30 46 46 30 50 4z" fill="{c}"/>') },
  { id: 'burst', label: 'Burst', svg: S('<path d="M50 2l9 20 20-9-4 22 22 4-17 15 15 17-22 2 2 22-20-11-14 17-8-21-22 6 6-22-21-8 18-13-10-20 22 2z" fill="{c}"/>') },
  { id: 'ring', label: 'Ring', svg: S('<circle cx="50" cy="50" r="40" fill="none" stroke="{c}" stroke-width="12"/>') },
  { id: 'squiggle', label: 'Squiggle', svg: S('<path d="M6 50c10-24 20-24 30 0s20 24 30 0 20-24 28 0" fill="none" stroke="{c}" stroke-width="10" stroke-linecap="round"/>') },
  { id: 'brackets', label: 'Frame', svg: S('<path d="M30 8H8v22M70 8h22v22M30 92H8V70M70 92h22V70" fill="none" stroke="{c}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>') },
  { id: 'play', label: 'Play', svg: S('<circle cx="50" cy="50" r="46" fill="{c}"/><path d="M40 30l32 20-32 20z" fill="#fff"/>') },
  { id: 'pin', label: 'Pin', svg: S('<path d="M50 94S20 60 20 38a30 30 0 0 1 60 0c0 22-30 56-30 56z" fill="{c}"/><circle cx="50" cy="38" r="11" fill="#fff"/>') },
  { id: 'bolt', label: 'Bolt', svg: S('<path d="M58 4L18 56h26l-8 40 42-54H52z" fill="{c}"/>') },
];
export const stickerById = (id) => STICKERS.find((s) => s.id === id) || null;
export const EMOJI = ['⭐', '🔥', '❤️', '👍', '👏', '🎉', '😀', '😍', '😂', '🤩', '😮', '💡', '📚', '🎓', '✏️', '📌', '📣', '🏆', '🌟', '✅', '❌', '⚠️', '💬', '🔔', '📈', '💰', '🌍', '🏠', '🚀', '🎵', '📷', '🎬', '👉', '👇', '✨', '🌈', '☀️', '🌙', '🌿', '💥'];

export const BACKGROUNDS = [
  { id: 'cream', label: 'Cream', c1: '#f8f7f4', c2: '#ece9e2', angle: 135 }, { id: 'ink', label: 'Ink', c1: '#171717', c2: '#0c0c0b', angle: 135 }, { id: 'rust', label: 'Rust', c1: '#a8471f', c2: '#7a2f12', angle: 135 },
  { id: 'dawn', label: 'Dawn', c1: '#ffd9bd', c2: '#e39a6d', angle: 120 }, { id: 'ocean', label: 'Ocean', c1: '#0f4c75', c2: '#3282b8', angle: 150 }, { id: 'forest', label: 'Forest', c1: '#1b4332', c2: '#52b788', angle: 150 },
  { id: 'grape', label: 'Grape', c1: '#3c1361', c2: '#9d4edd', angle: 135 }, { id: 'sand', label: 'Sand', c1: '#e9d8a6', c2: '#ee9b00', angle: 120 },
];

// Text presets. `text` overrides the default text style; kinetic and animation names are understood by render.js.
export const TEXT_PRESETS = [
  { id: 'title', label: 'Title', sample: 'Big title', text: { content: 'Your title', size: 120, weight: 800, animIn: 'pop' }, dur: 4 },
  { id: 'subtitle', label: 'Subtitle', sample: 'Quiet line', text: { content: 'A supporting line', size: 56, weight: 500, animIn: 'fade' }, dur: 4, y: 0.12 },
  { id: 'lower', label: 'Lower third', sample: 'Name, role', text: { content: 'Aminat Lawal\nProprietress', size: 54, weight: 600, align: 'left', box: { on: true, color: '#a8471f', alpha: 0.92, pad: 28, radius: 14 }, shadow: { on: false }, animIn: 'slideLeft', animOut: 'fade', width: 0.6 }, dur: 5, x: -0.14, y: 0.34 },
  { id: 'serif', label: 'Serif headline', sample: 'Headline', text: { content: 'An elegant headline', font: 'serif', size: 110, weight: 400, animIn: 'fade' }, dur: 4 },
  { id: 'word', label: 'Word by word', sample: 'One word at a time', text: { content: 'Words arrive one at a time', size: 104, weight: 800, kinetic: 'word', kStagger: 0.22 }, dur: 5 },
  { id: 'letter', label: 'Letter pop', sample: 'Letter pop', text: { content: 'Letters pop in', size: 120, weight: 800, kinetic: 'letter', kStagger: 0.05 }, dur: 4 },
  { id: 'type', label: 'Typewriter', sample: 'Typing...', text: { content: 'Typed out, one character at a time.', font: 'mono', size: 64, weight: 600, kinetic: 'typewriter', align: 'left', width: 0.8 }, dur: 5 },
  { id: 'slideup', label: 'Slide up', sample: 'Slide up', text: { content: 'Each word slides up', size: 104, weight: 800, kinetic: 'slideUp', kStagger: 0.14 }, dur: 4.5 },
  { id: 'highlight', label: 'Highlight sweep', sample: 'Highlighted', text: { content: 'The key phrase gets highlighted', size: 92, weight: 800, kinetic: 'highlight', hl: '#ffd9bd', color: '#ffffff' }, dur: 4.5 },
  { id: 'outline', label: 'Outlined', sample: 'Outlined', text: { content: 'OUTLINED', font: 'impact', size: 140, weight: 400, color: '#ffffff', stroke: { w: 10, color: '#a8471f' }, animIn: 'zoom' }, dur: 4 },
  { id: 'gradient', label: 'Gradient', sample: 'Gradient', text: { content: 'Gradient fill', size: 130, weight: 800, gradient: { on: true, c1: '#ffd9bd', c2: '#e8553b', angle: 90 }, animLoop: 'float' }, dur: 4.5 },
  { id: 'note', label: 'Note on a card', sample: 'On a card', text: { content: 'Remember this', size: 64, weight: 600, color: '#171717', box: { on: true, color: '#fff7ec', alpha: 1, pad: 34, radius: 22 }, shadow: { on: true, x: 0, y: 8, blur: 24, color: 'rgba(0,0,0,0.25)' }, animIn: 'pop', animLoop: 'wiggle' }, dur: 4 },
];

export const CAPTION_PRESETS = [
  { id: 'plain', label: 'Plain', hint: 'White text with a soft shadow' },
  { id: 'boxed', label: 'Boxed', hint: 'Dark box behind the words' },
  { id: 'outlined', label: 'Outlined', hint: 'Bold with a black outline' },
  { id: 'karaoke', label: 'Karaoke', hint: 'The spoken word lights up' },
  { id: 'pop', label: 'Pop in', hint: 'Bouncy entrance, outlined' },
];

// Built-in templates. `rel` times are seconds from where the template is placed. trackType picks (or creates) a matching track.
export const BUILTIN_TEMPLATES = [
  { id: 'tpl-lower', name: 'Lower third', hint: 'Name bar with a subtitle line', duration: 5, items: [
    { kind: 'shape', trackType: 'graphic', rel: 0, duration: 5, props: { name: 'Bar', transform: { x: -0.08, y: 0.3 }, shape: { type: 'rounded', fill: '#a8471f', w: 640, h: 150, radius: 18 }, transitionIn: { type: 'wipe', duration: 0.5, dir: 'right' }, transitionOut: { type: 'fade', duration: 0.4 } } },
    { kind: 'text', trackType: 'text', rel: 0.2, duration: 4.6, props: { name: 'Name', transform: { x: -0.1, y: 0.285 }, text: { content: 'Your name', size: 58, weight: 700, align: 'left', width: 0.55, animIn: 'slideLeft', shadow: { on: false } } } },
    { kind: 'text', trackType: 'text', rel: 0.4, duration: 4.4, props: { name: 'Role', transform: { x: -0.1, y: 0.33 }, text: { content: 'Role or place', size: 38, weight: 500, align: 'left', width: 0.55, animIn: 'fade', color: '#ffd9bd', shadow: { on: false } } } },
  ] },
  { id: 'tpl-title', name: 'Title card', hint: 'Gradient background and a bold title', duration: 5, items: [
    { kind: 'shape', trackType: 'graphic', rel: 0, duration: 5, fill: true, props: { name: 'Background', shape: { type: 'rect', gradient: { on: true, c1: '#a8471f', c2: '#7a2f12', angle: 135 } } } },
    { kind: 'text', trackType: 'text', rel: 0.1, duration: 4.8, props: { name: 'Title', transform: { y: -0.04 }, text: { content: 'Your title here', size: 130, weight: 800, kinetic: 'word', kStagger: 0.2 } } },
    { kind: 'text', trackType: 'text', rel: 0.9, duration: 4, props: { name: 'Subtitle', transform: { y: 0.1 }, text: { content: 'A short supporting line', size: 54, weight: 500, color: '#ffd9bd', animIn: 'slideUp' } } },
  ] },
  { id: 'tpl-cta', name: 'Call to action', hint: 'Pill with a follow prompt', duration: 4, items: [
    { kind: 'shape', trackType: 'graphic', rel: 0, duration: 4, props: { name: 'Pill', transform: { y: 0.3 }, shape: { type: 'rounded', fill: '#ffffff', w: 640, h: 140, radius: 70 }, transitionIn: { type: 'zoomIn', duration: 0.4 }, transitionOut: { type: 'fade', duration: 0.3 } } },
    { kind: 'text', trackType: 'text', rel: 0.1, duration: 3.8, props: { name: 'Prompt', transform: { y: 0.3 }, text: { content: 'Follow for more', size: 58, weight: 700, color: '#171717', shadow: { on: false }, animLoop: 'pulse' } } },
  ] },
  { id: 'tpl-quote', name: 'Quote card', hint: 'Serif quote on a warm background', duration: 6, items: [
    { kind: 'shape', trackType: 'graphic', rel: 0, duration: 6, fill: true, props: { name: 'Background', shape: { type: 'rect', gradient: { on: true, c1: '#f8f7f4', c2: '#ece9e2', angle: 135 } } } },
    { kind: 'text', trackType: 'text', rel: 0.2, duration: 5.6, props: { name: 'Quote', transform: { y: -0.02 }, text: { content: 'A thoughtful quotation goes here.', font: 'serif', size: 96, weight: 400, color: '#171717', shadow: { on: false }, animIn: 'fade', width: 0.78 } } },
    { kind: 'text', trackType: 'text', rel: 1, duration: 5, props: { name: 'Author', transform: { y: 0.16 }, text: { content: 'Name of the speaker', size: 42, weight: 600, color: '#a8471f', shadow: { on: false }, animIn: 'slideUp' } } },
  ] },
];
