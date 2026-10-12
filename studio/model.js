// studio/model.js
// Project model v2: tracks, clips, keyframes, markers. Pure data and pure functions, no DOM, no network.
// Also holds the migration from the v1 scene-based shape and the sanitiser used for imported project files.
//
// Time is in seconds. A clip's source range is [in, in + duration * speed]; "out" is derived, never stored.
// Tracks are stored top to bottom in the order the timeline shows them, and drawn bottom to top.

import { narrKey, validNarr, sceneDur, NARR_LEAD, NARR_TAIL } from './engine.js';

export const MODEL_VERSION = 2;
export const nid = (p = 'id') => p + '_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
export const clamp = (n, a, b) => Math.min(b, Math.max(a, n));
export const num = (v, d = 0) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : d);
const str = (v, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
export const clone = (o) => JSON.parse(JSON.stringify(o));

export const LIMITS = { tracks: 64, clips: 4000, markers: 1000, assets: 400, keyframes: 400, effects: 12, json: 8 * 1048576 };

// ───────── presets ─────────
export const SIZE_PRESETS = [
  { id: 'yt1080', label: 'YouTube 16:9 (1080p)', w: 1920, h: 1080 },
  { id: 'yt4k', label: 'YouTube 16:9 (4K)', w: 3840, h: 2160 },
  { id: 'vertical', label: 'Shorts, TikTok, Reels, WhatsApp Status 9:16', w: 1080, h: 1920 },
  { id: 'ig45', label: 'Instagram portrait 4:5', w: 1080, h: 1350 },
  { id: 'square', label: 'Square 1:1', w: 1080, h: 1080 },
  { id: 'fb', label: 'Facebook 16:9', w: 1280, h: 720 },
  { id: 'x', label: 'X (Twitter) 16:9', w: 1280, h: 720 },
  { id: 'linkedin', label: 'LinkedIn 16:9', w: 1920, h: 1080 },
  { id: 'cinema', label: 'Cinema 21:9', w: 2560, h: 1080 },
  { id: 'custom', label: 'Custom size' },
];
export const FPS_OPTIONS = [24, 25, 30, 50, 60];
const gcd = (a, b) => (b ? gcd(b, a % b) : a);
export function aspectLabel(w, h) { const g = gcd(w, h) || 1; const a = w / g, b = h / g; return a > 40 || b > 40 ? (w / h).toFixed(2) + ':1' : a + ':' + b; }
export const V1_ASPECTS = { '9:16': [1080, 1920], '16:9': [1920, 1080], '1:1': [1080, 1080] };
export const even = (n) => Math.max(2, Math.round(n / 2) * 2);

// ───────── tracks and clips ─────────
export const TRACK_TYPES = ['video', 'image', 'audio', 'text', 'caption', 'sticker', 'graphic', 'effect', 'adjustment'];
export const VISUAL_KINDS = new Set(['video', 'image', 'text', 'shape', 'sticker', 'scene']);
export const AUDIO_KINDS = new Set(['audio', 'music']);
export function trackAccepts(type, kind) {
  if (type === 'audio') return AUDIO_KINDS.has(kind);
  if (type === 'caption') return kind === 'caption';
  if (type === 'effect') return kind === 'effect';
  if (type === 'adjustment') return kind === 'adjustment';
  return VISUAL_KINDS.has(kind);
}
export const defaultTrackType = (kind) => ({ audio: 'audio', music: 'audio', caption: 'caption', effect: 'effect', adjustment: 'adjustment', text: 'text', shape: 'graphic', sticker: 'sticker', image: 'image' }[kind] || 'video');
const TRACK_NAMES = { video: 'Video', image: 'Image', audio: 'Audio', text: 'Text', caption: 'Captions', sticker: 'Stickers', graphic: 'Graphics', effect: 'Effects', adjustment: 'Adjustment' };

export function newTrack(type, name, extra = {}) {
  return { id: nid('t'), type, name: name || TRACK_NAMES[type] || 'Track', locked: false, muted: false, hidden: false, solo: false, height: type === 'audio' ? 52 : 56, volume: 1, ...extra };
}
export function defaultTracks() {
  return [newTrack('caption', 'Captions', { role: 'captions' }), newTrack('text', 'Text 1'), newTrack('video', 'Overlay 1'), newTrack('video', 'Video 1', { role: 'main', height: 64 }), newTrack('audio', 'Audio 1'), newTrack('audio', 'Music', { role: 'music' })];
}

export const zeroAdjust = () => ({ brightness: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0, exposure: 0, blur: 0, sharpen: 0, vignette: 0, grain: 0 });
export const defaultMask = () => ({ shape: 'none', feather: 0, invert: false, x: 0, y: 0, w: 0.6, h: 0.6 });

export function newClip(kind, props = {}) {
  const c = {
    id: nid('c'), trackId: '', kind, assetId: null, name: '', start: 0, duration: 3, in: 0, speed: 1, reverse: false, freeze: false, groupId: null,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, flipX: false, flipY: false, crop: { l: 0, t: 0, r: 0, b: 0 }, fit: 'fit', mask: defaultMask() },
    opacity: 1, blend: 'normal', adjust: zeroAdjust(), filter: 'none', filterAmount: 1, effects: [],
    chroma: { on: false, color: '#00ff00', tolerance: 0.32, softness: 0.12 },
    transitionIn: { type: 'none', duration: 0.6, dir: 'left' }, transitionOut: { type: 'none', duration: 0.6, dir: 'left' },
    audio: { gain: 1, fadeIn: 0, fadeOut: 0, loop: false, pan: 0, mute: false, duck: false, denoise: false, role: '' },
    keyframes: {},
  };
  return deepAssign(c, props);
}
export function deepAssign(t, s) {
  Object.keys(s || {}).forEach((k) => {
    if (isObj(s[k]) && isObj(t[k])) deepAssign(t[k], s[k]);
    else t[k] = Array.isArray(s[k]) || isObj(s[k]) ? clone(s[k]) : s[k];
  });
  return t;
}

