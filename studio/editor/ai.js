// studio/editor/ai.js
// The AI tab and everything that talks to Cognita's services: storyboard -> timeline adapter, Assistant, narration clips, AI pictures.
// Plus the LOCAL tools (scene detection, reframe). Media never leaves the device; only small JSON/text goes to the Worker.

import { S, P, emit, transact, selClips, clipById, toast, addAssetRecord, sceneEndShift, splitAt, addClip, bump, snapT } from './state.js';
import * as M from '../model.js';
import * as sb from '../storyboard.js';
import * as nar from '../narration.js';
import * as media from '../media.js';
import * as store from '../store.js';
import { getAsset } from '../store.js';
import { esc } from './util.js';
import { narrKey } from '../engine.js';

const STORY_ROLES = { storyboard: ['video', 'Storyboard'], storyCaptions: ['caption', 'Captions'], narration: ['audio', 'Narration'], music: ['audio', 'Music'] };
export const nStatus = () => (S.status && S.status.narration) || { allowed: false, voices: [] };
export const sttStatus = () => (S.status ? S.status.transcription || { allowed: false, notDeployed: true } : { allowed: false, unknown: true });
export async function refreshStatus() { try { S.status = await nar.loadStatus(); } catch (_) { S.status = null; } emit('status-narr'); }
let log = []; let busy = false; let draft = { story: '', ask: '', pic: '' };

function ensureRole(pp, role) {
  let t = pp.tracks.find((x) => x.role === role); if (t) return t; const [type, name] = STORY_ROLES[role]; t = M.newTrack(type, name, { role });
  if (type === 'audio') pp.tracks.push(t); else if (role === 'storyboard') { const mi = pp.tracks.findIndex((x) => x.role === 'main'); pp.tracks.splice(mi >= 0 ? mi : pp.tracks.length, 0, t); } else pp.tracks.unshift(t); return t;
}
const storyEnd = (pp) => pp.clips.filter((c) => c.kind === 'scene').reduce((a, c) => Math.max(a, c.start + c.duration), 0);

