// studio/engine.js
// Rendering core. No UI and no network here. A frame is a pure function of (project, time), the same idea Remotion uses,
// so the preview and the exporter draw identical pictures and a frame can be rendered at any speed, in any order.
// Also holds the audio scheduler (music, narration, footage sound) that works on both live and offline audio contexts.

export const ASPECT_DIMS = { '9:16': { w: 9, h: 16 }, '16:9': { w: 16, h: 9 }, '1:1': { w: 1, h: 1 } };

export function dimsFor(aspect, shortSide) {
  const a = ASPECT_DIMS[aspect] || ASPECT_DIMS['9:16'];
  const k = shortSide / Math.min(a.w, a.h);
  return { width: Math.round((a.w * k) / 2) * 2, height: Math.round((a.h * k) / 2) * 2 };
}

const THEMES = {
  clean: { bg: ['#f8f7f4', '#ece9e2'], fg: '#171717', mute: '#6f6f6a', accent: '#a8471f', bar: 'rgba(23,23,23,0.78)', barText: '#ffffff', hi: '#ffd9bd' },
  dark: { bg: ['#171717', '#0c0c0b'], fg: '#f4f3ef', mute: '#a8a8a1', accent: '#e39a6d', bar: 'rgba(0,0,0,0.6)', barText: '#ffffff', hi: '#ffd9bd' },
  bold: { bg: ['#a8471f', '#7a2f12'], fg: '#ffffff', mute: '#f3d9c9', accent: '#ffe2c7', bar: 'rgba(0,0,0,0.5)', barText: '#ffffff', hi: '#ffe2c7' },
};

export const TRANSITIONS = ['fade', 'slide', 'wipe', 'zoom', 'none'];
export const NARR_LEAD = 0.15;   // seconds of silence before a scene's narration starts
export const NARR_TAIL = 0.5;    // seconds kept after the narration ends
const XFADE = 0.5;

const lum = (hex) => { const m = /^#([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return null; const n = parseInt(m[1], 16); return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255; };
const clamp01 = (n) => Math.min(1, Math.max(0, n));
const easeOut = (t) => 1 - Math.pow(1 - clamp01(t), 3);
const spring = (t) => { t = clamp01(t); return 1 - Math.exp(-7 * t) * Math.cos(11 * t); };
const SANS = '"Geist", system-ui, -apple-system, "Segoe UI", sans-serif';
const SERIF = '"Instrument Serif", Georgia, serif';

// ── timing: narration decides the minimum length of a scene, so speech is never cut off ──
export const fnv = (s) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); };
export const narrKey = (p, s) => fnv([p.voice || '', p.rate || 1, p.lang || '', (s.caption || '').trim()].join('|'));
export const validNarr = (p, s) => !!(s.narr && s.narr.dur > 0 && (s.caption || '').trim() && s.narr.key === narrKey(p, s));
export const sceneDur = (p, s) => Math.max(s.duration, validNarr(p, s) ? s.narr.dur + NARR_LEAD + NARR_TAIL : 0);
export const totalDuration = (p) => p.scenes.reduce((a, s) => a + sceneDur(p, s), 0);

export function sceneAt(p, t) {
  let acc = 0;
  for (let i = 0; i < p.scenes.length; i++) {
    const d = sceneDur(p, p.scenes[i]);
    if (t < acc + d || i === p.scenes.length - 1) return { index: i, local: Math.max(0, Math.min(t - acc, d)), start: acc, dur: d };
    acc += d;
  }
  return { index: 0, local: 0, start: 0, dur: 1 };
}
// A paused preview or thumbnail should show the scene once its entrance animation has finished, not the empty first frame.
export const SETTLE = 2.4;
export function settleTime(p, t) {
  const { local, start, dur } = sceneAt(p, t);
  if (local >= SETTLE) return t;
  return start + Math.max(local, Math.min(SETTLE, dur - 0.05));
}
export function sceneStart(p, index) { let a = 0; for (let i = 0; i < index; i++) a += sceneDur(p, p.scenes[i]); return a; }

