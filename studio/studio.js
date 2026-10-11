// studio/studio.js
// Cognita Studio view. Mounted by js/router.js (?view=studio). Exports mount/activate/deactivate.
// UI and orchestration only. Rendering: engine.js. Export: export.js. AI: storyboard.js. Voice: narration.js. Footage and pictures: media.js.

import { escapeHtml as esc, showToast } from '../js/shell.js';
import * as store from './store.js';
import * as sb from './storyboard.js';
import * as eng from './engine.js';
import * as nar from './narration.js';
import * as media from './media.js';
import * as exp from './export.js';

export const HANDOFF_KEY = 'cognita.studio.handoff';
const STUDIO_PLAN_URL = '/pricing.html';

const S = {
  screen: 'home', mode: 'prompt',
  opts: { aspect: '9:16', duration: 45, style: 'clean', music: 'calm', language: 'English (Nigeria)', captions: true, aiImages: true, narrate: true },
  prompt: '', sourceText: '', pendingImages: [], pendingVideos: [],
  clarify: '', error: '', notice: '',
  project: null, selected: 0, images: new Map(), vthumbs: new Map(), buffers: new Map(),
  history: [], future: [], dirty: false, saveState: 'saved',
  t: 0, playing: false, pane: 'preview', tab: 'scene', vol: 0.5, narrate: false,
  projects: [], busy: false, stages: [], genStage: 0, assistantLog: [],
  status: null, narrJob: null, handle: null, exportState: null,
};

let root = null, ctx = null, canvas = null, raf = 0, lastTs = 0, saveTimer = 0, mounted = false, thumbTimer = 0, spokenScene = -1;
let pv = null;            // preview videos
let pa = null;            // preview audio { ctx, bus, nodes[], music }
const $ = (s, el = root) => el.querySelector(s);

// ───────────── helpers ─────────────
const clone = (o) => JSON.parse(JSON.stringify(o));
const projSnap = () => JSON.stringify({ title: S.project.title, aspect: S.project.aspect, style: S.project.style, music: S.project.music, captions: S.project.captions, voice: S.project.voice, rate: S.project.rate, scenes: S.project.scenes });
const fmt = (s) => { s = Math.max(0, s); const m = Math.floor(s / 60); return m + ':' + String(Math.floor(s % 60)).padStart(2, '0'); };
const fmtSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
const rel = (ts) => { const d = Date.now() - ts; if (d < 6e4) return 'Just now'; if (d < 36e5) return Math.round(d / 6e4) + ' min ago'; if (d < 864e5) return Math.round(d / 36e5) + ' h ago'; return new Date(ts).toLocaleDateString(); };
const isMobile = () => window.matchMedia('(max-width: 900px)').matches;
const fixed = (n) => (Math.round(n * 10) / 10).toString();
const assetOf = (id) => ((S.project && S.project.assets) || []).find((a) => a.id === id);
const nStatus = () => (S.status && S.status.narration) || { allowed: false, voices: [] };
const dur = (s) => eng.sceneDur(S.project, s);
const langCode = () => (S.project && S.project.lang) || nar.langCodeFor((S.project && S.project.language) || S.opts.language);

function narrState(s) {
  if (!(s.caption || '').trim()) return 'none';
  if (!s.narr) return 'missing';
  return eng.validNarr(S.project, s) ? 'ready' : 'outdated';
}
const needsNarration = () => S.project.scenes.filter((sc) => ['missing', 'outdated'].includes(narrState(sc)));

function commit() {
  if (!S.project) return;
  S.history.push(S._lastSnap || projSnap()); if (S.history.length > 60) S.history.shift();
  S.future = []; S._lastSnap = projSnap(); markDirty();
}
function markDirty() { S.dirty = true; S.saveState = 'unsaved'; renderStatus(); clearTimeout(saveTimer); saveTimer = setTimeout(save, 900); scheduleThumbs(); }
function applySnap(json) { Object.assign(S.project, JSON.parse(json)); S.selected = Math.min(S.selected, S.project.scenes.length - 1); S._lastSnap = projSnap(); }
function undo() { if (!S.history.length) return; S.future.push(projSnap()); applySnap(S.history.pop()); markDirty(); renderEditor(); }
function redo() { if (!S.future.length) return; S.history.push(projSnap()); applySnap(S.future.pop()); markDirty(); renderEditor(); }

async function save() {
  if (!S.project) return;
  S.saveState = 'saving'; renderStatus();
  try { S.project.updatedAt = Date.now(); S.project.vol = S.vol; S.project.thumb = makeThumb(); await store.saveProject(S.project); S.dirty = false; S.saveState = 'saved'; }
  catch (e) { S.saveState = 'failed'; console.error('[studio] save failed', e); }
  renderStatus();
}
const thumbFrames = (scene) => (scene.video ? S.vthumbs.get(scene.video) || null : null);
function makeThumb() {
  try {
    const { width, height } = eng.dimsFor(S.project.aspect, 160);
    const c = document.createElement('canvas'); c.width = width; c.height = height;
    eng.drawFrame(c.getContext('2d'), width, height, S.project, eng.settleTime(S.project, 0), S.images, thumbFrames);
    return c.toDataURL('image/jpeg', 0.7);
  } catch (_) { return ''; }
}

async function loadMedia(project) {
  S.images = new Map(); S.vthumbs = new Map();
  if (pv) pv.dispose(); pv = new media.PreviewVideos();
  for (const a of project.assets || []) {
    try {
      if (a.kind === 'video') {
        if (a.thumb) { const im = new Image(); im.src = a.thumb; await new Promise((r) => { im.onload = r; im.onerror = r; }); S.vthumbs.set(a.id, im); }
        await pv.load(a.id);
      } else {
        const rec = await store.getAsset(a.id); if (rec && rec.blob) S.images.set(a.id, await eng.decodeImage(rec.blob));
      }
    } catch (_) { /* missing asset is reported in the scene panel */ }
  }
  S.buffers = (await nar.loadBuffers(project)).buffers;
}

// ───────────── mount ─────────────
export async function mount() {
  root = document.getElementById('studioRoot'); mounted = true;
  try { S.projects = await store.listProjects(); } catch (_) { S.projects = []; S.storageOff = true; }
  window.addEventListener('online', () => { renderStatus(); refreshStatus(); }); window.addEventListener('offline', renderStatus);
  document.addEventListener('keydown', onKey); document.addEventListener('keydown', onModalKey);
  window.addEventListener('beforeunload', (e) => { if (S.dirty || S.busy || S.exportState === 'rendering' || S.narrJob) { e.preventDefault(); e.returnValue = ''; } });
  render(); refreshStatus(); checkHandoff();
}
export function activate() { checkHandoff(); refreshStatus(); }
export function deactivate() { pause(); }

async function refreshStatus() {
  try { S.status = await nar.loadStatus(); } catch (_) { S.status = null; }
  if (S.screen === 'home') renderHome(); else if (S.screen === 'editor' && S.tab === 'project') renderProps();
}
function checkHandoff() {
  let text = null; try { text = sessionStorage.getItem(HANDOFF_KEY); sessionStorage.removeItem(HANDOFF_KEY); } catch (_) { /* ignore */ }
  if (!text || S.busy) return;
  if (S.screen === 'editor') { pause(); S.screen = 'home'; S.project = null; }
  S.mode = 'prompt'; S.prompt = text; render(); generate();
}
function render() { if (!root) return; if (S.screen === 'home') renderHome(); else if (S.screen === 'generating') renderGenerating(); else renderEditor(); }

