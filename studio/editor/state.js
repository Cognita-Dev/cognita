// studio/editor/state.js
// The one editor state, the one command/undo system, and every edit operation. No edit bypasses transact().
// Undo is command based: each command is { label, before, after } over the project's edit state (tracks, clips, markers, settings,
// audio, captions), consecutive drags and slider moves coalesce into one command, and history is capped by count and size.

import * as M from '../model.js';
import * as store from '../store.js';
import { drawFrame } from '../render.js';

export const S = {
  screen: 'home', project: null, hub: null, sel: new Set(), t: 0, playing: false, loop: false, loopRange: false, rate: 1,
  pps: 90, scrollX: 0, scrollY: 0, snap: true, ripple: false, grid: false, safe: false, markIn: null, markOut: null,
  clipboard: null, history: [], future: [], saveState: 'saved', dirty: false, tab: 'media', busy: null, mobileTool: 'media', toast: '',
  narrJob: null, status: null, exportState: null, view: { w: 0, h: 0 },
};
const subs = {};
export const on = (e, fn) => { (subs[e] = subs[e] || []).push(fn); return () => { subs[e] = (subs[e] || []).filter((f) => f !== fn); }; };
export const emit = (e, a) => { (subs[e] || []).slice().forEach((f) => { try { f(a); } catch (err) { console.error('[studio] handler failed for', e, err); } }); };
export const P = () => S.project;
export const fps = () => (S.project ? S.project.settings.fps : 30);
export const snapT = (t) => M.quant(S.project, t);
export const dur = () => M.projectDuration(S.project);
export const clipById = (id) => S.project.clips.find((c) => c.id === id) || null;
export const trackById = (id) => S.project.tracks.find((t) => t.id === id) || null;
export const trackIdx = (id) => S.project.tracks.findIndex((t) => t.id === id);
export const selClips = () => [...S.sel].map(clipById).filter(Boolean);
export const toast = (msg) => { S.toast = msg; emit('toast', msg); };
export const bump = () => { S.project._rev = (S.project._rev || 0) + 1; };

// ───────── history ─────────
const EDIT_KEYS = ['tracks', 'clips', 'markers', 'settings', 'audio', 'captionStyle', 'style', 'voice', 'rate', 'lang', 'language', 'title'];
const snap = () => { const o = {}; EDIT_KEYS.forEach((k) => { o[k] = S.project[k]; }); return JSON.stringify(o); };
const HIST_MAX = 100, HIST_CHARS = 60e6;
let histChars = 0;
function pushCmd(cmd) {
  S.history.push(cmd); histChars += cmd.before.length; S.future = [];
  while (S.history.length > HIST_MAX || (histChars > HIST_CHARS && S.history.length > 1)) { const d = S.history.shift(); histChars -= d.before.length; }
}
// Runs a mutation as one undoable command. Pass { coalesce: 'key' } for drags and slider moves.
export function transact(label, fn, opts = {}) {
  if (!S.project) return false;
  const before = snap(); let r;
  try { r = fn(S.project); } catch (e) { applySnap(before, true); throw e; }
  bump(); const after = snap(); if (after === before) return r === undefined ? false : r;
  const last = S.history[S.history.length - 1]; const now = performance.now();
  if (opts.coalesce && last && last.key === opts.coalesce && now - last.ts < 1200) { last.after = after; last.ts = now; } else { pushCmd({ label, before, after, key: opts.coalesce || '', ts: now }); }
  markDirty(); emit(opts.soft ? 'frame' : 'project'); return r === undefined ? true : r;
}
// Live edits during a drag: mutate without recording, then call transact-like commit with the starting snapshot.
export function beginLive() { return snap(); }
export function commitLive(label, before, key) {
  bump(); const after = snap(); if (after === before) { emit('project'); return; }
  const last = S.history[S.history.length - 1]; const now = performance.now();
  if (key && last && last.key === key && now - last.ts < 1200) { last.after = after; last.ts = now; } else pushCmd({ label, before, after, key: key || '', ts: now });
  markDirty(); emit('project');
}
function applySnap(json, quiet) {
  const o = JSON.parse(json); EDIT_KEYS.forEach((k) => { if (k in o) S.project[k] = o[k]; });
  bump(); const ids = new Set(S.project.clips.map((c) => c.id)); [...S.sel].forEach((i) => { if (!ids.has(i)) S.sel.delete(i); });
  if (!quiet) { markDirty(); emit('project'); emit('sel'); }
}
export function undo() { const c = S.history.pop(); if (!c) return; histChars -= c.before.length; S.future.push(c); applySnap(c.before); toast('Undid: ' + c.label); }
export function redo() { const c = S.future.pop(); if (!c) return; S.history.push(c); histChars += c.before.length; applySnap(c.after); toast('Redid: ' + c.label); }
export function resetHistory() { S.history = []; S.future = []; histChars = 0; }

