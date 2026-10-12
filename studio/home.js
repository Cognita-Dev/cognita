// studio/home.js
// Studio home: the four ways to start (prompt, document, images, footage), blank projects, JSON import, the project library,
// and the generate pipeline (storyboard, files, AI pictures, narration, open editor). Opening and migrating projects lives here too.
import { escapeHtml as esc, showToast } from '../js/shell.js';
import * as store from './store.js';
import * as sb from './storyboard.js';
import * as nar from './narration.js';
import * as media from './media.js';
import * as M from './model.js';
import { S } from './editor/state.js';
import { narrateClips, needsNarration, nStatus, refreshStatus } from './editor/ai.js';
import { fmtDur, rel, safeName } from './editor/util.js';

export const H = {
  mode: 'prompt', opts: { aspect: '9:16', duration: 45, style: 'clean', music: 'calm', language: 'English (Nigeria)', captions: true, aiImages: true, narrate: true, blank: 'vertical' },
  prompt: '', sourceText: '', pendingImages: [], pendingVideos: [], clarify: '', error: '', projects: [], busy: false, stages: [], genStage: 0, storageOff: false, usage: null, notice: '',
};
let api = null, root = null;
export const setApi = (a) => { api = a; root = a.root; };
const $ = (s) => root.querySelector(s);
const ratioOf = (p) => (p.settings ? p.settings.width / p.settings.height : p.aspect === '16:9' ? 16 / 9 : p.aspect === '1:1' ? 1 : 9 / 16);
const clone = (o) => JSON.parse(JSON.stringify(o));

export async function loadList() { try { H.projects = (await store.listProjects()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)); H.storageOff = false; } catch (_) { H.projects = []; H.storageOff = true; } try { H.usage = await store.storageEstimate(); } catch (_) { H.usage = null; } }