// ───────────── Home ─────────────
function renderHome() {
  pause();
  const o = S.opts, ns = nStatus();
  const modes = [['prompt', 'ph-sparkle', 'From a prompt'], ['document', 'ph-file-text', 'From a document'], ['images', 'ph-images', 'From images'], ['footage', 'ph-film-strip', 'From footage']];
  const sel = (name, list, cur = o[name]) => `<select data-opt="${name}" aria-label="${name}">${list.map(([v, l, dis]) => `<option value="${v}"${String(cur) === String(v) ? ' selected' : ''}${dis ? ' disabled' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const narrOptions = [[true, 'Narrate with a voice', !ns.allowed], [false, 'No narration']];
  const keep = { open: !!root.querySelector('details.st-more[open]'), id: document.activeElement && root.contains(document.activeElement) ? document.activeElement.id : '', opt: document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.opt : '', a: 0, b: 0, top: (root.querySelector('.st-home') || {}).scrollTop || 0 };
  try { keep.a = document.activeElement.selectionStart; keep.b = document.activeElement.selectionEnd; } catch (_) { /* not a text field */ }
  root.innerHTML = `
  <div class="st-home"><div class="st-home-inner">
    <h2 class="st-title">What should we make?</h2>
    <p class="st-sub">Describe a video and Cognita builds an editable storyboard, then renders it on your device. No render queue and no waiting in line.</p>
    <div class="st-compose">
      <div class="st-modes" role="tablist" aria-label="How to start">${modes.map(([k, ic, l]) => `<button type="button" role="tab" class="st-mode${S.mode === k ? ' is-on' : ''}" data-mode="${k}" aria-selected="${S.mode === k}"><i class="ph ${ic}" aria-hidden="true"></i>${l}</button>`).join('')}</div>
      ${S.mode === 'document' ? `<label class="st-lbl" for="stSource">Paste your text, or load a .txt or .md file</label><textarea id="stSource" class="st-source" rows="5" placeholder="Paste an article, notes or a lesson here">${esc(S.sourceText)}</textarea><div><label class="st-link"><input type="file" id="stDocFile" accept=".txt,.md,text/plain" hidden>Load a text file</label></div>` : ''}
      ${S.mode === 'images' ? `<div class="st-imgrow">${S.pendingImages.map((im, i) => `<div class="st-pimg"><img src="${im.url}" alt="Selected image ${i + 1}"><button type="button" data-rm-img="${i}" aria-label="Remove image ${i + 1}"><i class="ph ph-x"></i></button></div>`).join('')}<label class="st-add"><input type="file" id="stImgFile" accept="image/*" multiple hidden><i class="ph ph-plus"></i><span>Add images</span></label></div>` : ''}
      ${S.mode === 'footage' ? `<div class="st-clips">${S.pendingVideos.map((v, i) => `<div class="st-clip${v.error ? ' is-err' : ''}"><span class="st-clip-th">${v.meta && v.meta.thumb ? `<img src="${v.meta.thumb}" alt="">` : '<i class="ph ph-film-strip"></i>'}</span><span class="st-clip-t"><b>${esc(v.file.name)}</b><small>${v.error ? esc(v.error) : v.meta ? fmt(v.meta.duration) + ' · ' + v.meta.width + '\u00D7' + v.meta.height + (v.meta.hasAudio ? ' · has sound' : ' · no sound') : 'Checking…'}</small></span><button type="button" class="st-icon" data-rm-vid="${i}" aria-label="Remove ${esc(v.file.name)}"><i class="ph ph-x"></i></button></div>`).join('')}<label class="st-add st-add--wide"><input type="file" id="stVidFile" accept="video/*" multiple hidden><i class="ph ph-plus"></i><span>Add clips (up to ${media.MAX_CLIPS}, ${media.maxVideoMB()} MB each)</span></label></div><p class="st-muted st-small">Describe each clip below, for example "Clip 1 is the school gate, clip 2 is assembly". The AI cannot see inside your footage.</p>` : ''}
      <label class="st-lbl st-vh" for="stPrompt">Describe the video</label>
      <textarea id="stPrompt" class="st-prompt" rows="3" placeholder="Describe the video you want to create…">${esc(S.prompt)}</textarea>
      ${S.clarify ? `<div class="st-note" role="status"><i class="ph ph-chat-circle-text"></i><div><strong>One question first</strong><p>${esc(S.clarify)}</p><span>Add your answer to the description above and press Create.</span></div></div>` : ''}
      ${S.error ? `<div class="st-note st-note--err" role="alert"><i class="ph ph-warning-circle"></i><div><strong>Could not create the video</strong><p>${esc(S.error)}</p></div></div>` : ''}
      <div class="st-compose-foot">
        <details class="st-more"><summary><i class="ph ph-sliders-horizontal" aria-hidden="true"></i> Settings</summary><div class="st-grid">
          <label>Format${sel('aspect', [['9:16', 'Vertical 9:16'], ['16:9', 'Landscape 16:9'], ['1:1', 'Square 1:1']])}</label>
          <label>Length${sel('duration', [[20, 'About 20 s'], [30, 'About 30 s'], [45, 'About 45 s'], [60, 'About 1 min'], [90, 'About 1.5 min'], [120, 'About 2 min']])}</label>
          <label>Look${sel('style', [['clean', 'Clean light'], ['dark', 'Dark'], ['bold', 'Bold colour']])}</label>
          <label>Music${sel('music', [['calm', 'Calm'], ['upbeat', 'Upbeat'], ['none', 'None']])}</label>
          <label>Language${sel('language', [['English (Nigeria)', 'English (Nigeria)'], ['English (UK)', 'English (UK)'], ['English (US)', 'English (US)'], ['French', 'French'], ['Yoruba', 'Yoruba (captions only)'], ['Hausa', 'Hausa (captions only)'], ['Igbo', 'Igbo (captions only)']])}</label>
          <label>Subtitles${sel('captions', [[true, 'Show subtitles'], [false, 'No subtitles']])}</label>
          <label>Narration${sel('narrate', narrOptions, ns.allowed ? o.narrate : false)}${!ns.allowed ? `<small class="st-muted">${ns.offline ? 'Offline' : ns.error ? 'Could not check your plan' : 'Narration is part of the Studio plan'}</small>` : ''}</label>
          <label>Pictures${sel('aiImages', [[true, 'AI pictures for up to 4 scenes'], [false, 'Only my own images']])}</label>
        </div></details>
        <button type="button" class="st-btn st-btn--primary" id="stCreate"${S.busy ? ' disabled' : ''}><i class="ph ph-magic-wand"></i>Create video</button>
      </div>
    </div>
    ${renderLibrary()}
  </div></div>`;
  wireHome();
  if (keep.open) { const d = $('details.st-more'); if (d) d.open = true; }
  const h = $('.st-home'); if (h) h.scrollTop = keep.top;
  const f = keep.id ? document.getElementById(keep.id) : (keep.opt ? $('[data-opt="' + keep.opt + '"]') : null);
  if (f && root.contains(f)) { f.focus({ preventScroll: true }); try { if (keep.a != null) f.setSelectionRange(keep.a, keep.b); } catch (_) { /* not a text field */ } }
}

function renderLibrary() {
  if (S.storageOff) return `<div class="st-note"><i class="ph ph-hard-drives"></i><div><strong>Projects cannot be saved here</strong><p>This browser blocks local storage (private mode, for example). You can still create and export, but drafts will not be kept.</p></div></div>`;
  if (!S.projects.length) return `<section class="st-lib" aria-labelledby="stLibH"><h3 id="stLibH" class="st-h">Projects</h3><div class="st-empty"><i class="ph ph-film-slate"></i><p>Nothing here yet. Your videos are saved on this device as drafts, so you can come back and edit them.</p></div></section>`;
  return `<section class="st-lib" aria-labelledby="stLibH"><h3 id="stLibH" class="st-h">Projects <span class="st-muted">Saved on this device</span></h3><div class="st-cards">${S.projects.map((p) => `
    <article class="st-card"><button type="button" class="st-card-main" data-open="${esc(p.id)}" aria-label="Open ${esc(p.title)}">
      <span class="st-thumb" style="aspect-ratio:${p.aspect === '16:9' ? '16/9' : p.aspect === '1:1' ? '1/1' : '9/16'}">${p.thumb ? `<img src="${p.thumb}" alt="">` : '<i class="ph ph-film-slate"></i>'}</span>
      <span class="st-card-t">${esc(p.title)}</span><span class="st-muted">${p.scenes.length} scenes · ${fmt(eng.totalDuration(p))} · ${rel(p.updatedAt || 0)}</span><span class="st-badge">Local draft</span></button>
      <div class="st-card-act"><button type="button" class="st-icon" data-dup="${esc(p.id)}" aria-label="Duplicate ${esc(p.title)}"><i class="ph ph-copy"></i></button><button type="button" class="st-icon" data-del="${esc(p.id)}" aria-label="Delete ${esc(p.title)}"><i class="ph ph-trash"></i></button></div></article>`).join('')}</div></section>`;
}

function wireHome() {
  root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { S.prompt = $('#stPrompt').value; S.mode = b.dataset.mode; render(); }));
  root.querySelectorAll('[data-opt]').forEach((el) => el.addEventListener('change', () => { const k = el.dataset.opt; let v = el.value; if (k === 'duration') v = Number(v); if (['captions', 'aiImages', 'narrate'].includes(k)) v = v === 'true'; S.opts[k] = v; }));
  const p = $('#stPrompt'); p.addEventListener('input', () => { S.prompt = p.value; }); p.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) generate(); });
  const src = $('#stSource'); if (src) src.addEventListener('input', () => { S.sourceText = src.value; });
  const df = $('#stDocFile'); if (df) df.addEventListener('change', async () => { const f = df.files[0]; if (!f) return; if (f.size > 400000) { showToast('That file is too large. Use a text file under 400 KB.'); return; } S.sourceText = await f.text(); render(); });
  const imf = $('#stImgFile'); if (imf) imf.addEventListener('change', () => addPendingImages([...imf.files]));
  const vf = $('#stVidFile'); if (vf) vf.addEventListener('change', () => addPendingVideos([...vf.files]));
  root.querySelectorAll('[data-rm-img]').forEach((b) => b.addEventListener('click', () => { const [r] = S.pendingImages.splice(Number(b.dataset.rmImg), 1); URL.revokeObjectURL(r.url); render(); }));
  root.querySelectorAll('[data-rm-vid]').forEach((b) => b.addEventListener('click', () => { S.pendingVideos.splice(Number(b.dataset.rmVid), 1); render(); }));
  $('#stCreate').addEventListener('click', generate);
  root.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openProject(b.dataset.open)));
  root.querySelectorAll('[data-dup]').forEach((b) => b.addEventListener('click', async () => { await dupProject(b.dataset.dup); }));
  root.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    const p = S.projects.find((x) => x.id === b.dataset.del);
    if (!p || !window.confirm('Delete "' + p.title + '" from this device? This cannot be undone.')) return;
    for (const a of p.assets || []) { try { await store.deleteAsset(a.id); } catch (_) { /* ignore */ } }
    await store.deleteProject(p.id); S.projects = await store.listProjects(); render();
  }));
}
function addPendingImages(files) {
  const ok = files.filter((f) => f.type.startsWith('image/'));
  if (ok.length < files.length) showToast('Some files were skipped. Only image files are supported.');
  ok.slice(0, 12 - S.pendingImages.length).forEach((f) => S.pendingImages.push({ file: f, url: URL.createObjectURL(f) })); render();
}
async function addPendingVideos(files) {
  const room = media.MAX_CLIPS - S.pendingVideos.length;
  if (files.length > room) showToast('Only ' + media.MAX_CLIPS + ' clips fit in one project.');
  const fresh = files.filter((f) => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name)).slice(0, room).map((file) => ({ file, meta: null, error: '' }));
  S.pendingVideos.push(...fresh); render();
  for (const v of fresh) {
    if (v.file.size > media.maxVideoMB() * 1048576) { v.error = 'Too large (' + Math.round(v.file.size / 1048576) + ' MB, limit ' + media.maxVideoMB() + ' MB)'; continue; }
    try { v.meta = await media.probeVideo(v.file); } catch (e) { v.error = e.message || 'Unsupported video'; }
    if (S.screen === 'home') render();
  }
}

