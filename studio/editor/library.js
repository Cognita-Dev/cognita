// studio/editor/library.js
// Left panel: Media, Audio, Text, Stickers and graphics, Effects, Transitions, Filters, Captions, Templates, AI.
// Items are click-to-add (mobile friendly) and draggable onto the timeline. Also owns importing and placing files.

import { S, P, on, emit, addClip, transact, selClips, clipById, toast, addAssetRecord, removeAsset, relinkAsset, usageOf, setClip, addMarker, snapT, dur, bump, select } from './state.js';
import * as M from '../model.js';
import * as media from '../media.js';
import * as LD from '../library-data.js';
import * as store from '../store.js';
import * as CP from '../captions.js';
import { detectBeats } from '../audio.js';
import { esc, fmtSize, fmtDur, download, safeName } from './util.js';
import { renderAI, sttStatus } from './ai.js';
import * as TR from '../transcribe.js';
import * as LS from '../localstt.js';

export const TABS = [['media', 'ph-folder-simple', 'Media'], ['audio', 'ph-waveform', 'Audio'], ['text', 'ph-text-t', 'Text'], ['stickers', 'ph-smiley-sticker', 'Stickers'], ['effects', 'ph-sparkle', 'Effects'], ['transitions', 'ph-arrows-left-right', 'Transitions'], ['filters', 'ph-drop-half', 'Filters'], ['captions', 'ph-subtitles', 'Captions'], ['templates', 'ph-layout', 'Templates'], ['ai', 'ph-magic-wand', 'AI']];
let busWired = false, root = null, view = { q: '', kind: 'all', mode: 'grid' }, imports = [], rec = null;

