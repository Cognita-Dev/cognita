// studio/editor/timeline.js
// Canvas multitrack timeline (smooth with hundreds of clips: it only paints what is on screen) with DOM track headers.
// Pointer events with setPointerCapture: mouse, touch and pen. Two fingers pinch-zoom; one finger on empty space pans.

import { S, P, on, emit, dur, fps, clipById, trackById, select, clearSel, selClips, moveClips, trimEdge, splitAt, deleteClips, setTrack, addTrack, removeTrack, moveTrack, addMarker, toast, withLinked, snapT, overlaps, transact } from './state.js';
import * as M from '../model.js';
import { seek } from './preview.js';
import { placeDrop, importAndPlace } from './library.js';

const RULER = 30, TRIM = 9;
const COL = { video: '#4f74a8', image: '#628f57', scene: '#a8471f', text: '#8a5fb0', shape: '#b8832f', sticker: '#c26690', audio: '#3b8f8c', music: '#5c8a5a', caption: '#7b7b78', effect: '#b04b4b', adjustment: '#85733a' };
let host, cv, g, heads, headList, wrap, W = 0, H = 0, dpr = 1, queued = false, drag = null, ghostDrop = null, headSig = '', offs = [];
const ptrs = new Map(); const thumbs = new Map();

export function mountTimeline(root) {
  host = root;
  host.innerHTML = `<div class="st-tl-tools" role="toolbar" aria-label="Timeline tools">
      <button type="button" class="st-icon" data-a="split" aria-label="Split at playhead" title="Split (S)"><i class="ph ph-scissors"></i></button>
      <button type="button" class="st-icon" data-a="del" aria-label="Delete selected" title="Delete (Del)"><i class="ph ph-trash"></i></button>
      <button type="button" class="st-icon" data-a="rdel" aria-label="Ripple delete" title="Ripple delete (Shift+Del)"><i class="ph ph-arrows-in-line-horizontal"></i></button>
      <button type="button" class="st-icon" data-a="dup" aria-label="Duplicate" title="Duplicate (D)"><i class="ph ph-copy"></i></button>
      <button type="button" class="st-icon" data-a="group" aria-label="Group selected" title="Group (G)"><i class="ph ph-link"></i></button>
      <button type="button" class="st-icon" data-a="ungroup" aria-label="Ungroup" title="Ungroup (Shift+G)"><i class="ph ph-link-break"></i></button>
      <button type="button" class="st-icon" data-a="marker" aria-label="Add marker" title="Marker (M)"><i class="ph ph-flag"></i></button>
      <span class="st-sep"></span>
      <button type="button" class="st-icon" data-a="snap" aria-label="Snapping" aria-pressed="true" title="Snapping (N)"><i class="ph ph-magnet"></i></button>
      <button type="button" class="st-icon" data-a="ripple" aria-label="Ripple trim" aria-pressed="false" title="Ripple trim (R)"><i class="ph ph-align-left"></i></button>
      <span class="st-sep"></span>
      <button type="button" class="st-icon" data-a="zout" aria-label="Zoom out" title="Zoom out (-)"><i class="ph ph-magnifying-glass-minus"></i></button>
      <input type="range" id="tlZoom" min="0" max="100" aria-label="Timeline zoom" title="Zoom">
      <button type="button" class="st-icon" data-a="zin" aria-label="Zoom in" title="Zoom in (+)"><i class="ph ph-magnifying-glass-plus"></i></button>
      <button type="button" class="st-icon" data-a="fit" aria-label="Fit timeline to window" title="Fit (Shift+Z)"><i class="ph ph-arrows-out-line-horizontal"></i></button>
      <span class="st-sep"></span>
      <label class="st-vh" for="tlAdd">Add track</label><select id="tlAdd" class="st-mini" aria-label="Add track"><option value="">Add track</option>${M.TRACK_TYPES.map((t) => `<option value="${t}">${t[0].toUpperCase() + t.slice(1)}</option>`).join('')}</select>
    </div>
    <div class="st-tl-body"><div class="st-tl-heads" id="tlHeads"><div class="st-tl-corner"></div><div class="st-tl-headlist" id="tlHeadList"></div></div><div class="st-tl-wrap" id="tlWrap"><canvas id="tlCv" tabindex="0" aria-label="Timeline. Use the toolbar and keyboard shortcuts to edit."></canvas></div></div>`;
  cv = host.querySelector('#tlCv'); g = cv.getContext('2d'); heads = host.querySelector('#tlHeads'); headList = host.querySelector('#tlHeadList'); wrap = host.querySelector('#tlWrap');
  host.querySelector('.st-tl-tools').addEventListener('click', toolClick);
  host.querySelector('#tlAdd').addEventListener('change', (e) => { if (e.target.value) addTrack(e.target.value); e.target.value = ''; });
  const zr = host.querySelector('#tlZoom'); zr.addEventListener('input', () => { const f = Number(zr.value) / 100; setZoom(4 * Math.pow(200, f), viewW() / 2 / S.pps + S.scrollX); });
  cv.style.touchAction = 'none';
  cv.addEventListener('pointerdown', down); cv.addEventListener('pointermove', move); cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up); cv.addEventListener('wheel', wheel, { passive: false });
  cv.addEventListener('dragover', dragOver); cv.addEventListener('dragleave', () => { ghostDrop = null; schedule(); }); cv.addEventListener('drop', dropped);
  cv.addEventListener('dblclick', dbl);
  const ro = new ResizeObserver(() => { fitCanvas(); schedule(); }); ro.observe(wrap); offs.push(() => ro.disconnect());
  offs.push(on('project', () => { buildHeads(); schedule(); }), on('sel', schedule), on('assets', schedule), on('playhead', () => { follow(); schedule(); }), on('live', schedule));
  S.hub && (S.hub.onPeaks = schedule);
  fitCanvas(); buildHeads(); fit(); schedule();
}
export function unmountTimeline() { offs.forEach((f) => f()); offs = []; ptrs.clear(); drag = null; }
const viewW = () => Math.max(100, W);
const tToX = (t) => (t - S.scrollX) * S.pps, xToT = (x) => x / S.pps + S.scrollX;
function fitCanvas() { dpr = Math.min(2, window.devicePixelRatio || 1); const r = wrap.getBoundingClientRect(); W = Math.floor(r.width); H = Math.floor(r.height); cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + 'px'; cv.style.height = H + 'px'; }
export function schedule() { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; draw(); }); }
const rows = () => { let y = RULER - S.scrollY; return P().tracks.map((t) => { const r = { t, y, h: t.height }; y += t.height + 2; return r; }); };
const totalH = () => P().tracks.reduce((a, t) => a + t.height + 2, 0) + 40;
function clampScroll() { S.scrollX = Math.max(-1, S.scrollX); S.scrollY = Math.max(0, Math.min(S.scrollY, Math.max(0, totalH() - (H - RULER)))); }
export function setZoom(pps, anchorT) { const a = anchorT == null ? xToT(viewW() / 2) : anchorT; const ax = tToX(a); S.pps = M.clamp(pps, 4, 800); S.scrollX = a - ax / S.pps; clampScroll(); syncZoomUi(); buildHeads(true); schedule(); }
export function zoomBy(f) { setZoom(S.pps * f, S.t); }
export function fit() { const d = Math.max(5, dur() + 1); S.pps = M.clamp((viewW() - 20) / d, 4, 800); S.scrollX = -0.2; syncZoomUi(); schedule(); }
function syncZoomUi() { const z = host && host.querySelector('#tlZoom'); if (z) z.value = Math.round((Math.log(S.pps / 4) / Math.log(200)) * 100); }
function follow() { if (!S.playing || drag) return; const x = tToX(S.t); if (x > W * 0.92 || x < 0) { S.scrollX = S.t - (W * 0.1) / S.pps; clampScroll(); } }