async function openProject(id) {
  const p = await store.getProject(id);
  if (!p) { showToast('That project could not be found.'); return; }
  S.project = p; S.selected = 0; S.t = 0; S.history = []; S.future = []; S.assistantLog = []; S.vol = typeof p.vol === 'number' ? p.vol : 0.5;
  p.scenes.forEach((s) => { if (!('transition' in s)) s.transition = 'fade'; if (!s.data) s.data = []; });
  if (!p.lang) { p.lang = nar.langCodeFor(p.language || 'English (Nigeria)'); }
  if (!p.rate) p.rate = 1;
  await loadMedia(p); S._lastSnap = projSnap();
  S.screen = 'editor'; S.pane = 'preview'; S.tab = 'scene'; S.dirty = false; S.saveState = 'saved'; S.notice = '';
  const miss = p.scenes.filter((s) => (s.image && !S.images.has(s.image)) || (s.layout === 'video' && s.video && !(pv && pv.els.get(s.video)))).length;
  render();
  if (miss) showToast(miss + ' scene(s) are missing their picture or clip on this device. Replace them in the Scene tab.');
}
async function dupProject(id) {
  const p = await store.getProject(id); if (!p) return;
  const c = clone(p); c.id = store.uid('prj'); c.title = p.title + ' copy'; c.updatedAt = Date.now(); const map = {};
  for (const a of c.assets || []) { const rec = await store.getAsset(a.id); const nid = store.uid(a.kind === 'video' ? 'vid' : 'img'); map[a.id] = nid; if (rec) await store.putAsset({ ...rec, id: nid }); a.id = nid; }
  c.scenes.forEach((s) => { if (s.image && map[s.image]) s.image = map[s.image]; if (s.video && map[s.video]) s.video = map[s.video]; });
  await store.saveProject(c); S.projects = await store.listProjects(); render(); showToast('Project duplicated');
}

// ───────────── Generate ─────────────
function renderGenerating() {
  root.innerHTML = `<div class="st-home"><div class="st-home-inner st-gen" role="status" aria-live="polite"><h2 class="st-title">Creating your video</h2>
    <ol class="st-steps">${S.stages.map((s, i) => `<li class="${i < S.genStage ? 'is-done' : i === S.genStage ? 'is-now' : ''}"><span class="st-dot" aria-hidden="true">${i < S.genStage ? '<i class="ph ph-check"></i>' : ''}</span><span>${esc(s.label)}${s.detail && i === S.genStage ? `<small class="st-muted"> ${esc(s.detail)}</small>` : ''}</span>${i === S.genStage ? '<span class="st-vh"> (in progress)</span>' : ''}</li>`).join('')}</ol>
    <p class="st-muted">This usually takes under a minute. The storyboard uses one message from your daily allowance.</p></div></div>`;
}
const setStage = (i, detail) => { S.genStage = i; if (S.stages[i]) S.stages[i].detail = detail || ''; renderGenerating(); };

async function generate() {
  if (S.busy) return;
  const prompt = ($('#stPrompt') ? $('#stPrompt').value : S.prompt).trim();
  S.prompt = prompt; S.error = ''; S.clarify = '';
  const fail = (m) => { S.error = m; render(); };
  if (S.mode === 'document' && !S.sourceText.trim() && !prompt) return fail('Paste some text or describe what the video should say.');
  if (S.mode === 'images' && !S.pendingImages.length) return fail('Add at least one image first.');
  if (S.mode === 'footage') {
    if (!S.pendingVideos.length) return fail('Add at least one clip first.');
    if (S.pendingVideos.some((v) => !v.meta && !v.error)) return fail('Still checking your clips. Try again in a moment.');
    if (S.pendingVideos.some((v) => v.error)) return fail('Remove the clips marked with a problem, then try again.');
  }
  if (S.mode === 'prompt' && prompt.length < 8) return fail('Describe the video in a little more detail.');
  const o = S.opts, ns = nStatus(), lang = nar.langCodeFor(o.language);
  const wantNarr = o.narrate && ns.allowed && !!lang && ns.available !== false;
  S.stages = [{ label: 'Writing the storyboard' }, { label: 'Preparing images and clips' }];
  if (wantNarr) S.stages.push({ label: 'Recording narration' });
  S.stages.push({ label: 'Building the preview' });
  S.busy = true; S.screen = 'generating'; setStage(0);
  const warnings = [];
  const newImages = [];
  try {
    const clips = S.mode === 'footage' ? S.pendingVideos.map((v) => ({ name: v.file.name, duration: v.meta.duration })) : [];
    const raw = await sb.generateStoryboard({ prompt, mode: S.mode, options: o, imageCount: S.pendingImages.length, videoClips: clips, sourceText: S.sourceText });
    if (raw.clarify && !(raw.scenes && raw.scenes.length)) { S.clarify = String(raw.clarify).slice(0, 300); S.screen = 'home'; S.busy = false; render(); return; }

    setStage(1, 'Your files');
    const assets = []; const imageIds = []; const videoIds = [];
    for (const im of S.pendingImages) {
      try {
        const d = await eng.downscaleImage(im.file); const id = store.uid('img');
        await store.putAsset({ id, blob: d.blob, name: im.file.name, kind: 'upload' }).catch(() => warnings.push('An image could not be saved to device storage and will be lost when you close this page.'));
        assets.push({ id, name: im.file.name, width: d.width, height: d.height, kind: 'upload' }); imageIds.push(id); newImages.push([id, await eng.decodeImage(d.blob)]);
      } catch (e) { imageIds.push(null); warnings.push('Skipped "' + im.file.name + '": unsupported or unreadable image.'); }
    }
    for (const [i, v] of S.pendingVideos.entries()) {
      setStage(1, 'Clip ' + (i + 1) + ' of ' + S.pendingVideos.length);
      try { const a = await media.ingestVideo(v.file); assets.push(a); videoIds.push(a.id); } catch (e) { videoIds.push(null); warnings.push('Skipped clip "' + v.file.name + '": ' + e.message); }
    }
    const base = { id: store.uid('prj'), createdAt: Date.now(), updatedAt: Date.now(), aspect: o.aspect, style: o.style, music: o.music, captions: o.captions, language: o.language, lang, rate: 1, vol: 0.5, assets };
    const vlist = ns.voices || [];
    const v0 = lang ? (vlist.find((v) => v.lang === lang && v.default) || vlist.find((v) => v.lang === lang)) : null;
    base.voice = v0 ? v0.id : '';
    const project = sb.normaliseProject(raw, base, imageIds, videoIds);
    // The model numbers images and clips by position; map those positions to stored assets.
    (raw.scenes || []).slice(0, project.scenes.length).forEach((rs, i) => {
      const sc = project.scenes[i];
      if (Number.isInteger(rs.imageIndex) && imageIds[rs.imageIndex]) { sc.image = imageIds[rs.imageIndex]; if (rs.layout === 'image') sc.layout = 'image'; }
      if (Number.isInteger(rs.videoIndex) && videoIds[rs.videoIndex] && rs.layout === 'video') { sc.video = videoIds[rs.videoIndex]; sc.layout = 'video'; }
    });
    if (S.mode === 'footage') {
      const used = new Set(project.scenes.filter((s) => s.layout === 'video').map((s) => s.video));
      videoIds.forEach((id, i) => { if (id && !used.has(id)) { const a = assets.find((x) => x.id === id); project.scenes.splice(Math.max(1, project.scenes.length - 1), 0, sb.normaliseScene({ title: a.name.replace(/\.[^.]+$/, '').slice(0, 60), layout: 'video', video: id, duration: 6 }, [], [id])); } });
      project.scenes.forEach((sc) => { if (sc.layout === 'video') { const a = assets.find((x) => x.id === sc.video); if (a) { sc.duration = Math.max(2, Math.min(a.duration, 12)); sc.keepAudio = !!a.hasAudio; } } });
    }
    if (!project.scenes.length) throw new Error('The AI did not return any scenes. Please try again.');
    project.aspect = o.aspect; project.style = o.style; project.captions = o.captions;

    // AI pictures (existing /api/image endpoint, counts toward the daily picture limit)
    S.images = new Map(newImages); S.vthumbs = new Map(); assets.filter((a) => a.kind === 'video').forEach((a) => { if (a.thumb) { const im = new Image(); im.src = a.thumb; S.vthumbs.set(a.id, im); } });
    const wanted = project.scenes.filter((s) => s.layout === 'image' && !s.image && s.imagePrompt).slice(0, 4);
    if (wanted.length && o.aiImages) {
      let stopped = false;
      for (const [i, sc] of wanted.entries()) {
        if (stopped) { sc.layout = 'title'; continue; }
        setStage(1, 'Picture ' + (i + 1) + ' of ' + wanted.length);
        try {
          const d = await media.generateAiImage(sc.imagePrompt); const id = store.uid('img');
          await store.putAsset({ id, blob: d.blob, name: 'AI picture', kind: 'generated' }).catch(() => {});
          project.assets.push({ id, name: 'AI picture: ' + sc.imagePrompt.slice(0, 40), width: d.width, height: d.height, kind: 'generated' });
          S.images.set(id, await eng.decodeImage(d.blob)); sc.image = id;
        } catch (e) { sc.layout = 'title'; warnings.push('A picture could not be made: ' + (e.message || 'unknown error')); if (e.status === 429) stopped = true; }
      }
    } else project.scenes.forEach((s) => { if (s.layout === 'image' && !s.image) s.layout = 'title'; });

    if (pv) pv.dispose(); pv = new media.PreviewVideos(); for (const a of project.assets) if (a.kind === 'video') await pv.load(a.id);
    S.project = project; S.selected = 0; S.t = 0; S.history = []; S.future = []; S.assistantLog = []; S.vol = 0.5; S.buffers = new Map();
    S.pendingImages.forEach((im) => URL.revokeObjectURL(im.url)); S.pendingImages = []; S.pendingVideos = [];

    if (wantNarr && project.voice) {
      const idx = S.stages.findIndex((s) => s.label === 'Recording narration'); setStage(idx, 'Starting');
      const r = await runNarration({ onProgress: (n, m) => setStage(idx, 'Scene ' + n + ' of ' + m) });
      if (r.failed.length || r.stopped) warnings.push('Narration is incomplete: ' + (r.stopped || r.failed[0].message) + ' You can finish it from the Project tab.');
    } else if (o.narrate && !wantNarr) warnings.push(!ns.allowed ? 'Narration needs the Studio plan, so this video has captions and music only.' : !lang ? 'There is no narration voice for ' + o.language + ' yet. Captions and music only.' : 'Narration is not available right now.');

    setStage(S.stages.length - 1);
    S._lastSnap = projSnap(); await save();
    try { S.projects = await store.listProjects(); } catch (_) { /* ignore */ }
    S.notice = warnings.join(' '); S.screen = 'editor'; S.pane = 'preview'; S.tab = 'scene'; S.busy = false; render();
    if (S.notice) showToast(warnings[0]);
  } catch (e) {
    console.error('[studio] generate failed', e);
    S.busy = false; S.screen = 'home'; S.error = e.status === 429 ? 'You have reached your message limit for now. Try again later or upgrade your plan.' : (e.message || 'Something went wrong.'); render();
  }
}

