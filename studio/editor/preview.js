// studio/editor/preview.js
// Preview canvas, playback clock, live audio (same graph builder as export), master meter, and the on-canvas transform handles.

import { S, P, on, emit, dur, fps, selClips, select, clearSel, beginLive, commitLive, bump, toast, snapT, clipById } from './state.js';
import { drawFrame, clipBox, hitTest, activeJobs } from '../render.js';
import { scheduleProject } from '../audio.js';
import * as M from '../model.js';
import { audioContextClass } from '../engine.js';

let el = {}, ctx = null, octx = null, W = 0, H = 0, raf = 0, last = 0, queued = false, pa = null, audioTimer = 0, meterBuf = null;

export const isMobile = () => window.matchMedia('(max-width: 900px)').matches;
export function mountPreview(host) {
  host.innerHTML = `<div class="st-stage" id="stStage"><div class="st-frame" id="stFrame"><canvas id="stCanvas" aria-label="Video preview"></canvas><canvas id="stOver" aria-label="Edit handles"></canvas></div></div>
  <div class="st-ctl" role="toolbar" aria-label="Playback">
    <button type="button" class="st-icon" id="cStart" aria-label="Go to start" title="Start (Home)"><i class="ph ph-skip-back"></i></button>
    <button type="button" class="st-icon" id="cPrev" aria-label="Previous frame" title="Previous frame (Left)"><i class="ph ph-caret-left"></i></button>
    <button type="button" class="st-icon st-play" id="cPlay" aria-label="Play" title="Play or pause (Space)"><i class="ph ph-play"></i></button>
    <button type="button" class="st-icon" id="cNext" aria-label="Next frame" title="Next frame (Right)"><i class="ph ph-caret-right"></i></button>
    <button type="button" class="st-icon" id="cEnd" aria-label="Go to end" title="End (End)"><i class="ph ph-skip-forward"></i></button>
    <span class="st-tc" id="cTime" aria-live="off">00:00:00:00</span>
    <button type="button" class="st-icon" id="cLoop" aria-label="Loop playback" aria-pressed="false" title="Loop (uses the I/O range when set)"><i class="ph ph-repeat"></i></button>
    <label class="st-vh" for="cRate">Preview speed</label><select id="cRate" class="st-mini" title="Preview speed (sound plays only at 1x)">${[0.25, 0.5, 1, 1.5, 2].map((r) => `<option value="${r}"${r === 1 ? ' selected' : ''}>${r}x</option>`).join('')}</select>
    <span class="st-meter" aria-label="Master level meter" title="Master level"><canvas id="cMeter" width="60" height="10"></canvas></span>
    <button type="button" class="st-icon" id="cGrid" aria-label="Show grid" aria-pressed="false" title="Grid"><i class="ph ph-grid-four"></i></button>
    <button type="button" class="st-icon" id="cSafe" aria-label="Show safe area" aria-pressed="false" title="Safe area"><i class="ph ph-frame-corners"></i></button>
    <button type="button" class="st-icon" id="cFull" aria-label="Full screen preview" title="Full screen"><i class="ph ph-corners-out"></i></button>
  </div>`;
  el = { stage: host.querySelector('#stStage'), frame: host.querySelector('#stFrame'), cv: host.querySelector('#stCanvas'), ov: host.querySelector('#stOver'), time: host.querySelector('#cTime'), play: host.querySelector('#cPlay'), meter: host.querySelector('#cMeter') };
  ctx = el.cv.getContext('2d'); octx = el.ov.getContext('2d');
  const q = (s) => host.querySelector(s);
  q('#cPlay').addEventListener('click', toggle); q('#cStart').addEventListener('click', () => seek(0)); q('#cEnd').addEventListener('click', () => seek(Math.max(0, dur() - 1 / fps())));
  q('#cPrev').addEventListener('click', () => step(-1)); q('#cNext').addEventListener('click', () => step(1));
  q('#cLoop').addEventListener('click', (e) => { S.loop = !S.loop; e.currentTarget.setAttribute('aria-pressed', S.loop); e.currentTarget.classList.toggle('is-on', S.loop); });
  q('#cRate').addEventListener('change', (e) => { S.rate = Number(e.target.value); if (S.playing) startAudio(); });
  q('#cGrid').addEventListener('click', (e) => { S.grid = !S.grid; e.currentTarget.setAttribute('aria-pressed', S.grid); e.currentTarget.classList.toggle('is-on', S.grid); schedule(); });
  q('#cSafe').addEventListener('click', (e) => { S.safe = !S.safe; e.currentTarget.setAttribute('aria-pressed', S.safe); e.currentTarget.classList.toggle('is-on', S.safe); schedule(); });
  q('#cFull').addEventListener('click', () => { const f = el.frame; (f.requestFullscreen || f.webkitRequestFullscreen || (() => toast('Full screen is not supported on this device.'))).call(f); });
  wireHandles(); resize();
  const ro = new ResizeObserver(() => resize()); ro.observe(el.stage); el.ro = ro;
  const offs = [on('project', () => { sizeCanvas(); schedule(); if (S.playing) audioSoon(); }), on('frame', schedule), on('time', schedule), on('sel', schedule)];
  el.offs = offs; S.hub.onChange = schedule; sizeCanvas(); schedule();
}
export function unmountPreview() { pause(); if (el.ro) el.ro.disconnect(); (el.offs || []).forEach((f) => f()); if (pa) { try { pa.ctx.close(); } catch (_) { /* ignore */ } pa = null; } el = {}; }