function toolClick(e) {
  const b = e.target.closest('[data-a]'); if (!b) return; const a = b.dataset.a; const ids = [...S.sel];
  if (a === 'split') splitAt(S.t, ids.length ? ids : null); else if (a === 'del') ids.length ? deleteClips(ids, false) : toast('Select a clip first.'); else if (a === 'rdel') ids.length ? deleteClips(ids, true) : toast('Select a clip first.');
  else if (a === 'dup') import('./state.js').then((m) => m.duplicateSel()); else if (a === 'group') import('./state.js').then((m) => m.groupSel()); else if (a === 'ungroup') import('./state.js').then((m) => m.ungroupSel());
  else if (a === 'marker') addMarker(S.t); else if (a === 'snap') { S.snap = !S.snap; b.setAttribute('aria-pressed', S.snap); b.classList.toggle('is-on', S.snap); } else if (a === 'ripple') { S.ripple = !S.ripple; b.setAttribute('aria-pressed', S.ripple); b.classList.toggle('is-on', S.ripple); }
  else if (a === 'zin') zoomBy(1.4); else if (a === 'zout') zoomBy(1 / 1.4); else if (a === 'fit') fit();
}
export function setToolbarState() { if (!host) return; const s = host.querySelector('[data-a="snap"]'); const r = host.querySelector('[data-a="ripple"]'); if (s) { s.setAttribute('aria-pressed', S.snap); s.classList.toggle('is-on', S.snap); } if (r) { r.setAttribute('aria-pressed', S.ripple); r.classList.toggle('is-on', S.ripple); } }