// ───────────── Narration ─────────────
// Records narration for every scene that needs it. Stops early on errors that retrying would not fix.
async function runNarration({ onProgress, only } = {}) {
  const todo = (only || needsNarration());
  const result = { done: 0, failed: [], stopped: '' };
  const ctl = new AbortController(); S.narrJob = { ctl, n: 0, m: todo.length };
  let consecutive = 0;
  try {
    for (const [i, sc] of todo.entries()) {
      if (ctl.signal.aborted) { result.stopped = 'Cancelled.'; break; }
      S.narrJob.n = i + 1; onProgress && onProgress(i + 1, todo.length);
      try {
        const r = await nar.synthesizeScene(S.project, sc, ctl.signal);
        sc.narr = r.narr; S.buffers.set(r.narr.key, await nar.getBuffer(r.narr.key)); result.done++; consecutive = 0;
        if (S.status && S.status.narration && r.left != null) { S.status.narration.charsLeft = r.left; }
      } catch (e) {
        if (e.name === 'AbortError') { result.stopped = 'Cancelled.'; break; }
        result.failed.push({ id: sc.id, message: e.message, code: e.code });
        if (['PLAN_REQUIRED', 'DAILY_LIMIT', 'TTS_NOT_CONFIGURED', 'NO_VOICE'].includes(e.code)) { result.stopped = e.message; break; }
        if (++consecutive >= 2) { result.stopped = e.message; break; }
      }
    }
  } finally { S.narrJob = null; }
  if (result.done) { if (S.screen === 'editor') commit(); else { S._lastSnap = projSnap(); } }
  return result;
}

async function generateNarrationFromUi() {
  const need = needsNarration(); if (!need.length) { showToast('Narration is already up to date.'); return; }
  const ns = nStatus(); const chars = need.reduce((a, s) => a + s.caption.trim().length, 0);
  if (ns.charsLeft != null && chars > ns.charsLeft && !window.confirm('This needs about ' + chars + ' characters but you have ' + ns.charsLeft + ' left today. Narrate as many scenes as fit?')) return;
  pause(); renderProps();
  const r = await runNarration({ onProgress: () => renderProps() });
  renderScenes(); renderTimeline(); renderProps(); drawNow(); $('#stTotal').textContent = fmt(eng.totalDuration(S.project));
  showToast(r.done ? 'Narration ready for ' + r.done + ' scene' + (r.done === 1 ? '' : 's') + (r.stopped || r.failed.length ? '. ' + (r.stopped || r.failed[0].message) : '.') : (r.stopped || (r.failed[0] && r.failed[0].message) || 'No narration was created.'));
  refreshStatus();
}

// ───────────── Editor ─────────────
function renderEditor() {
  const p = S.project;
  root.innerHTML = `
  ${S.notice ? `<div class="st-banner" role="status"><i class="ph ph-info"></i><span>${esc(S.notice)}</span><button type="button" class="st-icon" id="stBannerX" aria-label="Dismiss"><i class="ph ph-x"></i></button></div>` : ''}
  <div class="st-ed" data-pane="${S.pane}">
    <div class="st-bar">
      <button type="button" class="st-btn st-btn--ghost" id="stBack" aria-label="Back to Studio home"><i class="ph ph-arrow-left"></i><span class="st-hide-s">Studio</span></button>
      <input class="st-name" id="stName" value="${esc(p.title)}" aria-label="Project title" maxlength="80">
      <span class="st-status" id="stStatus" role="status" aria-live="polite"></span>
      <div class="st-bar-act">
        <button type="button" class="st-icon" id="stUndo" aria-label="Undo"><i class="ph ph-arrow-counter-clockwise"></i></button>
        <button type="button" class="st-icon" id="stRedo" aria-label="Redo"><i class="ph ph-arrow-clockwise"></i></button>
        <button type="button" class="st-btn st-btn--primary" id="stExport" aria-label="Export video"><i class="ph ph-export"></i><span>Export</span></button>
      </div>
    </div>
    <aside class="st-left" aria-label="Scenes"><div class="st-panel-h"><span>Scenes</span><button type="button" class="st-icon" id="stAddScene" aria-label="Add scene"><i class="ph ph-plus"></i></button></div><ol class="st-scenes" id="stScenes"></ol></aside>
    <section class="st-center" aria-label="Preview">
      <div class="st-stage"><div class="st-frame" id="stFrame" style="aspect-ratio:${p.aspect.replace(':', '/')}"><canvas id="stCanvas" aria-label="Video preview"></canvas></div></div>
      <div class="st-ctl">
        <button type="button" class="st-icon st-play" id="stPlay" aria-label="Play"><i class="ph ph-play"></i></button>
        <span class="st-time" id="stTime">0:00</span><input type="range" id="stSeek" min="0" max="1000" value="0" aria-label="Playback position"><span class="st-time" id="stTotal">${fmt(eng.totalDuration(p))}</span>
        <button type="button" class="st-icon" id="stFull" aria-label="Full screen preview"><i class="ph ph-corners-out"></i></button>
      </div>
      <div class="st-timeline" id="stTimeline" aria-label="Timeline"></div>
    </section>
    <aside class="st-right" aria-label="Edit"><div class="st-tabs" role="tablist">${[['scene', 'Scene'], ['project', 'Project'], ['ai', 'Assistant']].map(([k, l]) => `<button type="button" role="tab" class="st-tab${S.tab === k ? ' is-on' : ''}" data-tab="${k}" aria-selected="${S.tab === k}">${l}</button>`).join('')}</div><div class="st-props" id="stProps"></div></aside>
    <nav class="st-mnav" aria-label="Editor sections">${[['scenes', 'ph-rows', 'Scenes'], ['preview', 'ph-play-circle', 'Preview'], ['edit', 'ph-sliders-horizontal', 'Edit']].map(([k, ic, l]) => `<button type="button" data-pane="${k}" class="${S.pane === k ? 'is-on' : ''}"><i class="ph ${ic}"></i>${l}</button>`).join('')}</nav>
  </div>
  <div class="st-modal" id="stModal" hidden></div>`;
  canvas = $('#stCanvas'); ctx = canvas.getContext('2d');
  sizeCanvas(); wireEditor(); renderScenes(); renderProps(); renderTimeline(); renderStatus(); drawNow();
}
function sizeCanvas() { const { width, height } = eng.dimsFor(S.project.aspect, isMobile() ? 540 : 720); canvas.width = width; canvas.height = height; }

function wireEditor() {
  $('#stBack').addEventListener('click', async () => { pause(); if (S.dirty) await save(); S.projects = await store.listProjects().catch(() => S.projects); S.screen = 'home'; render(); });
  $('#stName').addEventListener('change', (e) => { S.project.title = e.target.value.trim() || 'Untitled video'; commit(); });
  $('#stUndo').addEventListener('click', undo); $('#stRedo').addEventListener('click', redo);
  $('#stExport').addEventListener('click', openExport);
  $('#stAddScene').addEventListener('click', () => addScene());
  const bx = $('#stBannerX'); if (bx) bx.addEventListener('click', () => { S.notice = ''; renderEditor(); });
  $('#stPlay').addEventListener('click', () => (S.playing ? pause() : play()));
  $('#stSeek').addEventListener('input', (e) => { const T = eng.totalDuration(S.project); S.t = (Number(e.target.value) / 1000) * T; spokenScene = -1; syncSelected(); drawNow(); if (S.playing) startAudio(); });
  $('#stFull').addEventListener('click', () => { const f = $('#stFrame'); (f.requestFullscreen || f.webkitRequestFullscreen || (() => showToast('Full screen is not supported on this device.'))).call(f); });
  root.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => { S.tab = b.dataset.tab; if (isMobile()) S.pane = 'edit'; renderEditor(); }));
  root.querySelectorAll('.st-mnav [data-pane]').forEach((b) => b.addEventListener('click', () => { S.pane = b.dataset.pane; $('.st-ed').dataset.pane = S.pane; root.querySelectorAll('.st-mnav button').forEach((x) => x.classList.toggle('is-on', x === b)); if (S.pane === 'preview') drawNow(); }));
}
function onKey(e) {
  if (!mounted || S.screen !== 'editor' || document.getElementById('view-studio').hidden) return;
  const tag = (e.target.tagName || '').toLowerCase(); if (['input', 'textarea', 'select'].includes(tag)) return;
  const m = $('#stModal'); if (m && !m.hidden) return;
  if (e.key === ' ' && (['button', 'a', 'summary'].includes(tag) || e.target.isContentEditable)) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if (e.key === ' ') { e.preventDefault(); S.playing ? pause() : play(); }
}

function renderScenes() {
  const ul = $('#stScenes'); if (!ul) return;
  ul.innerHTML = S.project.scenes.map((s, i) => { const st = narrState(s); return `<li class="st-scene${i === S.selected ? ' is-on' : ''}"><button type="button" class="st-scene-main" data-sel="${i}" aria-current="${i === S.selected}" aria-label="Scene ${i + 1}: ${esc(s.title || 'Untitled')}, ${fixed(dur(s))} seconds">
    <canvas class="st-sthumb" data-thumb="${i}"></canvas><span class="st-scene-t"><span><b>${i + 1}</b> ${esc(s.title || 'Untitled')}</span><small>${fixed(dur(s))}s · ${esc(s.layout)}${st === 'ready' ? ' · <i class="ph ph-microphone" aria-label="Narrated"></i>' : st === 'outdated' ? ' · narration outdated' : ''}</small></span></button></li>`; }).join('');
  ul.querySelectorAll('[data-sel]').forEach((b) => b.addEventListener('click', () => { selectScene(Number(b.dataset.sel), true); if (isMobile()) { S.pane = 'preview'; $('.st-ed').dataset.pane = 'preview'; root.querySelectorAll('.st-mnav button').forEach((x) => x.classList.toggle('is-on', x.dataset.pane === 'preview')); drawNow(); } }));
  scheduleThumbs(true);
}
function scheduleThumbs(now) { clearTimeout(thumbTimer); thumbTimer = setTimeout(drawThumbs, now ? 0 : 400); }
function drawThumbs() {
  if (!root || S.screen !== 'editor') return;
  root.querySelectorAll('canvas[data-thumb]').forEach((c) => {
    const i = Number(c.dataset.thumb); const s = S.project.scenes[i]; if (!s) return;
    const { width, height } = eng.dimsFor(S.project.aspect, 72); c.width = width; c.height = height;
    const st = eng.sceneStart(S.project, i);
    eng.drawFrame(c.getContext('2d'), width, height, S.project, eng.settleTime(S.project, st), S.images, thumbFrames);
  });
}
function selectScene(i, seek) {
  S.selected = Math.max(0, Math.min(i, S.project.scenes.length - 1));
  if (seek) { S.t = eng.sceneStart(S.project, S.selected); spokenScene = -1; if (S.playing) startAudio(); }
  renderScenes(); renderProps(); renderTimeline(); drawNow();
}
function syncSelected() { const { index } = eng.sceneAt(S.project, S.t); if (index !== S.selected) { S.selected = index; renderScenes(); renderProps(); renderTimeline(); } }
function addScene() { const s = sb.normaliseScene({ title: 'New scene', layout: 'title', text: 'Add your message here', duration: 5 }); S.project.scenes.splice(S.selected + 1, 0, s); commit(); S.selected += 1; renderEditor(); }