// ───────── saving, recovery ─────────
let saveTimer = 0, recTimer = 0;
export function markDirty() {
  S.dirty = true; S.saveState = 'unsaved'; emit('status'); clearTimeout(saveTimer); saveTimer = setTimeout(save, 900);
  if (!recTimer) recTimer = setTimeout(() => { recTimer = 0; if (S.dirty && S.project) store.saveRecovery(S.project.id, strip(S.project)).catch(() => {}); }, 8000);
}
export const strip = (p) => JSON.parse(JSON.stringify(p, (k, v) => (k.startsWith('_') ? undefined : v)));
export function makeThumb() {
  try {
    const p = S.project; const { width, height } = fitBox(p.settings.width, p.settings.height, 160); const c = document.createElement('canvas'); c.width = width; c.height = height;
    drawFrame(c.getContext('2d'), width, height, p, Math.min(thumbTime(p), Math.max(0, M.projectDuration(p) - 0.05)), S.hub.res); return c.toDataURL('image/jpeg', 0.7);
  } catch (_) { return ''; }
}
const thumbTime = (p) => { const c = p.clips.filter((x) => x.kind !== 'audio' && x.kind !== 'music').sort((a, b) => a.start - b.start)[0]; return c ? c.start + Math.min(1.5, c.duration * 0.5) : 0; };
export const fitBox = (w, h, long) => { const k = long / Math.max(w, h); return { width: M.even(w * k), height: M.even(h * k) }; };
export async function save() {
  if (!S.project) return; S.saveState = 'saving'; emit('status');
  try { S.project.updatedAt = Date.now(); S.project.thumb = makeThumb(); await store.saveProject(strip(S.project)); S.dirty = false; S.saveState = 'saved'; store.clearRecovery(S.project.id).catch(() => {}); }
  catch (e) { S.saveState = 'failed'; S.saveError = e.code === 'STORAGE' ? e.message : 'Could not save: ' + (e.message || e); console.error('[studio] save failed', e); }
  emit('status');
}