export const defaultText = () => ({ content: 'Your text', font: 'sans', size: 84, weight: 700, italic: false, align: 'center', color: '#ffffff', gradient: { on: false, c1: '#ffd9bd', c2: '#a8471f', angle: 90 }, stroke: { w: 0, color: '#000000' }, shadow: { on: true, x: 0, y: 4, blur: 14, color: 'rgba(0,0,0,0.45)' }, letterSpacing: 0, lineHeight: 1.2, width: 0.84, box: { on: false, color: '#000000', alpha: 0.6, pad: 22, radius: 16 }, animIn: 'none', animOut: 'none', animLoop: 'none', animDur: 0.5, kinetic: 'none', kStagger: 0.09, hl: '#ffd9bd' });
export const defaultShape = () => ({ type: 'rect', fill: '#a8471f', fillAlpha: 1, gradient: { on: false, c1: '#a8471f', c2: '#ffd9bd', angle: 45 }, stroke: '#ffffff', strokeW: 0, w: 480, h: 280, radius: 36, points: 5, inner: 0.45 });
export const FONTS = {
  sans: { label: 'Geist (sans)', css: '"Geist", system-ui, -apple-system, "Segoe UI", sans-serif' },
  serif: { label: 'Instrument Serif', css: '"Instrument Serif", Georgia, serif' },
  georgia: { label: 'Georgia', css: 'Georgia, "Times New Roman", serif' },
  mono: { label: 'Monospace', css: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace' },
  impact: { label: 'Impact', css: 'Impact, "Arial Black", "Helvetica Neue", sans-serif' },
  rounded: { label: 'Rounded', css: '"Trebuchet MS", "Verdana", system-ui, sans-serif' },
};
export const BLENDS = ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'soft-light', 'hard-light', 'difference', 'add'];
export const TRANSITION_TYPES = [
  ['dissolve', 'Dissolve'], ['fade', 'Fade through colour'], ['wipe', 'Wipe'], ['slide', 'Slide'], ['push', 'Push'], ['zoomIn', 'Zoom in'], ['zoomOut', 'Zoom out'], ['spin', 'Spin'], ['blur', 'Blur'], ['flash', 'Flash'], ['iris', 'Iris'],
];
export const DIR_TRANSITIONS = new Set(['wipe', 'slide', 'push']);
export const EFFECT_TYPES = [['blur', 'Blur', 'Soft focus', 12, 0, 60], ['glow', 'Glow', 'Bright bloom', 0.6, 0, 1], ['pixelate', 'Pixelate', 'Mosaic blocks', 14, 2, 80], ['rgbsplit', 'RGB split', 'Colour fringe', 8, 0, 40], ['shake', 'Shake', 'Camera shake', 0.012, 0, 0.05], ['pulse', 'Pulse', 'Beat zoom', 0.06, 0, 0.3], ['mirror', 'Mirror', 'Mirror left to right', 1, 0, 1]];