function sizeCanvas() {
  const p = P(); if (!p || !el.cv) return; const long = isMobile() ? 720 : 1080; const k = long / Math.max(p.settings.width, p.settings.height);
  const w = M.even(p.settings.width * k), h = M.even(p.settings.height * k); if (w !== W || h !== H) { W = w; H = h; el.cv.width = el.ov.width = W; el.cv.height = el.ov.height = H; }
  resize();
}
function resize() {
  const p = P(); if (!p || !el.stage) return; const sw = el.stage.clientWidth - 16, sh = el.stage.clientHeight - 16; if (sw <= 0 || sh <= 0) return;
  const ar = p.settings.width / p.settings.height; let w = sw, h = sw / ar; if (h > sh) { h = sh; w = sh * ar; }
  el.frame.style.width = Math.floor(w) + 'px'; el.frame.style.height = Math.floor(h) + 'px';
}
export function schedule() { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; drawNow(); }); }
export function drawNow() {
  const p = P(); if (!p || !ctx) return; const T = dur(); S.t = Math.max(0, Math.min(S.t, Math.max(0, T - 1e-3)));
  S.hub.syncVideo(p, S.t, S.playing); drawFrame(ctx, W, H, p, S.t, S.hub.res); drawOverlay();
  if (el.time) el.time.textContent = M.fmtTC(S.t, fps());
  emit('playhead');
}