// ───────── tracks ─────────
const PREFER = { video: 'video', image: 'video', scene: 'video', text: 'text', shape: 'graphic', sticker: 'sticker', audio: 'audio', music: 'audio', caption: 'caption', effect: 'effect', adjustment: 'adjustment' };
export const overlaps = (trackId, start, d, ignore = new Set()) => { const e = start + d; return S.project.clips.some((c) => c.trackId === trackId && !ignore.has(c.id) && c.start < e - 1e-6 && c.start + c.duration > start + 1e-6); };
function insertTrack(tr) {
  const p = S.project; const t = tr.type;
  if (t === 'audio') p.tracks.push(tr);
  else if (t === 'video' || t === 'image') { const mi = p.tracks.findIndex((x) => x.role === 'main' || x.role === 'storyboard'); p.tracks.splice(mi >= 0 ? mi : p.tracks.length, 0, tr); }
  else p.tracks.unshift(tr);
}
const nameFor = (type) => { const n = S.project.tracks.filter((t) => t.type === type).length + 1; return ({ video: 'Overlay', image: 'Image', audio: 'Audio', text: 'Text', caption: 'Captions', sticker: 'Stickers', graphic: 'Graphics', effect: 'Effects', adjustment: 'Adjustment' }[type] || 'Track') + ' ' + n; };
export function addTrack(type) { return transact('Add track', (p) => { const t = M.newTrack(type, nameFor(type)); insertTrack(t); return t.id; }); }
export function findTrackFor(kind, start, d, prefer, ignore) {
  const p = S.project; const want = PREFER[kind] || 'video';
  const ok = (t) => !t.locked && M.trackAccepts(t.type, kind) && !overlaps(t.id, start, d, ignore || new Set());
  const pt = prefer && trackById(prefer); if (pt && ok(pt)) return pt;
  const cands = p.tracks.filter((t) => t.type === want).concat(p.tracks.filter((t) => t.type !== want));
  return cands.find((t) => ok(t) && (!(t.role === 'storyCaptions' || t.role === 'storyboard' || t.role === 'narration') || kind === 'scene')) || null;
}
export function removeTrack(id) { return transact('Delete track', (p) => { if (p.tracks.length <= 1) return; p.tracks = p.tracks.filter((t) => t.id !== id); p.clips = p.clips.filter((c) => c.trackId !== id); S.sel.forEach((i) => { if (!clipById(i)) S.sel.delete(i); }); }); }
export function moveTrack(id, d) { return transact('Reorder track', (p) => { const i = trackIdx(id), j = i + d; if (j < 0 || j >= p.tracks.length) return; const [t] = p.tracks.splice(i, 1); p.tracks.splice(j, 0, t); }); }
export function setTrack(id, patch, label = 'Edit track') { return transact(label, () => { const t = trackById(id); if (t) Object.assign(t, patch); }, { coalesce: 'trk:' + id + Object.keys(patch).join() }); }

// ───────── clips ─────────
export const srcDurOf = (c) => { if (c.kind === 'audio' && c.narr) return c.narr.dur; const id = c.kind === 'scene' ? c.scene.video : c.assetId; const a = id && M.assetOf(S.project, id); return a && a.duration ? a.duration : Infinity; };
export function addClip(kind, props, start, d, prefer) {
  return transact('Add ' + kind, (p) => {
    start = Math.max(0, snapT(start)); const clip = M.newClip(kind, { ...props, start, duration: d });
    let tr = findTrackFor(kind, start, d, prefer);
    if (!tr) { tr = M.newTrack(PREFER[kind] === 'video' && kind === 'image' ? 'video' : PREFER[kind] || 'video', nameFor(PREFER[kind] || 'video')); insertTrack(tr); }
    clip.trackId = tr.id; p.clips.push(clip); S.sel = new Set([clip.id]); return clip.id;
  });
}
export const withLinked = (ids) => { const out = new Set(ids); S.project.clips.forEach((c) => { if (c.link && out.has(c.link)) out.add(c.id); }); [...out].forEach((id) => { const c = clipById(id); if (c && c.groupId) S.project.clips.forEach((x) => { if (x.groupId === c.groupId) out.add(x.id); }); }); return out; };
export function select(ids, additive) { if (!additive) S.sel = new Set(); ids.forEach((i) => S.sel.add(i)); emit('sel'); }
export const clearSel = () => { if (S.sel.size) { S.sel.clear(); emit('sel'); } };
export function setClip(id, fn, label = 'Edit clip', coalesce) { return transact(label, () => { const c = clipById(id); if (c) fn(c); }, { coalesce: coalesce || '' }); }

