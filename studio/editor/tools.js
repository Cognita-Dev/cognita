// studio/editor/tools.js
// Inspector sections for the on-device tools: Stabilise, Remove background, Track motion, and Follow a tracked point.
// All of them are LOCAL: the analysis runs in this browser (stabilisation and tracking in plain JavaScript, background removal in the
// isolated model frame). Results are stored on the clip and drawn by render.js, so preview and export match.

import { S, P, emit, selClips, clipById, setClip, transact, toast } from './state.js';
import * as M from '../model.js';
import * as AN from '../analyze.js';
import { canvasToSource, trackedCanvasPoint } from '../render.js';
import { removeMatte, forgetMatte } from '../matte.js';
import { mlSupported } from '../ml-client.js';
import { esc } from './util.js';

let host = null, repaint = () => {};
const ui = { trackSize: 'medium', follow: '' };
const fpsOf = (c) => { const a = P().assets.find((x) => x.id === c.assetId); return a && a.fps ? a.fps : 0; };
let job = null; // { clipId, kind, frac, stage, abort, note }

export function initTools(el, api) {
  host = el; repaint = api.rebuild;
  el.addEventListener('change', (e) => { const t = e.target; if (t && t.dataset && t.dataset.toolsel === 'size') ui.trackSize = t.value; else if (t && t.dataset && t.dataset.toolsel === 'follow') ui.follow = t.value; });
}
export const toolBusy = () => !!job;

const bar = (j) => `<div class="st-bar" role="progressbar" aria-label="${esc(j.stage)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(j.frac * 100)}"><i data-toolbar style="width:${Math.round(j.frac * 100)}%"></i></div><p class="st-muted st-small" role="status" data-toolstage>${esc(j.stage)}</p><div class="st-inline"><button type="button" class="st-btn" data-tool="cancel">Cancel</button></div>`;
const running = (c, kind) => job && job.clipId === c.id && job.kind === kind;
const busyElse = (c, kind) => job && !(job.clipId === c.id && job.kind === kind);
const why = (c, kind) => AN.blockReason(c, kind);

function paintProgress() {
  if (!host || !job) return;
  const b = host.querySelector('[data-toolbar]'); if (b) b.style.width = Math.round(job.frac * 100) + '%';
  const s = host.querySelector('[data-toolstage]'); if (s) s.textContent = job.stage;
}