// ───────── playback ─────────
export const toggle = () => (S.playing ? pause() : play());
export function seek(t) { S.t = Math.max(0, Math.min(t, Math.max(0, dur()))); if (S.playing) { startAudioSoon(); } schedule(); emit('time'); }
export function step(n) { pause(); seek(snapT(S.t) + n / fps()); }
export function play() {
  if (S.playing || !P()) return; const T = dur(); if (T <= 0) { toast('Add something to the timeline first.'); return; }
  const lo = S.loopRange && S.markIn != null ? S.markIn : 0, hi = S.loopRange && S.markOut != null ? S.markOut : T;
  if (S.t >= T - 0.04 || S.t >= hi - 0.02) S.t = lo;
  S.playing = true; last = performance.now(); setPlayIcon(true); startAudio();
  const tick = (now) => {
    if (!S.playing) return; const dt = (now - last) / 1000; last = now; S.t += dt * S.rate;
    const end = (S.loop && S.markOut != null && S.loopRange) ? S.markOut : T;
    if (S.t >= end) { if (S.loop) { S.t = (S.loopRange && S.markIn != null) ? S.markIn : 0; startAudio(); } else { S.t = Math.max(0, T - 1e-3); drawNow(); pause(); emit('time'); return; } }
    drawNow(); drawMeter(); emit('time'); raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}
export function pause() { S.playing = false; cancelAnimationFrame(raf); stopAudio(); if (S.hub) S.hub.pauseAll(); setPlayIcon(false); drawMeter(true); }
function setPlayIcon(on_) { if (!el.play) return; el.play.innerHTML = `<i class="ph ${on_ ? 'ph-pause' : 'ph-play'}"></i>`; el.play.setAttribute('aria-label', on_ ? 'Pause' : 'Play'); }

// ───────── live audio ─────────
function stopAudio() { clearTimeout(audioTimer); if (!pa) return; pa.nodes.forEach((n) => { try { n.stop(); } catch (_) { /* ignore */ } }); try { pa.out.disconnect(); } catch (_) { /* ignore */ } pa.nodes = []; }
const audioSoon = () => { clearTimeout(audioTimer); audioTimer = setTimeout(() => { if (S.playing) startAudio(); }, 250); };
const startAudioSoon = audioSoon;
async function startAudio() {
  stopAudio(); const p = P(); if (!p) return; if (S.rate !== 1) return;
  const AC = audioContextClass(); if (!AC) return; if (!pa) pa = { ctx: new AC(), out: null, an: null, nodes: [] };
  const c = pa.ctx; if (c.state === 'suspended') { try { await c.resume(); } catch (_) { /* ignore */ } }
  await S.hub.ensureSounds(p); if (!S.playing) return;
  pa.out = c.createGain(); pa.an = c.createAnalyser(); pa.an.fftSize = 512; pa.out.connect(pa.an); pa.out.connect(c.destination);
  const r = scheduleProject(c, pa.out, p, S.hub.bufs, { from: S.t, startAt: c.currentTime + 0.05, total: dur() }); pa.nodes = r.nodes;
}
function drawMeter(clear) {
  const cv = el.meter; if (!cv) return; const x = cv.getContext('2d'); x.clearRect(0, 0, cv.width, cv.height);
  x.fillStyle = 'rgba(128,128,128,0.25)'; x.fillRect(0, 2, cv.width, 6); if (clear || !pa || !pa.an) return;
  meterBuf = meterBuf || new Uint8Array(pa.an.fftSize); pa.an.getByteTimeDomainData(meterBuf); let m = 0; for (let i = 0; i < meterBuf.length; i++) m = Math.max(m, Math.abs(meterBuf[i] - 128) / 128);
  const v = Math.min(1, m * 1.4); x.fillStyle = v > 0.92 ? '#d33' : v > 0.7 ? '#e0a400' : '#3a9d5d'; x.fillRect(0, 2, cv.width * v, 6);
}

// ───────── overlay and handles ─────────
let drag = null;
const unit = () => W / Math.max(1, el.ov.getBoundingClientRect().width);
function primary() { const cs = selClips().filter((c) => c.kind !== 'audio' && c.kind !== 'music' && c.kind !== 'effect' && c.kind !== 'adjustment'); if (cs.length !== 1) return null; const c = cs[0]; const local = S.t - c.start; if (local < -1e-6 || local > c.duration + 1e-6) return null; return c; }
function handlesFor(b, c) {
  const a = b.rot * Math.PI / 180, cs = Math.cos(a), sn = Math.sin(a); const pt = (x, y) => ({ x: b.cx + x * cs - y * sn, y: b.cy + x * sn + y * cs }); const hw = b.w / 2, hh = b.h / 2; const u = unit();
  const hs = { tl: pt(-hw, -hh), tr: pt(hw, -hh), br: pt(hw, hh), bl: pt(-hw, hh), rot: pt(0, -hh - 28 * u) };
  if (c.kind === 'image' || c.kind === 'video') Object.assign(hs, { cl: pt(-hw, 0), cr: pt(hw, 0), ct: pt(0, -hh), cb: pt(0, hh) });
  return hs;
}
function drawOverlay() {
  octx.clearRect(0, 0, W, H); const u = unit();
  if (S.grid) { octx.strokeStyle = 'rgba(255,255,255,0.45)'; octx.lineWidth = u; octx.beginPath(); [1 / 3, 2 / 3].forEach((f) => { octx.moveTo(W * f, 0); octx.lineTo(W * f, H); octx.moveTo(0, H * f); octx.lineTo(W, H * f); }); octx.moveTo(W / 2 - 10 * u, H / 2); octx.lineTo(W / 2 + 10 * u, H / 2); octx.moveTo(W / 2, H / 2 - 10 * u); octx.lineTo(W / 2, H / 2 + 10 * u); octx.stroke(); }
  if (S.safe) { octx.strokeStyle = 'rgba(255,200,60,0.8)'; octx.lineWidth = u; octx.setLineDash([6 * u, 5 * u]); [0.9, 0.8].forEach((f) => octx.strokeRect(W * (1 - f) / 2, H * (1 - f) / 2, W * f, H * f)); octx.setLineDash([]); }
  const c = S.playing ? null : primary(); if (!c) return; const b = clipBox(P(), c, S.t - c.start, W, H, S.hub.res); if (!b) return;
  octx.save(); octx.translate(b.cx, b.cy); octx.rotate(b.rot * Math.PI / 180); octx.strokeStyle = '#ff7a3d'; octx.lineWidth = 2 * u; octx.strokeRect(-b.w / 2, -b.h / 2, b.w, b.h); octx.restore();
  const hs = handlesFor(b, c); octx.fillStyle = '#fff'; octx.strokeStyle = '#ff7a3d'; octx.lineWidth = 2 * u;
  octx.beginPath(); octx.moveTo((hs.tl.x + hs.tr.x) / 2, (hs.tl.y + hs.tr.y) / 2); octx.lineTo(hs.rot.x, hs.rot.y); octx.stroke();
  Object.entries(hs).forEach(([k, h]) => { const s = (k.startsWith('c') ? 6 : 8) * u; octx.beginPath(); if (k === 'rot') octx.arc(h.x, h.y, s, 0, 7); else if (k.startsWith('c')) octx.rect(h.x - s * 0.6, h.y - s * 0.6, s * 1.2, s * 1.2); else octx.rect(h.x - s, h.y - s, s * 2, s * 2); octx.fill(); octx.stroke(); });
}
const toCanvas = (e) => { const r = el.ov.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H }; };
function liveSet(c, path, v) { const local = M.clamp(S.t - c.start, 0, c.duration); if (M.hasKeyframes(c, path)) M.upsertKeyframe(c, path, local, v, M.keyframeAt(c, path, local) ? undefined : 'inout'); else M.setPath(c, path, v); }
function wireHandles() {
  const ov = el.ov; ov.style.touchAction = 'none';
  ov.addEventListener('pointerdown', (e) => {
    if (S.playing) return; const pt = toCanvas(e); const u = unit(); const c0 = primary(); let mode = null, clip = null;
    if (c0) { const b = clipBox(P(), c0, S.t - c0.start, W, H, S.hub.res); if (b) { const hs = handlesFor(b, c0); const tol = (e.pointerType === 'touch' ? 22 : 12) * u; for (const [k, h] of Object.entries(hs)) if (Math.hypot(pt.x - h.x, pt.y - h.y) <= tol) { mode = k; clip = c0; break; } } }
    if (!mode) { const hit = hitTest(P(), S.t, S.hub.res, W, H, pt.x, pt.y); if (hit) { if (!S.sel.has(hit.id)) select([hit.id], e.shiftKey); mode = 'move'; clip = hit; } else { clearSel(); return; } }
    if (!clip || M.assetOf && false) return; const tr = P().tracks.find((t) => t.id === clip.trackId); if (tr && tr.locked) { toast('This track is locked.'); return; }
    ov.setPointerCapture(e.pointerId);
    const b = clipBox(P(), clip, S.t - clip.start, W, H, S.hub.res);
    drag = { mode, id: clip.id, start: pt, before: beginLive(), tf: { x: clip.transform.x, y: clip.transform.y, scale: clip.transform.scale, rotation: clip.transform.rotation, crop: { ...clip.transform.crop } }, box: b, ang0: Math.atan2(pt.y - b.cy, pt.x - b.cx), d0: Math.max(1, Math.hypot(pt.x - b.cx, pt.y - b.cy)), moved: false, grp: [...S.sel].map(clipById).filter(Boolean).map((c) => ({ id: c.id, x: c.transform.x, y: c.transform.y })) };
  });
  ov.addEventListener('pointermove', (e) => {
    if (!drag) { if (!S.playing) { const pt = toCanvas(e); const c0 = primary(); let cur = 'default'; if (c0) { const b = clipBox(P(), c0, S.t - c0.start, W, H, S.hub.res); if (b) { const hs = handlesFor(b, c0); const u = unit(); for (const [k, h] of Object.entries(hs)) if (Math.hypot(pt.x - h.x, pt.y - h.y) <= 12 * u) cur = k === 'rot' ? 'grab' : k.startsWith('c') ? 'col-resize' : 'nwse-resize'; } } if (cur === 'default' && hitTest(P(), S.t, S.hub.res, W, H, pt.x, pt.y)) cur = 'move'; ov.style.cursor = cur; } return; }
    const clip = clipById(drag.id); if (!clip) return; const pt = toCanvas(e); drag.moved = true;
    if (drag.mode === 'move') {
      let dx = (pt.x - drag.start.x) / W, dy = (pt.y - drag.start.y) / H;
      drag.grp.forEach((g) => { const c = clipById(g.id); if (!c) return; let nx = g.x + dx, ny = g.y + dy; if (!e.altKey && drag.grp.length === 1) { if (Math.abs(nx) < 0.012) nx = 0; if (Math.abs(ny) < 0.012) ny = 0; } liveSet(c, 'transform.x', nx); liveSet(c, 'transform.y', ny); });
    } else if (drag.mode === 'rot') { let r = drag.tf.rotation + ((Math.atan2(pt.y - drag.box.cy, pt.x - drag.box.cx) - drag.ang0) * 180) / Math.PI; if (e.shiftKey) r = Math.round(r / 15) * 15; liveSet(clip, 'transform.rotation', Math.round(r * 10) / 10); }
    else if (['tl', 'tr', 'br', 'bl'].includes(drag.mode)) { const d = Math.hypot(pt.x - drag.box.cx, pt.y - drag.box.cy); liveSet(clip, 'transform.scale', M.clamp(drag.tf.scale * (d / drag.d0), 0.02, 20)); }
    else { // crop edges, measured along the clip's own axes
      const a = -drag.box.rot * Math.PI / 180; const dx = pt.x - drag.start.x, dy = pt.y - drag.start.y; const lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a); const fw = drag.box.w, fh = drag.box.h; const cr = { ...drag.tf.crop };
      const wBase = 1 - cr.l - cr.r, hBase = 1 - cr.t - cr.b;
      if (drag.mode === 'cl') cr.l = M.clamp(drag.tf.crop.l + (lx / fw) * wBase, 0, 0.9 - cr.r); if (drag.mode === 'cr') cr.r = M.clamp(drag.tf.crop.r - (lx / fw) * wBase, 0, 0.9 - cr.l);
      if (drag.mode === 'ct') cr.t = M.clamp(drag.tf.crop.t + (ly / fh) * hBase, 0, 0.9 - cr.b); if (drag.mode === 'cb') cr.b = M.clamp(drag.tf.crop.b - (ly / fh) * hBase, 0, 0.9 - cr.t);
      clip.transform.crop = cr;
    }
    bump(); schedule(); emit('live');
  });
  const end = (e) => { if (!drag) return; try { ov.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ } const d = drag; drag = null; if (d.moved) commitLive(d.mode === 'move' ? 'Move' : d.mode === 'rot' ? 'Rotate' : d.mode.startsWith('c') ? 'Crop' : 'Scale', d.before, ''); else emit('sel'); };
  ov.addEventListener('pointerup', end); ov.addEventListener('pointercancel', end);
}