function renderTimeline() {
  const el = $('#stTimeline'); if (!el) return;
  const p = S.project;
  const narrN = p.scenes.filter((s) => narrState(s) === 'ready').length;
  el.innerHTML = `<div class="st-track" role="list">${p.scenes.map((s, i) => `<button type="button" role="listitem" class="st-block${i === S.selected ? ' is-on' : ''}" style="flex:${dur(s)} 1 0" data-sel="${i}" aria-label="Scene ${i + 1}, ${fixed(dur(s))} seconds"><span>${i + 1}</span></button>`).join('')}<i class="st-head" id="stHead"></i></div>
  <div class="st-track st-track--aud"><span class="st-lane">${narrN ? 'Narration: ' + narrN + ' of ' + p.scenes.filter((s) => (s.caption || '').trim()).length + ' scenes' : 'No narration'}</span></div>
  <div class="st-track st-track--aud"><span class="st-lane">${p.music !== 'none' ? 'Music: ' + p.music + ' (synthesised)' : 'No music'}${p.captions ? ' · Subtitles on' : ''}</span></div>`;
  el.querySelectorAll('[data-sel]').forEach((b) => b.addEventListener('click', () => selectScene(Number(b.dataset.sel), true)));
  updateHead();
}
function updateHead() { const h = $('#stHead'); if (!h) return; h.style.left = (S.t / (eng.totalDuration(S.project) || 1)) * 100 + '%'; }

