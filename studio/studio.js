// studio/studio.js
// Cognita Studio view. Mounted by js/router.js (?view=studio). Exports mount/activate/deactivate.
// This file is the shell only: screens (home, generating, editor), the editor layout, autosave status and the leave guard.
// Editing lives in ./editor/*, drawing in render.js, sound in audio.js, export in export.js, project data in model.js.

import { showToast, escapeHtml as esc } from '../js/shell.js';
import * as store from './store.js';
import * as media from './media.js';
import * as M from './model.js';
import { S, on, undo, redo, save, resetHistory, emit, P } from './editor/state.js';
import { mountPreview, unmountPreview, pause, drawNow, isMobile } from './editor/preview.js';
import { mountTimeline, unmountTimeline, fit } from './editor/timeline.js';
import { mountLibrary } from './editor/library.js';
import { mountInspector } from './editor/inspector.js';
import { openExport, exportBusy } from './editor/export-ui.js';
import { installShortcuts, showCheatSheet } from './editor/shortcuts.js';
import { refreshStatus, resetAI } from './editor/ai.js';
import * as home from './home.js';

export const HANDOFF_KEY = 'cognita.studio.handoff';
let root = null, mounted = false, offs = [];
const isActive = () => { const v = document.getElementById('view-studio'); return !!mounted && (!v || !v.hidden); };

export async function mount() {
  root = document.getElementById('studioRoot'); if (!root) return; mounted = true;
  home.setApi({ root, pause, openEditor, isActive });
  await home.loadList();
  window.addEventListener('online', () => { refreshStatus().then(paintHome); }); window.addEventListener('offline', paintStatus);
  window.addEventListener('beforeunload', (e) => { if (S.dirty || home.H.busy || exportBusy() || S.narrJob) { e.preventDefault(); e.returnValue = ''; } });
  installShortcuts(isActive); on('toast', (m) => showToast(m)); on('status', paintStatus); on('project', paintStatus);
  renderHomeScreen(); refreshStatus().then(paintHome); checkHandoff();
}
export function activate() { checkHandoff(); refreshStatus().then(paintHome); }
export function deactivate() { pause(); }

const paintHome = () => { if (S.screen === 'home' && root) home.renderHome(); };
function renderHomeScreen() { S.screen = 'home'; home.renderHome(); }
async function checkHandoff() {
  let text = null; try { text = sessionStorage.getItem(HANDOFF_KEY); sessionStorage.removeItem(HANDOFF_KEY); } catch (_) { /* ignore */ }
  if (!text || home.H.busy) return;
  if (S.screen === 'editor') await closeEditor(true);
  if (home.checkHandoffText(text)) { home.renderHome(); home.generate(); }
}