// ── text helpers ──
function wrap(ctx, text, maxW) {
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = []; let line = '';
  words.forEach((w) => { const test = line ? line + ' ' + w : w; if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w; } else line = test; });
  if (line) lines.push(line);
  return lines;
}
function block(ctx, text, x, y, maxW, size, lh, maxLines, family, weight, color, align, alpha) {
  if (!text) return y;
  let s = size, lines;
  for (;;) { ctx.font = `${weight} ${s}px ${family}`; lines = wrap(ctx, text, maxW); if (lines.length <= maxLines || s < size * 0.55) break; s *= 0.92; }
  ctx.save(); ctx.fillStyle = color; ctx.textAlign = align; ctx.textBaseline = 'top'; ctx.globalAlpha *= alpha;
  lines.slice(0, maxLines).forEach((l, i) => ctx.fillText(l, x, y + i * s * lh));
  ctx.restore();
  return y + Math.min(lines.length, maxLines) * s * lh;
}
function drawCover(ctx, src, W, H, zoom) {
  const iw = src.videoWidth || src.width, ih = src.videoHeight || src.height;
  if (!iw || !ih) return false;
  const s = Math.max(W / iw, H / ih) * zoom;
  ctx.drawImage(src, (W - iw * s) / 2, (H - ih * s) / 2, iw * s, ih * s);
  return true;
}
function statValue(stat, p) {
  const m = String(stat).match(/^([^0-9-]*)(-?[\d,.]+)(.*)$/);
  if (!m) return stat;
  const raw = m[2].replace(/,/g, ''); const n = parseFloat(raw);
  if (!Number.isFinite(n)) return stat;
  const dec = (raw.split('.')[1] || '').length;
  let v = (n * easeOut(p)).toFixed(dec);
  if (m[2].includes(',')) v = Number(v).toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  return m[1] + v + m[3];
}
const numOf = (v) => { const n = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : 0; };

// Captions. When narration exists the word being spoken is highlighted, timed by character share of the audio length.
function drawCaption(ctx, W, H, scene, local, d, project, th, u, portrait, pad) {
  const text = scene.caption; if (!text) return;
  const cp = easeOut((local - 0.25) / 0.5); if (cp <= 0) return;
  let cs = u * (portrait ? 3.6 : 2.9);
  const minCs = cs * 0.72;
  ctx.save(); ctx.globalAlpha *= cp; ctx.font = `500 ${cs}px ${SANS}`;
  const maxW = W - pad * 2 - u * 6;
  let lines = wrap(ctx, text, maxW);
  while (lines.length > 3 && cs > minCs) { cs *= 0.94; ctx.font = `500 ${cs}px ${SANS}`; lines = wrap(ctx, text, maxW); }
  lines = lines.slice(0, 4);
  const bh = lines.length * cs * 1.3 + u * 3.6;
  const by = H - bh - u * (portrait ? 7 : 4.5);
  ctx.fillStyle = th.bar;
  const r = u * 1.6, bx = pad - u * 1.5, bw = W - (pad - u * 1.5) * 2;
  ctx.beginPath(); ctx.moveTo(bx + r, by); ctx.arcTo(bx + bw, by, bx + bw, by + bh, r); ctx.arcTo(bx + bw, by + bh, bx, by + bh, r); ctx.arcTo(bx, by + bh, bx, by, r); ctx.arcTo(bx, by, bx + bw, by, r); ctx.closePath(); ctx.fill();
  ctx.textBaseline = 'top';
  const spoken = validNarr(project, scene);
  const total = lines.join(' ').length || 1;
  const prog = spoken ? clamp01((local - NARR_LEAD) / Math.max(0.1, scene.narr.dur)) : -1;
  let seen = 0;
  lines.forEach((l, i) => {
    const y = by + u * 1.8 + cs * 0.12 + i * cs * 1.3;
    if (!spoken) { ctx.fillStyle = th.barText; ctx.textAlign = 'center'; ctx.fillText(l, W / 2, y); seen += l.length + 1; return; }
    const words = l.split(' ');
    const widths = words.map((w) => ctx.measureText(w).width); const sp = ctx.measureText(' ').width;
    const lineW = widths.reduce((a, b) => a + b, 0) + sp * (words.length - 1);
    let x = (W - lineW) / 2; ctx.textAlign = 'left';
    words.forEach((w, k) => {
      const mid = (seen + w.length / 2) / total;
      const active = prog >= 0 && prog < 1 && mid >= prog - 0.5 / total * 3 && mid <= prog + 0.5 / total * 3 + 0.001;
      ctx.fillStyle = active ? th.hi : (mid < prog ? th.barText : 'rgba(255,255,255,0.62)');
      ctx.fillText(w, x, y); x += widths[k] + sp; seen += w.length + 1;
    });
  });
  ctx.restore();
}