// ───────── headers ─────────
function buildHeads(onlyPos) {
  const p = P(); if (!p || !headList) return; const sig = p.tracks.map((t) => [t.id, t.name, t.locked, t.muted, t.hidden, t.solo, t.height, t.type].join(':')).join('|');
  const rs = rows();
  if (sig !== headSig && !onlyPos) {
    headSig = sig; headList.innerHTML = '';
    p.tracks.forEach((t) => {
      const d = document.createElement('div'); d.className = 'st-th' + (t.locked ? ' is-lock' : ''); d.dataset.id = t.id; d.style.height = t.height + 'px';
      const audio = t.type === 'audio';
      d.innerHTML = `<span class="st-th-ico" aria-hidden="true"><i class="ph ${({ video: 'ph-film-strip', image: 'ph-image', audio: 'ph-waveform', text: 'ph-text-t', caption: 'ph-subtitles', sticker: 'ph-smiley-sticker', graphic: 'ph-shapes', effect: 'ph-sparkle', adjustment: 'ph-sliders' })[t.type] || 'ph-rows'}"></i></span>
        <input class="st-th-name" value="${esc(t.name)}" aria-label="Track name" maxlength="40">
        <span class="st-th-btns"><button type="button" data-k="lock" class="${t.locked ? 'is-on' : ''}" aria-label="${t.locked ? 'Unlock' : 'Lock'} ${esc(t.name)}" aria-pressed="${t.locked}"><i class="ph ${t.locked ? 'ph-lock-simple' : 'ph-lock-simple-open'}"></i></button>
        <button type="button" data-k="${audio ? 'mute' : 'hide'}" class="${(audio ? t.muted : t.hidden) ? 'is-on' : ''}" aria-label="${audio ? (t.muted ? 'Unmute' : 'Mute') : (t.hidden ? 'Show' : 'Hide')} ${esc(t.name)}" aria-pressed="${audio ? t.muted : t.hidden}"><i class="ph ${audio ? (t.muted ? 'ph-speaker-slash' : 'ph-speaker-high') : (t.hidden ? 'ph-eye-slash' : 'ph-eye')}"></i></button>
        ${audio ? `<button type="button" data-k="solo" class="${t.solo ? 'is-on' : ''}" aria-label="Solo ${esc(t.name)}" aria-pressed="${t.solo}">S</button>` : ''}
        <button type="button" data-k="up" aria-label="Move ${esc(t.name)} up"><i class="ph ph-caret-up"></i></button><button type="button" data-k="down" aria-label="Move ${esc(t.name)} down"><i class="ph ph-caret-down"></i></button>
        <button type="button" data-k="del" aria-label="Delete ${esc(t.name)}"><i class="ph ph-x"></i></button></span>`;
      headList.appendChild(d);
    });
    headList.onclick = (e) => { const b = e.target.closest('button[data-k]'); if (!b) return; const id = b.closest('.st-th').dataset.id; const t = trackById(id); const k = b.dataset.k; if (k === 'lock') setTrack(id, { locked: !t.locked }); else if (k === 'mute') setTrack(id, { muted: !t.muted }); else if (k === 'hide') setTrack(id, { hidden: !t.hidden }); else if (k === 'solo') setTrack(id, { solo: !t.solo }); else if (k === 'up') moveTrack(id, -1); else if (k === 'down') moveTrack(id, 1); else if (k === 'del') { if (!S.project.clips.some((c) => c.trackId === id) || window.confirm('Delete this track and the clips on it? You can undo this.')) removeTrack(id); } };
    headList.onchange = (e) => { if (e.target.classList.contains('st-th-name')) { const id = e.target.closest('.st-th').dataset.id; setTrack(id, { name: e.target.value.trim() || 'Track' }); } };
  }
  [...headList.children].forEach((d, i) => { const r = rs[i]; if (r) { d.style.transform = `translateY(${r.y - RULER}px)`; d.style.height = r.h + 'px'; } });
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ───────── drawing ─────────
function snapPoints(exclude) { const p = P(); const pts = [S.t, 0]; p.clips.forEach((c) => { if (!exclude.has(c.id)) { pts.push(c.start, c.start + c.duration); } }); p.markers.forEach((m) => pts.push(m.t)); if (S.markIn != null) pts.push(S.markIn); if (S.markOut != null) pts.push(S.markOut); return pts; }
function thumbFor(a) { if (!a || !a.thumb) return null; let t = thumbs.get(a.id); if (!t) { const im = new Image(); t = { im, ok: false }; im.onload = () => { t.ok = true; schedule(); }; im.src = a.thumb; thumbs.set(a.id, t); } return t.ok ? t.im : null; }
function clipLabel(c) { return c.name || (c.kind === 'text' || c.kind === 'caption' ? (c.text.content || '').split('\n')[0] : c.kind); }
function draw() {
  const p = P(); if (!p || !g) return; clampScroll(); g.setTransform(dpr, 0, 0, dpr, 0, 0); const cs = getComputedStyle(host); const bg = cs.getPropertyValue('--bg-base').trim() || '#f8f7f4'; const fg = cs.getPropertyValue('--text-primary').trim() || '#171717'; const mute = cs.getPropertyValue('--text-muted').trim() || '#8c8c86'; const line = cs.getPropertyValue('--border').trim() || 'rgba(128,128,128,0.25)';
  g.fillStyle = bg; g.fillRect(0, 0, W, H); const rs = rows();
  // lanes
  rs.forEach((r, i) => { if (r.y + r.h < RULER || r.y > H) return; g.fillStyle = i % 2 ? 'rgba(128,128,128,0.07)' : 'rgba(128,128,128,0.035)'; g.fillRect(0, r.y, W, r.h); if (r.t.locked) { g.fillStyle = 'rgba(128,128,128,0.12)'; g.fillRect(0, r.y, W, r.h); } });
  const t0 = xToT(0), t1 = xToT(W); const movingIds = drag && drag.kind === 'move' ? drag.ids : null;
  const sel = S.sel; const idxOf = new Map(rs.map((r, i) => [r.t.id, r]));
  // clips
  for (const c of p.clips) {
    if (c.start > t1 || c.start + c.duration < t0) continue; const r = idxOf.get(c.trackId); if (!r || r.y + r.h < RULER || r.y > H) continue;
    drawClip(c, r, c.start, c.duration, sel.has(c.id), movingIds && movingIds.has(c.id) ? 0.35 : 1, fg);
  }
  // transitions at joints
  p.clips.forEach((c) => { if (c.transitionIn.type !== 'none') { const r = idxOf.get(c.trackId); if (!r) return; const x = tToX(c.start); if (x < -20 || x > W + 20) return; g.fillStyle = '#fff'; g.strokeStyle = '#a8471f'; g.lineWidth = 2; g.beginPath(); const cy = r.y + r.h / 2; g.moveTo(x, cy - 8); g.lineTo(x + 8, cy); g.lineTo(x, cy + 8); g.lineTo(x - 8, cy); g.closePath(); g.fill(); g.stroke(); } });
  // drag ghosts
  if (drag && drag.kind === 'move' && drag.moved) { drag.ids.forEach((id) => { const c = clipById(id); if (!c) return; const base = rs.findIndex((r) => r.t.id === c.trackId); const j = M.clamp(base + drag.dTrack, 0, rs.length - 1); const r = rs[j]; g.save(); g.globalAlpha = 0.85; drawClip(c, r, Math.max(0, c.start + drag.dt), c.duration, true, 1, fg, true); g.restore(); }); }
  if (drag && drag.kind === 'trim' && drag.moved) { const c = clipById(drag.id); const r = idxOf.get(c.trackId); const x = tToX(drag.tNew != null ? drag.tNew : drag.t0); g.strokeStyle = '#ff7a3d'; g.lineWidth = 2; g.beginPath(); g.moveTo(x, r.y); g.lineTo(x, r.y + r.h); g.stroke(); }
  if (drag && drag.kind === 'marquee') { g.fillStyle = 'rgba(255,122,61,0.15)'; g.strokeStyle = '#ff7a3d'; g.lineWidth = 1; const x = Math.min(drag.x0, drag.x1), y = Math.min(drag.y0, drag.y1), w = Math.abs(drag.x1 - drag.x0), h = Math.abs(drag.y1 - drag.y0); g.fillRect(x, y, w, h); g.strokeRect(x + 0.5, y + 0.5, w, h); }
  if (ghostDrop) { g.fillStyle = 'rgba(255,122,61,0.3)'; const r = rs[ghostDrop.row]; if (r) g.fillRect(tToX(ghostDrop.t), r.y, Math.max(24, ghostDrop.d * S.pps), r.h); }
  if (drag && drag.snapT != null) { const x = tToX(drag.snapT); g.strokeStyle = '#ffd24a'; g.lineWidth = 1; g.beginPath(); g.moveTo(x + 0.5, RULER); g.lineTo(x + 0.5, H); g.stroke(); }
  drawRuler(p, fg, mute, line, bg);
  // playhead
  const px = tToX(S.t); if (px >= -2 && px <= W + 2) { g.strokeStyle = '#ff5a1f'; g.lineWidth = 2; g.beginPath(); g.moveTo(px, 0); g.lineTo(px, H); g.stroke(); g.fillStyle = '#ff5a1f'; g.beginPath(); g.moveTo(px - 7, 0); g.lineTo(px + 7, 0); g.lineTo(px, 11); g.closePath(); g.fill(); }
}
function drawClip(c, r, start, d, selected, alpha, fg, ghost) {
  const x = tToX(start), w = Math.max(3, d * S.pps), y = r.y + 2, h = r.h - 4; if (x > W || x + w < 0) return;
  const col = COL[c.kind] || '#777'; g.save(); g.globalAlpha = alpha; g.fillStyle = col; rr(x, y, w, h, 5); g.fill(); g.save(); rr(x, y, w, h, 5); g.clip();
  const a = c.assetId ? M.assetOf(P(), c.assetId) : null; const th = (c.kind === 'video' || c.kind === 'image') ? thumbFor(a) : (c.kind === 'scene' && c.scene.video ? thumbFor(M.assetOf(P(), c.scene.video)) : null);
  if (th && h > 30) { const tw = h * (th.width / th.height); g.globalAlpha = alpha * 0.9; for (let tx = Math.max(x, x - (x % tw)); tx < x + w && tx < W; tx += tw) g.drawImage(th, tx, y, tw, h); g.globalAlpha = alpha; g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(x, y, w, h); }
  if (c.kind === 'audio' || c.kind === 'music') {
    const id = c.assetId; const pk = id && S.hub.peaks.get(id); if (id && !pk && !S.hub.peaks.has(id) && !(S.hub._pk || (S.hub._pk = new Set())).has(id)) { S.hub._pk.add(id); S.hub.peaksFor(P(), id).then(() => schedule()); }
    if (pk) { const buf = S.hub.audio.get(id); const sd = buf ? buf.duration : c.duration; const sp = c.speed || 1; g.fillStyle = 'rgba(255,255,255,0.75)'; const mid = y + h / 2; const x0 = Math.max(0, x), x1 = Math.min(W, x + w); for (let px = Math.floor(x0); px < x1; px += 2) { const lt = ((px - x) / S.pps) * sp + c.in; const bi = M.clamp(Math.floor((lt / sd) * pk.length), 0, pk.length - 1); const v = pk[bi] * (c.audio.gain || 1); const bh = Math.max(1, v * (h - 8)); g.fillRect(px, mid - bh / 2, 1.5, bh); } }
    else if (c.kind === 'music') { g.fillStyle = 'rgba(255,255,255,0.4)'; for (let px = Math.max(0, x); px < Math.min(W, x + w); px += 6) { const bh = 6 + 10 * Math.abs(Math.sin(px * 0.07)); g.fillRect(px, y + h / 2 - bh / 2, 3, bh); } }
    if (c.audio.fadeIn > 0) { g.fillStyle = 'rgba(0,0,0,0.25)'; g.beginPath(); g.moveTo(x, y); g.lineTo(x + c.audio.fadeIn * S.pps, y); g.lineTo(x, y + h); g.fill(); } if (c.audio.fadeOut > 0) { g.fillStyle = 'rgba(0,0,0,0.25)'; g.beginPath(); g.moveTo(x + w, y); g.lineTo(x + w - c.audio.fadeOut * S.pps, y); g.lineTo(x + w, y + h); g.fill(); }
  }
  g.restore();
  g.fillStyle = '#fff'; g.font = '600 11px system-ui, sans-serif'; g.textBaseline = 'top'; if (w > 30) { g.save(); rr(x, y, w, h, 5); g.clip(); g.shadowColor = 'rgba(0,0,0,0.6)'; g.shadowBlur = 3; const lab = clipLabel(c) + (c.speed && c.speed !== 1 ? '  ' + c.speed + 'x' : '') + (c.reverse ? ' ↩' : ''); g.fillText(lab, Math.max(x, 0) + 6, y + 4); g.restore(); }
  if (c.groupId) { g.fillStyle = '#ffd24a'; g.fillRect(x + 2, y + h - 5, Math.max(0, w - 4), 3); }
  // keyframe diamonds
  const kts = new Set(); Object.values(c.keyframes || {}).forEach((l) => l.forEach((k) => kts.add(Math.round(k.t * 100)))); g.fillStyle = '#ffe08a'; kts.forEach((k) => { const kx = x + (k / 100) * S.pps; if (kx > x + 2 && kx < x + w - 2) { g.beginPath(); g.moveTo(kx, y + h - 11); g.lineTo(kx + 4, y + h - 7); g.lineTo(kx, y + h - 3); g.lineTo(kx - 4, y + h - 7); g.fill(); } });
  if (selected) { g.strokeStyle = ghost ? '#ffd24a' : '#fff'; g.lineWidth = 2; rr(x + 1, y + 1, w - 2, h - 2, 5); g.stroke(); g.fillStyle = '#fff'; g.fillRect(x + 1, y + 6, 4, h - 12); g.fillRect(x + w - 5, y + 6, 4, h - 12); }
  g.restore();
}
function rr(x, y, w, h, r) { r = Math.min(r, w / 2, h / 2); g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
function drawRuler(p, fg, mute, line, bg) {
  g.fillStyle = bg; g.fillRect(0, 0, W, RULER); g.strokeStyle = line; g.lineWidth = 1; g.beginPath(); g.moveTo(0, RULER - 0.5); g.lineTo(W, RULER - 0.5); g.stroke();
  const f = fps(); const steps = [1 / f, 2 / f, 5 / f, 10 / f, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800]; let step = steps.find((s) => s * S.pps >= 78) || 1800; const minor = step >= 1 ? step / 5 : step / 2;
  if (S.markIn != null || S.markOut != null) { const a = tToX(S.markIn == null ? 0 : S.markIn), b = tToX(S.markOut == null ? dur() : S.markOut); g.fillStyle = 'rgba(255,122,61,0.18)'; g.fillRect(a, 0, b - a, RULER); g.fillStyle = '#ff7a3d'; if (S.markIn != null) g.fillRect(a, 0, 2, RULER); if (S.markOut != null) g.fillRect(b - 2, 0, 2, RULER); }
  g.fillStyle = mute; g.font = '10px ui-monospace, Menlo, monospace'; g.textBaseline = 'top'; const t0 = Math.floor(xToT(0) / minor) * minor;
  g.strokeStyle = mute; g.beginPath(); for (let t = t0; t < xToT(W) + minor; t += minor) { const x = Math.round(tToX(t)) + 0.5; g.moveTo(x, RULER - 5); g.lineTo(x, RULER); } g.stroke();
  const m0 = Math.floor(xToT(0) / step) * step; for (let t = m0; t < xToT(W) + step; t += step) { if (t < -1e-6) continue; const x = Math.round(tToX(t)) + 0.5; g.strokeStyle = mute; g.beginPath(); g.moveTo(x, RULER - 11); g.lineTo(x, RULER); g.stroke(); g.fillStyle = mute; g.fillText(M.fmtTC(t, f), x + 3, 4); }
  g.fillStyle = '#4aa3ff'; p.markers.forEach((m) => { const x = tToX(m.t); if (x < -10 || x > W + 10) return; g.beginPath(); g.moveTo(x, RULER - 1); g.lineTo(x - 6, RULER - 13); g.lineTo(x + 6, RULER - 13); g.closePath(); g.fill(); if (m.label) { g.fillStyle = fg; g.fillText(m.label, x + 8, 15); g.fillStyle = '#4aa3ff'; } });
  g.fillStyle = bg; g.globalAlpha = 0.0; g.fillRect(0, 0, 0, 0); g.globalAlpha = 1;
}

// ───────── interaction ─────────
const local = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
function hit(x, y, touch) {
  const rs = rows(); const tol = touch ? 16 : TRIM; const p = P();
  for (const c of [...p.clips].reverse()) {
    const r = rs.find((q) => q.t.id === c.trackId); if (!r || y < r.y || y > r.y + r.h) continue; const x0 = tToX(c.start), x1 = tToX(c.start + c.duration);
    if (c.transitionIn.type !== 'none' && Math.abs(x - x0) < 9 && Math.abs(y - (r.y + r.h / 2)) < 10) return { c, zone: 'trans' };
    if (x >= x0 - 2 && x <= x1 + 2) { const w = x1 - x0; const t2 = Math.min(tol, w / 3); if (x - x0 <= t2) return { c, zone: 'l' }; if (x1 - x <= t2) return { c, zone: 'r' }; return { c, zone: 'body' }; }
  }
  return null;
}
const rowAt = (y) => { const rs = rows(); return rs.findIndex((r) => y >= r.y && y < r.y + r.h + 2); };
function snapDelta(leaderStart, leaderEnd, ids, delta) {
  if (!S.snap) return { d: delta, at: null }; const pts = snapPoints(ids); const th = 8 / S.pps; let best = null;
  [leaderStart + delta, leaderEnd + delta].forEach((e, k) => { for (const q of pts) { const dd = q - e; if (Math.abs(dd) <= th && (!best || Math.abs(dd) < Math.abs(best.d))) best = { d: dd, at: q }; } void k; });
  if (!best) { const f = 1 / fps(); const ns = Math.round((leaderStart + delta) / f) * f; return { d: ns - leaderStart, at: null }; }
  return { d: delta + best.d, at: best.at };
}
function down(e) {
  cv.focus({ preventScroll: true }); cv.setPointerCapture(e.pointerId); const pt = local(e); ptrs.set(e.pointerId, { x: pt.x, y: pt.y });
  if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; drag = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), pps0: S.pps, t0: xToT((a.x + b.x) / 2), touch: true }; return; }
  const touch = e.pointerType === 'touch'; if (pt.y < RULER) { drag = { kind: 'scrub', touch }; seek(snapT(Math.max(0, xToT(pt.x)))); return; }
  const h2 = hit(pt.x, pt.y, touch);
  if (h2) {
    const { c, zone } = h2; if (trackById(c.trackId).locked) { toast('This track is locked. Unlock it to edit.'); drag = null; return; }
    if (zone === 'trans') { select([c.id]); emit('inspect', 'transition'); drag = null; return; }
    if (!S.sel.has(c.id)) select([c.id], e.shiftKey || e.metaKey || e.ctrlKey); else if (e.shiftKey) { S.sel.delete(c.id); emit('sel'); }
    const ids = withLinked([...S.sel]);
    if (zone === 'body') drag = { kind: 'move', id: c.id, ids, x0: pt.x, y0: pt.y, dt: 0, dTrack: 0, moved: false, touch, startT: c.start, endT: c.start + c.duration };
    else drag = { kind: 'trim', id: c.id, edge: zone, x0: pt.x, moved: false, t0: zone === 'l' ? c.start : c.start + c.duration, tNew: null, touch };
    return;
  }
  drag = { kind: touch ? 'pan' : 'marquee', x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y, sx: S.scrollX, sy: S.scrollY, touch, additive: e.shiftKey, moved: false };
}
function move(e) {
  const pt = local(e); if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, { x: pt.x, y: pt.y });
  if (!drag) { const h = hit(pt.x, pt.y, false); cv.style.cursor = h ? (h.zone === 'l' || h.zone === 'r' ? 'ew-resize' : h.zone === 'trans' ? 'pointer' : 'grab') : 'default'; return; }
  if (drag.kind === 'pinch') { if (ptrs.size < 2) return; const [a, b] = [...ptrs.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y); setZoom(drag.pps0 * (d / Math.max(10, drag.d0)), drag.t0); return; }
  if (drag.kind === 'scrub') { seek(snapT(Math.max(0, xToT(pt.x)))); return; }
  if (drag.kind === 'move') {
    const dx = pt.x - drag.x0, dy = pt.y - drag.y0; if (!drag.moved && Math.hypot(dx, dy) < 4) return; drag.moved = true;
    const s = snapDelta(drag.startT, drag.endT, drag.ids, dx / S.pps); drag.dt = Math.max(-drag.startT, s.d); drag.snapT = s.at; const c = clipById(drag.id); const base = rowAt(drag.y0); const cur = rowAt(pt.y); drag.dTrack = cur >= 0 && base >= 0 ? cur - base : 0; void c;
    autoScroll(pt.x); schedule(); return;
  }
  if (drag.kind === 'trim') { drag.moved = true; const s2 = snapDelta(drag.t0, drag.t0, new Set([drag.id]), (pt.x - drag.x0) / S.pps); drag.tNew = Math.max(0, drag.t0 + s2.d); drag.snapT = s2.at; autoScroll(pt.x); schedule(); return; }
  if (drag.kind === 'marquee') { drag.x1 = pt.x; drag.y1 = pt.y; if (Math.hypot(pt.x - drag.x0, pt.y - drag.y0) > 4) drag.moved = true; schedule(); return; }
  if (drag.kind === 'pan') { const dx = pt.x - drag.x0; const dy = pt.y - drag.y0; if (Math.hypot(dx, dy) > 3) drag.moved = true; S.scrollX = drag.sx - dx / S.pps; S.scrollY = drag.sy - dy; clampScroll(); buildHeads(true); schedule(); }
}
function autoScroll(x) { if (x > W - 30) { S.scrollX += 14 / S.pps * 4; } else if (x < 30 && S.scrollX > -1) { S.scrollX -= 14 / S.pps * 4; } }
function up(e) {
  ptrs.delete(e.pointerId); try { cv.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ } const d = drag; if (!d) return; if (d.kind === 'pinch') { if (ptrs.size < 2) drag = null; return; } drag = null;
  if (d.kind === 'move' && d.moved) { const ok = moveClips([...S.sel], d.dt, d.dTrack); if (ok === false) toast('There is no room there. Move it to a free spot or another track.'); }
  else if (d.kind === 'trim' && d.moved) { const ok = trimEdge(d.id, d.edge, d.tNew != null ? d.tNew : d.t0, S.ripple || e.altKey); if (ok === false) toast('This clip cannot be trimmed there.'); }
  else if (d.kind === 'marquee') { if (d.moved) { const x0 = Math.min(d.x0, d.x1), x1 = Math.max(d.x0, d.x1), y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1); const rs = rows(); const ids = P().clips.filter((c) => { const r = rs.find((q) => q.t.id === c.trackId); if (!r) return false; const cx0 = tToX(c.start), cx1 = tToX(c.start + c.duration); return cx1 >= x0 && cx0 <= x1 && r.y + r.h >= y0 && r.y <= y1; }).map((c) => c.id); select(ids, d.additive); } else { if (!d.additive) clearSel(); if (!S.playing) seek(snapT(Math.max(0, xToT(d.x0)))); } }
  else if (d.kind === 'pan' && !d.moved) { clearSel(); seek(snapT(Math.max(0, xToT(d.x0)))); }
  schedule();
}
function wheel(e) {
  e.preventDefault(); const pt = local(e);
  if (e.ctrlKey || e.metaKey) { setZoom(S.pps * Math.exp(-e.deltaY * 0.002), xToT(pt.x)); return; }
  if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) { S.scrollX += (e.deltaX || e.deltaY) / S.pps; } else S.scrollY += e.deltaY;
  clampScroll(); buildHeads(true); schedule();
}
function dbl(e) { const pt = local(e); const h = hit(pt.x, pt.y, false); if (h && h.zone === 'body') { select([h.c.id]); emit('inspect', 'main'); } }

// ───────── drop from the library and from the desktop ─────────
function dropInfo(e) { const pt = local(e); const row = rowAt(pt.y); return { t: snapT(Math.max(0, xToT(pt.x))), row, trackId: row >= 0 ? P().tracks[row].id : null }; }
function dragOver(e) {
  const dt = e.dataTransfer; if (!dt) return; const types = [...(dt.types || [])]; if (!types.includes('application/x-cognita-item') && !types.includes('Files')) return; e.preventDefault(); dt.dropEffect = 'copy';
  const di = dropInfo(e); ghostDrop = { t: di.t, row: Math.max(0, di.row), d: 3 }; schedule();
}
async function dropped(e) {
  e.preventDefault(); ghostDrop = null; schedule(); const di = dropInfo(e); const dt = e.dataTransfer; if (!dt) return;
  const raw = dt.getData('application/x-cognita-item');
  if (raw) { try { await placeDrop(JSON.parse(raw), di.t, di.trackId); } catch (err) { toast(err.message || 'Could not add that.'); } return; }
  if (dt.files && dt.files.length) await importAndPlace([...dt.files], di.t, di.trackId);
}