// Turns the model's storyboard JSON into scene, caption and music clips on the project (appended after the existing storyboard).
export async function appendStoryboard(raw, { imageIds = [], videoIds = [], aiImages = false, onStage = () => {}, extraVideo = false } = {}) {
  const p = P(); const warnings = [];
  const v1 = sb.normaliseProject(raw, { id: 'x', aspect: p.settings.aspect === '16:9' ? '16:9' : p.settings.aspect === '1:1' ? '1:1' : '9:16', style: p.style, music: 'none', captions: true, lang: p.lang, voice: p.voice, rate: p.rate, language: p.language, assets: [] }, imageIds, videoIds);
  (raw.scenes || []).slice(0, v1.scenes.length).forEach((rs, i) => { const sc = v1.scenes[i]; if (Number.isInteger(rs.imageIndex) && imageIds[rs.imageIndex]) { sc.image = imageIds[rs.imageIndex]; if (rs.layout === 'image') sc.layout = 'image'; } if (Number.isInteger(rs.videoIndex) && videoIds[rs.videoIndex] && rs.layout === 'video') { sc.video = videoIds[rs.videoIndex]; sc.layout = 'video'; } });
  if (extraVideo) { const used = new Set(v1.scenes.filter((s) => s.layout === 'video').map((s) => s.video)); videoIds.forEach((id) => { if (id && !used.has(id)) { const a = M.assetOf(p, id); v1.scenes.splice(Math.max(1, v1.scenes.length - 1), 0, sb.normaliseScene({ title: (a ? a.name : 'Clip').replace(/\.[^.]+$/, '').slice(0, 60), layout: 'video', video: id, duration: 6 }, [], [id])); } }); }
  v1.scenes.forEach((sc) => { if (sc.layout === 'video') { const a = M.assetOf(p, sc.video); if (a) { sc.duration = Math.max(2, Math.min(a.duration, 12)); sc.keepAudio = !!a.hasAudio; } } });
  if (!v1.scenes.length) throw new Error('The AI did not return any scenes. Please try again.');
  const wanted = v1.scenes.filter((s) => s.layout === 'image' && !s.image && s.imagePrompt).slice(0, 4);
  if (wanted.length && aiImages) {
    let stopped = false;
    for (const [i, sc] of wanted.entries()) { if (stopped) { sc.layout = 'title'; continue; } onStage('Picture ' + (i + 1) + ' of ' + wanted.length);
      try { const d = await media.generateAiImage(sc.imagePrompt); const a = await media.importBlob(d.blob, 'AI picture ' + (i + 1) + '.jpg', 'image', 'generated', S.hub.ctx()); a.name = 'AI picture: ' + sc.imagePrompt.slice(0, 40); addAssetRecord(a); await S.hub.ensure(M.assetOf(P(), a.id)); sc.image = a.id; } catch (e) { sc.layout = 'title'; warnings.push('A picture could not be made: ' + (e.message || 'unknown error')); if (e.status === 429) stopped = true; } }
  } else v1.scenes.forEach((s) => { if (s.layout === 'image' && !s.image) s.layout = 'title'; });
  const built = M.v1ToV2({ ...v1, id: 'x', assets: [], vol: 0.5 }); const roleOf = new Map(built.tracks.map((t) => [t.id, t.role]));
  transact('Add storyboard', (pp) => {
    const off = storyEnd(pp); const ids = [];
    built.clips.forEach((c) => { const role = roleOf.get(c.trackId); if (role === 'music') { if (pp.clips.some((x) => x.kind === 'music')) return; } c.trackId = ensureRole(pp, role).id; c.start += off; if (c.kind === 'scene' && c.scene.video) c.scene.keepAudio = !!c.scene.keepAudio; pp.clips.push(c); ids.push(c.id); });
    const mus = pp.clips.find((x) => x.kind === 'music'); if (mus && v1.music !== 'none') { mus.music.kind = v1.music; }
    S.sel = new Set(built.clips.filter((c) => c.kind === 'scene').map((c) => c.id).slice(0, 1));
  });
  return warnings;
}