// ───────── keyframes and easing ─────────
function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx, cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sx = (t) => ((ax * t + bx) * t + cx) * t, sy = (t) => ((ay * t + by) * t + cy) * t, dx = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0; if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) { const e = sx(t) - x; if (Math.abs(e) < 1e-5) return sy(t); const d = dx(t); if (Math.abs(d) < 1e-6) break; t -= e / d; }
    let lo = 0, hi = 1; t = x;
    for (let i = 0; i < 20; i++) { const e = sx(t); if (Math.abs(e - x) < 1e-5) break; if (x > e) lo = t; else hi = t; t = (lo + hi) / 2; }
    return sy(t);
  };
}
const bezCache = new Map();
export const EASE_NAMES = [['linear', 'Linear'], ['in', 'Ease in'], ['out', 'Ease out'], ['inout', 'Ease in and out'], ['spring', 'Spring'], ['bounce', 'Bounce'], ['bezier', 'Custom curve']];
export function ease(name, p, b) {
  p = clamp(p, 0, 1);
  switch (name) {
    case 'in': return p * p * p;
    case 'out': return 1 - Math.pow(1 - p, 3);
    case 'inout': return p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
    case 'spring': return p >= 1 ? 1 : 1 - Math.exp(-7 * p) * Math.cos(11 * p);
    case 'bounce': { const n = 7.5625, d = 2.75; if (p < 1 / d) return n * p * p; if (p < 2 / d) { p -= 1.5 / d; return n * p * p + 0.75; } if (p < 2.5 / d) { p -= 2.25 / d; return n * p * p + 0.9375; } p -= 2.625 / d; return n * p * p + 0.984375; }
    case 'bezier': { const k = (b || [0.25, 0.1, 0.25, 1]).join(','); let f = bezCache.get(k); if (!f) { f = cubicBezier(...(b || [0.25, 0.1, 0.25, 1])); bezCache.set(k, f); } return f(p); }
    default: return p;
  }
}
export function getPath(o, path) { let a = o; const ks = path.split('.'); for (let i = 0; i < ks.length; i++) { if (a == null) return undefined; a = a[ks[i]]; } return a; }
export function setPath(o, path, v) { const ks = path.split('.'); let a = o; for (let i = 0; i < ks.length - 1; i++) { if (!isObj(a[ks[i]])) a[ks[i]] = {}; a = a[ks[i]]; } a[ks[ks.length - 1]] = v; }
export function valueAt(clip, path, local) {
  const kf = clip.keyframes && clip.keyframes[path];
  if (!kf || !kf.length) return getPath(clip, path);
  if (local <= kf[0].t) return kf[0].v;
  const last = kf[kf.length - 1]; if (local >= last.t) return last.v;
  let i = 0; while (i < kf.length - 1 && kf[i + 1].t <= local) i++;
  const a = kf[i], b = kf[i + 1]; const p = (local - a.t) / Math.max(1e-6, b.t - a.t);
  return a.v + (b.v - a.v) * ease(a.ease || 'linear', p, a.b);
}
export const hasKeyframes = (clip, path) => !!(clip.keyframes && clip.keyframes[path] && clip.keyframes[path].length);
export function keyframeAt(clip, path, local, tol = 0.02) { const kf = clip.keyframes && clip.keyframes[path]; return kf ? kf.find((k) => Math.abs(k.t - local) <= tol) || null : null; }
export function upsertKeyframe(clip, path, local, v, easeName) {
  if (!clip.keyframes) clip.keyframes = {};
  const list = clip.keyframes[path] || (clip.keyframes[path] = []);
  const hit = list.find((k) => Math.abs(k.t - local) <= 0.02);
  if (hit) { hit.v = v; if (easeName) hit.ease = easeName; } else { list.push({ t: Math.max(0, Math.round(local * 1000) / 1000), v, ease: easeName || 'inout' }); list.sort((a, b) => a.t - b.t); }
  if (list.length > LIMITS.keyframes) list.length = LIMITS.keyframes;
}
export function removeKeyframe(clip, path, local) {
  const list = clip.keyframes && clip.keyframes[path]; if (!list) return;
  const i = list.findIndex((k) => Math.abs(k.t - local) <= 0.02); if (i >= 0) list.splice(i, 1);
  if (!list.length) delete clip.keyframes[path];
}
export const KEYFRAME_PATHS = { 'transform.x': 'Position X', 'transform.y': 'Position Y', 'transform.scale': 'Scale', 'transform.rotation': 'Rotation', opacity: 'Opacity', 'audio.gain': 'Volume', 'adjust.brightness': 'Brightness', 'adjust.contrast': 'Contrast', 'adjust.saturation': 'Saturation', 'adjust.blur': 'Blur', 'adjust.vignette': 'Vignette' };

// ───────── timing helpers ─────────
export const clipEnd = (c) => c.start + c.duration;
export const quant = (p, t) => { const f = (p.settings && p.settings.fps) || 30; return Math.round(t * f) / f; };
export const frameDur = (p) => 1 / ((p.settings && p.settings.fps) || 30);
export function projectDuration(p) { let m = 0; for (const c of p.clips) { const e = c.start + c.duration; if (e > m) m = e; } return m; }
export function fmtTC(t, fps = 30) {
  t = Math.max(0, t); const f = Math.round(fps); const total = Math.floor(t); const ff = Math.min(f - 1, Math.round((t - total) * f));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const z = (n) => String(n).padStart(2, '0'); return `${z(h)}:${z(m)}:${z(s)}:${z(ff)}`;
}
export function fmtShort(s) { s = Math.max(0, s); const m = Math.floor(s / 60); return m + ':' + String(Math.floor(s % 60)).padStart(2, '0'); }

// The media a clip plays: video clips and storyboard scenes that use footage. Returns null for everything else.
export function videoRef(clip) {
  if (clip.kind === 'video') return { id: clip.id, assetId: clip.assetId, in: clip.in, speed: clip.speed || 1, reverse: !!clip.reverse, freeze: !!clip.freeze, duration: clip.duration };
  if (clip.kind === 'scene' && clip.scene && clip.scene.layout === 'video' && clip.scene.video) return { id: clip.id, assetId: clip.scene.video, in: clip.scene.trimStart || 0, speed: 1, reverse: false, freeze: false, duration: clip.duration };
  return null;
}
export function srcTime(ref, local) {
  if (ref.freeze) return Math.max(0, ref.in);
  const sp = ref.speed || 1;
  if (ref.reverse) return Math.max(0, ref.in + (ref.duration - clamp(local, 0, ref.duration)) * sp);
  return Math.max(0, ref.in + local * sp);
}
export function assetOf(p, id) { return p.assets.find((a) => a.id === id) || null; }

// Per-track sorted clip lists, cached on the project revision so the renderer does not sort every frame.
const idxCache = new WeakMap();
export function trackIndex(p) {
  const hit = idxCache.get(p);
  if (hit && hit.rev === p._rev && hit.n === p.clips.length) return hit.map;
  const map = new Map(); p.tracks.forEach((t) => map.set(t.id, []));
  p.clips.forEach((c) => { const l = map.get(c.trackId); if (l) l.push(c); });
  map.forEach((l) => l.sort((a, b) => a.start - b.start));
  idxCache.set(p, { rev: p._rev, n: p.clips.length, map });
  return map;
}