// Moves clips by dt seconds and, optionally, across tracks by dTrack positions. Returns false when the move would collide.
export function moveClips(ids, dt, dTrack = 0, label = 'Move') {
  const set = withLinked(ids); const p = S.project; const group = [...set].map(clipById).filter(Boolean);
  if (group.some((c) => trackById(c.trackId).locked)) return false;
  const minStart = Math.min(...group.map((c) => c.start)); dt = Math.max(dt, -minStart);
  const plan = group.map((c) => { let tr = trackById(c.trackId); if (dTrack) { const j = trackIdx(c.trackId) + dTrack; const cand = p.tracks[j]; if (cand && cand.type !== 'audio' === (tr.type !== 'audio') && !cand.locked && M.trackAccepts(cand.type, c.kind) && !(cand.role === 'storyboard' || cand.role === 'narration')) tr = cand; } return { c, tr, start: Math.max(0, snapT(c.start + dt)) }; });
  if (plan.some((x) => overlaps(x.tr.id, x.start, x.c.duration, set))) return false;
  const internal = plan.some((x, i) => plan.some((y, j) => j > i && x.tr.id === y.tr.id && x.start < y.start + y.c.duration - 1e-6 && x.start + x.c.duration > y.start + 1e-6)); if (internal) return false;
  return transact(label, () => { plan.forEach((x) => { x.c.start = x.start; x.c.trackId = x.tr.id; }); }, { coalesce: 'move' }) !== false;
}
const MIN_DUR = 0.1;
export function trimEdge(id, edge, time, ripple) {
  const c = clipById(id); if (!c) return false; const tr = trackById(c.trackId); if (tr.locked) return false;
  const list = S.project.clips.filter((x) => x.trackId === c.trackId && x.id !== id).sort((a, b) => a.start - b.start); const sp = c.speed || 1; const end = c.start + c.duration; const media = c.kind === 'video' || c.kind === 'audio';
  return transact('Trim', () => {
    if (edge === 'r') {
      const prevEnd = end; let ne = Math.max(c.start + MIN_DUR, snapT(time));
      if (media && !c.audio.loop && !c.freeze && c.kind !== 'image') ne = Math.min(ne, c.start + (srcDurOf(c) - c.in) / sp);
      if (c.kind === 'audio' && c.audio.loop) ne = Math.max(ne, c.start + MIN_DUR);
      if (!ripple) { const nx = list.find((x) => x.start >= prevEnd - 1e-6); if (nx) ne = Math.min(ne, nx.start); }
      const dd = ne - prevEnd; c.duration = ne - c.start;
      if (ripple && dd) list.forEach((x) => { if (x.start >= prevEnd - 1e-6) x.start = Math.max(0, x.start + dd); });
    } else {
      let ns = Math.min(end - MIN_DUR, Math.max(0, snapT(time))); if (media && !c.freeze) ns = Math.max(ns, c.start - c.in / sp);
      if (!ripple) { const pv = [...list].reverse().find((x) => x.start + x.duration <= c.start + 1e-6); if (pv) ns = Math.max(ns, pv.start + pv.duration); }
      const delta = ns - c.start;
      if (media && !c.freeze) c.in = Math.max(0, c.reverse ? c.in : c.in + delta * sp);
      if (ripple) { list.forEach((x) => { if (x.start >= end - 1e-6) x.start = Math.max(0, x.start - delta); }); c.duration = end - ns - delta; } else { c.start = ns; c.duration = end - ns; }
      if (c.kind === 'text' || c.kind === 'caption') Object.values(c.keyframes).forEach((l) => l.forEach((k) => { k.t = Math.max(0, k.t - delta); }));
    }
  }, { coalesce: 'trim:' + id }) !== false;
}
function splitProps(c, p) {
  const d = c.duration, sp = c.speed || 1; const L = JSON.parse(JSON.stringify(c)), R = JSON.parse(JSON.stringify(c)); R.id = M.nid('c'); R.start = c.start + p; R.duration = d - p; L.duration = p;
  if (c.kind === 'video' || c.kind === 'audio') { if (c.reverse) { L.in = c.in + (d - p) * sp; R.in = c.in; } else R.in = c.in + p * sp; }
  L.transitionOut = { type: 'none', duration: 0.6, dir: 'left' }; R.transitionIn = { type: 'none', duration: 0.6, dir: 'left' }; L.groupId = c.groupId; delete R.link;
  Object.keys(c.keyframes || {}).forEach((k) => { const v = M.valueAt(c, k, p); const kf = c.keyframes[k]; L.keyframes[k] = kf.filter((x) => x.t < p - 1e-3).concat([{ t: p, v, ease: 'linear' }]); R.keyframes[k] = [{ t: 0, v, ease: 'linear' }].concat(kf.filter((x) => x.t > p + 1e-3).map((x) => ({ ...x, t: x.t - p }))); });
  if (c.kind === 'caption' || c.kind === 'text') { const words = c.text.content.split(/\s+/).filter(Boolean); if (c.kind === 'caption' && words.length > 1) { const n = Math.max(1, Math.min(words.length - 1, Math.round((words.length * p) / d))); L.text.content = words.slice(0, n).join(' '); R.text.content = words.slice(n).join(' '); } if (c.cap) { L.cap.dur = 0; R.cap.dur = 0; } }
  if (c.kind === 'audio' && c.narr) { delete L.link; }
  return [L, R];
}
export function splitAt(t, ids) {
  const p = S.project; const target = (ids && ids.length ? ids.map(clipById) : p.clips.filter((c) => c.start < t - 0.02 && c.start + c.duration > t + 0.02)).filter((c) => c && !trackById(c.trackId).locked && c.start < t - 0.02 && c.start + c.duration > t + 0.02);
  const sceneBlocked = target.filter((c) => c.kind === 'scene'); const ok = target.filter((c) => c.kind !== 'scene');
  if (!ok.length) { toast(sceneBlocked.length ? 'Storyboard scenes cannot be split. Duplicate or trim them instead.' : 'Nothing to split at the playhead.'); return false; }
  return transact('Split', () => { ok.forEach((c) => { const [L, R] = splitProps(c, t - c.start); Object.assign(c, L); p.clips.push(R); }); S.sel = new Set(ok.map((c) => c.id)); });
}
export function deleteClips(ids, ripple) {
  const set = withLinked(ids); const items = [...set].map(clipById).filter((c) => c && !trackById(c.trackId).locked); if (!items.length) return false;
  return transact(ripple ? 'Ripple delete' : 'Delete', (p) => {
    const gone = new Set(items.map((c) => c.id));
    if (ripple) items.forEach((c) => { p.clips.forEach((x) => { if (!gone.has(x.id) && x.trackId === c.trackId && x.start >= c.start + c.duration - 1e-6) x.start = Math.max(0, x.start - c.duration); }); });
    p.clips = p.clips.filter((c) => !gone.has(c.id)); S.sel.clear();
  });
}
export function copySel() {
  const cs = selClips(); if (!cs.length) return false; const t0 = Math.min(...cs.map((c) => c.start)); const base = Math.min(...cs.map((c) => trackIdx(c.trackId)));
  S.clipboard = cs.map((c) => ({ clip: JSON.parse(JSON.stringify(c)), dt: c.start - t0, tIdx: trackIdx(c.trackId) - base, type: trackById(c.trackId).type })); toast('Copied ' + cs.length + ' clip' + (cs.length > 1 ? 's' : '')); return true;
}
export function pasteAt(t, offsetTracks) {
  if (!S.clipboard || !S.clipboard.length) return false; const items = S.clipboard;
  return transact('Paste', (p) => {
    const ids = []; const gmap = {}; const ref = S.sel.size ? Math.min(...selClips().map((c) => trackIdx(c.trackId))) : -1;
    items.forEach((it) => {
      const c = M.newClip(it.clip.kind, {}); Object.assign(c, JSON.parse(JSON.stringify(it.clip))); c.id = M.nid('c'); c.start = Math.max(0, snapT(t + it.dt)); delete c.link; if (c.groupId) c.groupId = gmap[c.groupId] = gmap[c.groupId] || M.nid('g');
      let tr = findTrackFor(c.kind, c.start, c.duration, it.clip.trackId); if (!tr) { tr = M.newTrack(it.type === 'audio' ? 'audio' : it.type, nameFor(it.type)); insertTrack(tr); }
      c.trackId = tr.id; p.clips.push(c); ids.push(c.id);
    }); S.sel = new Set(ids); void ref; void offsetTracks;
  });
}
export function duplicateSel() { const cs = selClips(); if (!cs.length) return false; copySel(); const end = Math.max(...cs.map((c) => c.start + c.duration)); return pasteAt(end, 0); }
export function groupSel() { const cs = selClips(); if (cs.length < 2) { toast('Select two or more clips to group them.'); return false; } return transact('Group', () => { const g = M.nid('g'); cs.forEach((c) => { c.groupId = g; }); }); }
export function ungroupSel() { const cs = selClips(); if (!cs.some((c) => c.groupId)) return false; return transact('Ungroup', () => { const gs = new Set(cs.map((c) => c.groupId)); S.project.clips.forEach((c) => { if (gs.has(c.groupId)) c.groupId = null; }); }); }
export function mergeCaptions() {
  const cs = selClips().filter((c) => c.kind === 'caption').sort((a, b) => a.start - b.start); if (cs.length < 2) { toast('Select two or more caption cues to merge them.'); return false; }
  return transact('Merge cues', (p) => { const f = cs[0]; const last = cs[cs.length - 1]; f.text.content = cs.map((c) => c.text.content).join(' ').replace(/\s+/g, ' ').trim(); f.duration = last.start + last.duration - f.start; if (f.cap) { f.cap.dur = 0; } const rm = new Set(cs.slice(1).map((c) => c.id)); p.clips = p.clips.filter((c) => !rm.has(c.id)); S.sel = new Set([f.id]); });
}
// Changes speed and keeps the clip's source range, so the clip gets longer or shorter on the timeline.
export function setSpeed(id, speed) {
  const c = clipById(id); if (!c) return false; speed = M.clamp(speed, 0.1, 8);
  return transact('Speed', () => { const src = c.duration * (c.speed || 1); let nd = src / speed; const nx = S.project.clips.filter((x) => x.trackId === c.trackId && x.id !== c.id && x.start >= c.start + c.duration - 1e-6).sort((a, b) => a.start - b.start)[0]; if (nx) nd = Math.min(nd, nx.start - c.start); c.speed = speed; c.duration = Math.max(MIN_DUR, nd); }, { coalesce: 'speed:' + id });
}
export function freezeFrame(t) {
  const c = selClips().find((x) => x.kind === 'video') || S.project.clips.find((x) => x.kind === 'video' && x.start <= t && x.start + x.duration > t); if (!c) { toast('Select a video clip first.'); return false; }
  if (!(t > c.start + 0.05 && t < c.start + c.duration - 0.05)) { toast('Move the playhead inside the clip to freeze that frame.'); return false; }
  const D = 2;
  return transact('Freeze frame', (p) => {
    const [L, R] = splitProps(c, t - c.start); Object.assign(c, L); p.clips.forEach((x) => { if (x.trackId === c.trackId && x.start >= t - 1e-6 && x.id !== c.id) x.start += D; }); R.start += D; p.clips.push(R);
    const ref = M.videoRef(c); const f = M.newClip('video', { trackId: c.trackId, assetId: c.assetId, start: t, duration: D, in: M.srcTime({ ...ref, duration: L.duration }, L.duration), freeze: true, speed: 1, name: 'Freeze', audio: { mute: true } }); p.clips.push(f); S.sel = new Set([f.id]);
  });
}
export function detachAudio(id) {
  const c = clipById(id); if (!c || c.kind !== 'video') return false; const a = M.assetOf(S.project, c.assetId); if (!a || !a.hasAudio) { toast('This clip has no sound to detach.'); return false; }
  return transact('Detach audio', (p) => {
    const tr = findTrackFor('audio', c.start, c.duration) || (() => { const t = M.newTrack('audio', nameFor('audio')); insertTrack(t); return t; })();
    const au = M.newClip('audio', { trackId: tr.id, assetId: c.assetId, start: c.start, duration: c.duration, in: c.in, speed: c.speed, reverse: c.reverse, name: 'Audio: ' + (c.name || a.name), audio: { gain: c.audio.gain } }); p.clips.push(au); c.audio.mute = true; S.sel = new Set([au.id]);
  });
}
export function addMarker(t, label = '') { return transact('Add marker', (p) => { if (p.markers.some((m) => Math.abs(m.t - t) < 0.05)) { p.markers = p.markers.filter((m) => Math.abs(m.t - t) >= 0.05); return; } p.markers.push({ id: M.nid('m'), t: snapT(t), label }); p.markers.sort((a, b) => a.t - b.t); }); }
// Keyframes: when a property already has keyframes, edits write a keyframe at the playhead; otherwise they set the plain value.
export function setProp(id, path, v, coalesce = true) {
  return transact('Edit ' + (M.KEYFRAME_PATHS[path] || path.split('.').pop()), () => {
    const c = clipById(id); if (!c) return; const local = M.clamp(S.t - c.start, 0, c.duration);
    if (M.hasKeyframes(c, path)) M.upsertKeyframe(c, path, local, v, M.keyframeAt(c, path, local) ? undefined : 'inout'); else M.setPath(c, path, v);
  }, { coalesce: coalesce ? 'prop:' + id + path : '', soft: true });
}
export function toggleKeyframe(id, path) {
  return transact('Keyframe', () => { const c = clipById(id); if (!c) return; const local = M.clamp(S.t - c.start, 0, c.duration); if (M.keyframeAt(c, path, local)) M.removeKeyframe(c, path, local); else M.upsertKeyframe(c, path, local, M.valueAt(c, path, local), 'inout'); });
}

