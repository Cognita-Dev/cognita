// studio/editor/export-ui.js
// Export dialog. All real work is in ../export.js (probes the encoders, writes the file). This file only shows the options,
// the honest capability report, progress, and the finished file.
import { S, P, toast, transact, strip, markDirty } from './state.js';
import { openDialog, closeDialog } from './dialog.js';
import { pause } from './preview.js';
import { esc, fmtSize, fmtDur, download, safeName } from './util.js';
import * as X from '../export.js';
import * as M from '../model.js';

const opt = { res: 1080, fps: 0, quality: 'medium', container: 'auto', audio: true, sampleRate: 48000, range: 'all', burn: true, stream: false };
let plan = null, job = null, url = '', wake = null, seq = 0;

export function exportBusy() { return !!job; }
export async function openExport() {
  if (!P()) return; pause(); if (job) { renderRun(); return; }
  opt.burn = P().export ? P().export.burnCaptions !== false : true; opt.fps = P().settings.fps; if (!opt.res || opt.res > Math.max(P().settings.width, P().settings.height)) opt.res = Math.min(P().settings.width, P().settings.height) >= 1080 ? 1080 : 0;
  renderForm(); await refreshPlan();
}
const rangeOf = () => (opt.range === 'io' && S.markIn != null && S.markOut != null && S.markOut > S.markIn ? { start: S.markIn, end: S.markOut } : null);
const reqOpts = () => ({ project: P(), short: opt.res || 0, fps: opt.fps, quality: opt.quality, container: opt.container, audio: opt.audio, sampleRate: opt.sampleRate, range: rangeOf(), burnCaptions: opt.burn });
async function refreshPlan() { const my = ++seq; const box = document.getElementById('exReport'); if (box) box.innerHTML = '<span class="st-muted">Checking what this device can encode…</span>'; let p; try { p = await X.planExport(P(), reqOpts()); } catch (e) { p = { ok: false, reason: e.message || 'Could not check the encoder.', warnings: [], resOk: {} }; } if (my !== seq) return; plan = p; paintReport(); }
function paintReport() {
  const box = document.getElementById('exReport'); const go = document.getElementById('exGo'); if (!box) return; const p = plan;
  if (!p.ok) { box.innerHTML = `<div class="st-note st-note--err" role="alert"><i class="ph ph-warning-circle"></i><div><p>${esc(p.reason || 'Export is not available on this device.')}</p></div></div>`; if (go) go.disabled = true; return; }
  box.innerHTML = `<dl class="st-report"><dt>File</dt><dd>${esc(p.container)} (.${esc(p.ext)})</dd><dt>Video</dt><dd>${esc(p.vcodec)} · ${p.width}×${p.height} · ${p.fps} fps · ${(p.bitrate / 1e6).toFixed(1)} Mbit/s</dd><dt>Audio</dt><dd>${p.hasSound ? esc(p.acodec || 'browser default') + ' · ' + p.sampleRate / 1000 + ' kHz' : 'No sound'}</dd><dt>Length</dt><dd>${fmtDur(p.duration)}</dd><dt>About</dt><dd>${fmtSize(p.sizeBytes)} (estimate)</dd><dt>Method</dt><dd>${p.engine === 'webcodecs' ? 'Fast, frame by frame' : 'Compatibility mode, real time'}</dd></dl>${(p.warnings || []).map((w) => `<div class="st-note"><i class="ph ph-info"></i><div><p>${esc(w)}</p></div></div>`).join('')}`;
  if (go) go.disabled = false; X.RES_OPTIONS.forEach(([s]) => { const o = document.querySelector('#exRes option[value="' + s + '"]'); if (o && s) o.disabled = p.resOk && p.resOk[s] === false; });
}
function renderForm() {
  const hasIO = S.markIn != null && S.markOut != null && S.markOut > S.markIn; const mx = Math.max(P().settings.width, P().settings.height);
  const sel = (id, list, cur) => `<select id="${id}">${list.map(([v, l]) => `<option value="${v}"${String(cur) === String(v) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  openDialog(`<h3 id="stDlgT">Export video</h3><p class="st-muted">Rendered on this device. Nothing is uploaded.</p>
  <div class="st-grid st-grid--ex">
   <label>Resolution${sel('exRes', X.RES_OPTIONS.map(([v, l]) => [v, l + (v && v > mx ? ' (upscaled)' : '')]), opt.res)}</label>
   <label>Frame rate${sel('exFps', M.FPS_OPTIONS.map((f) => [f, f + ' fps']), opt.fps)}</label>
   <label>Quality${sel('exQ', Object.entries(X.QUALITY).map(([k, v]) => [k, v.label]), opt.quality)}</label>
   <label>Format${sel('exFmt', [['auto', 'Best for this device'], ['mp4', 'MP4 (H.264)'], ['webm', 'WebM']], opt.container)}</label>
   <label>Sound${sel('exAud', [[true, 'Include audio'], [false, 'No audio']], opt.audio)}</label>
   <label>Audio rate${sel('exSr', [[48000, '48 kHz'], [44100, '44.1 kHz']], opt.sampleRate)}</label>
   <label>Range${sel('exRange', [['all', 'Whole timeline'], ...(hasIO ? [['io', 'In to Out marks (' + fmtDur(S.markIn) + ' to ' + fmtDur(S.markOut) + ')']] : [])], opt.range)}</label>
   <label class="st-check st-check--wide"><input type="checkbox" id="exBurn"${opt.burn ? ' checked' : ''}> Burn in captions</label>
   ${X.fsSaveSupported() ? '<label class="st-check st-check--wide"><input type="checkbox" id="exStream"' + (opt.stream ? ' checked' : '') + '> Save straight to a file (best for long videos, uses less memory)</label>' : ''}
  </div><div id="exReport" aria-live="polite"></div>
  <div class="st-dlg-foot"><button type="button" class="st-btn" id="exCancel">Close</button><button type="button" class="st-btn st-btn--primary" id="exGo" data-autofocus disabled><i class="ph ph-export"></i>Start export</button></div>`);
  const d = document.querySelector('.st-dialog'); const rd = (id) => d.querySelector('#' + id);
  const map = { exRes: ['res', Number], exFps: ['fps', Number], exQ: ['quality', String], exFmt: ['container', String], exAud: ['audio', (v) => v === 'true'], exSr: ['sampleRate', Number], exRange: ['range', String] };
  Object.entries(map).forEach(([id, [k, f]]) => rd(id).addEventListener('change', () => { opt[k] = f(rd(id).value); refreshPlan(); }));
  rd('exBurn').addEventListener('change', () => { opt.burn = rd('exBurn').checked; transact('Export setting', (p) => { p.export = p.export || {}; p.export.burnCaptions = opt.burn; }); });
  const st = rd('exStream'); if (st) st.addEventListener('change', () => { opt.stream = st.checked; });
  rd('exCancel').addEventListener('click', closeDialog); rd('exGo').addEventListener('click', start);
}
async function start() {
  if (!plan || !plan.ok) return; let fileHandle = null;
  if (opt.stream && X.fsSaveSupported()) { try { fileHandle = await X.pickSaveHandle(safeName(P().title), plan.ext); } catch (e) { if (e && e.name === 'AbortError') return; toast('Could not open the save dialog, so the file will download instead.'); } }
  job = { stage: 'Starting', frac: 0, eta: null, handle: null, cancelled: false }; S.exportState = 'rendering'; renderRun();
  try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch (_) { wake = null; }
  try {
    const h = await X.exportProject({ ...reqOpts(), hub: S.hub, plan, fileHandle, onStage: (s) => { job.stage = s; paintRun(); }, onProgress: (f, i, n, eta) => { job.frac = f; job.eta = eta; paintRun(); } });
    job.handle = h; const r = await h.promise; done(r);
  } catch (e) { console.error('[studio] export failed', e); fail(e); }
}
function end() { job = null; S.exportState = null; if (wake) { try { wake.release(); } catch (_) { /* ignore */ } wake = null; } }
function fail(e) { end(); openDialog(`<h3 id="stDlgT">Export did not finish</h3><div class="st-note st-note--err" role="alert"><i class="ph ph-warning-circle"></i><div><p>${esc(e && e.message ? e.message : 'Something went wrong.')}</p></div></div><div class="st-dlg-foot"><button type="button" class="st-btn" id="exBack" data-autofocus>Back to options</button></div>`); document.getElementById('exBack').addEventListener('click', () => { renderForm(); refreshPlan(); }); }
function done(r) {
  const was = job; end(); if (r.cancelled || (was && was.cancelled)) { renderForm(); refreshPlan(); return; }
  const real = r.plan || plan; const info = `${esc(real.container)} · ${esc(real.vcodec)}${real.hasSound ? ' + ' + esc(real.acodec || 'audio') : ', no sound'} · ${r.width}×${r.height} · ${fmtDur(r.duration)}`;
  if (r.savedToFile) { openDialog(`<h3 id="stDlgT">Saved</h3><p>Saved to <b>${esc(r.name)}</b> on your device.</p><p class="st-muted">${info}</p><div class="st-dlg-foot"><button type="button" class="st-btn st-btn--primary" id="exDone" data-autofocus>Done</button></div>`); document.getElementById('exDone').addEventListener('click', closeDialog); return; }
  if (url) URL.revokeObjectURL(url); url = URL.createObjectURL(r.blob); const name = safeName(P().title) + '.' + r.ext;
  openDialog(`<h3 id="stDlgT">Your video is ready</h3><video class="st-result" src="${url}" controls playsinline></video><p class="st-muted">${info} · ${fmtSize(r.blob.size)}</p>
  ${(real.warnings || []).concat(r.footageSoundNote ? [r.footageSoundNote] : []).map((w) => `<div class="st-note"><i class="ph ph-info"></i><div><p>${esc(w)}</p></div></div>`).join('')}${r.missingFootage ? `<div class="st-note"><i class="ph ph-info"></i><div><p>${r.missingFootage} clip(s) had missing media and were left blank.</p></div></div>` : ''}
  <div class="st-dlg-foot"><button type="button" class="st-btn" id="exClose">Close</button><button type="button" class="st-btn st-btn--primary" id="exDl" data-autofocus><i class="ph ph-download-simple"></i>Download .${esc(r.ext)}</button></div>`, { onClose: () => { if (url) { URL.revokeObjectURL(url); url = ''; } } });
  document.getElementById('exClose').addEventListener('click', closeDialog); document.getElementById('exDl').addEventListener('click', () => download(r.blob, name));
}
function renderRun() {
  openDialog(`<h3 id="stDlgT">Exporting</h3><p id="exStage" role="status" aria-live="polite">${esc(job.stage)}</p><div class="st-bar" role="progressbar" aria-label="Export progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" id="exBar"><i id="exFill"></i></div><p class="st-muted" id="exEta"></p><p class="st-muted st-small">Keep this tab open${plan && plan.engine === 'recorder' ? ' and in front' : ''}.</p>
  <div class="st-dlg-foot"><button type="button" class="st-btn st-btn--danger" id="exStop" data-autofocus>Cancel export</button></div>`, { locked: true }); document.getElementById('exStop').addEventListener('click', () => { job.cancelled = true; document.getElementById('exStop').disabled = true; job.stage = 'Cancelling'; paintRun(); if (job.handle) job.handle.cancel(); });
  paintRun();
}
function paintRun() { const s = document.getElementById('exStage'); if (!s || !job) return; s.textContent = job.stage; const pct = Math.round(job.frac * 100); document.getElementById('exFill').style.width = pct + '%'; document.getElementById('exBar').setAttribute('aria-valuenow', pct); document.getElementById('exEta').textContent = pct + '%' + (job.eta != null && job.eta > 1 ? ' · about ' + fmtDur(job.eta) + ' left' : ''); }
void strip; void markDirty;