// ───────── html ─────────
function stabHtml(c, H) {
  if (running(c, 'stabilise')) return bar(job);
  const block = why(c, 'stabilise'); const dis = block || busyElse(c, 'stabilise') ? ' disabled' : '';
  const st = c.stab;
  return `${st ? `${H.ck(c, 'Stabilisation on', 'stab.on')}${st.on ? `${H.sl(c, 'Strength', 'stab.strength', 0, 100, 1, { scale: 100, unit: '%' })}${H.sl(c, 'Crop limit', 'stab.zoomMax', 100, 160, 1, { scale: 100, unit: '%' })}<p class="st-muted st-small">Stronger smoothing removes more shake but needs more zoom to hide the edges. The crop limit caps that zoom; past it, the correction is reduced instead of showing black borders.</p>` : ''}`
    : '<p class="st-muted st-small">Reads the movement of the whole picture (shift and slight roll), smooths it, and counter-moves each frame. Works best on handheld footage with plenty of detail. It cannot fix rolling-shutter wobble or motion blur.</p>'}
    ${block ? `<p class="st-muted st-small">${esc(block)}</p>` : ''}
    <div class="st-inline st-wrap"><button type="button" class="st-btn st-btn--primary" data-tool="stab"${dis}><i class="ph ph-video-camera"></i>${st ? 'Analyse again' : 'Analyse and stabilise'}</button>${st ? '<button type="button" class="st-btn" data-tool="stabClear">Remove</button>' : ''}</div>`;
}
function cutHtml(c, H) {
  if (running(c, 'cutout')) return bar(job);
  const sup = mlSupported(); const block = why(c, 'cutout') || (sup.ok ? '' : sup.reason); const dis = block || busyElse(c, 'cutout') ? ' disabled' : '';
  const bg = c.bg;
  return `${bg ? `${H.ck(c, 'Cut-out on', 'bg.on')}${bg.on ? `${H.sl(c, 'Edge position', 'bg.cutoff', 5, 95, 1, { scale: 100, unit: '%' })}${H.sl(c, 'Edge softness', 'bg.soft', 0, 50, 1, { scale: 100, unit: '%' })}<p class="st-muted st-small">Move Edge position up to trim more, down to keep more. Put a picture or colour on the track below to see through to it.</p>` : ''}`
    : `<p class="st-muted st-small">Finds the main subject and makes everything else transparent, on this device. The first run downloads a 5 MB model; nothing is uploaded. It works best on a clear person or object. ${c.kind === 'video' ? 'Video is cut out at up to 10 frames per second and blended in between, so it takes a while on long clips.' : ''}</p>`}
    ${block ? `<p class="st-muted st-small">${esc(block)}</p>` : ''}
    <div class="st-inline st-wrap"><button type="button" class="st-btn st-btn--primary" data-tool="cut"${dis}><i class="ph ph-scissors"></i>${bg ? 'Cut out again' : 'Remove background'}</button>${bg ? '<button type="button" class="st-btn" data-tool="cutClear">Remove cut-out</button>' : ''}</div>`;
}
function trackHtml(c) {
  if (running(c, 'track')) return bar(job);
  const block = why(c, 'track'); const dis = block || busyElse(c, 'track') ? ' disabled' : ''; const picking = !!S.pickPoint;
  const list = (c.tracks || []).map((t) => { const n = t.pts.length / 2, lost = (t.ok.match(/0/g) || []).length; return `<div class="st-row-item"><div><b>${esc(t.name)}</b><small>${n} frames${lost ? ', lost on ' + lost : ', never lost'}</small></div><button type="button" class="st-icon" data-tool="trackDel" data-id="${esc(t.id)}" aria-label="Remove ${esc(t.name)}"><i class="ph ph-x"></i></button></div>`; }).join('');
  return `<p class="st-muted st-small">Move the playhead to a frame where the point is clearly visible, press Pick a point, then click it on the preview. It is followed forwards and backwards through the clip. Then select a text, sticker, shape or picture clip and attach it under Follow a tracked point.</p>
    ${block ? `<p class="st-muted st-small">${esc(block)}</p>` : ''}
    <div class="st-field"><label for="trkSize">Size of the area to follow</label><select id="trkSize" data-toolsel="size">${[['small', 'Small (precise detail)'], ['medium', 'Medium'], ['large', 'Large (steady surface)']].map(([v, l]) => `<option value="${v}"${ui.trackSize === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="st-inline st-wrap"><button type="button" class="st-btn st-btn--primary" data-tool="pick"${dis || (c.tracks && c.tracks.length >= 6 ? ' disabled' : '')} aria-pressed="${picking}"><i class="ph ph-crosshair"></i>${picking ? 'Click the point on the preview…' : 'Pick a point to follow'}</button></div>
    ${list ? `<div class="st-list">${list}</div>` : ''}`;
}
function followHtml(c) {
  const opts = []; for (const v of P().clips) { if (v.kind !== 'video' || !v.tracks) continue; for (const t of v.tracks) opts.push([v.id + '|' + t.id, (v.name || 'Video clip') + ' · ' + t.name]); }
  const cur = c.follow ? c.follow.clipId + '|' + c.follow.trackId : '';
  if (c.follow) { const src = clipById(c.follow.clipId); const ok = src && (src.tracks || []).some((t) => t.id === c.follow.trackId); return `<p class="st-small">${ok ? 'Following <b>' + esc((src.name || 'Video clip') + ' · ' + src.tracks.find((t) => t.id === c.follow.trackId).name) + '</b>. Position X and Y are now offsets from the tracked point.' : 'The tracked point this clip followed no longer exists, so it stays where it is.'}</p><div class="st-inline"><button type="button" class="st-btn" data-tool="detach">Stop following</button></div>`; }
  if (!opts.length) return '<p class="st-muted st-small">No tracked points yet. Select a video clip and use Track motion first.</p>';
  const sel = ui.follow && opts.some((o) => o[0] === ui.follow) ? ui.follow : opts[0][0]; void cur;
  return `<div class="st-field"><label for="trkFollow">Tracked point</label><select id="trkFollow" data-toolsel="follow">${opts.map(([v, l]) => `<option value="${esc(v)}"${sel === v ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div><div class="st-inline"><button type="button" class="st-btn st-btn--primary" data-tool="attach"><i class="ph ph-link"></i>Attach to this point</button></div><p class="st-muted st-small">The clip keeps its place on screen at the playhead and moves with the point from there.</p>`;
}

// H = { sec, sl, ck } from the inspector (its markup helpers)
export function toolsHtml(c, H) {
  const k = c.kind; let out = '';
  const tag = '<span class="st-tag st-tag--local">LOCAL</span>';
  if (k === 'video') out += H.sec('stab', 'Stabilise ' + tag, stabHtml(c, H));
  if (k === 'video' || k === 'image') out += H.sec('cutout', 'Remove background ' + tag, cutHtml(c, H));
  if (k === 'video') out += H.sec('track', 'Track motion ' + tag, trackHtml(c));
  if (k === 'text' || k === 'shape' || k === 'sticker' || k === 'image' || k === 'caption') out += H.sec('follow', 'Follow a tracked point ' + tag, followHtml(c));
  return out;
}

// ───────── jobs ─────────
async function run(c, kind, fn, done) {
  if (job) return; const ctl = new AbortController(); job = { clipId: c.id, kind, frac: 0, stage: 'Starting', abort: ctl };
  const onProgress = (p) => { if (!job) return; job.frac = Math.max(0, Math.min(1, p.frac || 0)); job.stage = p.download && p.download < 1 ? p.stage + ' (' + Math.round(p.download * 100) + '%)' : p.stage; paintProgress(); };
  repaint();
  try { const r = await fn(onProgress, ctl.signal); const msg = done(r); if (msg) toast(msg); }
  catch (e) { if (e && e.name === 'AbortError') toast('Cancelled.'); else toast((e && e.message) || 'That did not work.'); }
  finally { job = null; emit('frame'); repaint(); }
}

function onPick(clipId, fx, fy) {
  const c = clipById(clipId); if (!c) return; const ref = M.videoRef(c); const local = M.clamp(S.t - c.start, 0, c.duration);
  const pw = P().settings.width, ph = P().settings.height; const fr = ref && S.hub.res.frame(ref, M.srcTime(ref, local));
  if (!fr) { toast('The picture is not ready yet. Try again in a moment.'); return; }
  const pt = canvasToSource(c, local, fr, fx * pw, fy * ph, pw, ph);
  if (!pt || pt.x < 0.02 || pt.x > 0.98 || pt.y < 0.02 || pt.y > 0.98) { toast('That point is outside the picture or too close to its edge.'); return; }
  const n = (c.tracks || []).length + 1;
  run(c, 'track', (onProgress, signal) => AN.analyseTrack({ clip: c, fps: fpsOf(c), fx: pt.x, fy: pt.y, local, size: ui.trackSize, name: 'Track ' + n, onProgress, signal }), (r) => {
    setClip(c.id, (x) => { x.tracks = (x.tracks || []).concat(r.track).slice(-6); }, 'Track motion');
    return r.found < r.frames * 0.5 ? 'The point was lost on most frames. Try a point with more detail, or a larger area.' : r.lost ? 'Tracked. The point was lost on ' + r.lost + ' of ' + r.frames + ' frames (it holds its last place there).' : 'Tracked all ' + r.frames + ' frames. Now attach a text or sticker to it.';
  });
}

export function handleToolClick(e) {
  const b = e.target.closest('[data-tool]'); if (!b) return false; const c = selClips()[0]; if (!c) return true; const a = b.dataset.tool;
  if (a === 'cancel') { if (job && job.abort) job.abort.abort(); return true; }
  if (a === 'stab') { run(c, 'stabilise', (onProgress, signal) => AN.analyseStabilise({ clip: c, fps: fpsOf(c), onProgress, signal }), (r) => { setClip(c.id, (x) => { x.stab = r.stab; }, 'Stabilise'); return r.weakShare > 0.3 ? 'Stabilised, but parts of this clip have little detail to lock onto, so those parts may still shake.' : 'Stabilised. Adjust Strength to taste.'; }); }
  else if (a === 'stabClear') setClip(c.id, (x) => { delete x.stab; }, 'Remove stabilisation');
  else if (a === 'cut') { const prev = c.bg && c.bg.key; run(c, 'cutout', (onProgress, signal) => AN.analyseCutout({ clip: c, previousKey: prev, onProgress, signal }), (r) => { setClip(c.id, (x) => { x.bg = r.bg; }, 'Remove background'); return 'Background removed (' + r.frames + (r.frames === 1 ? ' frame' : ' frames') + ', ' + Math.round(r.seconds) + ' s).'; }); }
  else if (a === 'cutClear') { const k = c.bg && c.bg.key; setClip(c.id, (x) => { delete x.bg; }, 'Remove cut-out'); if (k) { forgetMatte(k); removeMatte(k); } }
  else if (a === 'pick') {
    if (S.pickPoint) { S.pickPoint = null; repaint(); return true; }
    const cid = c.id; S.pickPoint = (fx, fy) => { S.pickPoint = null; onPick(cid, fx, fy); }; toast('Click the point to follow on the preview.'); repaint();
  }
  else if (a === 'trackDel') { const id = b.dataset.id; transact('Remove track', (p) => { const v = p.clips.find((x) => x.id === c.id); if (!v) return; v.tracks = (v.tracks || []).filter((t) => t.id !== id); if (!v.tracks.length) delete v.tracks; p.clips.forEach((o) => { if (o.follow && o.follow.clipId === c.id && o.follow.trackId === id) delete o.follow; }); }); }
  else if (a === 'attach') {
    const sel = host.querySelector('#trkFollow'); const val = sel ? sel.value : ''; const [cid, tid] = val.split('|'); const src = clipById(cid); if (!src) return true;
    const pw = P().settings.width, ph = P().settings.height; const p = trackedCanvasPoint(P(), src, tid, S.t, pw, ph, S.hub.res);
    if (!p) { toast('The tracked picture is not ready yet. Try again in a moment.'); return true; }
    const local = M.clamp(S.t - c.start, 0, c.duration); const cx = M.valueAt(c, 'transform.x', local), cy = M.valueAt(c, 'transform.y', local);
    transact('Attach to tracked point', (pp) => { const v = pp.clips.find((x) => x.id === c.id); v.follow = { clipId: cid, trackId: tid }; if (v.keyframes) { delete v.keyframes['transform.x']; delete v.keyframes['transform.y']; } v.transform.x = cx - (p.x / pw - 0.5); v.transform.y = cy - (p.y / ph - 0.5); });
  }
  else if (a === 'detach') {
    const src = c.follow && clipById(c.follow.clipId); const pw = P().settings.width, ph = P().settings.height; const p = src && trackedCanvasPoint(P(), src, c.follow.trackId, S.t, pw, ph, S.hub.res);
    transact('Stop following', (pp) => { const v = pp.clips.find((x) => x.id === c.id); if (p) { v.transform.x += p.x / pw - 0.5; v.transform.y += p.y / ph - 0.5; } delete v.follow; });
  }
  return true;
}