// ───────── assets ─────────
export function addAssetRecord(a) { const rec = { ...a }; delete rec._buf; if (S.project.assets.length >= M.LIMITS.assets) throw new Error('This project has too many media files.'); S.project.assets.push(rec); bump(); markDirty(); emit('assets'); return rec; }
export const usageOf = (assetId) => S.project.clips.filter((c) => c.assetId === assetId || (c.scene && (c.scene.image === assetId || c.scene.video === assetId)));
export async function removeAsset(id) {
  const used = usageOf(id).map((c) => c.id); if (used.length) transact('Delete media', (p) => { const gone = withLinked(used); p.clips = p.clips.filter((c) => !gone.has(c.id)); S.sel.clear(); });
  S.project.assets = S.project.assets.filter((a) => a.id !== id); S.hub.forget(id); bump(); markDirty(); emit('assets'); emit('project');
}
export function relinkAsset(oldId, na) {
  const p = S.project; const rec = { ...na }; delete rec._buf;
  transact('Replace media', () => { p.clips.forEach((c) => { if (c.assetId === oldId) c.assetId = rec.id; if (c.scene) { if (c.scene.image === oldId) c.scene.image = rec.id; if (c.scene.video === oldId) c.scene.video = rec.id; } }); });
  const i = p.assets.findIndex((a) => a.id === oldId); if (i >= 0) p.assets.splice(i, 1, rec); else p.assets.push(rec); S.hub.forget(oldId); bump(); markDirty(); emit('assets'); emit('project');
}

// ───────── narration helpers (storyboard-aware) ─────────
export function sceneEndShift(sceneClipId, newDur) {
  const c = clipById(sceneClipId); if (!c) return; const delta = newDur - c.duration; if (delta <= 0.001) return; const oldEnd = c.start + c.duration;
  S.project.clips.forEach((x) => { if (x.id !== c.id && x.start >= oldEnd - 1e-6 && x.kind !== 'music') x.start += delta; });
  c.duration = newDur; S.project.clips.filter((x) => x.link === c.id && x.kind === 'caption').forEach((x) => { x.duration = newDur; });
  const music = S.project.clips.find((x) => x.kind === 'music'); if (music) music.duration = Math.max(music.duration, M.projectDuration({ clips: S.project.clips.filter((x) => x.kind !== 'music') }));
}