// ── properties ──
function narrChip(s) {
  const st = narrState(s);
  if (st === 'none') return '<span class="st-chip-s">No caption to narrate</span>';
  const map = { ready: ['ph-check-circle', 'Narration ready, ' + fixed(s.narr && s.narr.dur) + ' s' + (s.narr && s.narr.engine === 'workers-ai' ? ' (backup voice)' : '')], outdated: ['ph-warning', 'Narration outdated, regenerate it'], missing: ['ph-microphone-slash', 'Narration not generated'] };
  return `<span class="st-chip-s st-chip-s--${st}"><i class="ph ${map[st][0]}"></i>${map[st][1]}</span>`;
}
function renderProps() {
  const el = $('#stProps'); if (!el) return;
  if (S.tab === 'project') return renderProjectProps(el);
  if (S.tab === 'ai') return renderAssistant(el);
  const s = S.project.scenes[S.selected]; const p = S.project;
  const imgAssets = (p.assets || []).filter((a) => a.kind !== 'video'); const vidAssets = (p.assets || []).filter((a) => a.kind === 'video');
  const missingImg = s.image && !S.images.has(s.image); const vAsset = s.video ? assetOf(s.video) : null; const missingVid = s.layout === 'video' && s.video && !(pv && pv.els.get(s.video));
  const narrMin = eng.validNarr(p, s) ? s.narr.dur + eng.NARR_LEAD + eng.NARR_TAIL : 0; const ns = nStatus();
  const lay = (l) => `<option value="${l}"${l === s.layout ? ' selected' : ''}${(l === 'video' && !vidAssets.length) ? ' disabled' : ''}>${l}</option>`;
  el.innerHTML = `
  <div class="st-field"><label for="pTitle">Headline</label><input id="pTitle" value="${esc(s.title)}" maxlength="90"></div>
  <div class="st-field"><label for="pText">Supporting text</label><textarea id="pText" rows="2" maxlength="220">${esc(s.text)}</textarea></div>
  <div class="st-field"><label for="pCap">Caption and narration script</label><textarea id="pCap" rows="3" maxlength="240">${esc(s.caption)}</textarea>${narrChip(s)}
    ${ns.allowed && narrState(s) !== 'none' ? `<div class="st-inline"><button type="button" class="st-link" id="nGen">${s.narr ? 'Regenerate' : 'Generate'} narration for this scene</button>${s.narr ? '<button type="button" class="st-link" id="nPlay">Play</button><button type="button" class="st-link" id="nDel">Remove</button>' : ''}</div>` : ''}</div>
  <div class="st-row2"><div class="st-field"><label for="pLay">Layout</label><select id="pLay">${sb.LAYOUTS.map(lay).join('')}</select></div>
    <div class="st-field"><label for="pAnim">Animation</label><select id="pAnim">${sb.ANIMS.map((l) => `<option${l === s.anim ? ' selected' : ''}>${l}</option>`).join('')}</select></div></div>
  <div class="st-field"><label for="pTr">Transition into this scene</label><select id="pTr"${S.selected === 0 ? ' disabled' : ''}>${sb.TRANSITIONS.map((l) => `<option${l === s.transition ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
  ${s.layout === 'bullets' ? `<div class="st-field"><label for="pBul">Bullet points (one per line)</label><textarea id="pBul" rows="4">${esc(s.bullets.join('\n'))}</textarea></div>` : ''}
  ${s.layout === 'stat' ? `<div class="st-field"><label for="pStat">Number</label><input id="pStat" value="${esc(s.stat)}" maxlength="24" placeholder="e.g. 85% or 12,000"></div>` : ''}
  ${s.layout === 'chart' ? `<div class="st-field"><label for="pData">Chart rows (label: value, one per line, 2 to 6)</label><textarea id="pData" rows="5">${esc((s.data || []).map((r) => r.label + ': ' + r.value).join('\n'))}</textarea></div>` : ''}
  ${s.layout === 'video' ? `<div class="st-field"><label>Clip</label>${missingVid ? '<p class="st-warn"><i class="ph ph-warning"></i>This clip is missing from this device. Choose another.</p>' : ''}
    <div class="st-imgpick">${vidAssets.map((a) => `<button type="button" class="st-imgbtn${s.video === a.id ? ' is-on' : ''}" data-vid="${esc(a.id)}" aria-label="Use clip ${esc(a.name)}" aria-pressed="${s.video === a.id}">${a.thumb ? `<img src="${a.thumb}" alt="">` : '<i class="ph ph-film-strip"></i>'}</button>`).join('')}<label class="st-add st-add--sm"><input type="file" id="pVidUp" accept="video/*" hidden><i class="ph ph-upload-simple"></i><span>Add</span></label></div>
    ${vAsset ? `<div class="st-field"><label for="pTrim">Start at: <output id="pTrimO">${fixed(s.trimStart || 0)}</output> s of ${fixed(vAsset.duration)} s</label><input type="range" id="pTrim" min="0" max="${Math.max(0, Math.floor((vAsset.duration - 1) * 10) / 10)}" step="0.1" value="${s.trimStart || 0}"></div>
    <label class="st-check"><input type="checkbox" id="pKeep"${s.keepAudio ? ' checked' : ''}${vAsset.hasAudio ? '' : ' disabled'}> Keep the clip's own sound${vAsset.hasAudio ? '' : ' (this clip has none)'}</label>` : ''}</div>` : ''}
  <div class="st-field"><label for="pDur">Length: <output id="pDurO">${fixed(s.duration)}</output> s</label><input type="range" id="pDur" min="2" max="20" step="0.5" value="${s.duration}">${narrMin > s.duration ? `<small>This scene runs ${fixed(narrMin)} s so its narration is not cut off.</small>` : ''}</div>
  <div class="st-field"><label for="pBg">Background colour</label><div class="st-colorrow"><input type="color" id="pBg" value="${s.bg || '#f8f7f4'}"><button type="button" class="st-link" id="pBgReset"${s.bg ? '' : ' disabled'}>Use theme colour</button></div></div>
  <div class="st-field"><label>Picture</label>${missingImg ? '<p class="st-warn"><i class="ph ph-warning"></i>This scene\'s picture is missing from this device.</p>' : ''}
    <div class="st-imgpick">${imgAssets.map((a) => `<button type="button" class="st-imgbtn${s.image === a.id ? ' is-on' : ''}" data-img="${esc(a.id)}" aria-label="Use ${esc(a.name)} (${a.kind === 'generated' ? 'AI-generated' : 'uploaded'})" aria-pressed="${s.image === a.id}">${S.images.has(a.id) ? `<canvas data-ic="${esc(a.id)}"></canvas>` : '<i class="ph ph-image-broken"></i>'}${a.kind === 'generated' ? '<span class="st-ai">AI</span>' : ''}</button>`).join('')}
    <label class="st-add st-add--sm"><input type="file" id="pUp" accept="image/*" hidden><i class="ph ph-upload-simple"></i><span>Upload</span></label>${s.image ? '<button type="button" class="st-link" id="pImgClear">Remove picture</button>' : ''}</div>
    <textarea id="pImgPrompt" rows="2" maxlength="300" placeholder="Describe a picture to generate with AI">${esc(s.imagePrompt || '')}</textarea>
    <div class="st-inline"><button type="button" class="st-btn" id="pImgGen"><i class="ph ph-sparkle"></i>Generate picture</button><small class="st-muted">Uses your daily picture allowance</small></div></div>
  <div class="st-actions"><button type="button" class="st-btn" id="sUp"${S.selected === 0 ? ' disabled' : ''}><i class="ph ph-arrow-up"></i>Move up</button><button type="button" class="st-btn" id="sDown"${S.selected === p.scenes.length - 1 ? ' disabled' : ''}><i class="ph ph-arrow-down"></i>Move down</button><button type="button" class="st-btn" id="sDup"><i class="ph ph-copy"></i>Duplicate</button><button type="button" class="st-btn st-btn--danger" id="sDel"${p.scenes.length < 2 ? ' disabled' : ''}><i class="ph ph-trash"></i>Delete</button></div>`;
  el.querySelectorAll('canvas[data-ic]').forEach((c) => { const im = S.images.get(c.dataset.ic); c.width = 56; c.height = 56; const x = c.getContext('2d'); const k = Math.max(56 / im.width, 56 / im.height); x.drawImage(im, (56 - im.width * k) / 2, (56 - im.height * k) / 2, im.width * k, im.height * k); });
  const bind = (id, fn, ev = 'change') => { const n = $('#' + id, el); if (n) n.addEventListener(ev, fn); };
  const done = () => { renderScenes(); renderTimeline(); drawNow(); $('#stTotal').textContent = fmt(eng.totalDuration(p)); };
  const upd = (patch) => { Object.assign(s, patch); commit(); done(); };
  const live = (patch) => { Object.assign(s, patch); markDirty(); drawNow(); };
  bind('pTitle', (e) => upd({ title: e.target.value.trim() })); bind('pTitle', (e) => live({ title: e.target.value }), 'input');
  bind('pText', (e) => upd({ text: e.target.value.trim() })); bind('pText', (e) => live({ text: e.target.value }), 'input');
  bind('pCap', (e) => { upd({ caption: e.target.value.trim() }); renderProps(); }); bind('pCap', (e) => live({ caption: e.target.value }), 'input');
  bind('pLay', (e) => {
    const l = e.target.value; const patch = { layout: l };
    if (l === 'chart' && (s.data || []).length < 2) patch.data = [{ label: 'First', value: 30 }, { label: 'Second', value: 60 }];
    if (l === 'bullets' && !s.bullets.length && s.text) patch.bullets = [s.text];
    if (l === 'video' && !s.video && vidAssets[0]) patch.video = vidAssets[0].id;
    upd(patch); renderProps();
  });
  bind('pAnim', (e) => upd({ anim: e.target.value })); bind('pTr', (e) => upd({ transition: e.target.value }));
  bind('pBul', (e) => upd({ bullets: e.target.value.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 5) }));
  bind('pStat', (e) => upd({ stat: e.target.value.trim() }));
  bind('pData', (e) => { const rows = e.target.value.split('\n').map((l) => { const i = l.lastIndexOf(':'); if (i < 1) return null; const num = l.slice(i + 1).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/); const v = num ? Number(num[0]) : NaN; return l.slice(0, i).trim() && Number.isFinite(v) ? { label: l.slice(0, i).trim().slice(0, 30), value: v } : null; }).filter(Boolean).slice(0, 6); if (rows.length < 2) { showToast('Add at least two rows like "Term 1: 72".'); return; } upd({ data: rows }); e.target.value = rows.map((r) => r.label + ': ' + r.value).join('\n'); });
  bind('pDur', (e) => { s.duration = Number(e.target.value); $('#pDurO', el).textContent = fixed(s.duration); markDirty(); drawNow(); renderTimeline(); $('#stTotal').textContent = fmt(eng.totalDuration(p)); }, 'input'); bind('pDur', () => { commit(); renderScenes(); renderProps(); });
  bind('pBg', (e) => { s.bg = e.target.value; markDirty(); drawNow(); }, 'input'); bind('pBg', () => { commit(); renderProps(); }); bind('pBgReset', () => { s.bg = ''; commit(); renderProps(); drawNow(); }, 'click');
  bind('pImgClear', () => { s.image = null; if (s.layout === 'image') s.layout = 'title'; commit(); renderEditor(); }, 'click');
  el.querySelectorAll('[data-img]').forEach((b) => b.addEventListener('click', () => { s.image = b.dataset.img; if (s.layout === 'title') s.layout = 'image'; commit(); renderEditor(); }));
  el.querySelectorAll('[data-vid]').forEach((b) => b.addEventListener('click', () => { s.video = b.dataset.vid; s.trimStart = 0; commit(); renderEditor(); }));
  bind('pUp', async (e) => { const f = e.target.files[0]; if (f) await uploadImage(f, s); });
  bind('pVidUp', async (e) => { const f = e.target.files[0]; if (f) await uploadVideo(f, s); });
  bind('pTrim', (e) => { s.trimStart = Number(e.target.value); $('#pTrimO', el).textContent = fixed(s.trimStart); if (pv) pv.sync(s, 0, false); markDirty(); drawNow(); }, 'input'); bind('pTrim', () => commit());
  bind('pKeep', (e) => upd({ keepAudio: e.target.checked }));
  bind('pImgGen', () => genPicture(s, $('#pImgPrompt', el).value.trim() || s.title), 'click');
  bind('pImgPrompt', (e) => { s.imagePrompt = e.target.value.trim(); markDirty(); });
  bind('nGen', async () => { pause(); const r = await runNarration({ only: [s], onProgress: () => {} }); done(); renderProps(); if (r.failed.length || r.stopped) showToast(r.stopped || r.failed[0].message); refreshStatus(); }, 'click');
  bind('nPlay', () => { const b = S.buffers.get(s.narr.key); if (b) previewClip(b); else showToast('This narration is not stored on this device. Regenerate it.'); }, 'click');
  bind('nDel', () => { s.narr = null; commit(); done(); renderProps(); }, 'click');
  bind('sUp', () => moveScene(-1), 'click'); bind('sDown', () => moveScene(1), 'click');
  bind('sDup', () => { const c = clone(s); c.id = store.uid('sc'); S.project.scenes.splice(S.selected + 1, 0, c); commit(); S.selected++; renderEditor(); }, 'click');
  bind('sDel', () => { S.project.scenes.splice(S.selected, 1); commit(); S.selected = Math.max(0, S.selected - 1); renderEditor(); showToast('Scene deleted. Use Undo to restore it.'); }, 'click');
}
function moveScene(d) { const a = S.project.scenes; const j = S.selected + d; if (j < 0 || j >= a.length) return; [a[S.selected], a[j]] = [a[j], a[S.selected]]; commit(); S.selected = j; renderEditor(); }

function previewClip(buf) {
  try { const AC = eng.audioContextClass(); const c = new AC(); const src = c.createBufferSource(); src.buffer = buf; src.connect(c.destination); src.onended = () => c.close(); src.start(); } catch (_) { showToast('Audio playback is not available.'); }
}
async function uploadImage(file, scene) {
  if (!file.type.startsWith('image/')) { showToast('Unsupported file. Choose an image.'); return; }
  try {
    const d = await eng.downscaleImage(file); const id = store.uid('img');
    try { await store.putAsset({ id, blob: d.blob, name: file.name, kind: 'upload' }); } catch (_) { showToast('This image could not be saved to device storage. It will work until you close the page.'); }
    S.images.set(id, await eng.decodeImage(d.blob)); S.project.assets.push({ id, name: file.name, width: d.width, height: d.height, kind: 'upload' });
    scene.image = id; if (scene.layout === 'title') scene.layout = 'image'; commit(); renderEditor();
  } catch (e) { showToast('That image format is not supported on this device.'); }
}
async function uploadVideo(file, scene) {
  showToast('Checking clip…');
  try {
    const a = await media.ingestVideo(file);
    if (a.thumb) { const im = new Image(); im.src = a.thumb; S.vthumbs.set(a.id, im); } await pv.load(a.id);
    S.project.assets.push(a); scene.video = a.id; scene.layout = 'video'; scene.trimStart = 0; scene.keepAudio = !!a.hasAudio; scene.duration = Math.max(2, Math.min(a.duration, 12)); commit(); renderEditor();
  } catch (e) { showToast(e.message || 'That video could not be used.'); }
}
async function genPicture(scene, prompt) {
  const b = $('#pImgGen'); if (b) { b.disabled = true; b.textContent = 'Generating…'; }
  try {
    const d = await media.generateAiImage(prompt); const id = store.uid('img');
    await store.putAsset({ id, blob: d.blob, name: 'AI picture', kind: 'generated' }).catch(() => showToast('The picture could not be saved to device storage and will be lost when you close this page.'));
    S.images.set(id, await eng.decodeImage(d.blob)); S.project.assets.push({ id, name: 'AI picture: ' + prompt.slice(0, 40), width: d.width, height: d.height, kind: 'generated' });
    scene.image = id; scene.imagePrompt = prompt; if (scene.layout === 'title') scene.layout = 'image'; commit(); renderEditor();
  } catch (e) { showToast(e.status === 429 ? e.message : (e.message || 'Could not generate the picture.')); renderProps(); }
}

// project tab
function renderProjectProps(el) {
  const p = S.project, ns = nStatus(), lc = langCode(); const sup = exp.exportSupport();
  const voices = (ns.voices || []).filter((v) => v.lang === lc); const need = needsNarration(); const chars = need.reduce((a, s) => a + s.caption.trim().length, 0);
  let narrBlock;
  if (S.narrJob) narrBlock = `<div class="st-card-s"><strong>Recording narration</strong><p>Scene ${S.narrJob.n} of ${S.narrJob.m}</p><div class="st-prog"><i style="width:${Math.round(((S.narrJob.n - 1) / S.narrJob.m) * 100)}%"></i></div><button type="button" class="st-btn" id="nCancel">Cancel</button></div>`;
  else if (!ns.allowed) narrBlock = `<div class="st-card-s"><strong>Narration</strong><p>${ns.offline ? 'You are offline, so narration cannot be checked.' : ns.error ? 'Could not check your plan right now.' : 'Spoken narration in exported videos is part of the Cognita Studio plan. Captions, music and the browser-voice preview stay free.'}</p>${ns.offline || ns.error ? '<button type="button" class="st-btn" id="nRetry">Check again</button>' : `<a class="st-btn st-btn--primary" href="${STUDIO_PLAN_URL}">See plans</a>`}</div>`;
  else if (!lc || !voices.length) narrBlock = `<div class="st-card-s"><strong>Narration</strong><p>There is no narration voice for ${esc(p.language || 'this language')} yet. Captions and music still work.</p></div>`;
  else narrBlock = `<div class="st-card-s"><strong>Narration</strong>
    <div class="st-row2"><div class="st-field"><label for="nVoice">Voice</label><select id="nVoice">${voices.map((v) => `<option value="${v.id}"${v.id === p.voice ? ' selected' : ''}>${esc(v.name)} (${v.gender})</option>`).join('')}</select></div>
    <div class="st-field"><label for="nRate">Speed</label><select id="nRate">${[[0.9, 'Slower'], [1, 'Normal'], [1.1, 'Faster']].map(([v, l]) => `<option value="${v}"${(p.rate || 1) === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div></div>
    <p class="st-muted st-small">${need.length ? need.length + ' scene' + (need.length === 1 ? '' : 's') + ' need narration, about ' + chars + ' characters.' : 'Every scene with a caption has narration.'} ${ns.charsLeft != null ? ns.charsLeft + ' characters left today.' : 'No daily limit on your account.'} Changing the voice or speed makes existing narration outdated.</p>
    <button type="button" class="st-btn st-btn--primary" id="nAll"${need.length ? '' : ' disabled'}><i class="ph ph-microphone"></i>${p.scenes.some((s) => s.narr) ? 'Generate missing and outdated' : 'Generate narration'}</button>
    ${ns.engines && !ns.engines.edge && ns.engines.workersAi ? '<p class="st-muted st-small">The main voice service is off, so the backup voice is used. It has no speed control.</p>' : ''}</div>`;
  el.innerHTML = `${narrBlock}
  <div class="st-field"><label for="gAsp">Format</label><select id="gAsp">${sb.ASPECTS.map((a) => `<option${a === p.aspect ? ' selected' : ''}>${a}</option>`).join('')}</select></div>
  <div class="st-field"><label for="gSty">Look</label><select id="gSty">${sb.STYLES.map((a) => `<option value="${a}"${a === p.style ? ' selected' : ''}>${{ clean: 'Clean light', dark: 'Dark', bold: 'Bold colour' }[a]}</option>`).join('')}</select></div>
  <div class="st-field"><label for="gMus">Background music</label><select id="gMus">${sb.MUSIC.map((a) => `<option${a === p.music ? ' selected' : ''}>${a}</option>`).join('')}</select><small>Music is generated in your browser and lowers itself under narration.</small></div>
  <div class="st-field"><label for="gVol">Music volume</label><input type="range" id="gVol" min="0" max="100" value="${Math.round(S.vol * 100)}"></div>
  <label class="st-check"><input type="checkbox" id="gCap"${p.captions ? ' checked' : ''}> Show subtitles</label>
  <label class="st-check"><input type="checkbox" id="gNar"${S.narrate ? ' checked' : ''}${eng.browserVoice.supported() ? '' : ' disabled'}> Browser voice for scenes without narration (preview only)</label>
  ${sup.ok ? `<p class="st-muted st-small">${sup.engine === 'webcodecs' ? 'Export uses WebCodecs: fast, frame-exact, and not tied to real time.' : 'This browser exports in compatibility mode, in real time.'}</p>` : `<p class="st-warn"><i class="ph ph-warning"></i>${esc(sup.reason)}</p>`}`;
  const b = (id, fn, ev = 'change') => { const n = $('#' + id, el); if (n) n.addEventListener(ev, fn); };
  b('nVoice', (e) => { p.voice = e.target.value; commit(); renderScenes(); renderTimeline(); renderProps(); }); b('nRate', (e) => { p.rate = Number(e.target.value); commit(); renderScenes(); renderTimeline(); renderProps(); });
  b('nAll', generateNarrationFromUi, 'click'); b('nCancel', () => S.narrJob && S.narrJob.ctl.abort(), 'click'); b('nRetry', refreshStatus, 'click');
  b('gAsp', (e) => { p.aspect = e.target.value; commit(); renderEditor(); }); b('gSty', (e) => { p.style = e.target.value; commit(); renderScenes(); drawNow(); });
  b('gMus', (e) => { p.music = e.target.value; commit(); renderTimeline(); if (S.playing) startAudio(); });
  b('gVol', (e) => { S.vol = Number(e.target.value) / 100; markDirty(); if (S.playing) startAudio(); }, 'input');
  b('gCap', (e) => { p.captions = e.target.checked; commit(); renderTimeline(); drawNow(); scheduleThumbs(true); });
  b('gNar', (e) => { S.narrate = e.target.checked; if (!S.narrate) eng.browserVoice.stop(); });
}

// assistant
function renderAssistant(el) {
  el.innerHTML = `<p class="st-muted st-small">Ask for a change in plain words. Changes are applied to the project and can be undone. Each request uses one message from your daily allowance.</p>
  <div class="st-chips">${['Make the intro shorter', 'Use the dark look', 'Make every scene 4 seconds', 'Switch to vertical format', 'Use slide transitions'].map((t) => `<button type="button" class="st-chip" data-chip="${esc(t)}">${esc(t)}</button>`).join('')}</div>
  <div class="st-log" id="stLog" aria-live="polite">${S.assistantLog.map((m) => `<div class="st-msg st-msg--${m.k}">${esc(m.t)}</div>`).join('')}</div>
  <div class="st-ask"><textarea id="stAsk" rows="2" placeholder="e.g. Add a chart scene about pass rates" aria-label="Edit instruction">${esc(S.askDraft || '')}</textarea><button type="button" class="st-btn st-btn--primary" id="stAskGo"${S.busy ? ' disabled' : ''}>Apply</button></div>`;
  el.querySelectorAll('[data-chip]').forEach((c) => c.addEventListener('click', () => { $('#stAsk', el).value = c.dataset.chip; }));
  $('#stAsk', el).addEventListener('input', (e) => { S.askDraft = e.target.value; });
  $('#stAskGo', el).addEventListener('click', runAssistant);
  $('#stAsk', el).addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runAssistant(); } });
}
async function runAssistant() {
  const ta = $('#stAsk'); const text = ta.value.trim(); if (!text || S.busy) return;
  S.assistantLog.push({ k: 'u', t: text }); S.busy = true; ta.value = ''; S.askDraft = ''; S.assistantLog.push({ k: 'w', t: 'Working on it…' }); renderProps();
  try {
    const r = await sb.editProject(S.project, text, (S.project.assets || []).filter((a) => a.kind !== 'video').map((a) => a.id), (S.project.assets || []).filter((a) => a.kind === 'video').map((a) => a.id));
    S.assistantLog.pop();
    if (r.unsupported) S.assistantLog.push({ k: 'a', t: 'This cannot be done yet. ' + r.unsupported });
    else {
      const prev = S.project.aspect; commit();
      const keep = S.project.assets; Object.assign(S.project, r.project, { assets: keep }); S._lastSnap = projSnap();
      S.selected = Math.min(S.selected, S.project.scenes.length - 1); markDirty();
      const outdated = needsNarration().filter((s) => s.narr).length;
      S.assistantLog.push({ k: 'a', t: r.summary + ' You can undo this from the top bar.' + (outdated ? ' ' + outdated + ' scene(s) have new captions, so regenerate their narration in the Project tab.' : '') });
      S.busy = false;
      if (prev !== S.project.aspect) renderEditor(); else { renderScenes(); renderTimeline(); drawNow(); $('#stTotal').textContent = fmt(eng.totalDuration(S.project)); }
    }
  } catch (e) { S.assistantLog.pop(); S.assistantLog.push({ k: 'e', t: e.message || 'The edit failed.' }); }
  S.busy = false; if (S.screen === 'editor') { renderStatus(); renderProps(); }
}
function renderStatus() {
  const el = $('#stStatus'); if (!el) return;
  const map = { saved: ['ph-check-circle', 'Saved on this device'], saving: ['ph-circle-notch', 'Saving…'], unsaved: ['ph-dot-outline', 'Unsaved changes'], failed: ['ph-warning', 'Could not save'] };
  const [ic, tx] = map[S.saveState] || map.saved;
  el.innerHTML = `<i class="ph ${ic}" aria-hidden="true"></i><span>${tx}${navigator.onLine ? '' : ' · Offline'}</span>`;
  const u = $('#stUndo'), r = $('#stRedo'); if (u) u.disabled = !S.history.length; if (r) r.disabled = !S.future.length;
}

// ───────────── Playback ─────────────
function drawNow() {
  if (!ctx || !S.project) return;
  const T = eng.totalDuration(S.project); S.t = Math.min(S.t, T - 0.001);
  if (pv) { const { index, local } = eng.sceneAt(S.project, S.t); pv.sync(S.project.scenes[index], local, S.playing); }
  eng.drawFrame(ctx, canvas.width, canvas.height, S.project, S.playing ? S.t : eng.settleTime(S.project, S.t), S.images, pv ? pv.frames : null);
  const tm = $('#stTime'); if (tm) tm.textContent = fmt(S.t);
  const sk = $('#stSeek'); if (sk && document.activeElement !== sk) sk.value = Math.round((S.t / T) * 1000);
  updateHead();
}
function stopAudio() {
  if (!pa) return;
  pa.nodes.forEach((n) => { try { n.stop(); } catch (_) { /* ignore */ } });
  try { pa.bus.disconnect(); } catch (_) { /* ignore */ } if (pa.music) { try { pa.music.master.disconnect(); } catch (_) { /* ignore */ } }
  pa.nodes = [];
}
function startAudio() {
  stopAudio(); eng.browserVoice.stop();
  const AC = eng.audioContextClass(); if (!AC) return;
  if (!pa) pa = { ctx: new AC(), bus: null, nodes: [], music: null };
  const c = pa.ctx; if (c.state === 'suspended') c.resume().catch(() => {});
  const p = S.project; pa.bus = c.createGain(); pa.bus.gain.value = 0.92; pa.bus.connect(c.destination);
  const startAt = c.currentTime + 0.05, total = eng.totalDuration(p);
  pa.nodes = eng.scheduleNarration(c, pa.bus, p, S.buffers, { from: S.t, startAt });
  pa.music = eng.scheduleMusic(c, pa.bus, { kind: p.music, volume: S.vol, total, from: S.t, startAt, duck: eng.narrationRanges(p) });
  pa.nodes.push(...pa.music.nodes);
}
function play() {
  if (S.playing) return;
  const T = eng.totalDuration(S.project); if (S.t >= T - 0.05) S.t = 0;
  S.playing = true; lastTs = performance.now(); spokenScene = -1;
  const b = $('#stPlay'); b.innerHTML = '<i class="ph ph-pause"></i>'; b.setAttribute('aria-label', 'Pause');
  startAudio();
  const tick = (now) => {
    if (!S.playing) return;
    S.t += (now - lastTs) / 1000; lastTs = now;
    if (S.t >= T) { S.t = T - 0.001; drawNow(); pause(); S.t = 0; drawNow(); return; }
    const { index } = eng.sceneAt(S.project, S.t);
    if (index !== S.selected) { S.selected = index; renderScenes(); renderProps(); renderTimeline(); }
    const sc = S.project.scenes[index];
    if (S.narrate && spokenScene !== index && !eng.validNarr(S.project, sc)) { spokenScene = index; eng.browserVoice.speak(sc.caption, langCode() || 'en-NG'); }
    drawNow(); raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
}
function pause() {
  S.playing = false; cancelAnimationFrame(raf); stopAudio(); eng.browserVoice.stop(); if (pv) pv.pauseAll();
  const b = $('#stPlay'); if (b) { b.innerHTML = '<i class="ph ph-play"></i>'; b.setAttribute('aria-label', 'Play'); }
}

// ───────────── Export ─────────────
let modalOpener = null;
function modal(html) { const m = $('#stModal'); if (m.hidden) modalOpener = document.activeElement; m.hidden = false; m.innerHTML = `<div class="st-dialog" role="dialog" aria-modal="true" aria-labelledby="stDlgT">${html}</div>`; const f = m.querySelector('button, select, a'); if (f) f.focus(); return m; }
function closeModal() { const m = $('#stModal'); if (m) { m.hidden = true; m.innerHTML = ''; } if (modalOpener && document.contains(modalOpener)) { try { modalOpener.focus(); } catch (_) { /* ignore */ } } modalOpener = null; }
function onModalKey(e) {
  const m = document.getElementById('stModal'); if (!m || m.hidden || !mounted) return;
  if (e.key === 'Escape') { if (S.exportState === 'rendering') return; e.preventDefault(); closeModal(); return; }
  if (e.key !== 'Tab') return;
  const f = [...m.querySelectorAll('button, a[href], select, input, video[controls]')].filter((x) => !x.disabled && x.offsetParent !== null);
  if (!f.length) return;
  const first = f[0], last = f[f.length - 1];
  if (!m.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
  else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}
const EXPORT_HINTS = {
  NARR_MISSING: 'Open the Project tab and generate the narration again, then export.',
  NO_ENCODER: 'Try 720p or 480p. Some phones cannot encode large videos.',
  NO_EXPORT: 'Open Cognita in a recent Chrome, Edge, Firefox or Safari.',
  EMPTY: 'Keep this tab in front while rendering and try again.',
};

function openExport() {
  pause();
  const sup = exp.exportSupport(); const p = S.project; const T = eng.totalDuration(p);
  if (!sup.ok) { const m = modal(`<h3 id="stDlgT">Export is not available here</h3><p>${esc(sup.reason)}</p><p class="st-muted">Open Cognita in a recent version of Chrome, Edge, Firefox or Safari. Your project is saved.</p><div class="st-actions"><button type="button" class="st-btn st-btn--primary" id="xClose">Close</button></div>`); $('#xClose', m).addEventListener('click', closeModal); return; }
  const mobile = media.isMobileDevice();
  const outdated = p.scenes.filter((s) => narrState(s) === 'outdated').length, missingN = p.scenes.filter((s) => narrState(s) === 'missing').length, ready = p.scenes.filter((s) => narrState(s) === 'ready').length;
  const missImg = p.scenes.filter((s) => (s.layout === 'image' && !(s.image && S.images.has(s.image))) || (s.layout === 'video' && !(s.video && pv && pv.els.get(s.video)))).length;
  const hasFoot = p.scenes.some((s) => s.layout === 'video' && s.keepAudio);
  const m = modal(`<h3 id="stDlgT">Export video</h3>
    <p class="st-muted">${sup.engine === 'webcodecs' ? 'Your device renders this frame by frame and usually finishes faster than the video plays.' : 'This browser records the video in real time, so a ' + fmt(T) + ' video takes about ' + fmt(T) + '. Keep this tab in front.'} Nothing is uploaded.</p>
    ${missImg ? `<p class="st-warn"><i class="ph ph-warning"></i>${missImg} scene(s) are missing their picture or clip and will render without it.</p>` : ''}
    ${outdated ? `<p class="st-warn"><i class="ph ph-warning"></i>${outdated} scene(s) have outdated narration and will be silent. Regenerate it in the Project tab first if you want it spoken.</p>` : ''}
    ${nStatus().allowed && missingN && ready ? `<p class="st-warn"><i class="ph ph-warning"></i>${missingN} scene(s) have no narration.</p>` : ''}
    ${mobile && T > 120 ? '<p class="st-warn"><i class="ph ph-warning"></i>Long videos can run out of memory on phones. Choose 720p or shorten the video.</p>' : ''}
    <div class="st-field"><label for="xQ">Quality</label><select id="xQ"><option value="720" selected>720p (recommended)</option><option value="1080">1080p (larger file)</option><option value="480">480p (smallest)</option></select></div>
    <div class="st-field"><label for="xF">Frame rate</label><select id="xF"><option value="30" selected>30 fps</option><option value="24">24 fps</option></select></div>
    <label class="st-check"><input type="checkbox" id="xN"${ready ? ' checked' : ' disabled'}> Include spoken narration${ready ? '' : ' (none generated)'}</label>
    <label class="st-check"><input type="checkbox" id="xM"${p.music !== 'none' ? ' checked' : ' disabled'}> Include background music</label>
    ${hasFoot && sup.engine !== 'webcodecs' ? '<p class="st-muted st-small">Original footage sound is not included in compatibility mode.</p>' : ''}
    <div class="st-actions"><button type="button" class="st-btn" id="xCancel">Cancel</button><button type="button" class="st-btn st-btn--primary" id="xGo"><i class="ph ph-export"></i>Start export</button></div>`);
  $('#xCancel', m).addEventListener('click', closeModal);
  $('#xGo', m).addEventListener('click', () => startExport({ shortSide: Number($('#xQ', m).value), fps: Number($('#xF', m).value), includeMusic: $('#xM', m).checked, includeNarration: $('#xN', m).checked }));
}

async function startExport(o) {
  const T = eng.totalDuration(S.project); S.exportState = 'rendering';
  const m = modal(`<h3 id="stDlgT">Rendering on your device</h3><div class="st-prog" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" id="xBar"><i id="xFill"></i></div>
    <p class="st-muted" id="xTxt" aria-live="polite">Starting…</p><p class="st-muted st-small">Keep this tab open until the file is ready.</p><div class="st-actions"><button type="button" class="st-btn" id="xStop">Cancel</button></div>`);
  const t0 = performance.now(); let stage = 'Preparing';
  const hiddenWatch = () => { if (document.hidden) { const t = $('#xTxt'); if (t) t.textContent = 'The tab is in the background. Rendering may slow down until you return.'; } };
  document.addEventListener('visibilitychange', hiddenWatch);
  try {
    const h = await exp.exportVideo({ project: S.project, images: S.images, shortSide: o.shortSide, fps: o.fps, includeMusic: o.includeMusic, includeNarration: o.includeNarration, volume: S.vol, previewVideos: pv,
      onStage: (s) => { stage = s; const t = $('#xTxt'); if (t) t.textContent = s + '…'; },
      onProgress: (p, i, n) => { const pc = Math.round(p * 100); const f = $('#xFill'); if (f) f.style.width = pc + '%'; const b = $('#xBar'); if (b) b.setAttribute('aria-valuenow', pc); const tx = $('#xTxt'); if (tx) tx.textContent = `${stage}: ${pc}% · frame ${i} of ${n} · ${fmt((performance.now() - t0) / 1000)} elapsed`; } });
    $('#xStop', m).addEventListener('click', () => h.cancel());
    const res = await h.promise;
    document.removeEventListener('visibilitychange', hiddenWatch); S.exportState = null;
    if (res.cancelled) { closeModal(); showToast('Export cancelled'); return; }
    const url = URL.createObjectURL(res.blob);
    const name = (S.project.title || 'video').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'video';
    const mm = modal(`<h3 id="stDlgT">Your video is ready</h3><video class="st-result" src="${url}" controls playsinline></video>
      <dl class="st-meta"><div><dt>Format</dt><dd>${res.ext.toUpperCase()}</dd></div><div><dt>Resolution</dt><dd>${res.width}\u00D7${res.height}</dd></div><div><dt>Duration</dt><dd>${fmt(res.duration)}</dd></div><div><dt>Size</dt><dd>${fmtSize(res.blob.size)}</dd></div></dl>
      <p class="st-muted st-small">${res.audio ? 'Includes audio.' : 'No audio track.'} Rendered in ${fmt((performance.now() - t0) / 1000)} with ${res.engine === 'webcodecs' ? 'WebCodecs' : 'compatibility mode'}. This file exists only in this tab until you download it.${res.missingFootage ? ' ' + res.missingFootage + ' clip(s) were missing and left out.' : ''}${res.footageSoundSkipped ? ' Original footage sound was not included.' : ''}</p>
      <div class="st-actions"><button type="button" class="st-btn" id="xEdit">Back to editing</button><button type="button" class="st-btn" id="xAgain">Render again</button><a class="st-btn st-btn--primary" id="xDl" href="${url}" download="${name}.${res.ext}"><i class="ph ph-download-simple"></i>Download</a></div>`);
    $('#xEdit', mm).addEventListener('click', () => { URL.revokeObjectURL(url); closeModal(); }); $('#xAgain', mm).addEventListener('click', () => { URL.revokeObjectURL(url); openExport(); });
  } catch (e) {
    document.removeEventListener('visibilitychange', hiddenWatch); S.exportState = null; console.error('[studio] export failed', e);
    const mm = modal(`<h3 id="stDlgT">Export failed</h3><p>${esc(e.message || 'The video could not be rendered.')}</p><p class="st-muted">${esc(EXPORT_HINTS[e.code] || 'Try 480p or 720p, close other tabs to free memory, and keep this tab in front. Your project is safe.')}</p><div class="st-actions"><button type="button" class="st-btn" id="xClose">Close</button><button type="button" class="st-btn st-btn--primary" id="xRetry">Try again</button></div>`);
    $('#xClose', mm).addEventListener('click', closeModal); $('#xRetry', mm).addEventListener('click', openExport);
  }
}