// ───────── creating projects ─────────
export function newProject({ title = 'Untitled video', preset = 'vertical', width, height, fps = 30, bg = '#000000' } = {}) {
  const pr = SIZE_PRESETS.find((x) => x.id === preset) || SIZE_PRESETS[2];
  const w = even(width || pr.w), h = even(height || pr.h);
  return {
    v: MODEL_VERSION, id: nid('prj'), title: str(title, 80) || 'Untitled video', createdAt: Date.now(), updatedAt: Date.now(), thumb: '',
    language: 'English (Nigeria)', lang: 'en-NG', voice: '', rate: 1, style: 'clean',
    settings: { width: w, height: h, aspect: aspectLabel(w, h), fps: FPS_OPTIONS.includes(fps) ? fps : 30, bg, preset },
    audio: { master: 1, duck: { amount: 0.7, attack: 0.25, release: 0.6 } },
    assets: [], tracks: defaultTracks(), clips: [], markers: [], styles: [],
    captionStyle: { preset: 'boxed' }, export: { burnCaptions: true },
  };
}

// ───────── v1 (scene based) to v2 ─────────
export const isV1 = (p) => !!p && p.v !== MODEL_VERSION && Array.isArray(p.scenes);
const V1_TRANSITIONS = { fade: 'dissolve', slide: 'push', wipe: 'wipe', zoom: 'zoomIn' };
export const SCENE_KEYS = ['id', 'title', 'layout', 'text', 'bullets', 'stat', 'data', 'caption', 'duration', 'anim', 'bg', 'image', 'video', 'imagePrompt', 'trimStart', 'keepAudio'];

export function v1ToV2(p1) {
  const dims = V1_ASPECTS[p1.aspect] || V1_ASPECTS['9:16'];
  const p = newProject({ title: p1.title, width: dims[0], height: dims[1] });
  p.id = p1.id || p.id; p.createdAt = p1.createdAt || Date.now(); p.updatedAt = p1.updatedAt || Date.now(); p.thumb = typeof p1.thumb === 'string' ? p1.thumb : '';
  p.language = p1.language || 'English (Nigeria)'; p.lang = p1.lang || 'en-NG'; p.voice = p1.voice || ''; p.rate = p1.rate || 1; p.style = p1.style || 'clean';
  p.assets = (p1.assets || []).filter((a) => a && a.id).map((a) => ({ id: str(a.id, 60), kind: a.kind === 'video' ? 'video' : 'image', origin: a.kind === 'generated' ? 'generated' : 'upload', name: str(a.name, 120), mime: '', size: 0, duration: a.kind === 'video' ? num(a.duration) : 0, width: num(a.width), height: num(a.height), fps: 0, hasAudio: !!a.hasAudio, thumb: typeof a.thumb === 'string' ? a.thumb : '', status: 'ready' }));
  p.tracks = [newTrack('caption', 'Captions', { role: 'storyCaptions', hidden: p1.captions === false }), newTrack('text', 'Text 1'), newTrack('video', 'Overlay 1'), newTrack('video', 'Storyboard', { role: 'storyboard', height: 64 }), newTrack('audio', 'Narration', { role: 'narration' }), newTrack('audio', 'Music', { role: 'music' })];
  const tr = (role) => p.tracks.find((t) => t.role === role);
  p.captionStyle = { preset: 'boxed' };
  let acc = 0;
  (p1.scenes || []).forEach((s, i) => {
    const d = sceneDur(p1, s);
    const sc = {}; SCENE_KEYS.forEach((k) => { if (s[k] !== undefined) sc[k] = clone(s[k]); });
    if (!sc.id) sc.id = nid('sc');
    const trn = i > 0 && s.transition !== 'none' ? (V1_TRANSITIONS[s.transition] || 'dissolve') : 'none';
    const clip = newClip('scene', { trackId: tr('storyboard').id, start: acc, duration: d, name: str(s.title || 'Scene ' + (i + 1), 60), scene: sc, transitionIn: { type: trn, duration: 0.5, dir: 'right' } });
    p.clips.push(clip);
    const cap = (s.caption || '').trim();
    if (cap) {
      const ok = validNarr(p1, s);
      p.clips.push(newClip('caption', { trackId: tr('storyCaptions').id, start: acc, duration: d, name: cap.slice(0, 40), link: clip.id, text: { ...defaultText(), content: cap }, cap: { preset: 'karaoke', lead: ok ? NARR_LEAD : 0, dur: ok ? s.narr.dur : 0 }, transform: { y: 0.3 } }));
      if (ok) p.clips.push(newClip('audio', { trackId: tr('narration').id, assetId: 'narr_' + s.narr.key, start: acc + NARR_LEAD, duration: s.narr.dur, name: 'Narration: ' + cap.slice(0, 30), link: clip.id, narr: { key: s.narr.key, dur: s.narr.dur, text: cap, voice: s.narr.voice || '', rate: s.narr.rate || 1, engine: s.narr.engine || '' }, audio: { role: 'voice', gain: 1 } }));
    }
    acc += d;
  });
  if (p1.music && p1.music !== 'none' && acc > 0) p.clips.push(newClip('music', { trackId: tr('music').id, start: 0, duration: acc, name: 'Music: ' + p1.music, music: { kind: p1.music }, audio: { gain: typeof p1.vol === 'number' ? p1.vol : 0.5, duck: true, fadeIn: 0.8, fadeOut: 1.2 } }));
  return p;
}