// ───────── editor shell ─────────
function teardown() {
  pause(); try { unmountPreview(); } catch (_) { /* ignore */ } try { unmountTimeline(); } catch (_) { /* ignore */ }
  if (S.hub) { try { S.hub.dispose(); } catch (_) { /* ignore */ } } S.hub = null; offs.forEach((f) => f()); offs = [];
}
export async function openEditor(project, { fresh = false, hub = null, notice = '', migrated = false } = {}) {
  if (S.screen === 'editor') teardown();
  S.project = project; S.hub = hub || new media.Hub(); S.sel = new Set(); S.t = 0; S.playing = false; S.markIn = S.markOut = null; S.dirty = false; S.saveState = 'saved'; S.saveError = ''; S.tab = 'media'; S.mobileTool = 'media'; S.clipboard = S.clipboard || null;
  resetHistory(); resetAI(); S.screen = 'editor'; S.pane = 'preview'; store.requestPersist();
  root.innerHTML = `<div class="st-app">
    <header class="st-top"><button type="button" class="st-btn st-btn--ghost" id="stBack"><i class="ph ph-arrow-left"></i><span>Projects</span></button>
      <label class="st-vh" for="stName">Project name</label><input id="stName" class="st-name" value="${esc(project.title)}" maxlength="80">
      <span class="st-status" id="stStatus" role="status" aria-live="polite"></span>
      <button type="button" class="st-icon" id="stUndo" aria-label="Undo" title="Undo (Ctrl+Z)"><i class="ph ph-arrow-counter-clockwise"></i></button>
      <button type="button" class="st-icon" id="stRedo" aria-label="Redo" title="Redo (Ctrl+Shift+Z)"><i class="ph ph-arrow-clockwise"></i></button>
      <button type="button" class="st-icon st-hide-m" id="stKeys" aria-label="Keyboard shortcuts" title="Shortcuts (?)"><i class="ph ph-keyboard"></i></button>
      <button type="button" class="st-btn st-btn--primary" id="stExport"><i class="ph ph-export"></i><span>Export</span></button></header>
    ${notice ? `<div class="st-banner" role="status"><i class="ph ph-info"></i><span>${esc(notice)}</span><button type="button" class="st-icon" id="stBannerX" aria-label="Dismiss"><i class="ph ph-x"></i></button></div>` : ''}
    <div class="st-ed" data-pane="preview"><aside class="st-left" id="stLib" aria-label="Library"></aside><section class="st-center" id="stPrev" aria-label="Preview"></section><aside class="st-right" id="stInsp" aria-label="Inspector"></aside><section class="st-tl" id="stTl" aria-label="Timeline"></section></div>
    <nav class="st-mnav" aria-label="Editor sections">${[['tools', 'ph-folder-simple', 'Library'], ['preview', 'ph-play-circle', 'Preview'], ['edit', 'ph-sliders-horizontal', 'Edit']].map(([k, ic, l]) => `<button type="button" data-pane="${k}" class="${k === 'preview' ? 'is-on' : ''}"><i class="ph ${ic}"></i>${l}</button>`).join('')}</nav>
  </div><div class="st-modal" id="stModal" hidden></div>`;
  const q = (s) => root.querySelector(s);
  q('#stBack').addEventListener('click', () => closeEditor(false)); q('#stUndo').addEventListener('click', undo); q('#stRedo').addEventListener('click', redo); q('#stExport').addEventListener('click', openExport); q('#stKeys').addEventListener('click', showCheatSheet);
  q('#stName').addEventListener('change', (e) => { import('./editor/state.js').then((m) => m.transact('Rename', (p) => { p.title = e.target.value.trim() || 'Untitled video'; })); });
  const bx = q('#stBannerX'); if (bx) bx.addEventListener('click', () => bx.parentElement.remove());
  root.querySelectorAll('.st-mnav [data-pane]').forEach((b) => b.addEventListener('click', () => { setPane(b.dataset.pane); }));
  mountLibrary(q('#stLib')); mountPreview(q('#stPrev')); mountTimeline(q('#stTl')); mountInspector(q('#stInsp'));
  offs.push(on('sel', () => { if (isMobile() && S.sel.size && root.querySelector('.st-ed').dataset.pane === 'tools') setPane('preview'); }), on('libtab', () => { if (isMobile()) setPane('tools'); }));
  paintStatus(); fit(); drawNow();
  S.hub.ensureAll(project).then(() => { emit('frame'); return missingCount(); }).then((n) => { if (n) showToast(n + ' media file' + (n > 1 ? 's are' : ' is') + ' missing on this device. Use Replace in the Media tab.'); }).catch(() => {});
  if (fresh || migrated) { save().then(() => { if (home.H) home.loadList(); }); }
}
function setPane(k) { const ed = root.querySelector('.st-ed'); if (!ed) return; ed.dataset.pane = k; root.querySelectorAll('.st-mnav button').forEach((x) => x.classList.toggle('is-on', x.dataset.pane === k)); if (k === 'preview') { drawNow(); } }
async function missingCount() { let n = 0; for (const a of P().assets) { if (/^narr_/.test(a.id)) continue; if (!(await store.hasAsset(a.id).catch(() => true))) n++; } return n; }
async function closeEditor(quiet) {
  pause(); if (S.dirty) await save(); teardown(); S.project = null; S.screen = 'home'; await home.loadList(); if (!quiet || root) home.renderHome();
}
function paintStatus() {
  const el = root && root.querySelector('#stStatus'); if (!el) return; const off = navigator.onLine === false;
  const m = { saved: 'Saved on this device', unsaved: 'Unsaved changes…', saving: 'Saving…', failed: S.saveError || 'Could not save' }[S.saveState] || '';
  el.textContent = m + (off ? ' · Offline' : ''); el.classList.toggle('is-err', S.saveState === 'failed');
  const u = root.querySelector('#stUndo'), r = root.querySelector('#stRedo'); if (u) u.disabled = !S.history.length; if (r) r.disabled = !S.future.length;
}
void M;