export function renderHome() {
  const o = H.opts, ns = nStatus(); api.pause();
  const modes = [['prompt', 'ph-sparkle', 'From a prompt'], ['document', 'ph-file-text', 'From a document'], ['images', 'ph-images', 'From images'], ['footage', 'ph-film-strip', 'From footage']];
  const sel = (name, list, cur = o[name]) => `<select data-opt="${name}" aria-label="${name}">${list.map(([v, l, dis]) => `<option value="${v}"${String(cur) === String(v) ? ' selected' : ''}${dis ? ' disabled' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const keep = { open: !!root.querySelector('details.st-more[open]'), id: document.activeElement && root.contains(document.activeElement) ? document.activeElement.id : '', opt: document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.opt : '', a: 0, b: 0, top: (root.querySelector('.st-home') || {}).scrollTop || 0 };
  try { keep.a = document.activeElement.selectionStart; keep.b = document.activeElement.selectionEnd; } catch (_) { /* not a text field */ }
  root.innerHTML = `<div class="st-home"><div class="st-home-inner">
    <h2 class="st-title">What should we make?</h2>
    <p class="st-sub">Describe a video and Cognita builds an editable storyboard, then renders it on your device. Or start from a blank timeline and edit like a normal video editor.</p>
    <div class="st-compose">
      <div class="st-modes" role="tablist" aria-label="How to start">${modes.map(([k, ic, l]) => `<button type="button" role="tab" class="st-mode${H.mode === k ? ' is-on' : ''}" data-mode="${k}" aria-selected="${H.mode === k}"><i class="ph ${ic}" aria-hidden="true"></i>${l}</button>`).join('')}</div>
      ${H.mode === 'document' ? `<label class="st-lbl" for="stSource">Paste your text, or load a .txt or .md file</label><textarea id="stSource" class="st-source" rows="5" placeholder="Paste an article, notes or a lesson here">${esc(H.sourceText)}</textarea><div><label class="st-link"><input type="file" id="stDocFile" accept=".txt,.md,text/plain" hidden>Load a text file</label></div>` : ''}
      ${H.mode === 'images' ? `<div class="st-imgrow">${H.pendingImages.map((im, i) => `<div class="st-pimg"><img src="${im.url}" alt="Selected image ${i + 1}"><button type="button" data-rm-img="${i}" aria-label="Remove image ${i + 1}"><i class="ph ph-x"></i></button></div>`).join('')}<label class="st-add"><input type="file" id="stImgFile" accept="image/*" multiple hidden><i class="ph ph-plus"></i><span>Add images</span></label></div>` : ''}
      ${H.mode === 'footage' ? `<div class="st-clips">${H.pendingVideos.map((v, i) => `<div class="st-clip${v.error ? ' is-err' : ''}"><span class="st-clip-th">${v.meta && v.meta.thumb ? `<img src="${v.meta.thumb}" alt="">` : '<i class="ph ph-film-strip"></i>'}</span><span class="st-clip-t"><b>${esc(v.file.name)}</b><small>${v.error ? esc(v.error) : v.meta ? fmtDur(v.meta.duration) + ' · ' + v.meta.width + '×' + v.meta.height + (v.meta.hasAudio ? ' · has sound' : ' · no sound') : 'Checking…'}</small></span><button type="button" class="st-icon" data-rm-vid="${i}" aria-label="Remove ${esc(v.file.name)}"><i class="ph ph-x"></i></button></div>`).join('')}<label class="st-add st-add--wide"><input type="file" id="stVidFile" accept="video/*" multiple hidden><i class="ph ph-plus"></i><span>Add clips (up to 12, ${media.maxVideoMB()} MB each)</span></label></div><p class="st-muted st-small">Describe each clip below, for example "Clip 1 is the school gate, clip 2 is assembly". The AI cannot see inside your footage.</p>` : ''}
      <label class="st-lbl st-vh" for="stPrompt">Describe the video</label>
      <textarea id="stPrompt" class="st-prompt" rows="3" placeholder="Describe the video you want to create…">${esc(H.prompt)}</textarea>
      ${H.clarify ? `<div class="st-note" role="status"><i class="ph ph-chat-circle-text"></i><div><strong>One question first</strong><p>${esc(H.clarify)}</p><span>Add your answer to the description above and press Create.</span></div></div>` : ''}
      ${H.error ? `<div class="st-note st-note--err" role="alert"><i class="ph ph-warning-circle"></i><div><strong>Could not create the video</strong><p>${esc(H.error)}</p></div></div>` : ''}
      <div class="st-compose-foot">
        <details class="st-more"><summary><i class="ph ph-sliders-horizontal" aria-hidden="true"></i> Settings</summary><div class="st-grid">
          <label>Format${sel('aspect', [['9:16', 'Vertical 9:16'], ['16:9', 'Landscape 16:9'], ['1:1', 'Square 1:1']])}</label>
          <label>Length${sel('duration', [[20, 'About 20 s'], [30, 'About 30 s'], [45, 'About 45 s'], [60, 'About 1 min'], [90, 'About 1.5 min'], [120, 'About 2 min']])}</label>
          <label>Look${sel('style', [['clean', 'Clean light'], ['dark', 'Dark'], ['bold', 'Bold colour']])}</label>
          <label>Music${sel('music', [['calm', 'Calm'], ['upbeat', 'Upbeat'], ['none', 'None']])}</label>
          <label>Language${sel('language', [['English (Nigeria)', 'English (Nigeria)'], ['English (UK)', 'English (UK)'], ['English (US)', 'English (US)'], ['French', 'French'], ['Yoruba', 'Yoruba (captions only)'], ['Hausa', 'Hausa (captions only)'], ['Igbo', 'Igbo (captions only)']])}</label>
          <label>Subtitles${sel('captions', [[true, 'Show subtitles'], [false, 'No subtitles']])}</label>
          <label>Narration${sel('narrate', [[true, 'Narrate with a voice', !ns.allowed], [false, 'No narration']], ns.allowed ? o.narrate : false)}${!ns.allowed ? `<small class="st-muted">${ns.offline ? 'Offline' : ns.error ? 'Could not check your plan' : 'Narration is part of the Studio plan'}</small>` : ''}</label>
          <label>Pictures${sel('aiImages', [[true, 'AI pictures for up to 4 scenes'], [false, 'Only my own images']])}</label>
        </div></details>
        <button type="button" class="st-btn st-btn--primary" id="stCreate"${H.busy ? ' disabled' : ''}><i class="ph ph-magic-wand"></i>Create video</button>
      </div>
    </div>
    <section class="st-blank" aria-labelledby="stBlankH"><h3 id="stBlankH" class="st-h">Or start from scratch</h3><div class="st-blank-row"><label class="st-vh" for="stBlankSize">Project size</label><select id="stBlankSize" data-opt="blank">${M.SIZE_PRESETS.filter((x) => x.w).map((x) => `<option value="${x.id}"${o.blank === x.id ? ' selected' : ''}>${esc(x.label)}</option>`).join('')}</select><button type="button" class="st-btn" id="stBlank"><i class="ph ph-plus"></i>Blank project</button><label class="st-btn"><input type="file" id="stJson" accept=".json,application/json" hidden><i class="ph ph-upload-simple"></i>Import project JSON</label></div></section>
    ${renderLibrary()}
  </div></div>`;
  wireHome();
  if (keep.open) { const d = $('details.st-more'); if (d) d.open = true; }
  const h = $('.st-home'); if (h) h.scrollTop = keep.top;
  const f = keep.id ? document.getElementById(keep.id) : (keep.opt ? $('[data-opt="' + keep.opt + '"]') : null);
  if (f && root.contains(f)) { f.focus({ preventScroll: true }); try { if (keep.a != null) f.setSelectionRange(keep.a, keep.b); } catch (_) { /* not a text field */ } }
}
function renderLibrary() {
  if (H.storageOff) return `<div class="st-note"><i class="ph ph-hard-drives"></i><div><strong>Projects cannot be saved here</strong><p>This browser blocks local storage (private mode, for example). You can still create and export, but drafts will not be kept.</p></div></div>`;
  const use = H.usage && H.usage.quota ? `<span class="st-muted st-small">${(H.usage.usage / 1048576).toFixed(0)} MB used of about ${(H.usage.quota / 1048576 / 1024).toFixed(1)} GB available</span>` : '';
  if (!H.projects.length) return `<section class="st-lib" aria-labelledby="stLibH"><h3 id="stLibH" class="st-h">Projects</h3><div class="st-empty"><i class="ph ph-film-slate"></i><p>Nothing here yet. Your videos are saved on this device as drafts, so you can come back and edit them.</p></div></section>`;
  return `<section class="st-lib" aria-labelledby="stLibH"><h3 id="stLibH" class="st-h">Projects <span class="st-muted">Saved on this device</span> ${use}</h3><div class="st-cards">${H.projects.map((p) => { const s = M.summarise(p); return `
    <article class="st-card"><button type="button" class="st-card-main" data-open="${esc(p.id)}" aria-label="Open ${esc(p.title)}">
      <span class="st-thumb" style="aspect-ratio:${ratioOf(p).toFixed(3)}">${p.thumb ? `<img src="${p.thumb}" alt="">` : '<i class="ph ph-film-slate"></i>'}</span>
      <span class="st-card-t">${esc(p.title)}</span><span class="st-muted">${esc(s.label)} · ${fmtDur(s.duration)} · ${rel(p.updatedAt || 0)}</span><span class="st-badge">Local draft</span></button>
      <div class="st-card-act"><button type="button" class="st-icon" data-dup="${esc(p.id)}" aria-label="Duplicate ${esc(p.title)}"><i class="ph ph-copy"></i></button><button type="button" class="st-icon" data-del="${esc(p.id)}" aria-label="Delete ${esc(p.title)}"><i class="ph ph-trash"></i></button></div></article>`; }).join('')}</div></section>`;
}
function wireHome() {
  root.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => { H.prompt = $('#stPrompt').value; H.mode = b.dataset.mode; renderHome(); }));
  root.querySelectorAll('[data-opt]').forEach((el) => el.addEventListener('change', () => { const k = el.dataset.opt; let v = el.value; if (k === 'duration') v = Number(v); if (['captions', 'aiImages', 'narrate'].includes(k)) v = v === 'true'; H.opts[k] = v; }));
  const p = $('#stPrompt'); p.addEventListener('input', () => { H.prompt = p.value; }); p.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) generate(); });
  const src = $('#stSource'); if (src) src.addEventListener('input', () => { H.sourceText = src.value; });
  const df = $('#stDocFile'); if (df) df.addEventListener('change', async () => { const f = df.files[0]; if (!f) return; if (f.size > 400000) { showToast('That file is too large. Use a text file under 400 KB.'); return; } H.sourceText = await f.text(); renderHome(); });
  const imf = $('#stImgFile'); if (imf) imf.addEventListener('change', () => addPendingImages([...imf.files]));
  const vf = $('#stVidFile'); if (vf) vf.addEventListener('change', () => addPendingVideos([...vf.files]));
  root.querySelectorAll('[data-rm-img]').forEach((b) => b.addEventListener('click', () => { const [r] = H.pendingImages.splice(Number(b.dataset.rmImg), 1); URL.revokeObjectURL(r.url); renderHome(); }));
  root.querySelectorAll('[data-rm-vid]').forEach((b) => b.addEventListener('click', () => { H.pendingVideos.splice(Number(b.dataset.rmVid), 1); renderHome(); }));
  $('#stCreate').addEventListener('click', generate); $('#stBlank').addEventListener('click', newBlank);
  $('#stJson').addEventListener('change', (e) => importJson(e.target.files[0]));
  root.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => openById(b.dataset.open)));
  root.querySelectorAll('[data-dup]').forEach((b) => b.addEventListener('click', () => dupProject(b.dataset.dup)));
  root.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
    const p = H.projects.find((x) => x.id === b.dataset.del); if (!p || !window.confirm('Delete "' + p.title + '" from this device? This cannot be undone.')) return;
    try { await store.deleteProjectAndAssets(p.id); } catch (e) { showToast('Could not delete: ' + (e.message || e)); } await loadList(); renderHome();
  }));
}
function addPendingImages(files) {
  const ok = files.filter((f) => f.type.startsWith('image/')); if (ok.length < files.length) showToast('Some files were skipped. Only image files are supported.');
  ok.slice(0, 12 - H.pendingImages.length).forEach((f) => H.pendingImages.push({ file: f, url: URL.createObjectURL(f) })); renderHome();
}
async function addPendingVideos(files) {
  const room = 12 - H.pendingVideos.length; if (files.length > room) showToast('Only 12 clips fit in one project.');
  const fresh = files.filter((f) => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name)).slice(0, room).map((file) => ({ file, meta: null, error: '' }));
  H.pendingVideos.push(...fresh); renderHome();
  for (const v of fresh) {
    if (v.file.size > media.maxVideoMB() * 1048576) { v.error = 'Too large (' + Math.round(v.file.size / 1048576) + ' MB, limit ' + media.maxVideoMB() + ' MB)'; continue; }
    try { v.meta = await media.probeVideo(v.file); } catch (e) { v.error = e.message || 'Unsupported video'; }
    if (S.screen === 'home') renderHome();
  }
}