// Rebuilds the clips owned by the AI storyboard (scene clips, their captions, narration and the music clip) from a scene list.
// Clips on tracks the user added are left alone. Used by the Assistant, which edits the storyboard rather than raw clips.
export function storyboardScenes(p) {
  return p.clips.filter((c) => c.kind === 'scene').sort((a, b) => a.start - b.start).map((c) => {
    const s = { ...clone(c.scene), id: c.scene.id || c.id };
    const cue = p.clips.find((x) => x.kind === 'caption' && x.link === c.id);
    const nar = p.clips.find((x) => x.kind === 'audio' && x.link === c.id && x.narr);
    s.caption = cue ? cue.text.content : (s.caption || '');
    s.duration = Math.max(2, Math.min(20, Math.round(c.duration * 2) / 2));
    s.transition = c.transitionIn.type === 'none' ? 'none' : (Object.keys(V1_TRANSITIONS).find((k) => V1_TRANSITIONS[k] === c.transitionIn.type) || 'fade');
    if (nar) s.narr = { key: nar.narr.key, dur: nar.narr.dur, voice: nar.narr.voice, rate: nar.narr.rate, engine: nar.narr.engine };
    return s;
  });
}
export function toV1View(p) {
  const music = p.clips.find((c) => c.kind === 'music');
  const capTrack = p.tracks.find((t) => t.role === 'storyCaptions');
  return { title: p.title, aspect: p.settings.aspect, style: p.style, music: music ? music.music.kind : 'none', captions: capTrack ? !capTrack.hidden : true, voice: p.voice, rate: p.rate, lang: p.lang, language: p.language, assets: p.assets, scenes: storyboardScenes(p) };
}
export function applyStoryboard(p, v1) {
  const need = [['storyboard', 'video', 'Storyboard'], ['storyCaptions', 'caption', 'Captions'], ['narration', 'audio', 'Narration'], ['music', 'audio', 'Music']];
  need.forEach(([role, type, name]) => { if (!p.tracks.some((t) => t.role === role)) { const t = newTrack(type, name, { role }); if (type === 'audio') p.tracks.push(t); else p.tracks.unshift(t); } });
  const keepTracks = p.tracks.filter((t) => ['storyboard', 'storyCaptions', 'narration', 'music'].includes(t.role));
  const sbTrack = keepTracks.find((t) => t.role === 'storyboard');
  const oldScene = new Map(p.clips.filter((c) => c.kind === 'scene').map((c) => [c.scene.id || c.id, c]));
  const ownIds = new Set(p.clips.filter((c) => c.kind === 'scene' || (c.link && p.clips.some((x) => x.id === c.link && x.kind === 'scene')) || (c.kind === 'music' && keepTracks.some((t) => t.role === 'music' && t.id === c.trackId))).map((c) => c.id));
  const others = p.clips.filter((c) => !ownIds.has(c.id));
  const fake = { ...v1, voice: v1.voice || p.voice, rate: v1.rate || p.rate, lang: v1.lang || p.lang, captions: true };
  const built = v1ToV2({ ...fake, id: p.id, assets: [], aspect: '9:16', vol: (p.clips.find((c) => c.kind === 'music') || { audio: { gain: 0.5 } }).audio.gain });
  const map = { storyboard: sbTrack.id, storyCaptions: (keepTracks.find((t) => t.role === 'storyCaptions') || {}).id, narration: (keepTracks.find((t) => t.role === 'narration') || {}).id, music: (keepTracks.find((t) => t.role === 'music') || {}).id };
  const roleOfTrack = new Map(built.tracks.map((t) => [t.id, t.role]));
  const fresh = built.clips.map((c) => {
    const role = roleOfTrack.get(c.trackId); c.trackId = map[role] || c.trackId;
    if (c.kind === 'scene') { const old = oldScene.get(c.scene.id); if (old) { c.transform = clone(old.transform); c.opacity = old.opacity; c.blend = old.blend; c.adjust = clone(old.adjust); c.filter = old.filter; c.effects = clone(old.effects); c.id = old.id; } }
    return c;
  });
  const idMap = new Map(); built.clips.forEach((c) => { if (c.kind === 'scene') idMap.set(c.scene.id, c.id); });
  fresh.forEach((c) => { if (c.link) { const sid = built.clips.find((x) => x.id === c.link); if (sid && sid.scene) c.link = idMap.get(sid.scene.id) || c.link; } });
  p.clips = [...others, ...fresh.filter((c) => c.trackId)];
  p.style = v1.style || p.style;
  const capTrack = p.tracks.find((t) => t.role === 'storyCaptions'); if (capTrack) capTrack.hidden = v1.captions === false;
  if (v1.aspect && v1.aspect !== p.settings.aspect && V1_ASPECTS[v1.aspect]) { p.settings.width = V1_ASPECTS[v1.aspect][0]; p.settings.height = V1_ASPECTS[v1.aspect][1]; p.settings.aspect = v1.aspect; p.settings.preset = 'custom'; }
}