function drawScene(ctx, W, H, scene, local, project, images, frames) {
  const th = THEMES[project.style] || THEMES.clean;
  const d = sceneDur(project, scene);
  const u = Math.min(W, H) / 100;
  const portrait = H > W * 1.2;
  const pad = u * (portrait ? 9 : 8);
  const maxW = W - pad * 2;
  const p = easeOut(local / 0.8);

  ctx.save();
  const g = ctx.createLinearGradient(0, 0, W, H);
  if (scene.bg) { g.addColorStop(0, scene.bg); g.addColorStop(1, scene.bg); } else { g.addColorStop(0, th.bg[0]); g.addColorStop(1, th.bg[1]); }
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

  const img = scene.image ? images.get(scene.image) : null;
  const vid = scene.layout === 'video' && frames ? frames(scene) : null;
  const media = scene.layout === 'video' ? vid : (scene.layout === 'image' ? img : null);
  const onMedia = !!media && (scene.layout === 'image' || scene.layout === 'video');
  if (onMedia) {
    ctx.save();
    const zoom = scene.layout === 'image' ? 1 + 0.08 * clamp01(local / Math.max(d, 1)) : 1;
    const ok = drawCover(ctx, media, W, H, zoom);
    if (ok) { const sh = ctx.createLinearGradient(0, H * 0.35, 0, H); sh.addColorStop(0, 'rgba(0,0,0,0)'); sh.addColorStop(1, 'rgba(0,0,0,0.72)'); ctx.fillStyle = sh; ctx.fillRect(0, 0, W, H); }
    ctx.restore();
  }
  const bgL = !onMedia && scene.bg ? lum(scene.bg) : null;
  const flip = bgL !== null && ((project.style === 'dark' || project.style === 'bold') ? bgL > 0.6 : bgL < 0.45);
  const lightText = onMedia || (flip ? !(project.style === 'dark' || project.style === 'bold') : (bgL === null && false));
  const darkText = flip && (project.style === 'dark' || project.style === 'bold');
  const fg = lightText ? '#ffffff' : darkText ? '#171717' : (onMedia ? '#ffffff' : th.fg);
  const mute = lightText ? 'rgba(255,255,255,0.82)' : darkText ? 'rgba(23,23,23,0.7)' : th.mute;

  let dy = 0, sc = 1;
  if (scene.anim === 'slide') dy = (1 - p) * u * 6;
  if (scene.anim === 'zoom') sc = 0.94 + 0.06 * p;
  ctx.save();
  ctx.translate(W / 2, H / 2); ctx.scale(sc, sc); ctx.translate(-W / 2, -H / 2 + dy);
  ctx.globalAlpha *= p;
  const capSpace = project.captions && scene.caption ? u * (portrait ? 20 : 16) : 0;
  const usableH = H - capSpace;
  const L = scene.layout;

  if (L === 'title' || ((L === 'image' || L === 'video') && !onMedia)) {
    const ts = u * (portrait ? 9 : 7.2);
    ctx.font = `600 ${ts}px ${SANS}`;
    const lines = Math.min(4, wrap(ctx, scene.title).length);
    const subH = scene.text ? u * 12 : 0;
    const top = (usableH - (lines * ts * 1.12 + subH + u * 6)) / 2;
    ctx.fillStyle = th.accent; ctx.fillRect(pad, top, u * 10 * p, u * 0.9);
    const y = block(ctx, scene.title, pad, top + u * 4, maxW, ts, 1.12, 4, SANS, 600, fg, 'left', 1);
    block(ctx, scene.text, pad, y + u * 2.5, maxW, u * (portrait ? 3.8 : 3.2), 1.4, 4, SANS, 400, mute, 'left', 1);
  } else if (L === 'bullets') {
    const ts = u * (portrait ? 7 : 5.6);
    let y = block(ctx, scene.title, pad, pad, maxW, ts, 1.12, 3, SANS, 600, fg, 'left', 1) + u * 4;
    const items = scene.bullets.length ? scene.bullets : (scene.text ? [scene.text] : []);
    items.forEach((b, i) => {
      const bp = easeOut((local - 0.4 - i * 0.35) / 0.6), bs = u * (portrait ? 4.1 : 3.3);
      ctx.save(); ctx.globalAlpha *= bp; ctx.fillStyle = th.accent; ctx.fillRect(pad, y + bs * 0.35, u * 1.3, u * 1.3); ctx.restore();
      y = block(ctx, b, pad + u * 4, y + (1 - bp) * u * 2, maxW - u * 4, bs, 1.3, 3, SANS, 400, fg, 'left', bp) + u * 2.6;
    });
  } else if (L === 'quote') {
    const qs = u * (portrait ? 5.6 : 4.6);
    ctx.font = `400 ${u * 22}px ${SERIF}`; ctx.fillStyle = th.accent; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('\u201C', pad, usableH * 0.14);
    const y0 = usableH * 0.14 + u * 16;
    const y1 = block(ctx, scene.text || scene.title, pad, y0, maxW, qs, 1.28, 7, SERIF, 400, fg, 'left', 1);
    if (scene.text && scene.title) block(ctx, scene.title, pad, y1 + u * 3, maxW, u * 3, 1.3, 2, SANS, 500, mute, 'left', 1);
  } else if (L === 'stat') {
    const big = u * (portrait ? 22 : 18);
    ctx.font = `600 ${big}px ${SANS}`;
    const val = statValue(scene.stat || scene.title, local / 1.4);
    let fs = big;
    while (ctx.measureText(val).width > maxW && fs > u * 6) { fs *= 0.9; ctx.font = `600 ${fs}px ${SANS}`; }
    const top = (usableH - (fs * 1.1 + u * 14)) / 2;
    ctx.fillStyle = th.accent; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(val, pad, top);
    const y = block(ctx, scene.title, pad, top + fs * 1.15, maxW, u * (portrait ? 4.8 : 3.8), 1.25, 3, SANS, 600, fg, 'left', 1);
    block(ctx, scene.text, pad, y + u * 1.5, maxW, u * 3, 1.4, 3, SANS, 400, mute, 'left', 1);
  } else if (L === 'chart') {
    const rows = (scene.data || []).slice(0, 6);
    const ts = u * (portrait ? 6.4 : 5);
    let y = block(ctx, scene.title, pad, pad, maxW, ts, 1.12, 2, SANS, 600, fg, 'left', 1) + u * 4;
    const max = Math.max(1, ...rows.map((r) => Math.abs(numOf(r.value))));
    const rowH = Math.min(u * (portrait ? 11 : 9), (usableH - y - pad * 0.5) / Math.max(1, rows.length));
    const lab = u * (portrait ? 3.3 : 2.7);
    rows.forEach((r, i) => {
      const rp = easeOut((local - 0.3 - i * 0.25) / 0.9);
      const v = numOf(r.value), by = y + i * rowH;
      ctx.font = `500 ${lab}px ${SANS}`; ctx.fillStyle = fg; ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.save(); ctx.globalAlpha *= clamp01(rp * 2);
      ctx.fillText(String(r.label).slice(0, 28), pad, by);
      const bw = (maxW - u * 14) * clamp01(Math.abs(v) / max) * rp, bh = rowH * 0.34, byy = by + lab * 1.35;
      ctx.fillStyle = th.accent; ctx.fillRect(pad, byy, Math.max(0, bw), bh);
      ctx.fillStyle = mute; ctx.font = `600 ${lab}px ${SANS}`;
      ctx.fillText(statValue(String(r.value), rp), pad + bw + u * 1.5, byy + bh / 2 - lab / 2);
      ctx.restore();
    });
  } else if (L === 'kinetic') {
    const words = String(scene.title || scene.text || '').split(/\s+/).filter(Boolean).slice(0, 24);
    let fs = u * (portrait ? 13 : 10), lay;
    for (;;) {
      ctx.font = `700 ${fs}px ${SANS}`;
      const sp = ctx.measureText(' ').width; lay = []; let x = 0, y = 0, line = [];
      words.forEach((w) => { const wd = ctx.measureText(w).width; if (x + wd > maxW && line.length) { lay.push(line); line = []; x = 0; } line.push({ w, wd, x }); x += wd + sp; });
      if (line.length) lay.push(line);
      if (lay.length * fs * 1.15 <= usableH - pad * 1.2 || fs < u * 4) break; fs *= 0.9;
    }
    const topY = (usableH - lay.length * fs * 1.15) / 2;
    const span = Math.max(0.6, Math.min(d * 0.7, words.length * 0.4)); let idx = 0;
    ctx.textBaseline = 'top'; ctx.textAlign = 'left';
    lay.forEach((ln, li) => ln.forEach((it) => {
      const wp = (local - 0.15 - (idx / words.length) * span) / 0.35;
      if (wp > 0) { const sk = 1.3 - 0.3 * spring(wp); ctx.save(); ctx.globalAlpha *= clamp01(wp * 2); ctx.translate(pad + it.x + it.wd / 2, topY + li * fs * 1.15 + fs / 2); ctx.scale(sk, sk); ctx.fillStyle = idx % 5 === 4 ? th.accent : fg; ctx.font = `700 ${fs}px ${SANS}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(it.w, 0, 0); ctx.restore(); }
      idx++;
    }));
  } else if (onMedia) {
    const ts = u * (portrait ? 7.2 : 5.6);
    ctx.font = `600 ${ts}px ${SANS}`;
    const lines = Math.min(3, wrap(ctx, scene.title).length);
    const y0 = usableH - (lines * ts * 1.12 + (scene.text ? u * 8 : 0)) - u * 4;
    const y1 = block(ctx, scene.title, pad, y0, maxW, ts, 1.12, 3, SANS, 600, fg, 'left', 1);
    block(ctx, scene.text, pad, y1 + u * 1.5, maxW, u * 3.2, 1.35, 2, SANS, 400, mute, 'left', 1);
  }
  ctx.restore();
  if (project.captions) drawCaption(ctx, W, H, scene, local, d, project, th, u, portrait, pad);
  ctx.restore();
}

export function drawFrame(ctx, W, H, project, t, images, frames) {
  const { index, local, dur } = sceneAt(project, t);
  const scene = project.scenes[index];
  const next = project.scenes[index + 1];
  const remaining = dur - local;
  ctx.clearRect(0, 0, W, H);
  const kind = next ? (next.transition || 'fade') : 'none';
  if (!next || kind === 'none' || remaining >= XFADE) { drawScene(ctx, W, H, scene, local, project, images, frames); return; }
  const q = clamp01(1 - remaining / XFADE);
  if (kind === 'slide') {
    ctx.save(); ctx.translate(-q * W, 0); drawScene(ctx, W, H, scene, local, project, images, frames); ctx.restore();
    ctx.save(); ctx.translate((1 - q) * W, 0); drawScene(ctx, W, H, next, 0, project, images, frames); ctx.restore();
  } else if (kind === 'wipe') {
    drawScene(ctx, W, H, scene, local, project, images, frames);
    ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W * q, H); ctx.clip(); drawScene(ctx, W, H, next, 0, project, images, frames); ctx.restore();
  } else if (kind === 'zoom') {
    drawScene(ctx, W, H, next, 0, project, images, frames);
    ctx.save(); ctx.globalAlpha = 1 - q; ctx.translate(W / 2, H / 2); ctx.scale(1 + 0.2 * q, 1 + 0.2 * q); ctx.translate(-W / 2, -H / 2); drawScene(ctx, W, H, scene, local, project, images, frames); ctx.restore();
  } else {
    drawScene(ctx, W, H, scene, local, project, images, frames);
    ctx.save(); ctx.globalAlpha = q; drawScene(ctx, W, H, next, 0, project, images, frames); ctx.restore();
  }
}

// ── audio scheduling (works on a live AudioContext and on an OfflineAudioContext) ──
// Music is synthesised, so no audio files are needed. `duck` is a list of [start, end] seconds where narration plays;
// music dips under it. Times are on the video timeline; `from` lets live preview start in the middle.
export function scheduleMusic(ctx, dest, { kind, volume, total, from = 0, startAt = 0, duck = [] }) {
  const master = ctx.createGain();
  master.connect(dest);
  const nodes = [];
  if (kind === 'none') return { master, nodes };
  const at = (tl) => startAt + Math.max(0, tl - from);
  master.gain.setValueAtTime(0, at(from));
  master.gain.linearRampToValueAtTime(volume, at(from) + 0.8);
  let level = volume;
  duck.slice().sort((a, b) => a[0] - b[0]).forEach(([s, e]) => {
    if (e <= from) return;
    const lo = volume * 0.3;
    const s0 = Math.max(from, s - 0.25), e0 = Math.max(from, e);
    if (s0 > from + 0.8) { master.gain.setValueAtTime(level, at(s0)); master.gain.linearRampToValueAtTime(lo, at(s0) + 0.3); level = lo; }
    master.gain.setValueAtTime(level, at(e0)); master.gain.linearRampToValueAtTime(volume, at(e0) + 0.6); level = volume;
  });
  master.gain.setValueAtTime(level, at(Math.max(from, total - 1.2))); master.gain.linearRampToValueAtTime(0, at(total));
  const chords = kind === 'upbeat'
    ? [[261.6, 329.6, 392], [220, 261.6, 329.6], [174.6, 220, 261.6], [196, 246.9, 293.7]]
    : [[220, 261.6, 329.6], [174.6, 220, 261.6], [196, 246.9, 293.7], [164.8, 207.7, 246.9]];
  const step = kind === 'upbeat' ? 1.8 : 3.6;
  for (let n = 0; n * step < total; n++) {
    const tl = n * step; if (tl + step + 0.7 < from) continue;
    const when = at(tl); const chord = chords[n % chords.length];
    chord.forEach((f, i) => {
      const o = ctx.createOscillator(), gn = ctx.createGain();
      o.type = kind === 'upbeat' ? 'triangle' : 'sine'; o.frequency.value = f; o.detune.value = (i - 1) * 4;
      gn.gain.setValueAtTime(0, when); gn.gain.linearRampToValueAtTime(0.16, when + 0.5); gn.gain.linearRampToValueAtTime(0, when + step + 0.6);
      o.connect(gn); gn.connect(master); o.start(when); o.stop(when + step + 0.7); nodes.push(o);
    });
    if (kind === 'upbeat') for (let b = 0; b < 4; b++) {
      const bt = when + b * (step / 4); if (bt < startAt) continue;
      const o = ctx.createOscillator(), gn = ctx.createGain(); o.type = 'sine'; o.frequency.value = chord[0] / 2;
      gn.gain.setValueAtTime(0.0001, bt); gn.gain.exponentialRampToValueAtTime(0.28, bt + 0.02); gn.gain.exponentialRampToValueAtTime(0.0001, bt + 0.28);
      o.connect(gn); gn.connect(master); o.start(bt); o.stop(bt + 0.3); nodes.push(o);
    }
  }
  return { master, nodes };
}

// Places each scene's narration clip on the timeline. `buffers` maps narration key to an AudioBuffer.
export function scheduleNarration(ctx, dest, project, buffers, { from = 0, startAt = 0 } = {}) {
  const nodes = []; let acc = 0;
  project.scenes.forEach((s) => {
    const d = sceneDur(project, s); const buf = validNarr(project, s) ? buffers.get(s.narr.key) : null;
    if (buf) {
      const begin = acc + NARR_LEAD, end = begin + buf.duration;
      if (end > from) {
        const src = ctx.createBufferSource(); src.buffer = buf; src.connect(dest);
        if (begin >= from) src.start(startAt + (begin - from)); else src.start(startAt, from - begin);
        nodes.push(src);
      }
    }
    acc += d;
  });
  return nodes;
}

export function narrationRanges(project) {
  const out = []; let acc = 0;
  project.scenes.forEach((s) => { const d = sceneDur(project, s); if (validNarr(project, s)) out.push([acc + NARR_LEAD, acc + NARR_LEAD + s.narr.dur]); acc += d; });
  return out;
}

// Browser built-in voice. Plays through the speaker only; it cannot be recorded, so it is a preview aid and nothing more.
export const browserVoice = {
  supported: () => 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window,
  speak(text, lang) { if (!this.supported() || !text) return; window.speechSynthesis.cancel(); const u = new SpeechSynthesisUtterance(text); u.lang = lang || 'en-NG'; window.speechSynthesis.speak(u); },
  stop() { if (this.supported()) window.speechSynthesis.cancel(); },
};

export const audioContextClass = () => window.AudioContext || window.webkitAudioContext;

// ── images ──
export async function decodeImage(blob) {
  if ('createImageBitmap' in window) { try { return await createImageBitmap(blob); } catch (_) { /* fall through */ } }
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob); const im = new Image();
    im.onload = () => resolve(im); im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Unsupported image format')); }; im.src = url;
  });
}
export async function downscaleImage(file, maxSide = 1920) {
  const bmp = await decodeImage(file);
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas'); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.88));
  if (bmp.close) bmp.close();
  if (!blob) throw new Error('Could not process this image');
  return { blob, width: c.width, height: c.height };
}