// ───────── blank, import, open, duplicate ─────────
async function newBlank() { const p = M.newProject({ title: 'Untitled video', preset: H.opts.blank }); p.createdAt = p.updatedAt = Date.now(); await api.openEditor(p, { fresh: true }); }
async function importJson(file) {
  if (!file) return; if (file.size > 30e6) { showToast('That file is too large to be a project.'); return; }
  try { const raw = JSON.parse(await file.text()); const p = M.sanitiseProject(raw); p.id = store.uid('prj'); p.createdAt = p.updatedAt = Date.now(); p.title = (p.title || 'Imported project').slice(0, 70);
    const miss = []; for (const a of p.assets) if (!(await store.hasAsset(a.id).catch(() => false))) miss.push(a); await api.openEditor(p, { fresh: true, notice: miss.length ? miss.length + ' media file' + (miss.length > 1 ? 's are' : ' is') + ' not on this device. Open the Media tab and use Replace to relink them.' : '' });
  } catch (e) { showToast(e.message || 'That file is not a Cognita Studio project.'); }
}
// Reads a stored project, migrating an old scene-based (v1) one without touching the stored copy. The original is kept inside as legacyV1.
export function migrate(raw) {
  if (M.isV1(raw)) { const p = M.v1ToV2(raw); p.legacyV1 = { ...clone(raw), thumb: '' }; p.migratedFrom = 1; return p; }
  return M.sanitiseProject(raw);
}
export async function openById(id) {
  let raw; try { raw = await store.getProject(id); } catch (e) { showToast('Could not read that project: ' + (e.message || e)); return; }
  if (!raw) { showToast('That project could not be found.'); return; }
  let p;
  try { p = migrate(raw); } catch (e) { showToast('This project could not be opened: ' + (e.message || e)); return; }
  let notice = M.isV1(raw) ? 'Opened from the older Studio format. Your original is kept until you edit.' : '';
  try { const rec = await store.getRecovery(id); if (rec && rec.project && rec.ts > (raw.updatedAt || 0) + 2000 && !M.isV1(raw) && window.confirm('Unsaved changes from an earlier session were found for "' + p.title + '". Restore them?')) { p = M.sanitiseProject(rec.project); p.id = id; notice = 'Recovered unsaved changes.'; } else if (rec && !(rec.ts > (raw.updatedAt || 0) + 2000)) store.clearRecovery(id).catch(() => {}); } catch (_) { /* no recovery */ }
  await api.openEditor(p, { notice, migrated: M.isV1(raw) });
}
async function dupProject(id) {
  try {
    const raw = await store.getProject(id); if (!raw) return; const c = migrate(raw); const old = c.id; c.id = store.uid('prj'); c.title = (c.title + ' copy').slice(0, 80); c.updatedAt = c.createdAt = Date.now(); delete c.legacyV1; const map = {};
    for (const a of c.assets) { if (/^narr_/.test(a.id)) continue; const rec = await store.getAsset(a.id); const nid = store.uid(a.kind === 'video' ? 'vid' : a.kind === 'audio' ? 'aud' : 'img'); map[a.id] = nid; if (rec) await store.putAsset({ ...rec, id: nid }); a.id = nid; }
    c.clips.forEach((x) => { if (x.assetId && map[x.assetId]) x.assetId = map[x.assetId]; if (x.scene) { if (map[x.scene.image]) x.scene.image = map[x.scene.image]; if (map[x.scene.video]) x.scene.video = map[x.scene.video]; } }); void old;
    await store.saveProject(c); await loadList(); renderHome(); showToast('Project duplicated');
  } catch (e) { showToast(e.code === 'STORAGE' ? e.message : 'Could not duplicate: ' + (e.message || e)); }
}