// ───────── sanitising imported projects ─────────
function sanTransform(t) {
  const d = newClip('image').transform; const o = isObj(t) ? t : {};
  const crop = isObj(o.crop) ? o.crop : {}; const mk = isObj(o.mask) ? o.mask : {};
  return { x: clamp(num(o.x, d.x), -3, 3), y: clamp(num(o.y, d.y), -3, 3), scale: clamp(num(o.scale, 1), 0.01, 20), rotation: clamp(num(o.rotation, 0), -3600, 3600), flipX: !!o.flipX, flipY: !!o.flipY,
    crop: { l: clamp(num(crop.l), 0, 0.9), t: clamp(num(crop.t), 0, 0.9), r: clamp(num(crop.r), 0, 0.9), b: clamp(num(crop.b), 0, 0.9) }, fit: ['fit', 'fill', 'stretch', 'fitblur'].includes(o.fit) ? o.fit : 'fit',
    mask: { shape: ['none', 'rect', 'ellipse', 'heart', 'star'].includes(mk.shape) ? mk.shape : 'none', feather: clamp(num(mk.feather), 0, 200), invert: !!mk.invert, x: clamp(num(mk.x), -2, 2), y: clamp(num(mk.y), -2, 2), w: clamp(num(mk.w, 0.6), 0.01, 4), h: clamp(num(mk.h, 0.6), 0.01, 4) } };
}
const colour = (v, d) => (typeof v === 'string' && /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i.test(v) ? v : d);
function sanText(t) {
  const d = defaultText(); const o = isObj(t) ? t : {};
  const g = isObj(o.gradient) ? o.gradient : {}, st = isObj(o.stroke) ? o.stroke : {}, sh = isObj(o.shadow) ? o.shadow : {}, bx = isObj(o.box) ? o.box : {};
  return { content: str(o.content, 2000), font: FONTS[o.font] ? o.font : 'sans', size: clamp(num(o.size, d.size), 4, 600), weight: clamp(num(o.weight, d.weight), 100, 900), italic: !!o.italic, align: ['left', 'center', 'right'].includes(o.align) ? o.align : 'center', color: colour(o.color, d.color),
    gradient: { on: !!g.on, c1: colour(g.c1, d.gradient.c1), c2: colour(g.c2, d.gradient.c2), angle: clamp(num(g.angle, 90), -360, 360) }, stroke: { w: clamp(num(st.w), 0, 60), color: colour(st.color, '#000000') },
    shadow: { on: sh.on !== false, x: clamp(num(sh.x), -100, 100), y: clamp(num(sh.y, 4), -100, 100), blur: clamp(num(sh.blur, 14), 0, 100), color: colour(sh.color, d.shadow.color) }, letterSpacing: clamp(num(o.letterSpacing), -20, 80), lineHeight: clamp(num(o.lineHeight, 1.2), 0.6, 3), width: clamp(num(o.width, 0.84), 0.1, 2),
    box: { on: !!bx.on, color: colour(bx.color, '#000000'), alpha: clamp(num(bx.alpha, 0.6), 0, 1), pad: clamp(num(bx.pad, 22), 0, 200), radius: clamp(num(bx.radius, 16), 0, 200) },
    animIn: str(o.animIn, 16) || 'none', animOut: str(o.animOut, 16) || 'none', animLoop: str(o.animLoop, 16) || 'none', animDur: clamp(num(o.animDur, 0.5), 0.05, 5), kinetic: str(o.kinetic, 16) || 'none', kStagger: clamp(num(o.kStagger, 0.09), 0.01, 1), hl: colour(o.hl, d.hl) };
}
function sanShape(s) {
  const d = defaultShape(); const o = isObj(s) ? s : {}; const g = isObj(o.gradient) ? o.gradient : {};
  return { type: ['rect', 'rounded', 'ellipse', 'line', 'arrow', 'star', 'polygon'].includes(o.type) ? o.type : 'rect', fill: colour(o.fill, d.fill), fillAlpha: clamp(num(o.fillAlpha, 1), 0, 1), gradient: { on: !!g.on, c1: colour(g.c1, d.gradient.c1), c2: colour(g.c2, d.gradient.c2), angle: clamp(num(g.angle, 45), -360, 360) }, stroke: colour(o.stroke, '#ffffff'), strokeW: clamp(num(o.strokeW), 0, 80), w: clamp(num(o.w, d.w), 1, 8000), h: clamp(num(o.h, d.h), 1, 8000), radius: clamp(num(o.radius, d.radius), 0, 2000), points: clamp(Math.round(num(o.points, 5)), 3, 20), inner: clamp(num(o.inner, 0.45), 0.1, 0.95) };
}
function sanScene(s) {
  const o = isObj(s) ? s : {}; const out = {};
  out.id = str(o.id, 60) || nid('sc'); out.title = str(o.title, 120); out.layout = ['title', 'bullets', 'quote', 'stat', 'chart', 'kinetic', 'image', 'video'].includes(o.layout) ? o.layout : 'title'; out.text = str(o.text, 400);
  out.bullets = Array.isArray(o.bullets) ? o.bullets.slice(0, 8).map((b) => str(b, 120)) : []; out.stat = str(o.stat, 40);
  out.data = Array.isArray(o.data) ? o.data.slice(0, 8).map((r) => ({ label: str(r && r.label, 40), value: num(r && r.value) })) : [];
  out.caption = str(o.caption, 400); out.duration = clamp(num(o.duration, 5), 1, 60); out.anim = ['fade', 'slide', 'zoom'].includes(o.anim) ? o.anim : 'fade';
  out.bg = /^#[0-9a-f]{6}$/i.test(o.bg || '') ? o.bg : ''; out.image = o.image ? str(o.image, 60) : null; out.video = o.video ? str(o.video, 60) : null; out.imagePrompt = str(o.imagePrompt, 300); out.trimStart = clamp(num(o.trimStart), 0, 36000); out.keepAudio = !!o.keepAudio;
  return out;
}
const sanTrans = (t) => { const o = isObj(t) ? t : {}; return { type: ['none', ...TRANSITION_TYPES.map((x) => x[0])].includes(o.type) ? o.type : 'none', duration: clamp(num(o.duration, 0.6), 0.1, 3), dir: ['left', 'right', 'up', 'down'].includes(o.dir) ? o.dir : 'left' }; };
export function sanitiseClip(raw, trackIds) {
  if (!isObj(raw) || !trackIds.has(raw.trackId)) return null;
  const kind = ['video', 'image', 'audio', 'music', 'text', 'shape', 'sticker', 'scene', 'caption', 'effect', 'adjustment'].includes(raw.kind) ? raw.kind : null; if (!kind) return null;
  const start = num(raw.start, NaN), duration = num(raw.duration, NaN); if (!Number.isFinite(start) || !Number.isFinite(duration) || duration <= 0 || start < 0 || start > 86400 || duration > 86400) return null;
  const adj = isObj(raw.adjust) ? raw.adjust : {}, a0 = zeroAdjust(); const adjust = {}; Object.keys(a0).forEach((k) => { adjust[k] = clamp(num(adj[k]), -100, 100); });
  adjust.exposure = clamp(num(adj.exposure), -3, 3); adjust.blur = clamp(num(adj.blur), 0, 100);
  const au = isObj(raw.audio) ? raw.audio : {}; const ch = isObj(raw.chroma) ? raw.chroma : {};
  const c = newClip(kind, {});
  Object.assign(c, { id: str(raw.id, 60) || nid('c'), trackId: raw.trackId, assetId: raw.assetId ? str(raw.assetId, 80) : null, name: str(raw.name, 120), start, duration, in: clamp(num(raw.in), 0, 86400), speed: clamp(num(raw.speed, 1), 0.1, 8), reverse: !!raw.reverse, freeze: !!raw.freeze, groupId: raw.groupId ? str(raw.groupId, 60) : null,
    transform: sanTransform(raw.transform), opacity: clamp(num(raw.opacity, 1), 0, 1), blend: BLENDS.includes(raw.blend) ? raw.blend : 'normal', adjust, filter: str(raw.filter, 24) || 'none', filterAmount: clamp(num(raw.filterAmount, 1), 0, 1),
    effects: (Array.isArray(raw.effects) ? raw.effects : []).slice(0, LIMITS.effects).filter((e) => isObj(e) && EFFECT_TYPES.some((x) => x[0] === e.type)).map((e) => ({ type: e.type, amount: clamp(num(e.amount, 1), 0, 100) })),
    chroma: { on: !!ch.on, color: colour(ch.color, '#00ff00'), tolerance: clamp(num(ch.tolerance, 0.32), 0, 1), softness: clamp(num(ch.softness, 0.12), 0, 1) }, transitionIn: sanTrans(raw.transitionIn), transitionOut: sanTrans(raw.transitionOut),
    audio: { gain: clamp(num(au.gain, 1), 0, 4), fadeIn: clamp(num(au.fadeIn), 0, 60), fadeOut: clamp(num(au.fadeOut), 0, 60), loop: !!au.loop, pan: clamp(num(au.pan), -1, 1), mute: !!au.mute, duck: !!au.duck, denoise: !!au.denoise, role: au.role === 'voice' ? 'voice' : '' } });
  if (raw.link) c.link = str(raw.link, 60);
  if (kind === 'text' || kind === 'caption') c.text = sanText(raw.text);
  if (kind === 'caption') { const cp = isObj(raw.cap) ? raw.cap : {}; c.cap = { preset: ['plain', 'boxed', 'outlined', 'karaoke', 'pop'].includes(cp.preset) ? cp.preset : 'boxed', lead: clamp(num(cp.lead), 0, 30), dur: clamp(num(cp.dur), 0, 3600) }; }
  if (kind === 'shape') c.shape = sanShape(raw.shape);
  if (kind === 'sticker') { const s = isObj(raw.sticker) ? raw.sticker : {}; c.sticker = { type: s.type === 'svg' ? 'svg' : 'emoji', char: str(s.char, 16) || '⭐', id: str(s.id, 40), color: colour(s.color, '#a8471f'), size: clamp(num(s.size, 240), 8, 4000) }; }
  if (kind === 'scene') c.scene = sanScene(raw.scene);
  if (kind === 'music') c.music = { kind: raw.music && raw.music.kind === 'upbeat' ? 'upbeat' : 'calm' };
  if (raw.narr && isObj(raw.narr) && typeof raw.narr.key === 'string') c.narr = { key: str(raw.narr.key, 24), dur: clamp(num(raw.narr.dur), 0, 3600), text: str(raw.narr.text, 400), voice: str(raw.narr.voice, 30), rate: clamp(num(raw.narr.rate, 1), 0.5, 2), engine: str(raw.narr.engine, 24) };
  const kfs = {}; if (isObj(raw.keyframes)) Object.keys(raw.keyframes).slice(0, 40).forEach((k) => { const l = raw.keyframes[k]; if (!/^[a-zA-Z.]{1,40}$/.test(k) || !Array.isArray(l)) return; const clean = l.slice(0, LIMITS.keyframes).filter((x) => isObj(x) && Number.isFinite(Number(x.t)) && Number.isFinite(Number(x.v))).map((x) => ({ t: clamp(Number(x.t), 0, 86400), v: Number(x.v), ease: EASE_NAMES.some((e) => e[0] === x.ease) ? x.ease : 'inout', ...(Array.isArray(x.b) && x.b.length === 4 && x.b.every((n) => Number.isFinite(Number(n))) ? { b: x.b.map(Number) } : {}) })).sort((a, b) => a.t - b.t); if (clean.length) kfs[k] = clean; });
  c.keyframes = kfs;
  return c;
}
// Accepts a parsed JSON value (v1 or v2), returns a clean v2 project or throws a readable Error.
export function sanitiseProject(raw) {
  if (!isObj(raw)) throw new Error('This file is not a Cognita Studio project.');
  if (isV1(raw)) return v1ToV2(raw);
  if (raw.v !== MODEL_VERSION || !Array.isArray(raw.tracks) || !Array.isArray(raw.clips)) throw new Error('This file is not a Cognita Studio project (missing tracks or clips).');
  const p = newProject({ title: str(raw.title, 80) || 'Imported project' });
  const s = isObj(raw.settings) ? raw.settings : {};
  const w = even(clamp(num(s.width, 1080), 64, 7680)), h = even(clamp(num(s.height, 1920), 64, 7680));
  p.settings = { width: w, height: h, aspect: aspectLabel(w, h), fps: FPS_OPTIONS.includes(num(s.fps)) ? num(s.fps) : 30, bg: colour(s.bg, '#000000'), preset: str(s.preset, 16) || 'custom' };
  p.id = str(raw.id, 60) || p.id; p.createdAt = num(raw.createdAt, Date.now()); p.updatedAt = Date.now(); p.language = str(raw.language, 40) || p.language; p.lang = str(raw.lang, 10) || p.lang; p.voice = str(raw.voice, 30); p.rate = clamp(num(raw.rate, 1), 0.5, 2); p.style = ['clean', 'dark', 'bold'].includes(raw.style) ? raw.style : 'clean';
  const au = isObj(raw.audio) ? raw.audio : {}, du = isObj(au.duck) ? au.duck : {};
  p.audio = { master: clamp(num(au.master, 1), 0, 2), duck: { amount: clamp(num(du.amount, 0.7), 0, 1), attack: clamp(num(du.attack, 0.25), 0.01, 3), release: clamp(num(du.release, 0.6), 0.01, 5) } };
  p.assets = raw.assets && Array.isArray(raw.assets) ? raw.assets.slice(0, LIMITS.assets).filter((a) => isObj(a) && a.id).map((a) => ({ id: str(a.id, 80), kind: ['video', 'image', 'audio'].includes(a.kind) ? a.kind : 'image', origin: a.origin === 'generated' || a.origin === 'recorded' ? a.origin : 'upload', name: str(a.name, 120), mime: str(a.mime, 60), size: num(a.size), duration: num(a.duration), width: num(a.width), height: num(a.height), fps: num(a.fps), hasAudio: !!a.hasAudio, vcodec: str(a.vcodec, 24), acodec: str(a.acodec, 24), thumb: typeof a.thumb === 'string' && a.thumb.startsWith('data:image/') && a.thumb.length < 60000 ? a.thumb : '', status: 'ready' })) : [];
  p.tracks = raw.tracks.slice(0, LIMITS.tracks).filter((t) => isObj(t) && t.id && TRACK_TYPES.includes(t.type)).map((t) => ({ id: str(t.id, 60), type: t.type, name: str(t.name, 60) || TRACK_NAMES[t.type], locked: !!t.locked, muted: !!t.muted, hidden: !!t.hidden, solo: !!t.solo, height: clamp(num(t.height, 56), 32, 160), volume: clamp(num(t.volume, 1), 0, 2), ...(t.role ? { role: str(t.role, 24) } : {}) }));
  if (!p.tracks.length) p.tracks = defaultTracks();
  const ids = new Set(p.tracks.map((t) => t.id));
  p.clips = raw.clips.slice(0, LIMITS.clips).map((c) => sanitiseClip(c, ids)).filter(Boolean);
  p.markers = Array.isArray(raw.markers) ? raw.markers.slice(0, LIMITS.markers).filter((m) => isObj(m) && Number.isFinite(Number(m.t))).map((m) => ({ id: str(m.id, 40) || nid('m'), t: clamp(Number(m.t), 0, 86400), label: str(m.label, 60) })) : [];
  p.styles = []; p.captionStyle = { preset: isObj(raw.captionStyle) && ['plain', 'boxed', 'outlined', 'karaoke', 'pop'].includes(raw.captionStyle.preset) ? raw.captionStyle.preset : 'boxed' };
  p.export = { burnCaptions: !isObj(raw.export) || raw.export.burnCaptions !== false };
  return p;
}

// What the library cards need, for both shapes.
export function summarise(p) {
  if (isV1(p)) { const total = p.scenes.reduce((a, s) => a + sceneDur(p, s), 0); return { clips: p.scenes.length, label: p.scenes.length + ' scenes', duration: total, aspect: p.aspect }; }
  return { clips: (p.clips || []).length, label: (p.clips || []).length + ' clips', duration: projectDuration({ clips: p.clips || [] }), aspect: p.settings ? p.settings.aspect : '9:16' };
}
export { narrKey, validNarr, NARR_LEAD, NARR_TAIL };