// ───────── narration ─────────
const clipKey = (text) => narrKey(P(), { caption: text });
export function narrState(c) {
  const text = (c.text && c.text.content || '').trim(); if (!text) return 'none';
  const n = P().clips.find((x) => x.kind === 'audio' && x.narr && x.link === (c.link || c.id)); if (!n) return 'missing'; return n.narr.key === clipKey(text) ? 'ready' : 'outdated';
}
export const narratable = () => P().clips.filter((c) => (c.kind === 'caption' && c.link) || (c.kind === 'caption' && selClips().includes(c)) || (c.kind === 'text' && selClips().includes(c)));
export const needsNarration = () => narratable().filter((c) => ['missing', 'outdated'].includes(narrState(c)));
export async function narrateClips(clips, { onProgress } = {}) {
  const res = { done: 0, failed: [], stopped: '' }; const ctl = new AbortController(); S.narrJob = { ctl, n: 0, m: clips.length }; let bad = 0;
  try {
    for (const [i, c0] of clips.entries()) {
      if (ctl.signal.aborted) { res.stopped = 'Cancelled.'; break; } S.narrJob.n = i + 1; onProgress && onProgress(i + 1, clips.length); const c = clipById(c0.id); if (!c) continue; const text = c.text.content.trim(); if (!text) continue;
      try {
        const r = await nar.synthesizeScene(P(), { caption: text }, ctl.signal); await S.hub.soundFor(P(), 'narr_' + r.narr.key); const owner = c.link || c.id; const lead = c.link ? 0.15 : 0;
        transact('Narration', (pp) => {
          pp.clips = pp.clips.filter((x) => !(x.kind === 'audio' && x.narr && x.link === owner));
          const tr = ensureNarrTrack(pp, c.start + lead, r.narr.dur);
          pp.clips.push(M.newClip('audio', { trackId: tr.id, assetId: 'narr_' + r.narr.key, start: c.start + lead, duration: r.narr.dur, name: 'Narration: ' + text.slice(0, 30), link: owner, narr: { key: r.narr.key, dur: r.narr.dur, text, voice: r.narr.voice || pp.voice, rate: r.narr.rate || 1, engine: r.narr.engine || '' }, audio: { role: 'voice', gain: 1 } }));
          if (c.link) { const need = lead + r.narr.dur + 0.5; const sc = pp.clips.find((x) => x.id === c.link); if (sc && sc.duration < need) sceneEndShift(sc.id, need); } else c.cap && (c.cap.dur = r.narr.dur);
          if (c.cap) { c.cap.lead = lead; c.cap.dur = r.narr.dur; }
        });
        if (S.status && S.status.narration && r.left != null) S.status.narration.charsLeft = r.left; res.done++; bad = 0;
      } catch (e) { if (e.name === 'AbortError') { res.stopped = 'Cancelled.'; break; } res.failed.push({ id: c.id, message: e.message, code: e.code }); if (['PLAN_REQUIRED', 'DAILY_LIMIT', 'TTS_NOT_CONFIGURED', 'NO_VOICE'].includes(e.code)) { res.stopped = e.message; break; } if (++bad >= 2) { res.stopped = e.message; break; } }
    }
  } finally { S.narrJob = null; }
  return res;
}
function ensureNarrTrack(pp, start, d) {
  const free = (t) => !pp.clips.some((x) => x.trackId === t.id && x.start < start + d - 1e-6 && x.start + x.duration > start + 1e-6);
  let t = pp.tracks.find((x) => x.role === 'narration' && free(x)) || pp.tracks.find((x) => x.type === 'audio' && !x.locked && x.role !== 'music' && free(x)); if (t) return t;
  t = M.newTrack('audio', 'Narration', { role: pp.tracks.some((x) => x.role === 'narration') ? undefined : 'narration' }); pp.tracks.push(t); return t;
}