// ───────── generate ─────────
function renderGenerating() {
  root.innerHTML = `<div class="st-home"><div class="st-home-inner st-gen" role="status" aria-live="polite"><h2 class="st-title">Creating your video</h2>
    <ol class="st-steps">${H.stages.map((s, i) => `<li class="${i < H.genStage ? 'is-done' : i === H.genStage ? 'is-now' : ''}"><span class="st-dot" aria-hidden="true">${i < H.genStage ? '<i class="ph ph-check"></i>' : ''}</span><span>${esc(s.label)}${s.detail && i === H.genStage ? `<small class="st-muted"> ${esc(s.detail)}</small>` : ''}</span>${i === H.genStage ? '<span class="st-vh"> (in progress)</span>' : ''}</li>`).join('')}</ol>
    <p class="st-muted">This usually takes under a minute. The storyboard uses one message from your daily allowance.</p></div></div>`;
}
const setStage = (i, detail) => { H.genStage = i; if (H.stages[i]) H.stages[i].detail = detail || ''; renderGenerating(); };
const PRESET = { '9:16': 'vertical', '16:9': 'yt1080', '1:1': 'square' };

export async function generate() {
  if (H.busy) return; const pe = $('#stPrompt'); const prompt = (pe ? pe.value : H.prompt).trim(); H.prompt = prompt; H.error = ''; H.clarify = '';
  const fail = (m) => { H.error = m; renderHome(); };
  if (H.mode === 'document' && !H.sourceText.trim() && !prompt) return fail('Paste some text or describe what the video should say.');
  if (H.mode === 'images' && !H.pendingImages.length) return fail('Add at least one image first.');
  if (H.mode === 'footage') { if (!H.pendingVideos.length) return fail('Add at least one clip first.'); if (H.pendingVideos.some((v) => !v.meta && !v.error)) return fail('Still checking your clips. Try again in a moment.'); if (H.pendingVideos.some((v) => v.error)) return fail('Remove the clips marked with a problem, then try again.'); }
  if (H.mode === 'prompt' && prompt.length < 8) return fail('Describe the video in a little more detail.');
  const o = H.opts, ns = nStatus(), lang = nar.langCodeFor(o.language); const wantNarr = o.narrate && ns.allowed && !!lang && ns.available !== false;
  H.stages = [{ label: 'Writing the storyboard' }, { label: 'Preparing images and clips' }]; if (wantNarr) H.stages.push({ label: 'Recording narration' }); H.stages.push({ label: 'Building the preview' });
  H.busy = true; S.screen = 'generating'; setStage(0); const warnings = []; const assets = [];
  const hub = new media.Hub();
  try {
    const clips = H.mode === 'footage' ? H.pendingVideos.map((v) => ({ name: v.file.name, duration: v.meta.duration })) : [];
    const raw = await sb.generateStoryboard({ prompt, mode: H.mode, options: o, imageCount: H.pendingImages.length, videoClips: clips, sourceText: H.sourceText });
    if (raw.clarify && !(raw.scenes && raw.scenes.length)) { H.clarify = String(raw.clarify).slice(0, 300); S.screen = 'home'; H.busy = false; hub.dispose(); renderHome(); return; }
    setStage(1, 'Your files'); const imageIds = [], videoIds = [];
    for (const im of H.pendingImages) { try { const a = await media.importFile(im.file, { actx: hub.ctx() }); delete a._buf; assets.push(a); imageIds.push(a.id); } catch (e) { imageIds.push(null); warnings.push('Skipped "' + im.file.name + '": ' + (e.message || 'unreadable image') + '.'); } }
    for (const [i, v] of H.pendingVideos.entries()) { setStage(1, 'Clip ' + (i + 1) + ' of ' + H.pendingVideos.length); try { const a = await media.importFile(v.file, { actx: hub.ctx() }); delete a._buf; assets.push(a); videoIds.push(a.id); } catch (e) { videoIds.push(null); warnings.push('Skipped clip "' + v.file.name + '": ' + e.message); } }
    const vlist = ns.voices || []; const v0 = lang ? (vlist.find((v) => v.lang === lang && v.default) || vlist.find((v) => v.lang === lang)) : null;
    const base = { id: store.uid('prj'), createdAt: Date.now(), updatedAt: Date.now(), aspect: o.aspect, style: o.style, music: o.music, captions: o.captions, language: o.language, lang, rate: 1, vol: 0.5, assets: [], voice: v0 ? v0.id : '' };
    const v1 = sb.normaliseProject(raw, base, imageIds, videoIds);
    (raw.scenes || []).slice(0, v1.scenes.length).forEach((rs, i) => { const sc = v1.scenes[i]; if (Number.isInteger(rs.imageIndex) && imageIds[rs.imageIndex]) { sc.image = imageIds[rs.imageIndex]; if (rs.layout === 'image') sc.layout = 'image'; } if (Number.isInteger(rs.videoIndex) && videoIds[rs.videoIndex] && rs.layout === 'video') { sc.video = videoIds[rs.videoIndex]; sc.layout = 'video'; } });
    if (H.mode === 'footage') {
      const used = new Set(v1.scenes.filter((s) => s.layout === 'video').map((s) => s.video));
      videoIds.forEach((id) => { if (id && !used.has(id)) { const a = assets.find((x) => x.id === id); v1.scenes.splice(Math.max(1, v1.scenes.length - 1), 0, sb.normaliseScene({ title: a.name.replace(/\.[^.]+$/, '').slice(0, 60), layout: 'video', video: id, duration: 6 }, [], [id])); } });
      v1.scenes.forEach((sc) => { if (sc.layout === 'video') { const a = assets.find((x) => x.id === sc.video); if (a) { sc.duration = Math.max(2, Math.min(a.duration || 6, 12)); sc.keepAudio = !!a.hasAudio; } } });
    }
    if (!v1.scenes.length) throw new Error('The AI did not return any scenes. Please try again.');
    v1.aspect = o.aspect; v1.style = o.style; v1.captions = o.captions; v1.music = o.music;
    const wanted = v1.scenes.filter((s) => s.layout === 'image' && !s.image && s.imagePrompt).slice(0, 4);
    if (wanted.length && o.aiImages) { let stopped = false;
      for (const [i, sc] of wanted.entries()) { if (stopped) { sc.layout = 'title'; continue; } setStage(1, 'Picture ' + (i + 1) + ' of ' + wanted.length);
        try { const d = await media.generateAiImage(sc.imagePrompt); const a = await media.importBlob(d.blob, 'AI picture ' + (i + 1) + '.jpg', 'image', 'generated', hub.ctx()); a.name = 'AI picture: ' + sc.imagePrompt.slice(0, 40); delete a._buf; assets.push(a); sc.image = a.id; }
        catch (e) { sc.layout = 'title'; warnings.push('A picture could not be made: ' + (e.message || 'unknown error')); if (e.status === 429) stopped = true; } }
    } else v1.scenes.forEach((s) => { if (s.layout === 'image' && !s.image) s.layout = 'title'; });
    const p = M.v1ToV2({ ...v1, assets: [], vol: 0.5 }); p.assets = assets; p.settings.preset = PRESET[o.aspect] || p.settings.preset; p.createdAt = p.updatedAt = Date.now();
    H.pendingImages.forEach((im) => URL.revokeObjectURL(im.url)); H.pendingImages = []; H.pendingVideos = [];
    S.project = p; S.hub = hub;
    if (wantNarr && p.voice) { const idx = H.stages.findIndex((s) => s.label === 'Recording narration'); setStage(idx, 'Starting'); const todo = needsNarration(); const r = await narrateClips(todo, { onProgress: (n, m) => setStage(idx, 'Scene ' + n + ' of ' + m) }); if (r.failed.length || r.stopped) warnings.push('Narration is incomplete: ' + (r.stopped || r.failed[0].message) + ' You can finish it from the AI tab.'); }
    else if (o.narrate && !wantNarr) warnings.push(!ns.allowed ? 'Narration needs the Studio plan, so this video has captions and music only.' : !lang ? 'There is no narration voice for ' + o.language + ' yet. Captions and music only.' : 'Narration is not available right now.');
    setStage(H.stages.length - 1); H.busy = false;
    await api.openEditor(p, { fresh: true, hub, notice: warnings.join(' ') }); if (warnings[0]) showToast(warnings[0]);
  } catch (e) {
    console.error('[studio] generate failed', e); H.busy = false; S.project = null; S.screen = 'home'; try { hub.dispose(); } catch (_) { /* ignore */ }
    H.error = e.status === 429 ? 'You have reached your message limit for now. Try again later or upgrade your plan.' : (e.message || 'Something went wrong.'); renderHome();
  }
}
export function checkHandoffText(text) { if (!text || H.busy) return false; H.mode = 'prompt'; H.prompt = text; return true; }
void safeName; void refreshStatus;