export function mountLibrary(host) {
  root = host; host.innerHTML = `<div class="st-tabs st-tabs--lib" role="tablist" aria-label="Library">${TABS.map(([k, ic, l]) => `<button type="button" role="tab" class="st-tab" data-tab="${k}" aria-selected="false"><i class="ph ${ic}" aria-hidden="true"></i><span>${l}</span></button>`).join('')}</div><div class="st-lib-body" id="stLibBody"></div>`;
  host.querySelector('.st-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab); });
  host.addEventListener('dragstart', (e) => { const it = e.target.closest('[data-drag]'); if (it) { e.dataTransfer.setData('application/x-cognita-item', it.dataset.drag); e.dataTransfer.effectAllowed = 'copy'; } });
  if (!busWired) { busWired = true; on('assets', () => { if (['media', 'audio'].includes(S.tab)) renderBody(); }); on('sel', () => { if (['effects', 'transitions', 'filters'].includes(S.tab)) syncHint(); if (S.tab === 'captions' && !stt.running) paintStt(); }); on('status-narr', () => { if (S.tab === 'captions') paintStt(); }); }
  setTab(S.tab || 'media');
}
export function setTab(k) {
  S.tab = k; root.querySelectorAll('[data-tab]').forEach((b) => { const on_ = b.dataset.tab === k; b.classList.toggle('is-on', on_); b.setAttribute('aria-selected', on_); });
  // The tab strip scrolls sideways on phones: keep the chosen tab in view so the others are clearly there to swipe to.
  const bar = root.querySelector('.st-tabs'); const cur = bar && bar.querySelector('.st-tab.is-on'); if (bar && cur) { try { bar.scrollTo({ left: Math.max(0, cur.offsetLeft - (bar.clientWidth - cur.offsetWidth) / 2), behavior: 'smooth' }); } catch (_) { bar.scrollLeft = cur.offsetLeft; } }
  renderBody(); emit('libtab', k);
}
const body = () => root.querySelector('#stLibBody');
function renderBody() { const b = body(); if (!b) return; const f = { media: mediaTab, audio: audioTab, text, stickers, effects, transitions, filters, captions, templates, ai: renderAI }[S.tab]; b.scrollTop = 0; f(b); }
const syncHint = () => { const h = body().querySelector('[data-hint]'); if (h) h.textContent = hintText(); };
const hintText = () => { const n = selClips().length; return n ? n + ' clip' + (n > 1 ? 's' : '') + ' selected. Click an item to apply it.' : 'Select a clip on the timeline, then click an item to apply it.'; };
const dragAttr = (o) => `draggable="true" data-drag='${esc(JSON.stringify(o))}'`;

// ───────── importing ─────────
export async function importFiles(files, { place = null } = {}) {
  const list = files.slice(0, 40); if (files.length > 40) toast('Only the first 40 files were imported at once.');
  const added = [];
  for (const f of list) {
    if (S.project.assets.length >= M.LIMITS.assets) { toast('This project has too many media files.'); break; }
    const job = { name: f.name, state: 'working', cancel: false }; imports.push(job); renderImports();
    try {
      const a = await media.importFile(f, { actx: S.hub.ctx() }); if (job.cancel) { await store.deleteAsset(a.id).catch(() => {}); job.state = 'cancelled'; continue; }
      const rec_ = addAssetRecord(a); if (a._buf) S.hub.audio.set(a.id, a._buf); await S.hub.ensure(rec_); job.state = 'done'; added.push(rec_); if (a.note) toast(a.note);
      if (place) { placeAsset(rec_, place.t + added.slice(0, -1).reduce((s, x) => s + (x.kind === 'image' ? 4 : x.duration || 4), 0), place.trackId); }
    } catch (e) { job.state = 'error'; job.msg = e.message || 'Import failed'; toast('"' + f.name + '": ' + job.msg); }
    renderImports();
  }
  setTimeout(() => { imports = imports.filter((j) => j.state === 'working'); renderImports(); }, 3500); emit('assets'); return added;
}
export const importAndPlace = (files, t, trackId) => importFiles(files, { place: { t, trackId } });
function renderImports() {
  const el = root && root.querySelector('#stImports'); if (!el) return;
  el.innerHTML = imports.map((j, i) => `<div class="st-imp is-${j.state}"><span>${esc(j.name)}</span><small>${j.state === 'working' ? 'Importing…' : j.state === 'done' ? 'Added' : j.state === 'cancelled' ? 'Cancelled' : esc(j.msg || 'Failed')}</small>${j.state === 'working' ? `<button type="button" class="st-link" data-cancel="${i}">Cancel</button>` : ''}</div>`).join('');
  el.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', () => { const j = imports[Number(b.dataset.cancel)]; if (j) j.cancel = true; b.disabled = true; }));
}
export function placeAsset(a, t, trackId) {
  t = t == null ? S.t : t;
  if (a.kind === 'video') { const d = Math.max(0.5, a.duration); return addClip('video', { assetId: a.id, name: a.name.replace(/\.[^.]+$/, ''), audio: { gain: 1 }, transform: { fit: 'fit' } }, t, d, trackId); }
  if (a.kind === 'image') return addClip('image', { assetId: a.id, name: a.name.replace(/\.[^.]+$/, ''), transform: { fit: 'fit' } }, t, 4, trackId);
  return addClip('audio', { assetId: a.id, name: a.name.replace(/\.[^.]+$/, ''), audio: { gain: 1 } }, t, Math.max(0.2, a.duration), trackId);
}
const projectUnit = () => 1080 / Math.min(P().settings.width, P().settings.height);
function addShape(type, extra = {}, t, trackId, d = 4) {
  const u = projectUnit(); const S0 = { type, ...extra };
  if (type === 'line') Object.assign(S0, { w: 500, h: 10, fill: '#ffffff' }); if (type === 'arrow') Object.assign(S0, { w: 480, h: 14, fill: '#ffffff' }); if (type === 'ellipse') Object.assign(S0, { w: 360, h: 360 });
  if (type === 'star') Object.assign(S0, { w: 360, h: 360, fill: '#ffd24a' }); if (type === 'polygon') Object.assign(S0, { w: 360, h: 360, points: 6 }); void u;
  return addClip('shape', { name: type[0].toUpperCase() + type.slice(1), shape: { ...S0 } }, t == null ? S.t : t, d, trackId);
}
function addBackground(bg, t, trackId, d = 5) { const u = projectUnit(); const w = P().settings.width * u + 6, h = P().settings.height * u + 6; return addClip('shape', { name: 'Background: ' + bg.label, shape: { type: 'rect', w, h, gradient: { on: true, c1: bg.c1, c2: bg.c2, angle: bg.angle } } }, t == null ? S.t : t, d, trackId); }

// Everything that can be dropped or clicked into the timeline funnels through here.
export async function placeDrop(it, t, trackId) {
  if (it.type === 'asset') { const a = M.assetOf(P(), it.id); if (!a) throw new Error('That media is no longer in this project.'); return placeAsset(a, t, trackId); }
  if (it.type === 'text') { const pr = LD.TEXT_PRESETS.find((x) => x.id === it.id); if (!pr) return; const tx = M.deepAssign(M.defaultText(), pr.text); const tr = { x: pr.x || 0, y: pr.y || 0 }; return addClip('text', { name: pr.label, text: tx, transform: tr }, t == null ? S.t : t, pr.dur || 4, trackId); }
  if (it.type === 'sticker') return addClip('sticker', { name: it.label || 'Sticker', sticker: it.kind === 'svg' ? { type: 'svg', id: it.id, color: it.color || '#a8471f', size: 260 } : { type: 'emoji', char: it.char, size: 240 } }, t == null ? S.t : t, 3, trackId);
  if (it.type === 'shape') return addShape(it.shape, {}, t, trackId);
  if (it.type === 'bg') return addBackground(LD.BACKGROUNDS.find((b) => b.id === it.id), t, trackId);
  if (it.type === 'music') return addClip('music', { name: 'Music: ' + it.kind, music: { kind: it.kind }, audio: { gain: 0.5, duck: true, fadeIn: 0.8, fadeOut: 1.2 } }, t == null ? S.t : t, Math.max(10, dur() - (t || 0) || 30), trackId);
  if (it.type === 'effectlayer') return addClip('effect', { name: it.label, effects: [{ type: it.fx, amount: it.amount }] }, t == null ? S.t : t, Math.max(3, dur() || 5), trackId);
  if (it.type === 'template') return applyTemplate(it.id, t);
}

// ───────── Media and Audio ─────────
function mediaList(kinds) {
  const q = view.q.trim().toLowerCase(); return P().assets.filter((a) => kinds.includes(a.kind) && (view.kind === 'all' || a.kind === view.kind) && (!q || a.name.toLowerCase().includes(q)));
}
function importBar(accept) { return `<div class="st-lib-act"><label class="st-btn st-btn--primary"><input type="file" id="stImp" accept="${accept}" multiple hidden><i class="ph ph-upload-simple"></i>Import</label><span class="st-muted st-small">or drop files on the timeline</span></div><div id="stImports" class="st-imports"></div>`; }
function mediaCard(a) {
  const usage = usageOf(a.id).length; const bad = a.status && a.status !== 'ready';
  const th = a.thumb ? `<img src="${a.thumb}" alt="" draggable="false">` : `<i class="ph ${a.kind === 'audio' ? 'ph-waveform' : 'ph-image'}"></i>`;
  const meta = [a.kind === 'audio' ? fmtDur(a.duration) : a.kind === 'video' ? fmtDur(a.duration) : '', a.width ? a.width + '×' + a.height : '', a.fps ? Math.round(a.fps) + ' fps' : '', a.vcodec || '', a.acodec || '', a.size ? fmtSize(a.size) : ''].filter(Boolean).join(' · ');
  return `<div class="st-asset${bad ? ' is-bad' : ''}" ${dragAttr({ type: 'asset', id: a.id })} data-id="${esc(a.id)}"><button type="button" class="st-asset-th" data-add="${esc(a.id)}" aria-label="Add ${esc(a.name)} to the timeline">${th}${a.origin === 'generated' ? '<span class="st-ai">AI</span>' : ''}${a.origin === 'recorded' ? '<span class="st-ai">REC</span>' : ''}</button>
    <div class="st-asset-t"><b title="${esc(a.name)}">${esc(a.name)}</b><small>${esc(meta)}</small>${bad ? `<small class="st-warn-t">${a.status === 'missing' ? 'Missing from this device' : 'Cannot be read here'}</small>` : usage ? `<small>Used ${usage}x</small>` : ''}</div>
    <div class="st-asset-act"><button type="button" class="st-icon" data-ren="${esc(a.id)}" aria-label="Rename ${esc(a.name)}"><i class="ph ph-pencil-simple"></i></button><label class="st-icon" aria-label="Replace ${esc(a.name)}" title="Replace file (relinks every clip)"><input type="file" data-rep="${esc(a.id)}" hidden><i class="ph ph-swap"></i></label><button type="button" class="st-icon" data-del="${esc(a.id)}" aria-label="Delete ${esc(a.name)}"><i class="ph ph-trash"></i></button></div></div>`;
}
function wireAssets(b) {
  b.querySelectorAll('[data-add]').forEach((x) => x.addEventListener('click', () => { const a = M.assetOf(P(), x.dataset.add); if (a) placeAsset(a); }));
  b.querySelectorAll('[data-ren]').forEach((x) => x.addEventListener('click', () => { const a = M.assetOf(P(), x.dataset.ren); const n = window.prompt('Rename this media', a.name); if (n && n.trim()) { a.name = n.trim().slice(0, 120); bump(); emit('assets'); emit('project'); import('./state.js').then((m) => m.markDirty()); } }));
  b.querySelectorAll('[data-del]').forEach((x) => x.addEventListener('click', async () => { const a = M.assetOf(P(), x.dataset.del); const n = usageOf(a.id).length; if (window.confirm(n ? `"${a.name}" is used by ${n} clip${n > 1 ? 's' : ''}. Deleting it removes those clips too. This cannot be undone.` : `Delete "${a.name}" from this project? This cannot be undone.`)) { await removeAsset(a.id); toast('Media deleted'); } }));
  b.querySelectorAll('[data-rep]').forEach((x) => x.addEventListener('change', async () => { const f = x.files[0]; if (!f) return; const old = M.assetOf(P(), x.dataset.rep); if (media.kindOfFile(f) !== old.kind) { toast('Choose a ' + old.kind + ' file to replace this one.'); return; } try { const na = await media.importFile(f, { actx: S.hub.ctx() }); relinkAsset(old.id, na); if (na._buf) S.hub.audio.set(na.id, na._buf); await S.hub.ensure(M.assetOf(P(), na.id)); import('./state.js').then((m) => m.save()).then(() => store.sweepOrphans()).catch(() => {}); /* save first: the sweep deletes any file the SAVED project does not list, which would delete the file just added */ toast('Replaced. Every clip now uses the new file.'); emit('project'); } catch (e) { toast(e.message || 'Could not replace the file.'); } }));
  const imp = b.querySelector('#stImp'); if (imp) imp.addEventListener('change', async () => { await importFiles([...imp.files]); imp.value = ''; });
}
function media_(b, kinds, accept, label) {
  const list = mediaList(kinds); const stor = view._est;
  b.innerHTML = `${importBar(accept)}<div class="st-lib-filter"><label class="st-vh" for="stQ">Search</label><input id="stQ" type="search" placeholder="Search ${label}" value="${esc(view.q)}"><select id="stK" aria-label="Filter by type" class="st-mini"><option value="all">All</option>${kinds.map((k) => `<option value="${k}"${view.kind === k ? ' selected' : ''}>${k[0].toUpperCase() + k.slice(1)}</option>`).join('')}</select><button type="button" class="st-icon" id="stMode" aria-label="Switch between grid and list" aria-pressed="${view.mode === 'list'}"><i class="ph ${view.mode === 'grid' ? 'ph-list' : 'ph-squares-four'}"></i></button></div>
    <div class="st-assets st-assets--${view.mode}" id="stAssets">${list.length ? list.map(mediaCard).join('') : `<div class="st-empty"><i class="ph ph-folder-open"></i><p>${P().assets.length ? 'No media matches this search.' : 'Import video, images or audio. Everything stays on this device.'}</p></div>`}</div>
    ${stor ? `<p class="st-muted st-small">Device storage: ${fmtSize(stor.usage)} used of about ${fmtSize(stor.quota)}.</p>` : ''}`;
  wireAssets(b); renderImports();
  const q = b.querySelector('#stQ'); q.addEventListener('input', () => { view.q = q.value; const l = mediaList(kinds); const box = b.querySelector('#stAssets'); box.innerHTML = l.length ? l.map(mediaCard).join('') : '<div class="st-empty"><p>No media matches this search.</p></div>'; wireAssets(b); });
  b.querySelector('#stK').addEventListener('change', (e) => { view.kind = e.target.value; media_(b, kinds, accept, label); });
  b.querySelector('#stMode').addEventListener('click', () => { view.mode = view.mode === 'grid' ? 'list' : 'grid'; media_(b, kinds, accept, label); });
  if (!stor) store.storageEstimate().then((s) => { if (s) { view._est = s; if (S.tab === 'media' || S.tab === 'audio') { const p = document.createElement('p'); p.className = 'st-muted st-small'; p.textContent = `Device storage: ${fmtSize(s.usage)} used of about ${fmtSize(s.quota)}.`; b.appendChild(p); } } });
}
function mediaTab(b) { view.kind = view.kind === 'audio' ? 'all' : view.kind; media_(b, ['video', 'image'], media_accept(), 'media'); }
const media_accept = () => 'video/*,image/*,.mkv,.m4v,.avif,.svg';
function audioTab(b) {
  const music = ['calm', 'upbeat']; const recording = !!rec;
  media_(b, ['audio'], 'audio/*,.opus,.flac,.m4a,.aac', 'audio');
  const extra = document.createElement('div'); extra.className = 'st-lib-sec';
  extra.innerHTML = `<h4 class="st-h">Voice-over</h4><p class="st-muted st-small">Records from your microphone at the playhead. Music and footage sound duck under it.</p>
    <div class="st-inline"><button type="button" class="st-btn ${recording ? 'st-btn--danger' : 'st-btn--primary'}" id="stRec"><i class="ph ${recording ? 'ph-stop' : 'ph-microphone'}"></i>${recording ? 'Stop recording' : 'Record voice-over'}</button><span class="st-rec-t" id="stRecT" role="status" aria-live="polite"></span></div>
    <h4 class="st-h">Built-in music</h4><p class="st-muted st-small">Generated in your browser. No files, no licences.</p><div class="st-inline">${music.map((m) => `<button type="button" class="st-btn" ${dragAttr({ type: 'music', kind: m })} data-music="${m}"><i class="ph ph-music-notes"></i>${m[0].toUpperCase() + m.slice(1)}</button>`).join('')}</div>
    <h4 class="st-h">Sync helpers <span class="st-tag st-tag--local">LOCAL</span></h4><p class="st-muted st-small">Find beats in the selected audio or video clip and drop markers. Snapping then lines clips up with the beat.</p>
    <div class="st-inline"><button type="button" class="st-btn" id="stBeats"><i class="ph ph-pulse"></i>Detect beats</button><button type="button" class="st-btn" id="stNearBeat">Snap clip to nearest marker</button></div>
    <div class="st-inline"><button type="button" class="st-btn" id="stNudgeL" aria-label="Nudge selected clip one frame earlier">− 1 frame</button><button type="button" class="st-btn" id="stNudgeR" aria-label="Nudge selected clip one frame later">+ 1 frame</button></div>
    <h4 class="st-h">Transcription <span class="st-tag st-tag--svc">NEEDS SERVICE</span></h4><p class="st-muted st-small">Automatic speech to captions needs a speech service that Cognita does not have connected yet, so this control is off.</p><button type="button" class="st-btn" disabled>Transcribe audio</button>`;
  b.appendChild(extra);
  extra.querySelectorAll('[data-music]').forEach((x) => x.addEventListener('click', () => placeDrop({ type: 'music', kind: x.dataset.music }, S.t)));
  extra.querySelector('#stRec').addEventListener('click', () => (rec ? stopRecording() : startRecording(extra)));
  extra.querySelector('#stBeats').addEventListener('click', async (e) => {
    const c = selClips().find((x) => x.kind === 'audio' || x.kind === 'video'); if (!c) { toast('Select an audio or video clip first.'); return; }
    e.currentTarget.disabled = true; try { await S.hub.soundFor(P(), c.assetId); const buf = S.hub.audio.get(c.assetId); if (!buf) { toast('This clip has no sound to analyse.'); return; } const beats = await detectBeats(buf); const sp = c.speed || 1; const marks = beats.map((bt) => c.start + (bt - c.in) / sp).filter((tt) => tt >= c.start && tt <= c.start + c.duration);
      if (!marks.length) { toast('No clear beats found in this clip.'); return; } transact('Detect beats', (p) => { marks.forEach((tt) => { if (!p.markers.some((m) => Math.abs(m.t - tt) < 0.05)) p.markers.push({ id: M.nid('m'), t: M.quant(p, tt), label: '' }); }); p.markers.sort((a, z) => a.t - z.t); }); toast(marks.length + ' beat markers added.'); } catch (err) { toast(err.message || 'Beat detection failed.'); } finally { e.currentTarget.disabled = false; }
  });
  extra.querySelector('#stNearBeat').addEventListener('click', () => { const c = selClips()[0]; if (!c || !P().markers.length) { toast('Select a clip and add some markers first.'); return; } const m = P().markers.reduce((a, z) => (Math.abs(z.t - c.start) < Math.abs(a.t - c.start) ? z : a)); import('./state.js').then((st) => st.moveClips([c.id], m.t - c.start, 0, 'Snap to marker')); });
  const nudge = (d) => { const c = selClips(); if (!c.length) { toast('Select a clip first.'); return; } import('./state.js').then((st) => st.moveClips(c.map((x) => x.id), d / S.project.settings.fps, 0, 'Nudge')); };
  extra.querySelector('#stNudgeL').addEventListener('click', () => nudge(-1)); extra.querySelector('#stNudgeR').addEventListener('click', () => nudge(1));
}
async function startRecording(host) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') { toast('This browser cannot record from a microphone.'); return; }
  let stream; try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); } catch (e) { toast(e && e.name === 'NotAllowedError' ? 'Microphone permission was blocked. Allow it in the browser address bar and try again.' : 'No microphone could be opened.'); return; }
  const t = host.querySelector('#stRecT'); const at = S.t; rec = { stream, at, chunks: [], mr: null, started: 0 };
  for (let i = 3; i > 0; i--) { if (!rec) { stream.getTracks().forEach((x) => x.stop()); return; } if (t) t.textContent = 'Starting in ' + i + '…'; await new Promise((r) => setTimeout(r, 1000)); }
  if (!rec) { stream.getTracks().forEach((x) => x.stop()); return; }
  const mr = new MediaRecorder(stream); rec.mr = mr; mr.ondataavailable = (e) => { if (e.data && e.data.size) rec.chunks.push(e.data); }; mr.onstop = () => finishRecording(); mr.start(500); rec.started = performance.now();
  const btn = host.querySelector('#stRec'); if (btn) { btn.className = 'st-btn st-btn--danger'; btn.innerHTML = '<i class="ph ph-stop"></i>Stop recording'; }
  rec.timer = setInterval(() => { const el = document.querySelector('#stRecT'); if (el && rec) el.textContent = 'Recording ' + fmtDur((performance.now() - rec.started) / 1000); }, 250);
}
function stopRecording() { if (!rec) return; if (rec.mr && rec.mr.state !== 'inactive') rec.mr.stop(); else { rec.stream.getTracks().forEach((x) => x.stop()); rec = null; renderBody(); } }
async function finishRecording() {
  const r = rec; rec = null; if (!r) return; clearInterval(r.timer); r.stream.getTracks().forEach((x) => x.stop());
  const blob = new Blob(r.chunks, { type: (r.mr && r.mr.mimeType) || 'audio/webm' }); if (blob.size < 500) { toast('Nothing was recorded.'); renderBody(); return; }
  try { const a = await media.importBlob(blob, 'Voice-over ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + (blob.type.includes('mp4') ? '.m4a' : '.webm'), 'audio', 'recorded', S.hub.ctx()); const rec_ = addAssetRecord(a); if (a._buf) S.hub.audio.set(a.id, a._buf);
    addClip('audio', { assetId: a.id, name: 'Voice-over', audio: { role: 'voice', gain: 1, denoise: false } }, r.at, a.duration); toast('Voice-over added at ' + M.fmtTC(r.at, fps_())); void rec_; } catch (e) { toast(e.message || 'The recording could not be saved.'); }
  renderBody();
}
const fps_ = () => P().settings.fps;

// ───────── Text ─────────
function text(b) {
  b.innerHTML = `<p class="st-muted st-small">Click to add at the playhead, or drag onto the timeline. Edit everything in the inspector.</p><div class="st-presets">${LD.TEXT_PRESETS.map((p) => `<button type="button" class="st-preset" ${dragAttr({ type: 'text', id: p.id })} data-id="${p.id}"><span class="st-preset-s" style="${presetStyle(p)}">${esc(p.sample)}</span><small>${esc(p.label)}</small></button>`).join('')}</div>`;
  b.querySelectorAll('[data-id]').forEach((x) => x.addEventListener('click', () => placeDrop({ type: 'text', id: x.dataset.id }, S.t)));
}
function presetStyle(p) { const t = p.text; const f = M.FONTS[t.font || 'sans'].css; let s = `font-family:${f.replace(/"/g, "'")};font-weight:${Math.min(900, t.weight || 700)};`; if (t.gradient && t.gradient.on) s += `background:linear-gradient(90deg,${t.gradient.c1},${t.gradient.c2});-webkit-background-clip:text;background-clip:text;color:transparent;`; else s += `color:${t.color && t.color !== '#ffffff' ? t.color : 'var(--text-primary)'};`; if (t.stroke && t.stroke.w) s += `-webkit-text-stroke:1px ${t.stroke.color};`; if (t.box && t.box.on) s += `background:${t.box.color};color:#fff;padding:2px 8px;border-radius:6px;`; return s; }

// ───────── Stickers and graphics ─────────
function stickers(b) {
  b.innerHTML = `<h4 class="st-h">Stickers</h4><div class="st-grid-s">${LD.STICKERS.map((s) => `<button type="button" class="st-sticker" ${dragAttr({ type: 'sticker', kind: 'svg', id: s.id, label: s.label })} data-sid="${s.id}" aria-label="Add ${esc(s.label)} sticker">${s.svg('#a8471f')}</button>`).join('')}</div>
    <h4 class="st-h">Emoji</h4><div class="st-grid-s st-grid-s--emoji">${LD.EMOJI.map((c) => `<button type="button" class="st-sticker st-emoji" ${dragAttr({ type: 'sticker', kind: 'emoji', char: c })} data-char="${esc(c)}" aria-label="Add emoji ${esc(c)}">${c}</button>`).join('')}</div>
    <h4 class="st-h">Shapes</h4><div class="st-inline st-wrap">${['rect', 'rounded', 'ellipse', 'line', 'arrow', 'star', 'polygon'].map((s) => `<button type="button" class="st-btn" ${dragAttr({ type: 'shape', shape: s })} data-shape="${s}">${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}</div>
    <h4 class="st-h">Backgrounds</h4><div class="st-grid-s">${LD.BACKGROUNDS.map((g) => `<button type="button" class="st-sticker st-bg" style="background:linear-gradient(${g.angle}deg,${g.c1},${g.c2})" ${dragAttr({ type: 'bg', id: g.id })} data-bg="${g.id}" aria-label="Add ${esc(g.label)} background"></button>`).join('')}</div>
    <h4 class="st-h">Your logo or overlay</h4><p class="st-muted st-small">Import a PNG or SVG in the Media tab and place it like any image. Transparent areas are kept.</p>`;
  b.querySelectorAll('[data-sid]').forEach((x) => x.addEventListener('click', () => placeDrop({ type: 'sticker', kind: 'svg', id: x.dataset.sid, label: LD.stickerById(x.dataset.sid).label }, S.t)));
  b.querySelectorAll('[data-char]').forEach((x) => x.addEventListener('click', () => placeDrop({ type: 'sticker', kind: 'emoji', char: x.dataset.char }, S.t)));
  b.querySelectorAll('[data-shape]').forEach((x) => x.addEventListener('click', () => placeDrop({ type: 'shape', shape: x.dataset.shape }, S.t)));
  b.querySelectorAll('[data-bg]').forEach((x) => x.addEventListener('click', () => placeDrop({ type: 'bg', id: x.dataset.bg }, S.t)));
}

// ───────── Effects, Transitions, Filters ─────────
function applyToSelection(label, fn) { const cs = selClips().filter((c) => !['audio', 'music'].includes(c.kind)); if (!cs.length) return false; transact(label, () => { cs.forEach(fn); }); return true; }
function effects(b) {
  b.innerHTML = `<p class="st-muted st-small" data-hint>${hintText()}</p><div class="st-list">${M.EFFECT_TYPES.map(([id, label, hint, def]) => `<div class="st-row-item"><div><b>${label}</b><small>${hint}</small></div><div class="st-inline"><button type="button" class="st-btn" data-apply="${id}">Apply to clip</button><button type="button" class="st-btn" data-layer="${id}" title="Affects everything below it, for as long as it lasts">As layer</button></div></div>`).join('')}</div>`;
  b.querySelectorAll('[data-apply]').forEach((x) => x.addEventListener('click', () => { const t = M.EFFECT_TYPES.find((e) => e[0] === x.dataset.apply); if (!applyToSelection('Add effect', (c) => { if (c.effects.length < M.LIMITS.effects && !c.effects.some((e) => e.type === t[0])) c.effects.push({ type: t[0], amount: t[3] }); })) toast('Select a clip first, or use "As layer".'); }));
  b.querySelectorAll('[data-layer]').forEach((x) => x.addEventListener('click', () => { const t = M.EFFECT_TYPES.find((e) => e[0] === x.dataset.layer); placeDrop({ type: 'effectlayer', fx: t[0], amount: t[3], label: t[1] }, S.t); }));
}
function transitions(b) {
  b.innerHTML = `<p class="st-muted st-small" data-hint>${hintText()}</p><div class="st-field"><label for="trDir">Direction (wipe, slide, push)</label><select id="trDir"><option value="left">From the left</option><option value="right">From the right</option><option value="up">From the top</option><option value="down">From the bottom</option></select></div>
    <div class="st-inline st-wrap"><label class="st-check"><input type="radio" name="trEnd" value="in" checked> Start of clip</label><label class="st-check"><input type="radio" name="trEnd" value="out"> End of clip</label></div>
    <div class="st-grid-s st-grid-s--tr">${M.TRANSITION_TYPES.map(([id, l]) => `<button type="button" class="st-tr" data-tr="${id}"><i class="ph ph-arrows-left-right"></i><span>${l}</span></button>`).join('')}<button type="button" class="st-tr" data-tr="none"><i class="ph ph-prohibit"></i><span>None</span></button></div>
    <p class="st-muted st-small">When two clips touch on one track, a transition at the start of the second one blends the cut. Adjust its length in the inspector, or click the diamond on the timeline.</p>`;
  b.querySelectorAll('[data-tr]').forEach((x) => x.addEventListener('click', () => { const end = b.querySelector('input[name="trEnd"]:checked').value; const dir = b.querySelector('#trDir').value; const type = x.dataset.tr; if (!applyToSelection('Transition', (c) => { const key = end === 'in' ? 'transitionIn' : 'transitionOut'; c[key] = { type, duration: c[key].duration || 0.6, dir }; })) toast('Select a clip first.'); }));
}
function filters(b) {
  b.innerHTML = `<p class="st-muted st-small" data-hint>${hintText()}</p><div class="st-grid-s st-grid-s--f">${LD.FILTERS.map((f) => `<button type="button" class="st-filter" data-f="${f.id}"><span class="st-fsw" style="background:${f.swatch}"></span><small>${esc(f.label)}</small></button>`).join('')}</div>
    <div class="st-lib-act"><button type="button" class="st-btn" id="fAll"><i class="ph ph-stack"></i>Add as adjustment layer</button></div><p class="st-muted st-small">An adjustment layer applies the chosen filter to everything below it. Pick a filter, then press the button.</p>`;
  let last = 'none'; b.querySelectorAll('[data-f]').forEach((x) => x.addEventListener('click', () => { last = x.dataset.f; b.querySelectorAll('[data-f]').forEach((y) => y.classList.toggle('is-on', y === x)); applyToSelection('Filter', (c) => { c.filter = last; c.filterAmount = 1; }); }));
  b.querySelector('#fAll').addEventListener('click', () => { if (last === 'none') { toast('Pick a filter first.'); return; } addClip('adjustment', { name: 'Filter: ' + LD.filterById(last).label, filter: last, filterAmount: 1 }, 0, Math.max(3, dur())); });
}

// ───────── Captions ─────────
export const captionClips = () => P().clips.filter((c) => c.kind === 'caption' && !(P().tracks.find((t) => t.id === c.trackId) || {}).hidden || (c.kind === 'caption')).sort((a, b) => a.start - b.start);
function ensureCaptionTrack() { return P().tracks.find((t) => t.type === 'caption' && t.role !== 'storyCaptions') || P().tracks.find((t) => t.type === 'caption'); }
function captions(b) {
  const cs = captionClips(); const p = P();
  b.innerHTML = `<div class="st-lib-act"><button type="button" class="st-btn st-btn--primary" id="capAdd"><i class="ph ph-plus"></i>Add cue at playhead</button><label class="st-btn"><input type="file" id="capImp" accept=".srt,.vtt,text/vtt,application/x-subrip,text/plain" hidden><i class="ph ph-upload-simple"></i>Import SRT or VTT</label></div>
    <div class="st-inline st-wrap"><button type="button" class="st-btn" id="capSrt"${cs.length ? '' : ' disabled'}><i class="ph ph-download-simple"></i>Export .srt</button><button type="button" class="st-btn" id="capVtt"${cs.length ? '' : ' disabled'}><i class="ph ph-download-simple"></i>Export .vtt</button></div>
    <div class="st-field"><label for="capStyle">Style</label><select id="capStyle">${LD.CAPTION_PRESETS.map((c) => `<option value="${c.id}"${p.captionStyle.preset === c.id ? ' selected' : ''}>${c.label}: ${esc(c.hint)}</option>`).join('')}</select></div>
    <label class="st-check"><input type="checkbox" id="capBurn"${p.export.burnCaptions !== false ? ' checked' : ''}> Burn captions into the exported video</label><p class="st-muted st-small">Turn it off to export a clean video and share the .srt file alongside it.</p>
    <p class="st-muted st-small">Position: select a cue, then drag it on the preview or use Position in the inspector. Keep text inside the safe area (toggle it under the preview).</p>
    <h4 class="st-h">Cues <span class="st-muted">${cs.length}</span></h4><div class="st-cues" id="capList">${cs.slice(0, 300).map((c) => `<div class="st-cue${S.sel.has(c.id) ? ' is-on' : ''}" data-id="${c.id}"><button type="button" class="st-cue-t" data-go="${c.id}" aria-label="Go to cue at ${M.fmtShort(c.start)}">${M.fmtShort(c.start)}</button><textarea rows="2" data-txt="${c.id}" aria-label="Caption text">${esc(c.text.content)}</textarea><div class="st-cue-tm"><input type="number" step="0.1" min="0" value="${c.start.toFixed(2)}" data-st="${c.id}" aria-label="Start seconds"><input type="number" step="0.1" min="0.1" value="${c.duration.toFixed(2)}" data-du="${c.id}" aria-label="Duration seconds"></div></div>`).join('')}${cs.length > 300 ? '<p class="st-muted st-small">Showing the first 300 cues.</p>' : ''}</div>
    <div class="st-inline"><button type="button" class="st-btn" id="capMerge">Merge selected cues</button><button type="button" class="st-btn" id="capSplit">Split at playhead</button></div>
    <h4 class="st-h">Auto-captions <span class="st-tag st-tag--local">ON DEVICE</span> <span class="st-tag st-tag--svc">or cloud</span></h4><div id="sttBox" aria-live="polite"></div>`;
  b.querySelector('#capAdd').addEventListener('click', () => { const tr = ensureCaptionTrack(); addClip('caption', { name: 'Caption', text: { ...M.defaultText(), content: 'New caption', size: 64, weight: 700 }, cap: { preset: P().captionStyle.preset, lead: 0, dur: 0 }, transform: { y: 0.3 } }, S.t, 2.5, tr && tr.id); });
  b.querySelector('#capImp').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; if (f.size > CP.MAX_SUB_BYTES) { toast('That subtitle file is too large (over 2 MB).'); return; } try { const { cues, warnings } = CP.parseSubtitles(await f.text()); importCues(cues); toast(cues.length + ' cues imported.' + (warnings[0] ? ' ' + warnings[0] : '')); } catch (err) { toast(err.message || 'Could not read that subtitle file.'); } });
  const exp = (fmt) => { const cues = cs.map((c) => ({ start: c.start, end: c.start + c.duration, text: c.text.content })); download(new Blob([fmt === 'srt' ? CP.toSRT(cues) : CP.toVTT(cues)], { type: 'text/plain' }), safeName(p.title) + '.' + fmt); };
  b.querySelector('#capSrt').addEventListener('click', () => exp('srt')); b.querySelector('#capVtt').addEventListener('click', () => exp('vtt'));
  b.querySelector('#capStyle').addEventListener('change', (e) => transact('Caption style', (pp) => { pp.captionStyle.preset = e.target.value; pp.clips.forEach((c) => { if (c.kind === 'caption' && c.cap && c.cap.preset !== 'karaoke') c.cap.preset = e.target.value; else if (c.kind === 'caption' && c.cap && e.target.value !== 'karaoke') c.cap.preset = e.target.value; }); }));
  b.querySelector('#capBurn').addEventListener('change', (e) => transact('Burn captions', (pp) => { pp.export.burnCaptions = e.target.checked; }));
  b.querySelector('#capMerge').addEventListener('click', () => import('./state.js').then((m) => m.mergeCaptions())); b.querySelector('#capSplit').addEventListener('click', () => { const c = selClips().filter((x) => x.kind === 'caption'); import('./state.js').then((m) => m.splitAt(S.t, c.map((x) => x.id))); });
  paintStt();
  const list = b.querySelector('#capList');
  list.addEventListener('click', (e) => { const g = e.target.closest('[data-go]'); if (g) { const c = clipById(g.dataset.go); select([c.id]); import('./preview.js').then((m) => m.seek(c.start + 0.01)); } });
  list.addEventListener('change', (e) => { const t = e.target; if (t.dataset.txt) setClip(t.dataset.txt, (c) => { c.text.content = t.value.slice(0, 500); if (c.cap) c.cap.dur = 0; }, 'Edit caption'); else if (t.dataset.st) setClip(t.dataset.st, (c) => { c.start = Math.max(0, M.quant(P(), Number(t.value) || 0)); }, 'Caption timing'); else if (t.dataset.du) setClip(t.dataset.du, (c) => { c.duration = Math.max(0.1, M.quant(P(), Number(t.value) || 0.5)); if (c.cap) c.cap.dur = 0; }, 'Caption timing'); });
  list.addEventListener('focusin', (e) => { const row = e.target.closest('.st-cue'); if (row && !S.sel.has(row.dataset.id)) { S.sel = new Set([row.dataset.id]); emit('sel'); } });
}

// ───────── Auto-captions (NEEDS SERVICE: Cognita Worker, Studio plan) ─────────
const stt = { running: false, abort: null, stage: '', frac: 0, result: '', lang: 'project', mode: 'device' };
const STT_LANGS = [['project', 'Same as the project'], ['auto', 'Detect automatically'], ['en-NG', 'English'], ['fr-FR', 'French'], ['yo-NG', 'Yoruba'], ['ha-NG', 'Hausa']];
const sttLang = () => (stt.lang === 'project' ? ((P().lang && TR_LANGS.includes(P().lang)) ? P().lang : 'en-NG') : stt.lang);
const TR_LANGS = ['en-NG', 'en-GB', 'en-US', 'fr-FR'];
const sttTarget = () => { const cs = selClips().filter((c) => c.kind === 'video' || c.kind === 'audio'); if (cs.length > 1) return { ok: false, reason: 'Select just one clip to transcribe.' }; const c = cs[0] || null; const chk = TR.canTranscribe(c, P()); return chk.ok ? { ...chk, clip: c } : chk; };
const mins = (sec) => (sec < 90 ? Math.max(1, Math.round(sec)) + ' sec' : Math.round(sec / 60) + ' min');
function sttHtml() {
  const modeSel = `<div class="st-field"><label for="sttMode">Where to transcribe</label><select id="sttMode"${stt.running ? ' disabled' : ''}><option value="device"${stt.mode === 'device' ? ' selected' : ''}>On this device (private, free)</option><option value="cloud"${stt.mode === 'cloud' ? ' selected' : ''}>Cognita cloud (more accurate, Studio plan)</option></select></div>`;
  return modeSel + (stt.mode === 'device' ? deviceHtml() : cloudHtml());
}
// ON THIS DEVICE: Whisper tiny in the isolated model frame. No plan, no allowance, nothing leaves the device.
function deviceHtml() {
  const sup = LS.deviceSupport(); if (!sup.ok) return `<p class="st-muted st-small">${esc(sup.reason)}</p><button type="button" class="st-btn" disabled>Generate captions</button>`;
  const tg = sttTarget(); const opts = STT_LANGS.map(([v, l]) => `<option value="${v}"${stt.lang === v ? ' selected' : ''}>${esc(l)}</option>`).join(''); const pct = Math.round(stt.frac * 100);
  return `<p class="st-muted st-small">The sound is transcribed by a small speech model running in this browser. <b>Nothing is uploaded</b> and there is no daily limit. The first run downloads about 63 MB (kept by the browser afterwards). It is best at clear English; Yoruba and Hausa are weak on this small model, and names often need fixing. A minute of speech takes roughly a minute on a typical laptop, longer on phones.</p>
    <div class="st-field"><label for="sttLang">Language spoken</label><select id="sttLang"${stt.running ? ' disabled' : ''}>${opts}</select></div>
    ${tg.ok ? `<p class="st-small">Clip: <b>${esc(tg.clip.name || 'Selected clip')}</b> (${mins(tg.seconds)} of sound).</p>` : `<p class="st-muted st-small">${esc(tg.reason)}</p>`}
    <div class="st-inline"><button type="button" class="st-btn st-btn--primary" id="sttGo"${tg.ok && !stt.running ? '' : ' disabled'}><i class="ph ph-closed-captioning"></i>Generate captions</button>${stt.running ? '<button type="button" class="st-btn" id="sttStop">Cancel</button>' : ''}</div>
    ${stt.running ? `<div class="st-bar" role="progressbar" aria-label="Automatic captions progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div><p class="st-muted st-small" role="status">${esc(stt.stage)}</p>` : ''}
    ${stt.result ? `<p class="st-small" role="status">${esc(stt.result)}</p>` : ''}`;
}
function cloudHtml() {
  const st = sttStatus(); const dis = (why) => `<p class="st-muted st-small">${esc(why)}</p><button type="button" class="st-btn" disabled>Generate captions</button>`;
  if (!st.allowed) return dis(st.offline ? 'You appear to be offline, so automatic captions cannot be checked.' : st.error ? 'Could not check your plan right now. Reopen Studio to try again.' : st.notDeployed ? 'Automatic captions are not available on this server yet.' : st.unknown ? 'Checking what your plan allows…' : TR.MESSAGES.PLAN_REQUIRED + ' You can still type cues or import a subtitle file.');
  if (st.available === false) return dis(TR.MESSAGES.STT_NOT_CONFIGURED);
  const left = st.unlimited ? 'No daily limit on your account.' : st.secondsLeft != null ? 'About ' + mins(st.secondsLeft) + ' of speech left today (resets at midnight UTC).' : '';
  const tg = sttTarget();
  const opts = STT_LANGS.map(([v, l]) => `<option value="${v}"${stt.lang === v ? ' selected' : ''}>${esc(l)}</option>`).join('');
  const pct = Math.round(stt.frac * 100);
  return `<p class="st-muted st-small">Select a video or audio clip, then press Generate. <b>Only its sound</b> (not the picture) is sent to Cognita's speech service in short pieces, and nothing is kept. ${esc(left)}</p>
    <div class="st-field"><label for="sttLang">Language spoken</label><select id="sttLang"${stt.running ? ' disabled' : ''}>${opts}</select></div>
    ${tg.ok ? `<p class="st-small">Clip: <b>${esc(tg.clip.name || 'Selected clip')}</b>. This will use about <b>${mins(tg.seconds)}</b> of today's allowance.</p>` : `<p class="st-muted st-small">${esc(tg.reason)}</p>`}
    <div class="st-inline"><button type="button" class="st-btn st-btn--primary" id="sttGo"${tg.ok && !stt.running ? '' : ' disabled'}><i class="ph ph-closed-captioning"></i>Generate captions</button>${stt.running ? '<button type="button" class="st-btn" id="sttStop">Cancel</button>' : ''}</div>
    ${stt.running ? `<div class="st-bar" role="progressbar" aria-label="Automatic captions progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><i style="width:${pct}%"></i></div><p class="st-muted st-small" role="status">${esc(stt.stage)}</p>` : ''}
    ${stt.result ? `<p class="st-small" role="status">${esc(stt.result)}</p>` : ''}`;
}
function paintStt() {
  const box = root && root.querySelector('#sttBox'); if (!box) return;
  const keep = document.activeElement && document.activeElement.id; box.innerHTML = sttHtml();
  const go = box.querySelector('#sttGo'), stop = box.querySelector('#sttStop'), lg = box.querySelector('#sttLang');
  const md = box.querySelector('#sttMode'); if (md) md.addEventListener('change', () => { stt.mode = md.value; stt.result = ''; paintStt(); });
  if (lg) lg.addEventListener('change', () => { stt.lang = lg.value; });
  if (go) go.addEventListener('click', runStt); if (stop) stop.addEventListener('click', () => { stop.disabled = true; if (stt.abort) stt.abort.abort(); });
  if (keep) { const el = box.querySelector('#' + keep); if (el && !el.disabled) el.focus(); }
}
async function runStt() {
  const tg = sttTarget(); if (!tg.ok || stt.running) return;
  if (stt.mode === 'device') return runSttDevice(tg);
  stt.running = true; stt.abort = new AbortController(); stt.frac = 0; stt.stage = 'Reading the sound'; stt.result = ''; paintStt();
  try {
    const r = await TR.transcribeClip({ project: P(), clip: tg.clip, hub: S.hub, lang: sttLang(), signal: stt.abort.signal, onProgress: (p) => { stt.stage = p.stage; stt.frac = p.frac; paintStt(); } });
    if (r.cues.length) importCues(r.cues);
    const st = S.status && S.status.transcription; if (st && r.secondsLeft != null) { st.secondsLeft = r.secondsLeft; st.secondsUsed = (st.secondsPerDay || 0) - r.secondsLeft; }
    stt.result = (r.cues.length ? r.cues.length + ' caption cue' + (r.cues.length === 1 ? '' : 's') + ' added. ' : (r.partial ? '' : 'No speech was found in this clip. ')) + (r.skipped ? r.skipped + ' silent part' + (r.skipped === 1 ? ' was' : 's were') + ' skipped. ' : '') + (r.partial ? 'Stopped early: ' + r.error + ' Time already processed still counts toward today’s allowance.' : '');
    if (r.cues.length) toast(r.cues.length + ' captions added. Check the spelling of names.');
  } catch (e) { stt.result = e && e.name === 'AbortError' ? 'Cancelled.' : (e && e.message) || 'Automatic captions failed.'; }
  finally { stt.running = false; stt.abort = null; paintStt(); }
}
async function runSttDevice(tg) {
  stt.running = true; stt.abort = new AbortController(); stt.frac = 0; stt.stage = 'Reading the sound'; stt.result = ''; paintStt();
  try {
    const r = await LS.transcribeClipLocal({ project: P(), clip: tg.clip, hub: S.hub, lang: stt.lang === 'project' ? sttLang() : stt.lang, signal: stt.abort.signal, onProgress: (p) => { stt.stage = p.download && p.download < 1 ? p.stage + ' (' + Math.round(p.download * 100) + '%)' : p.stage; stt.frac = p.frac; paintStt(); } });
    if (r.cues.length) importCues(r.cues);
    stt.result = (r.cues.length ? r.cues.length + ' caption cue' + (r.cues.length === 1 ? '' : 's') + ' added' + (r.language ? ' (language: ' + r.language + ')' : '') + '. ' : (r.partial ? '' : 'No speech was found in this clip. ')) + (r.skipped ? r.skipped + ' silent part' + (r.skipped === 1 ? ' was' : 's were') + ' skipped. ' : '') + (r.partial ? 'Stopped early: ' + r.error : '');
    if (r.cues.length) toast(r.cues.length + ' captions added. Check the spelling of names.');
  } catch (e) { stt.result = e && e.name === 'AbortError' ? 'Cancelled.' : (e && e.message) || 'Automatic captions failed.'; }
  finally { stt.running = false; stt.abort = null; paintStt(); }
}
export function importCues(cues) {
  const p = P(); const tr = ensureCaptionTrack() || null; const style = p.captionStyle.preset;
  transact('Import captions', (pp) => { let track = tr; if (!track) { track = M.newTrack('caption', 'Captions'); pp.tracks.unshift(track); }
    const placed = []; cues.forEach((c) => { const d = Math.max(0.1, c.end - c.start); let t2 = track; if (pp.clips.some((x) => x.trackId === t2.id && x.start < c.start + d - 1e-6 && x.start + x.duration > c.start + 1e-6)) { t2 = pp.tracks.find((t) => t.type === 'caption' && !pp.clips.some((x) => x.trackId === t.id && x.start < c.start + d - 1e-6 && x.start + x.duration > c.start + 1e-6)); if (!t2) { t2 = M.newTrack('caption', 'Captions ' + (pp.tracks.filter((t) => t.type === 'caption').length + 1)); pp.tracks.unshift(t2); } }
      const cl = M.newClip('caption', { trackId: t2.id, start: c.start, duration: d, name: c.text.slice(0, 40), text: { ...M.defaultText(), content: c.text, size: 64, weight: 700 }, cap: { preset: style, lead: 0, dur: 0 }, transform: { y: 0.3 } }); pp.clips.push(cl); placed.push(cl.id); });
    S.sel = new Set(placed); });
}

// ───────── Templates ─────────
let userTpl = null;
async function loadTemplates() { try { userTpl = await store.listTemplates(); } catch (_) { userTpl = []; } }
function templates(b) {
  const draw = () => { b.innerHTML = `<p class="st-muted st-small">Templates add a group of clips at the playhead. Save your own from a selection, and share them as JSON files.</p>
    <div class="st-list">${LD.BUILTIN_TEMPLATES.map((t) => `<div class="st-row-item" ${dragAttr({ type: 'template', id: t.id })}><div><b>${esc(t.name)}</b><small>${esc(t.hint)}</small></div><button type="button" class="st-btn" data-tpl="${t.id}">Add</button></div>`).join('')}
    ${(userTpl || []).map((t) => `<div class="st-row-item" ${dragAttr({ type: 'template', id: t.id })}><div><b>${esc(t.name)}</b><small>Saved by you · ${t.items.length} clip${t.items.length === 1 ? '' : 's'}</small></div><div class="st-inline"><button type="button" class="st-btn" data-tpl="${esc(t.id)}">Add</button><button type="button" class="st-icon" data-tx="${esc(t.id)}" aria-label="Export ${esc(t.name)}"><i class="ph ph-download-simple"></i></button><button type="button" class="st-icon" data-td="${esc(t.id)}" aria-label="Delete ${esc(t.name)}"><i class="ph ph-trash"></i></button></div></div>`).join('')}</div>
    <div class="st-lib-act"><button type="button" class="st-btn st-btn--primary" id="tplSave"><i class="ph ph-floppy-disk"></i>Save selection as template</button><label class="st-btn"><input type="file" id="tplImp" accept=".json,application/json" hidden><i class="ph ph-upload-simple"></i>Import template</label></div>`;
    b.querySelectorAll('[data-tpl]').forEach((x) => x.addEventListener('click', () => applyTemplate(x.dataset.tpl, S.t)));
    b.querySelectorAll('[data-tx]').forEach((x) => x.addEventListener('click', () => { const t = userTpl.find((y) => y.id === x.dataset.tx); download(new Blob([JSON.stringify({ cognitaTemplate: 1, name: t.name, items: t.items }, null, 1)], { type: 'application/json' }), safeName(t.name) + '.template.json'); }));
    b.querySelectorAll('[data-td]').forEach((x) => x.addEventListener('click', async () => { if (!window.confirm('Delete this template?')) return; await store.deleteTemplate(x.dataset.td); await loadTemplates(); draw(); }));
    b.querySelector('#tplSave').addEventListener('click', async () => { const cs = selClips(); if (!cs.length) { toast('Select the clips you want to save first.'); return; } const name = window.prompt('Name this template', 'My template'); if (!name) return; const t0 = Math.min(...cs.map((c) => c.start)); const items = cs.filter((c) => c.kind !== 'scene').map((c) => ({ kind: c.kind, trackType: P().tracks.find((t) => t.id === c.trackId).type, rel: c.start - t0, duration: c.duration, props: stripClip(c) })); if (!items.length) { toast('Storyboard scenes cannot be saved as templates.'); return; } try { await store.saveTemplate({ id: store.uid('tpl'), name: name.slice(0, 60), createdAt: Date.now(), items }); await loadTemplates(); draw(); toast('Template saved'); } catch (e) { toast(e.message || 'Could not save the template.'); } });
    b.querySelector('#tplImp').addEventListener('change', async (e) => { const f = e.target.files[0]; e.target.value = ''; if (!f) return; try { if (f.size > 1048576) throw new Error('That file is too large to be a template.'); const j = JSON.parse(await f.text()); if (!j || j.cognitaTemplate !== 1 || !Array.isArray(j.items) || !j.items.length || j.items.length > 60) throw new Error('This is not a Cognita template file.'); const ids = new Set(['t']); const items = j.items.map((it) => { const c = M.sanitiseClip({ ...it.props, id: 'x', trackId: 't', kind: it.kind, start: 0, duration: Math.max(0.1, Number(it.duration) || 3) }, ids); return c ? { kind: c.kind, trackType: M.TRACK_TYPES.includes(it.trackType) ? it.trackType : 'video', rel: Math.max(0, Number(it.rel) || 0), duration: c.duration, props: stripClip(c) } : null; }).filter(Boolean); if (!items.length) throw new Error('This template has no usable clips.'); await store.saveTemplate({ id: store.uid('tpl'), name: String(j.name || 'Imported template').slice(0, 60), createdAt: Date.now(), items }); await loadTemplates(); draw(); toast('Template imported'); } catch (err) { toast(err.message || 'Could not import that template.'); } });
  };
  if (userTpl) draw(); else loadTemplates().then(() => { if (S.tab === 'templates') draw(); }); draw();
}
function stripClip(c) { const o = JSON.parse(JSON.stringify(c)); ['id', 'trackId', 'start', 'duration', 'groupId', 'link', 'narr', 'scene'].forEach((k) => delete o[k]); return o; }
export async function applyTemplate(id, t) {
  const tpl = LD.BUILTIN_TEMPLATES.find((x) => x.id === id) || (userTpl || (await store.listTemplates())).find((x) => x.id === id); if (!tpl) return; const t0 = t == null ? S.t : t; const p = P(); const g = M.nid('g'); const u = projectUnit();
  transact('Add template', (pp) => { const ids = []; tpl.items.forEach((it) => { const props = JSON.parse(JSON.stringify(it.props || {})); if (it.fill && props.shape) { props.shape.w = pp.settings.width * u + 6; props.shape.h = pp.settings.height * u + 6; }
    const c = M.newClip(it.kind, { ...props, start: Math.max(0, snapT(t0 + (it.rel || 0))), duration: it.duration }); c.groupId = g; c.name = c.name || it.kind; let tr = pp.tracks.find((x) => x.type === it.trackType && !x.locked && !pp.clips.some((y) => y.trackId === x.id && y.start < c.start + c.duration - 1e-6 && y.start + y.duration > c.start + 1e-6));
    if (!tr) { tr = M.newTrack(it.trackType, it.trackType[0].toUpperCase() + it.trackType.slice(1) + ' ' + (pp.tracks.filter((x) => x.type === it.trackType).length + 1)); if (it.trackType === 'audio') pp.tracks.push(tr); else pp.tracks.unshift(tr); } c.trackId = tr.id; pp.clips.push(c); ids.push(c.id); }); S.sel = new Set(ids); });
  void p;
}