// ───────── the tab ─────────
export function renderAI(b) {
  const ns = nStatus(); const p = P(); const voices = (ns.voices || []).filter((v) => v.lang === p.lang); const need = needsNarration(); const scenes = p.clips.filter((c) => c.kind === 'scene').length; const vids = selClips().filter((c) => c.kind === 'video');
  const job = S.narrJob;
  b.innerHTML = `
  <h4 class="st-h">Create scenes from a prompt</h4><p class="st-muted st-small">Cognita writes a storyboard and adds it to the timeline as editable scenes, captions and music. Uses one message from your daily allowance.</p>
  <textarea id="aiStory" rows="3" placeholder="e.g. A 30 second welcome video for new parents at Fahmid Nursery and Primary School" aria-label="Describe the scenes">${esc(draft.story)}</textarea>
  <div class="st-inline"><label class="st-check"><input type="checkbox" id="aiImgs"> AI pictures for up to 4 scenes</label><button type="button" class="st-btn st-btn--primary" id="aiGo"${busy ? ' disabled' : ''}><i class="ph ph-magic-wand"></i>Create scenes</button></div>
  <h4 class="st-h">Assistant</h4><p class="st-muted st-small">${scenes ? 'Ask for a change to the AI storyboard (scenes, captions, transitions, look). Other tracks are left alone. Undo restores everything.' : 'The Assistant edits AI storyboards. This project has none yet, so create scenes above first.'}</p>
  <div class="st-log" id="aiLog" aria-live="polite">${log.map((m) => `<div class="st-msg st-msg--${m.k}">${esc(m.t)}</div>`).join('')}</div>
  <div class="st-ask"><textarea id="aiAsk" rows="2" placeholder="e.g. Make every scene 4 seconds" aria-label="Edit instruction"${scenes ? '' : ' disabled'}>${esc(draft.ask)}</textarea><button type="button" class="st-btn st-btn--primary" id="aiApply"${scenes && !busy ? '' : ' disabled'}>Apply</button></div>
  <h4 class="st-h">Narration</h4>${narrBlock(ns, voices, need, job)}
  <h4 class="st-h">AI picture</h4><textarea id="aiPic" rows="2" maxlength="300" placeholder="Describe a picture to generate" aria-label="Picture description">${esc(draft.pic)}</textarea><div class="st-inline"><button type="button" class="st-btn" id="aiPicGo"><i class="ph ph-sparkle"></i>Generate picture</button><small class="st-muted">Adds it to Media. Uses your daily picture allowance.</small></div>
  <h4 class="st-h">Local tools <span class="st-tag st-tag--local">LOCAL</span></h4><p class="st-muted st-small">These run in your browser. Nothing is uploaded.</p>
  <div class="st-inline st-wrap"><button type="button" class="st-btn" id="aiScenes"${vids.length ? '' : ' disabled'}>Detect scene cuts in selected clip</button></div>
  <div class="st-inline st-wrap"><span class="st-muted st-small">Reframe all video and pictures:</span><button type="button" class="st-btn" data-fit="fill">Fill (centre crop)</button><button type="button" class="st-btn" data-fit="fit">Fit</button><button type="button" class="st-btn" data-fit="fitblur">Fit on blurred background</button></div>
  <p class="st-muted st-small">Chroma key lives in the clip inspector (Chroma key section) and the beat tools are in the Audio tab.</p>
  <h4 class="st-h">On-device tools <span class="st-tag st-tag--local">LOCAL</span></h4><div class="st-list"><div class="st-row-item"><div><b>Background removal, stabilisation, motion tracking</b><small>Select a video or picture clip and open the Inspector: Remove background, Stabilise and Track motion are there. They run in this browser and nothing is uploaded. Automatic captions can also run on this device (Captions tab).</small></div></div>
  <div class="st-row-item"><div><b>Automatic captions <span class="st-tag st-tag--local">ON DEVICE</span> <span class="st-tag st-tag--svc">or cloud</span></b><small>Turns the speech in a clip into caption cues. On this device is free and private. The cloud option is more accurate and is part of the Studio plan (only the sound is sent, in short pieces).</small></div><button type="button" class="st-btn" id="goCaps">Open Captions</button></div>`;
  const q = (s) => b.querySelector(s); const gc = b.querySelector('#goCaps'); if (gc) gc.addEventListener('click', () => import('./library.js').then((m) => m.setTab('captions')));
  q('#aiStory').addEventListener('input', (e) => { draft.story = e.target.value; }); q('#aiAsk').addEventListener('input', (e) => { draft.ask = e.target.value; }); q('#aiPic').addEventListener('input', (e) => { draft.pic = e.target.value; });
  q('#aiGo').addEventListener('click', async () => { const text = draft.story.trim(); if (text.length < 8) { toast('Describe the video in a little more detail.'); return; } busy = true; q('#aiGo').disabled = true; q('#aiGo').textContent = 'Working…';
    try { const raw = await sb.generateStoryboard({ prompt: text, mode: 'prompt', options: { aspect: p.settings.aspect === '16:9' ? '16:9' : p.settings.aspect === '1:1' ? '1:1' : '9:16', duration: 30, style: p.style, music: 'calm', language: p.language, captions: true, aiImages: q('#aiImgs').checked }, imageCount: 0, videoClips: [], sourceText: '' }); if (raw.clarify && !(raw.scenes && raw.scenes.length)) { toast(String(raw.clarify).slice(0, 200)); } else { const w = await appendStoryboard(raw, { aiImages: q('#aiImgs').checked }); toast(w[0] || 'Scenes added to the timeline.'); draft.story = ''; } }
    catch (e) { toast(e.status === 429 ? 'You have reached your message limit for now.' : e.message || 'Could not create scenes.'); } busy = false; renderAI(b); });
  q('#aiApply').addEventListener('click', () => runAssistant(b));
  q('#aiAsk').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); runAssistant(b); } });
  const nAll = q('#nAll'); if (nAll) nAll.addEventListener('click', async () => { const todo = needsNarration(); if (!todo.length) return; const chars = todo.reduce((a, c) => a + c.text.content.trim().length, 0); if (ns.charsLeft != null && chars > ns.charsLeft && !window.confirm('This needs about ' + chars + ' characters but you have ' + ns.charsLeft + ' left today. Narrate as many as fit?')) return; renderAI(b); const r = await narrateClips(todo, { onProgress: () => renderAI(b) }); toast(r.done ? 'Narration ready for ' + r.done + ' clip' + (r.done === 1 ? '' : 's') + (r.stopped || r.failed.length ? '. ' + (r.stopped || r.failed[0].message) : '.') : (r.stopped || (r.failed[0] && r.failed[0].message) || 'No narration was created.')); refreshStatus(); renderAI(b); });
  const nc = q('#nCancel'); if (nc) nc.addEventListener('click', () => S.narrJob && S.narrJob.ctl.abort());
  const nv = q('#nVoice'); if (nv) nv.addEventListener('change', () => { transact('Voice', (pp) => { pp.voice = nv.value; }); renderAI(b); }); const nr = q('#nRate'); if (nr) nr.addEventListener('change', () => { transact('Narration speed', (pp) => { pp.rate = Number(nr.value); }); renderAI(b); });
  const nrt = q('#nRetry'); if (nrt) nrt.addEventListener('click', async () => { await refreshStatus(); renderAI(b); });
  q('#aiPicGo').addEventListener('click', async (e) => { const t = draft.pic.trim(); if (!t) { toast('Describe the picture first.'); return; } e.currentTarget.disabled = true; try { const d = await media.generateAiImage(t); const a = await media.importBlob(d.blob, 'AI picture.jpg', 'image', 'generated', S.hub.ctx()); a.name = 'AI picture: ' + t.slice(0, 40); addAssetRecord(a); await S.hub.ensure(M.assetOf(P(), a.id)); toast('Picture added to Media. Click it there to place it.'); draft.pic = ''; } catch (err) { toast(err.status === 429 ? err.message : err.message || 'Could not generate the picture.'); } renderAI(b); });
  q('#aiScenes').addEventListener('click', async (e) => { const c = vids[0]; if (!c) return; e.currentTarget.disabled = true; e.currentTarget.textContent = 'Analysing…'; try { const rec = await getAsset(c.assetId); const cuts = await media.detectScenes(rec.blob); const sp = c.speed || 1; const ts = cuts.map((x) => c.start + (x - c.in) / sp).filter((t) => t > c.start + 0.3 && t < c.start + c.duration - 0.3); if (!ts.length) toast('No scene cuts found.'); else { transact('Split at scene cuts', (pp) => { ts.sort((a, z) => a - z).forEach((t) => { const tgt = pp.clips.find((x) => x.trackId === c.trackId && x.kind === 'video' && x.start < t - 0.02 && x.start + x.duration > t + 0.02); if (tgt) splitAtInner(pp, tgt, t); }); }); toast('Split into ' + (ts.length + 1) + ' clips at scene cuts.'); } } catch (err) { toast(err.message || 'Scene detection failed.'); } renderAI(b); });
  b.querySelectorAll('[data-fit]').forEach((x) => x.addEventListener('click', () => { const fit = x.dataset.fit; transact('Reframe', (pp) => { pp.clips.forEach((c) => { if (c.kind === 'video' || c.kind === 'image') { c.transform.fit = fit; if (fit === 'fill') { c.transform.x = 0; c.transform.y = 0; } } }); }); }));
}
function splitAtInner(pp, c, t) { const p = t - c.start; const d = c.duration, sp = c.speed || 1; const R = JSON.parse(JSON.stringify(c)); R.id = M.nid('c'); R.start = t; R.duration = d - p; R.in = c.in + p * sp; R.transitionIn = { type: 'none', duration: 0.6, dir: 'left' }; c.duration = p; c.transitionOut = { type: 'none', duration: 0.6, dir: 'left' }; pp.clips.push(R); }
function narrBlock(ns, voices, need, job) {
  const p = P();
  if (job) return `<div class="st-card-s"><strong>Recording narration</strong><p>Clip ${job.n} of ${job.m}</p><div class="st-prog"><i style="width:${Math.round(((job.n - 1) / job.m) * 100)}%"></i></div><button type="button" class="st-btn" id="nCancel">Cancel</button></div>`;
  if (!ns.allowed) return `<div class="st-card-s"><p>${ns.offline ? 'You are offline, so narration cannot be checked.' : ns.error ? 'Could not check your plan right now.' : 'Spoken narration is part of the Cognita Studio plan. Captions, music and everything else stay free.'}</p>${ns.offline || ns.error ? '<button type="button" class="st-btn" id="nRetry">Check again</button>' : '<a class="st-btn st-btn--primary" href="/pricing.html">See plans</a>'}</div>`;
  if (!voices.length) return `<div class="st-card-s"><p>There is no narration voice for ${esc(p.language || 'this language')} yet. Captions and music still work.</p></div>`;
  const chars = need.reduce((a, c) => a + c.text.content.trim().length, 0);
  return `<div class="st-card-s"><div class="st-row2"><div class="st-field"><label for="nVoice">Voice</label><select id="nVoice">${voices.map((v) => `<option value="${v.id}"${v.id === p.voice ? ' selected' : ''}>${esc(v.name)} (${v.gender})</option>`).join('')}</select></div><div class="st-field"><label for="nRate">Speed</label><select id="nRate">${[[0.9, 'Slower'], [1, 'Normal'], [1.1, 'Faster']].map(([v, l]) => `<option value="${v}"${(p.rate || 1) === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div></div>
    <p class="st-muted st-small">${need.length ? need.length + ' caption' + (need.length === 1 ? '' : 's') + ' need narration, about ' + chars + ' characters.' : 'Every storyboard caption (and any caption or text clip you have selected) has narration.'} ${ns.charsLeft != null ? ns.charsLeft + ' characters left today.' : 'No daily limit on your account.'} Changing the voice or speed makes existing narration outdated. To narrate a single caption or text clip, select it first.</p>
    <button type="button" class="st-btn st-btn--primary" id="nAll"${need.length ? '' : ' disabled'}><i class="ph ph-microphone"></i>Generate narration</button></div>`;
}
async function runAssistant(b) {
  const ta = b.querySelector('#aiAsk'); const text = ta.value.trim(); if (!text || busy) return; log.push({ k: 'u', t: text }, { k: 'w', t: 'Working on it…' }); busy = true; draft.ask = ''; renderAI(b);
  try {
    const v1 = M.toV1View(P()); const r = await sb.editProject(v1, text, P().assets.filter((a) => a.kind === 'image').map((a) => a.id), P().assets.filter((a) => a.kind === 'video').map((a) => a.id)); log.pop();
    if (r.unsupported) log.push({ k: 'a', t: 'This cannot be done yet. ' + r.unsupported });
    else { transact('Assistant', (pp) => { M.applyStoryboard(pp, r.project); }); const out = needsNarration().filter((c) => narrState(c) === 'outdated').length; log.push({ k: 'a', t: r.summary + ' Undo restores the previous version.' + (out ? ' ' + out + ' caption(s) changed, so regenerate their narration.' : '') }); }
  } catch (e) { log.pop(); log.push({ k: 'e', t: e.message || 'The edit failed.' }); }
  busy = false; renderAI(b);
}
export const resetAI = () => { log = []; busy = false; draft = { story: '', ask: '', pic: '' }; };
