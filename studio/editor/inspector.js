// studio/editor/inspector.js
// Right panel. Nothing selected: project settings. A clip selected: sections for its kind (transform, colour, effects, speed, audio,
// text, shape, transitions, keyframes). Controls are bound by data-path, so slider drags update the model and preview without rebuilding the panel
// (a focused input is never wiped). The panel is rebuilt only when the selection or its structure changes.

import { S, P, on, emit, selClips, clipById, setClip, setProp, toggleKeyframe, setSpeed, freezeFrame, detachAudio, transact, toast, splitAt, deleteClips, duplicateSel, groupSel, ungroupSel, bump, markDirty, strip, usageOf } from './state.js';
import * as M from '../model.js';
import * as LD from '../library-data.js';
import * as store from '../store.js';
import { esc, download, safeName, fmtSize } from './util.js';
import { seek } from './preview.js';
import { narrState, narrateClips, nStatus } from './ai.js';
import { setTab } from './library.js';

let wiredBus = false, host = null, sig = '', rafSync = 0, shown = 'main';
const VIS = new Set(['video', 'image', 'text', 'shape', 'sticker', 'scene', 'caption']);
export function mountInspector(el) {
  host = el; sig = ''; host.addEventListener('input', onInput); host.addEventListener('change', onChange); host.addEventListener('click', onClick);
  if (!wiredBus) { wiredBus = true; on('sel', () => build()); on('project', () => { build(); }); on('assets', () => build(true)); on('playhead', () => { cancelAnimationFrame(rafSync); rafSync = requestAnimationFrame(syncValues); }); on('inspect', (w) => { shown = w || 'main'; build(true); const t = host.querySelector('[data-sec="' + shown + '"]'); if (t) { t.open = true; t.scrollIntoView({ block: 'nearest' }); } }); } build(true);
}
const prim = () => selClips()[0] || null;
const local = (c) => M.clamp(S.t - c.start, 0, c.duration);
const curVal = (c, path) => { const v = M.valueAt(c, path, local(c)); return v; };
const hasKf = (c, path) => M.hasKeyframes(c, path); const kfNow = (c, path) => !!M.keyframeAt(c, path, local(c));

// ───────── builders ─────────
function kfBtn(c, path) { if (!c) return ''; const on_ = kfNow(c, path), has = hasKf(c, path); return `<button type="button" class="st-kf${on_ ? ' is-on' : has ? ' is-has' : ''}" data-kf="${path}" aria-label="${on_ ? 'Remove' : 'Add'} keyframe for ${M.KEYFRAME_PATHS[path] || path}" aria-pressed="${on_}" title="${on_ ? 'Remove keyframe here' : 'Add keyframe at the playhead'}"><i class="ph ph-diamond"></i></button>`; }
function sl(c, label, path, min, max, step, o = {}) { const k = o.scale || 1; const v = (curVal(c, path) ?? 0) * k; const id = 'i_' + path.replace(/\./g, '_'); return `<div class="st-ctl-row"><label for="${id}">${label}</label><input type="range" id="${id}" data-path="${path}" data-type="range" data-scale="${k}" min="${min}" max="${max}" step="${step}" value="${v}"><output data-out="${path}" data-unit="${o.unit || ''}">${fmtN(v)}${o.unit || ''}</output>${o.kf ? kfBtn(c, path) : '<span></span>'}</div>`; }
const fmtN = (n) => (Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 100) / 100);
function ck(c, label, path) { const id = 'i_' + path.replace(/\./g, '_'); return `<label class="st-check"><input type="checkbox" id="${id}" data-path="${path}" data-type="check"${M.getPath(c, path) ? ' checked' : ''}> ${label}</label>`; }
function sel(c, label, path, opts, o = {}) { const id = 'i_' + path.replace(/\./g, '_'); const v = M.getPath(c, path); return `<div class="st-field"><label for="${id}">${label}</label><select id="${id}" data-path="${path}" data-type="select">${opts.map(([val, l]) => `<option value="${esc(val)}"${String(v) === String(val) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></div>`; }
function col(c, label, path) { const id = 'i_' + path.replace(/\./g, '_'); let v = M.getPath(c, path); if (!/^#[0-9a-f]{6}$/i.test(v || '')) v = /^#[0-9a-f]{3}$/i.test(v || '') ? '#' + [...v.slice(1)].map((x) => x + x).join('') : '#ffffff'; return `<div class="st-ctl-row st-ctl-row--c"><label for="${id}">${label}</label><input type="color" id="${id}" data-path="${path}" data-type="color" value="${v}"></div>`; }
const sec = (id, title, body, open = false) => `<details class="st-sec" data-sec="${id}"${open || shown === id ? ' open' : ''}><summary>${title}</summary><div class="st-sec-b">${body}</div></details>`;
const OPTS = (arr) => arr.map((x) => (Array.isArray(x) ? x : [x, x[0].toUpperCase() + x.slice(1)]));
const ANIM_IN = OPTS([['none', 'None'], ['fade', 'Fade'], ['pop', 'Pop'], ['slideUp', 'Slide up'], ['slideDown', 'Slide down'], ['slideLeft', 'Slide from right'], ['slideRight', 'Slide from left'], ['zoom', 'Zoom']]);
const LOOPS = OPTS([['none', 'None'], ['pulse', 'Pulse'], ['float', 'Float'], ['wiggle', 'Wiggle'], ['shimmer', 'Shimmer']]);
const KIN = OPTS([['none', 'None'], ['word', 'Word by word'], ['letter', 'Letter pop'], ['typewriter', 'Typewriter'], ['slideUp', 'Slide up words'], ['highlight', 'Highlight sweep']]);

function secTransform(c) {
  const media_ = c.kind === 'video' || c.kind === 'image';
  return sec('transform', 'Position and size', `${sl(c, 'Position X', 'transform.x', -150, 150, 0.5, { scale: 100, unit: '%', kf: true })}${sl(c, 'Position Y', 'transform.y', -150, 150, 0.5, { scale: 100, unit: '%', kf: true })}${sl(c, 'Scale', 'transform.scale', 5, 400, 1, { scale: 100, unit: '%', kf: true })}${sl(c, 'Rotation', 'transform.rotation', -180, 180, 0.5, { unit: '°', kf: true })}
    <div class="st-inline"><label class="st-check"><input type="checkbox" data-path="transform.flipX" data-type="check"${c.transform.flipX ? ' checked' : ''}> Flip horizontally</label><label class="st-check"><input type="checkbox" data-path="transform.flipY" data-type="check"${c.transform.flipY ? ' checked' : ''}> Flip vertically</label></div>
    ${media_ ? sel(c, 'Fit', 'transform.fit', [['fit', 'Fit inside'], ['fill', 'Fill and crop'], ['stretch', 'Stretch'], ['fitblur', 'Fit on blurred background']]) + `<h5 class="st-h5">Crop</h5>${['l:Left', 't:Top', 'r:Right', 'b:Bottom'].map((x) => { const [k, l] = x.split(':'); return sl(c, l, 'transform.crop.' + k, 0, 80, 0.5, { scale: 100, unit: '%' }); }).join('')}` : ''}`, true);
}
function secLook(c) {
  const mk = c.transform.mask;
  return sec('look', 'Opacity, blend and mask', `${sl(c, 'Opacity', 'opacity', 0, 100, 1, { scale: 100, unit: '%', kf: true })}${sel(c, 'Blend mode', 'blend', M.BLENDS.map((b) => [b, b]))}
    ${sel(c, 'Mask', 'transform.mask.shape', [['none', 'None'], ['rect', 'Rectangle'], ['ellipse', 'Ellipse'], ['heart', 'Heart'], ['star', 'Star']])}${mk.shape !== 'none' ? `${sl(c, 'Feather', 'transform.mask.feather', 0, 120, 1)}${sl(c, 'Mask width', 'transform.mask.w', 5, 300, 1, { scale: 100, unit: '%' })}${sl(c, 'Mask height', 'transform.mask.h', 5, 300, 1, { scale: 100, unit: '%' })}${sl(c, 'Mask X', 'transform.mask.x', -100, 100, 1, { scale: 100, unit: '%' })}${sl(c, 'Mask Y', 'transform.mask.y', -100, 100, 1, { scale: 100, unit: '%' })}${ck(c, 'Invert mask', 'transform.mask.invert')}` : ''}`);
}
function secColour(c) {
  return sec('colour', 'Colour and filter', `${sel(c, 'Filter', 'filter', LD.FILTERS.map((f) => [f.id, f.label]))}${c.filter !== 'none' ? sl(c, 'Filter strength', 'filterAmount', 0, 100, 1, { scale: 100, unit: '%' }) : ''}
    ${[['brightness', 'Brightness', -100, 100], ['contrast', 'Contrast', -100, 100], ['saturation', 'Saturation', -100, 100], ['temperature', 'Temperature', -100, 100], ['tint', 'Tint', -100, 100], ['exposure', 'Exposure', -3, 3, 0.05], ['blur', 'Blur', 0, 40, 0.5], ['sharpen', 'Sharpen', 0, 100], ['vignette', 'Vignette', 0, 100], ['grain', 'Grain', 0, 100]].map(([k, l, a, b, st]) => sl(c, l, 'adjust.' + k, a, b, st || 1, { kf: ['brightness', 'contrast', 'saturation', 'blur', 'vignette'].includes(k) })).join('')}
    <button type="button" class="st-link" data-act="resetColour">Reset colour</button>`);
}
function secEffects(c) {
  return sec('effects', 'Effects', `${c.effects.map((e, i) => { const t = M.EFFECT_TYPES.find((x) => x[0] === e.type); return `<div class="st-ctl-row"><label>${t ? t[1] : e.type}</label><input type="range" data-fx="${i}" min="${t[4]}" max="${t[5]}" step="${t[5] <= 1 ? 0.01 : t[5] <= 0.3 ? 0.002 : 0.5}" value="${e.amount}" aria-label="${t[1]} amount"><button type="button" class="st-icon" data-act="rmFx" data-i="${i}" aria-label="Remove ${t[1]}"><i class="ph ph-x"></i></button></div>`; }).join('') || '<p class="st-muted st-small">No effects yet.</p>'}
    <div class="st-inline"><select id="fxAdd" class="st-mini" aria-label="Add effect"><option value="">Add effect…</option>${M.EFFECT_TYPES.map((t) => `<option value="${t[0]}">${t[1]}</option>`).join('')}</select></div>`);
}
function secChroma(c) {
  return sec('chroma', 'Chroma key <span class="st-tag st-tag--local">LOCAL</span>', `${ck(c, 'Remove a background colour (green screen)', 'chroma.on')}${c.chroma.on ? `${col(c, 'Key colour', 'chroma.color')}${sl(c, 'Tolerance', 'chroma.tolerance', 0, 100, 1, { scale: 100, unit: '%' })}${sl(c, 'Softness', 'chroma.softness', 0, 60, 1, { scale: 100, unit: '%' })}<p class="st-muted st-small">Works best on evenly lit green or blue backgrounds. It is a simple colour-distance key, not a studio-grade matte.</p>` : ''}`);
}
function secSpeed(c) {
  const v = c.kind === 'video'; const a = M.assetOf(P(), c.assetId);
  return sec('speed', 'Speed', `<div class="st-ctl-row"><label for="spd">Speed</label><input type="range" id="spd" data-spd="1" min="0.1" max="8" step="0.05" value="${c.speed}"><output>${fmtN(c.speed)}x</output><span></span></div>
    <div class="st-inline st-wrap">${[0.25, 0.5, 1, 2, 4].map((x) => `<button type="button" class="st-btn" data-act="spd" data-v="${x}">${x}x</button>`).join('')}</div>
    ${v ? `<label class="st-check"><input type="checkbox" data-act="rev"${c.reverse ? ' checked' : ''}> Reverse (clips up to 12 s)</label><div class="st-inline st-wrap"><button type="button" class="st-btn" data-act="freeze"><i class="ph ph-snowflake"></i>Freeze frame at playhead</button></div>` : ''}
    <p class="st-muted st-small">Speed changes the clip length on the timeline. Sound follows the speed (pitch changes, no time-stretch).${a && a.hasAudio === false && v ? ' This clip has no sound.' : ''}</p>`);
}
function secAudio(c) {
  const v = c.kind === 'video' || c.kind === 'scene'; const hasSound = c.kind !== 'video' || (M.assetOf(P(), c.assetId) || {}).hasAudio;
  if (c.kind === 'scene' && !(c.scene.layout === 'video')) return '';
  return sec('audio', 'Audio', `${hasSound ? '' : '<p class="st-muted st-small">This clip has no sound.</p>'}${sl(c, 'Volume', 'audio.gain', 0, 200, 1, { scale: 100, unit: '%', kf: true })}${sl(c, 'Fade in', 'audio.fadeIn', 0, 10, 0.1, { unit: ' s' })}${sl(c, 'Fade out', 'audio.fadeOut', 0, 10, 0.1, { unit: ' s' })}${sl(c, 'Pan', 'audio.pan', -100, 100, 1, { scale: 100 })}
    ${ck(c, c.kind === 'video' ? 'Mute original sound' : 'Mute this clip', 'audio.mute')}${c.kind === 'audio' ? ck(c, 'Loop to fill the clip', 'audio.loop') : ''}${ck(c, 'Lower under voice-over and narration (ducking)', 'audio.duck')}${ck(c, 'Basic noise reduction (rumble and hiss filters)', 'audio.denoise')}
    ${c.kind === 'audio' ? ck(c, 'This is speech (music ducks under it)', 'audio.voiceFlag') : ''}${c.kind === 'video' ? `<div class="st-inline st-wrap"><button type="button" class="st-btn" data-act="detach"><i class="ph ph-split-horizontal"></i>Detach audio</button></div><p class="st-muted st-small">To replace the original sound: mute it above, then add your own audio in the Audio tab.</p>` : ''}${v ? '' : ''}`);
}
function secText(c) {
  const t = c.text; const isCap = c.kind === 'caption'; const st = narrState(c);
  const nbtn = nStatus().allowed && st !== 'none' ? `<div class="st-inline"><button type="button" class="st-btn" data-act="narrate"><i class="ph ph-microphone"></i>${st === 'ready' ? 'Regenerate' : 'Generate'} narration for this clip</button><small class="st-muted">${st === 'ready' ? 'Narration ready' : st === 'outdated' ? 'Narration outdated' : 'No narration yet'}</small></div>` : '';
  return sec('text', isCap ? 'Caption' : 'Text', `<div class="st-field"><label for="i_text_content">Text</label><textarea id="i_text_content" rows="3" data-path="text.content" data-type="text" maxlength="2000">${esc(t.content)}</textarea></div>${nbtn}
    ${isCap ? sel(c, 'Caption style', 'cap.preset', LD.CAPTION_PRESETS.map((x) => [x.id, x.label])) : ''}
    ${sel(c, 'Font', 'text.font', Object.entries(M.FONTS).map(([k, f]) => [k, f.label]))}${sl(c, 'Size', 'text.size', 10, 400, 1)}${sl(c, 'Weight', 'text.weight', 100, 900, 100)}
    <div class="st-inline st-wrap">${[['left', 'ph-text-align-left'], ['center', 'ph-text-align-center'], ['right', 'ph-text-align-right']].map(([a, ic]) => `<button type="button" class="st-icon${t.align === a ? ' is-on' : ''}" data-act="align" data-v="${a}" aria-label="Align ${a}" aria-pressed="${t.align === a}"><i class="ph ${ic}"></i></button>`).join('')}<label class="st-check"><input type="checkbox" data-path="text.italic" data-type="check"${t.italic ? ' checked' : ''}> Italic</label></div>
    ${col(c, 'Colour', 'text.color')}${ck(c, 'Gradient fill', 'text.gradient.on')}${t.gradient.on ? `${col(c, 'Gradient from', 'text.gradient.c1')}${col(c, 'Gradient to', 'text.gradient.c2')}${sl(c, 'Gradient angle', 'text.gradient.angle', -180, 180, 1, { unit: '°' })}` : ''}
    ${sl(c, 'Outline', 'text.stroke.w', 0, 30, 0.5)}${t.stroke.w > 0 ? col(c, 'Outline colour', 'text.stroke.color') : ''}${ck(c, 'Shadow', 'text.shadow.on')}${t.shadow.on ? sl(c, 'Shadow blur', 'text.shadow.blur', 0, 60, 1) : ''}
    ${sl(c, 'Letter spacing', 'text.letterSpacing', -10, 40, 0.5)}${sl(c, 'Line spacing', 'text.lineHeight', 60, 250, 1, { scale: 100, unit: '%' })}${sl(c, 'Text width', 'text.width', 10, 200, 1, { scale: 100, unit: '%' })}
    ${ck(c, 'Background box', 'text.box.on')}${t.box.on ? `${col(c, 'Box colour', 'text.box.color')}${sl(c, 'Box opacity', 'text.box.alpha', 0, 100, 1, { scale: 100, unit: '%' })}${sl(c, 'Box padding', 'text.box.pad', 0, 80, 1)}${sl(c, 'Box roundness', 'text.box.radius', 0, 80, 1)}` : ''}
    ${isCap ? '' : `<h5 class="st-h5">Motion</h5>${sel(c, 'Entrance', 'text.animIn', ANIM_IN)}${sel(c, 'Exit', 'text.animOut', ANIM_IN)}${sel(c, 'Loop', 'text.animLoop', LOOPS)}${sel(c, 'Kinetic typography', 'text.kinetic', KIN)}${t.kinetic !== 'none' ? sl(c, 'Delay between words or letters', 'text.kStagger', 0.02, 0.6, 0.01, { unit: ' s' }) : ''}${t.kinetic === 'highlight' ? col(c, 'Highlight colour', 'text.hl') : ''}${sl(c, 'Entrance and exit length', 'text.animDur', 0.1, 2, 0.05, { unit: ' s' })}`}`, true);
}
function secShape(c) {
  const s = c.shape; return sec('shape', 'Shape', `${sel(c, 'Shape', 'shape.type', ['rect', 'rounded', 'ellipse', 'line', 'arrow', 'star', 'polygon'].map((x) => [x, x[0].toUpperCase() + x.slice(1)]))}${col(c, 'Fill', 'shape.fill')}${sl(c, 'Fill opacity', 'shape.fillAlpha', 0, 100, 1, { scale: 100, unit: '%' })}${ck(c, 'Gradient fill', 'shape.gradient.on')}${s.gradient.on ? `${col(c, 'Gradient from', 'shape.gradient.c1')}${col(c, 'Gradient to', 'shape.gradient.c2')}${sl(c, 'Gradient angle', 'shape.gradient.angle', -180, 180, 1, { unit: '°' })}` : ''}
    ${sl(c, 'Width', 'shape.w', 4, 4000, 1)}${sl(c, 'Height', 'shape.h', 2, 4000, 1)}${s.type === 'rounded' ? sl(c, 'Corner radius', 'shape.radius', 0, 400, 1) : ''}${s.type === 'star' || s.type === 'polygon' ? sl(c, 'Points', 'shape.points', 3, 12, 1) : ''}${s.type === 'star' ? sl(c, 'Inner size', 'shape.inner', 10, 90, 1, { scale: 100, unit: '%' }) : ''}${col(c, 'Outline colour', 'shape.stroke')}${sl(c, 'Outline width', 'shape.strokeW', 0, 40, 0.5)}`, true);
}
function secSticker(c) { return sec('sticker', 'Sticker', `${c.sticker.type === 'svg' ? col(c, 'Colour', 'sticker.color') : ''}${sl(c, 'Size', 'sticker.size', 20, 1200, 1)}`, true); }
function secScene(c) {
  const s = c.scene; const imgs = P().assets.filter((a) => a.kind === 'image');
  return sec('scene', 'Storyboard scene', `<p class="st-muted st-small">This scene came from the AI storyboard. Its caption is a separate clip on the Captions track.</p>
    <div class="st-field"><label for="sc_title">Headline</label><input id="sc_title" data-path="scene.title" data-type="text" value="${esc(s.title)}" maxlength="90"></div>
    <div class="st-field"><label for="sc_text">Supporting text</label><textarea id="sc_text" rows="2" data-path="scene.text" data-type="text" maxlength="220">${esc(s.text)}</textarea></div>
    ${sel(c, 'Layout', 'scene.layout', ['title', 'bullets', 'quote', 'stat', 'chart', 'kinetic', 'image', 'video'].filter((l) => !(l === 'video' && !s.video)).map((x) => [x, x]))}${sel(c, 'Animation', 'scene.anim', [['fade', 'Fade'], ['slide', 'Slide'], ['zoom', 'Zoom']])}
    ${s.layout === 'bullets' ? `<div class="st-field"><label for="sc_bul">Bullet points (one per line)</label><textarea id="sc_bul" rows="4" data-path="scene.bullets" data-type="text" data-parse="lines">${esc((s.bullets || []).join('\n'))}</textarea></div>` : ''}
    ${s.layout === 'stat' ? `<div class="st-field"><label for="sc_stat">Number</label><input id="sc_stat" data-path="scene.stat" data-type="text" value="${esc(s.stat)}" maxlength="24" placeholder="e.g. 85% or 12,000"></div>` : ''}
    ${s.layout === 'chart' ? `<div class="st-field"><label for="sc_data">Chart rows (label: value, 2 to 6)</label><textarea id="sc_data" rows="5" data-path="scene.data" data-type="text" data-parse="rows">${esc((s.data || []).map((r) => r.label + ': ' + r.value).join('\n'))}</textarea></div>` : ''}
    ${col({ scene: { bg: s.bg } }, 'Background colour', 'scene.bg').replace('data-path="scene.bg"', 'data-path="scene.bg"')}<button type="button" class="st-link" data-act="sceneBgReset"${s.bg ? '' : ' disabled'}>Use theme colour</button>
    <div class="st-field"><label for="sc_img">Picture</label><select id="sc_img" data-path="scene.image" data-type="select" data-null="1"><option value="">None</option>${imgs.map((a) => `<option value="${esc(a.id)}"${s.image === a.id ? ' selected' : ''}>${esc(a.name)}</option>`).join('')}</select></div>${s.layout === 'video' ? ck(c, 'Keep the clip\'s own sound', 'scene.keepAudio') : ''}`, true);
}
function secTrans(c) {
  const t = (k, l) => { const v = c[k]; return `<div class="st-field"><label for="tr_${k}">${l}</label><select id="tr_${k}" data-tr="${k}.type">${[['none', 'None'], ...M.TRANSITION_TYPES].map(([id, n]) => `<option value="${id}"${v.type === id ? ' selected' : ''}>${n}</option>`).join('')}</select></div>${v.type !== 'none' ? `<div class="st-ctl-row"><label for="trd_${k}">Length</label><input type="range" id="trd_${k}" data-tr="${k}.duration" min="0.1" max="3" step="0.05" value="${v.duration}"><output>${fmtN(v.duration)} s</output><span></span></div>${M.DIR_TRANSITIONS.has(v.type) ? `<div class="st-field"><label for="trr_${k}">Direction</label><select id="trr_${k}" data-tr="${k}.dir">${['left', 'right', 'up', 'down'].map((d) => `<option value="${d}"${v.dir === d ? ' selected' : ''}>From the ${d}</option>`).join('')}</select></div>` : ''}` : ''}`; };
  return sec('transition', 'Transitions', `${t('transitionIn', 'At the start')}${t('transitionOut', 'At the end')}<p class="st-muted st-small">When two clips touch on one track, the start transition blends the cut between them.</p>`);
}
function secTiming(c) {
  return sec('timing', 'Timing', `<div class="st-row2"><div class="st-field"><label for="tm_s">Start (s)</label><input id="tm_s" type="number" step="${1 / P().settings.fps}" min="0" value="${c.start.toFixed(3)}" data-tm="start"></div><div class="st-field"><label for="tm_d">Length (s)</label><input id="tm_d" type="number" step="${1 / P().settings.fps}" min="0.1" value="${c.duration.toFixed(3)}" data-tm="duration"></div></div>`);
}
const PRESETS = [['fadeIn', 'Fade in'], ['fadeOut', 'Fade out'], ['slideInL', 'Slide in left'], ['slideInR', 'Slide in right'], ['slideInU', 'Slide in up'], ['popIn', 'Pop in'], ['zoomOut', 'Zoom out'], ['spinIn', 'Spin in'], ['kenburns', 'Slow zoom (Ken Burns)'], ['pulse', 'Pulse loop'], ['float', 'Float loop'], ['clear', 'Clear animation']];
function secKeyframes(c) {
  const paths = Object.keys(c.keyframes || {}); const k0 = paths.map((p) => M.keyframeAt(c, p, local(c))).find(Boolean);
  const lanes = paths.map((p) => `<div class="st-kfrow"><span class="st-kfl">${M.KEYFRAME_PATHS[p] || p}</span><span class="st-kflane" data-lane="${p}">${c.keyframes[p].map((k) => `<button type="button" class="st-kfd" style="left:${(k.t / Math.max(0.01, c.duration)) * 100}%" data-kfgo="${k.t}" aria-label="Keyframe at ${k.t.toFixed(2)} seconds"></button>`).join('')}</span><button type="button" class="st-icon" data-act="clearKf" data-p="${p}" aria-label="Remove all keyframes for ${M.KEYFRAME_PATHS[p] || p}"><i class="ph ph-x"></i></button></div>`).join('');
  return sec('keyframes', 'Animation and keyframes', `<p class="st-muted st-small">Press the diamond beside Position, Scale, Rotation, Opacity or Volume to add a keyframe at the playhead. Move the playhead and change the value to animate.</p>
    <div class="st-inline st-wrap"><select id="presetAdd" class="st-mini" aria-label="Animation preset"><option value="">Animation presets…</option>${PRESETS.map(([id, l]) => `<option value="${id}">${l}</option>`).join('')}</select></div>${lanes || '<p class="st-muted st-small">No keyframes yet.</p>'}
    ${k0 ? `<div class="st-field"><label for="kfEase">Easing of the keyframe at the playhead</label><select id="kfEase" data-ease="1">${M.EASE_NAMES.map(([id, l]) => `<option value="${id}"${(k0.ease || 'linear') === id ? ' selected' : ''}>${l}</option>`).join('')}</select></div>${k0.ease === 'bezier' ? `<div class="st-row4">${[0, 1, 2, 3].map((i) => `<input type="number" step="0.05" data-bez="${i}" value="${(k0.b || [0.25, 0.1, 0.25, 1])[i]}" aria-label="Curve value ${i + 1}">`).join('')}</div>` : ''}` : ''}`);
}
function secActions(c, n) {
  return sec('actions', 'Clip actions', `<div class="st-inline st-wrap"><button type="button" class="st-btn" data-act="split"><i class="ph ph-scissors"></i>Split</button><button type="button" class="st-btn" data-act="dup"><i class="ph ph-copy"></i>Duplicate</button><button type="button" class="st-btn st-btn--danger" data-act="del"><i class="ph ph-trash"></i>Delete</button>${n > 1 ? '<button type="button" class="st-btn" data-act="group">Group</button>' : ''}${c.groupId ? '<button type="button" class="st-btn" data-act="ungroup">Ungroup</button>' : ''}</div>
    <div class="st-inline st-wrap"><button type="button" class="st-btn" data-act="saveStyle"><i class="ph ph-floppy-disk"></i>Save look as style</button><select id="styleApply" class="st-mini" aria-label="Apply a saved style"><option value="">Apply style…</option></select></div>`);
}

// ───────── build ─────────
function structSig() { const cs = selClips(); const p = P(); return cs.map((c) => [c.id, c.kind, Object.keys(c.keyframes || {}).map((k) => k + c.keyframes[k].length + (M.keyframeAt(c, k, local(c)) ? 'n' : '')).join(','), c.effects.length, c.filter !== 'none', c.chroma.on, c.transform.mask.shape, c.text ? [c.text.gradient.on, c.text.stroke.w > 0, c.text.shadow.on, c.text.box.on, c.text.kinetic, c.text.align].join('') : '', c.shape ? [c.shape.type, c.shape.gradient.on].join('') : '', c.scene ? [c.scene.layout, !!c.scene.bg].join('') : '', c.transitionIn.type, c.transitionOut.type, c.transitionIn.type !== 'none' && M.DIR_TRANSITIONS.has(c.transitionIn.type), c.transitionOut.type !== 'none' && M.DIR_TRANSITIONS.has(c.transitionOut.type), c.reverse, c.groupId ? 1 : 0, c.audio.mute, narrState(c)].join('|')).join('~') + '#' + (cs.length ? '' : p.settings.preset + '|' + p.tracks.length) + '#' + (cs.length ? '' : '') + S.sel.size; }
function build(force) {
  if (!host || !P()) return; const s = structSig(); const focusIn = host.contains(document.activeElement) && /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if (!force && s === sig) { syncValues(); return; } if (!force && focusIn && s === sig) return; sig = s;
  const keepFocus = focusIn ? { path: document.activeElement.dataset.path, id: document.activeElement.id } : null; const top = host.scrollTop; const openSecs = new Set([...host.querySelectorAll('details[open]')].map((d) => d.dataset.sec));
  const cs = selClips(); if (!cs.length) host.innerHTML = projectPanel(); else host.innerHTML = clipPanel(cs);
  if (cs.length) { openSecs.forEach((id) => { const d = host.querySelector('[data-sec="' + id + '"]'); if (d) d.open = true; }); }
  host.scrollTop = top; if (keepFocus) { const el = (keepFocus.id && host.querySelector('#' + CSS.escape(keepFocus.id))) || (keepFocus.path && host.querySelector('[data-path="' + keepFocus.path + '"]')); if (el) el.focus({ preventScroll: true }); }
  fillStyles(); wireProject();
}
function clipPanel(cs) {
  const c = cs[0]; const n = cs.length; const k = c.kind; const vis = VIS.has(k) || k === 'adjustment' || k === 'effect';
  const head = `<div class="st-insp-h"><b>${esc(n > 1 ? n + ' clips selected' : (c.name || k))}</b><small class="st-muted">${n > 1 ? 'Changes apply to every selected clip that has the setting.' : k}</small></div>`;
  const parts = [head];
  if (k === 'scene') parts.push(secScene(c));
  if (k === 'text' || k === 'caption') parts.push(secText(c)); if (k === 'shape') parts.push(secShape(c)); if (k === 'sticker') parts.push(secSticker(c));
  if (k === 'effect') parts.push(secEffects(c)); if (k === 'adjustment') parts.push(secColour(c));
  if (VIS.has(k)) { parts.push(secTransform(c)); parts.push(secLook(c)); parts.push(secColour(c)); }
  if (k === 'video' || k === 'image') parts.push(secChroma(c)); if (VIS.has(k)) parts.push(secEffects(c));
  if (k === 'video' || k === 'audio') parts.push(secSpeed(c)); if (k === 'video' || k === 'audio' || k === 'music' || k === 'scene') parts.push(secAudio(c));
  if (VIS.has(k) || k === 'adjustment' || k === 'effect') { parts.push(secTrans(c)); }
  if (VIS.has(k) || k === 'audio' || k === 'music') parts.push(secKeyframes(c));
  parts.push(secTiming(c), secActions(c, n)); void vis; return parts.join('');
}
function projectPanel() {
  const p = P(); const s = p.settings; const used = p.clips.length;
  return `<div class="st-insp-h"><b>Project</b><small class="st-muted">Nothing selected. Click a clip to edit it.</small></div>
  <div class="st-sec-b st-sec-b--flat"><div class="st-field"><label for="pj_title">Title</label><input id="pj_title" value="${esc(p.title)}" maxlength="80" data-pj="title"></div>
  <div class="st-field"><label for="pj_size">Size</label><select id="pj_size" data-pj="preset">${LD_SIZES().map((x) => `<option value="${x.id}"${s.preset === x.id ? ' selected' : ''}>${esc(x.label)}${x.w ? ' (' + x.w + '×' + x.h + ')' : ''}</option>`).join('')}</select></div>
  <div class="st-row2"><div class="st-field"><label for="pj_w">Width</label><input id="pj_w" type="number" min="64" max="7680" step="2" value="${s.width}" data-pj="width"></div><div class="st-field"><label for="pj_h">Height</label><input id="pj_h" type="number" min="64" max="7680" step="2" value="${s.height}" data-pj="height"></div></div>
  <p class="st-muted st-small">Current aspect ratio ${esc(s.aspect)}. After a size change, use "Reframe" in the AI tab to refit video and pictures.</p>
  <div class="st-row2"><div class="st-field"><label for="pj_fps">Frame rate</label><select id="pj_fps" data-pj="fps">${M.FPS_OPTIONS.map((f) => `<option${f === s.fps ? ' selected' : ''}>${f}</option>`).join('')}</select></div><div class="st-field"><label for="pj_bg">Background</label><input id="pj_bg" type="color" value="${/^#[0-9a-f]{6}$/i.test(s.bg) ? s.bg : '#000000'}" data-pj="bg"></div></div>
  <div class="st-ctl-row"><label for="pj_master">Master volume</label><input type="range" id="pj_master" min="0" max="150" step="1" value="${Math.round(p.audio.master * 100)}" data-pj="master"><output>${Math.round(p.audio.master * 100)}%</output><span></span></div>
  <h5 class="st-h5">Ducking (music and footage dip under speech)</h5>
  <div class="st-ctl-row"><label for="pj_da">Amount</label><input type="range" id="pj_da" min="0" max="100" step="1" value="${Math.round(p.audio.duck.amount * 100)}" data-pj="duckAmount"><output>${Math.round(p.audio.duck.amount * 100)}%</output><span></span></div>
  <div class="st-ctl-row"><label for="pj_dat">Attack</label><input type="range" id="pj_dat" min="0.02" max="1.5" step="0.02" value="${p.audio.duck.attack}" data-pj="duckAttack"><output>${p.audio.duck.attack.toFixed(2)} s</output><span></span></div>
  <div class="st-ctl-row"><label for="pj_dr">Release</label><input type="range" id="pj_dr" min="0.05" max="3" step="0.05" value="${p.audio.duck.release}" data-pj="duckRelease"><output>${p.audio.duck.release.toFixed(2)} s</output><span></span></div>
  <div class="st-field"><label for="pj_look">Storyboard look</label><select id="pj_look" data-pj="style">${[['clean', 'Clean light'], ['dark', 'Dark'], ['bold', 'Bold colour']].map(([v, l]) => `<option value="${v}"${p.style === v ? ' selected' : ''}>${l}</option>`).join('')}</select></div>
  <div class="st-inline st-wrap"><button type="button" class="st-btn" id="pjJson"><i class="ph ph-export"></i>Export project JSON</button><button type="button" class="st-btn" id="pjKeys"><i class="ph ph-keyboard"></i>Keyboard shortcuts</button></div>
  <p class="st-muted st-small">The JSON file holds the edit, not the media files. Import it from the Studio home screen, then relink any missing media from the Media tab (Replace).</p>
  <p class="st-muted st-small">${used} clip${used === 1 ? '' : 's'} · ${p.tracks.length} tracks · ${p.assets.length} media file${p.assets.length === 1 ? '' : 's'}</p></div>`;
}
const LD_SIZES = () => M.SIZE_PRESETS;
function wireProject() {
  const j = host.querySelector('#pjJson'); if (j) j.addEventListener('click', () => { download(new Blob([JSON.stringify(strip(P()), null, 1)], { type: 'application/json' }), safeName(P().title) + '.cognita-project.json'); });
  const k = host.querySelector('#pjKeys'); if (k) k.addEventListener('click', () => emit('shortcuts'));
}
async function fillStyles() {
  const sa = host.querySelector('#styleApply'); if (!sa) return; try { const all = (await store.listTemplates()).filter((t) => t.style && t.clipKind === (prim() || {}).kind); sa.innerHTML = '<option value="">Apply style…</option>' + all.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join(''); sa._styles = all; } catch (_) { /* ignore */ }
}

// ───────── events ─────────
function targets(path) { return selClips().filter((c) => M.getPath(c, path) !== undefined || path.startsWith('audio.') || path.startsWith('transform.')); }
function readEl(el) {
  const t = el.dataset.type; if (t === 'check') return el.checked; if (t === 'range' || el.type === 'number') return Number(el.value) / (Number(el.dataset.scale) || 1); if (el.dataset.parse === 'lines') return el.value.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 5);
  if (el.dataset.parse === 'rows') return el.value.split('\n').map((l) => { const i = l.lastIndexOf(':'); if (i < 1) return null; const n = l.slice(i + 1).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/); const v = n ? Number(n[0]) : NaN; return l.slice(0, i).trim() && Number.isFinite(v) ? { label: l.slice(0, i).trim().slice(0, 30), value: v } : null; }).filter(Boolean).slice(0, 6);
  if (el.dataset.null && el.value === '') return null; return el.value;
}
function applyPath(path, v, coalesce) {
  const cs = targets(path); if (!cs.length) return; if (path === 'audio.voiceFlag') { transact('Edit', () => { cs.forEach((c) => { c.audio.role = v ? 'voice' : ''; }); }); return; }
  transact('Edit ' + (M.KEYFRAME_PATHS[path] || path.split('.').pop()), () => { cs.forEach((c) => { if (path === 'scene.data' && v.length < 2) return; const local_ = local(c); if (M.hasKeyframes(c, path) && typeof v === 'number') M.upsertKeyframe(c, path, local_, v, M.keyframeAt(c, path, local_) ? undefined : 'inout'); else M.setPath(c, path, v); }); }, { coalesce: coalesce ? 'ins:' + path + [...S.sel].join() : '', soft: coalesce });
}
function onInput(e) {
  const el = e.target;
  if (el.dataset.path && (el.dataset.type === 'range' || el.dataset.type === 'text' || el.dataset.type === 'color')) { if (el.dataset.parse) return; const v = readEl(el); applyPath(el.dataset.path, v, true); const out = host.querySelector('[data-out="' + el.dataset.path + '"]'); if (out) out.textContent = fmtN(Number(el.value)) + (out.dataset.unit || ''); return; }
  if (el.dataset.spd) { const out = el.nextElementSibling; if (out) out.textContent = fmtN(Number(el.value)) + 'x'; return; }
  if (el.dataset.fx !== undefined) { const i = Number(el.dataset.fx); setClip(prim().id, (c) => { if (c.effects[i]) c.effects[i].amount = Number(el.value); }, 'Effect amount', 'fx' + i); return; }
  if (el.dataset.tr && el.type === 'range') { const [k, f] = el.dataset.tr.split('.'); setClip(prim().id, (c) => { c[k][f] = Number(el.value); }, 'Transition length', 'tr' + k); const out = el.nextElementSibling; if (out) out.textContent = fmtN(Number(el.value)) + ' s'; return; }
  if (el.dataset.pj) { projInput(el, true); }
}
function onChange(e) {
  const el = e.target;
  if (el.dataset.path && el.dataset.type !== 'range' && el.dataset.type !== 'color') { applyPath(el.dataset.path, readEl(el), false); if (el.dataset.parse === 'rows') build(true); return; }
  if (el.dataset.spd) { setSpeed(prim().id, Number(el.value)); return; }
  if (el.dataset.tr && el.tagName === 'SELECT') { const [k, f] = el.dataset.tr.split('.'); setClip(prim().id, (c) => { c[k][f] = el.value; if (f === 'type' && el.value !== 'none' && !c[k].duration) c[k].duration = 0.6; }, 'Transition'); return; }
  if (el.dataset.tm) { setClip(prim().id, (c) => { const v = Math.max(el.dataset.tm === 'duration' ? 0.1 : 0, M.quant(P(), Number(el.value) || 0)); const other = P().clips.filter((x) => x.trackId === c.trackId && x.id !== c.id); const s = el.dataset.tm === 'start' ? v : c.start, d = el.dataset.tm === 'duration' ? v : c.duration; if (other.some((x) => x.start < s + d - 1e-6 && x.start + x.duration > s + 1e-6)) { toast('That overlaps another clip on this track.'); return; } c.start = s; c.duration = d; }, 'Timing'); build(true); return; }
  if (el.id === 'fxAdd' && el.value) { const t = M.EFFECT_TYPES.find((x) => x[0] === el.value); setClip(prim().id, (c) => { if (c.effects.length < M.LIMITS.effects && !c.effects.some((x) => x.type === t[0])) c.effects.push({ type: t[0], amount: t[3] }); }, 'Add effect'); build(true); return; }
  if (el.id === 'presetAdd' && el.value) { applyPreset(el.value); el.value = ''; return; }
  if (el.dataset.ease) { const c = prim(); const k = [...Object.keys(c.keyframes)].map((p) => M.keyframeAt(c, p, local(c))).filter(Boolean); transact('Easing', () => { k.forEach((x) => { x.ease = el.value; if (el.value === 'bezier' && !x.b) x.b = [0.25, 0.1, 0.25, 1]; }); }); build(true); return; }
  if (el.dataset.bez !== undefined) { const c = prim(); const k = Object.keys(c.keyframes).map((p) => M.keyframeAt(c, p, local(c))).filter(Boolean); transact('Easing curve', () => { k.forEach((x) => { x.b = x.b || [0.25, 0.1, 0.25, 1]; x.b[Number(el.dataset.bez)] = Math.min(1, Math.max(Number(el.dataset.bez) % 2 === 0 ? 0 : -1, Number(el.value) || 0)); if (Number(el.dataset.bez) % 2 === 0) x.b[Number(el.dataset.bez)] = Math.min(1, Math.max(0, Number(el.value) || 0)); }); }); return; }
  if (el.id === 'styleApply' && el.value) { const st = (el._styles || []).find((x) => x.id === el.value); if (st) transact('Apply style', () => { selClips().filter((c) => c.kind === st.clipKind).forEach((c) => { Object.keys(st.style).forEach((k) => { c[k] = JSON.parse(JSON.stringify(st.style[k])); }); }); }); el.value = ''; return; }
  if (el.dataset.act === 'rev') { reverseToggle(el); return; }
  if (el.dataset.pj) projInput(el, false);
}
function projInput(el, live) {
  const k = el.dataset.pj; const v = el.value;
  if (k === 'title') { if (!live) transact('Rename', (p) => { p.title = v.trim() || 'Untitled video'; }); return; }
  if (k === 'preset') { const pr = M.SIZE_PRESETS.find((x) => x.id === v); transact('Project size', (p) => { if (pr && pr.w) { p.settings.width = pr.w; p.settings.height = pr.h; } p.settings.preset = v; p.settings.aspect = M.aspectLabel(p.settings.width, p.settings.height); }); build(true); return; }
  if (k === 'width' || k === 'height') { if (live) return; transact('Project size', (p) => { p.settings[k] = M.even(M.clamp(Number(v) || 1080, 64, 7680)); p.settings.preset = 'custom'; p.settings.aspect = M.aspectLabel(p.settings.width, p.settings.height); }); build(true); return; }
  if (k === 'fps') { transact('Frame rate', (p) => { p.settings.fps = Number(v); }); return; } if (k === 'bg') { transact('Background', (p) => { p.settings.bg = v; }, { coalesce: 'bg', soft: true }); return; }
  if (k === 'style') { transact('Look', (p) => { p.style = v; }); return; }
  const map = { master: ['master', 100], duckAmount: ['amount', 100], duckAttack: ['attack', 1], duckRelease: ['release', 1] }; const m = map[k]; if (m) { transact('Audio setting', (p) => { if (k === 'master') p.audio.master = Number(v) / 100; else p.audio.duck[m[0]] = Number(v) / m[1]; }, { coalesce: 'pj' + k, soft: true }); const o = el.nextElementSibling; if (o) o.textContent = k === 'duckAttack' || k === 'duckRelease' ? Number(v).toFixed(2) + ' s' : Math.round(Number(v)) + '%'; }
}
async function reverseToggle(el) {
  const c = prim(); if (!c) return; if (el.checked) { try { const { reverseBudget } = await import('../media.js'); const a = M.assetOf(P(), c.assetId); const chk = reverseBudget(a, c.duration * c.speed, 360, 12); if (!chk.ok) { toast(chk.reason); el.checked = false; return; } setClip(c.id, (x) => { x.reverse = true; }, 'Reverse'); await S.hub.prepareReverse(P(), clipById(c.id)); emit('frame'); } catch (e) { toast(e.message || 'Could not reverse this clip.'); setClip(c.id, (x) => { x.reverse = false; }, 'Reverse'); } } else setClip(c.id, (x) => { x.reverse = false; }, 'Reverse');
}
function applyPreset(id) {
  const cs = selClips(); if (!cs.length) return;
  transact('Animation preset', () => { cs.forEach((c) => { const D = c.duration; const K = c.keyframes = c.keyframes || {}; const kf = (p, arr) => { K[p] = arr.map(([t, v, e]) => ({ t: M.clamp(t, 0, D), v, ease: e || 'out' })); };
    const x0 = c.transform.x, y0 = c.transform.y, s0 = c.transform.scale, o0 = c.opacity, r0 = c.transform.rotation; const d = Math.min(0.6, D / 2);
    const merge = (p, arr) => { const ex = (K[p] || []).filter((k) => !arr.some((a) => Math.abs(a[0] - k.t) < 0.02)); K[p] = ex.concat(arr.map(([t, v, e]) => ({ t: M.clamp(t, 0, D), v, ease: e || 'out' }))).sort((a, b) => a.t - b.t); void kf; };
    if (id === 'clear') { c.keyframes = {}; } else if (id === 'fadeIn') merge('opacity', [[0, 0, 'out'], [d, o0, 'out']]); else if (id === 'fadeOut') merge('opacity', [[D - d, o0, 'in'], [D, 0, 'in']]);
    else if (id === 'slideInL') merge('transform.x', [[0, x0 - 0.5, 'out'], [d, x0, 'out']]); else if (id === 'slideInR') merge('transform.x', [[0, x0 + 0.5, 'out'], [d, x0, 'out']]); else if (id === 'slideInU') merge('transform.y', [[0, y0 + 0.4, 'out'], [d, y0, 'out']]);
    else if (id === 'popIn') { merge('transform.scale', [[0, s0 * 0.4, 'spring'], [d, s0, 'spring']]); merge('opacity', [[0, 0, 'out'], [d * 0.5, o0, 'out']]); } else if (id === 'zoomOut') merge('transform.scale', [[0, s0 * 1.5, 'out'], [Math.min(D, 0.8), s0, 'out']]);
    else if (id === 'spinIn') { merge('transform.rotation', [[0, r0 - 180, 'out'], [Math.min(D, 0.8), r0, 'out']]); merge('transform.scale', [[0, s0 * 0.3, 'out'], [Math.min(D, 0.8), s0, 'out']]); } else if (id === 'kenburns') merge('transform.scale', [[0, s0, 'linear'], [D, s0 * 1.2, 'linear']]);
    else if (id === 'pulse') { const arr = []; for (let t = 0; t <= D + 0.001; t += 0.5) arr.push([t, ((t / 0.5) | 0) % 2 === 0 ? s0 : s0 * 1.08, 'inout']); K['transform.scale'] = arr.map(([t, v, e]) => ({ t, v, ease: e })); } else if (id === 'float') { const arr = []; for (let t = 0; t <= D + 0.001; t += 0.75) arr.push([t, ((t / 0.75) | 0) % 2 === 0 ? y0 : y0 - 0.02, 'inout']); K['transform.y'] = arr.map(([t, v, e]) => ({ t, v, ease: e })); } }); });
}
function onClick(e) {
  const b = e.target.closest('[data-kf],[data-act],[data-kfgo]'); if (!b) return; const c = prim();
  if (b.dataset.kf) { if (c) toggleKeyframe(c.id, b.dataset.kf); return; }
  if (b.dataset.kfgo !== undefined) { seek(c.start + Number(b.dataset.kfgo)); return; }
  const a = b.dataset.act;
  if (a === 'split') splitAt(S.t, [...S.sel]); else if (a === 'dup') duplicateSel(); else if (a === 'del') deleteClips([...S.sel], false); else if (a === 'group') groupSel(); else if (a === 'ungroup') ungroupSel();
  else if (a === 'align') applyPath('text.align', b.dataset.v, false); else if (a === 'resetColour') transact('Reset colour', () => { selClips().forEach((x) => { x.adjust = M.zeroAdjust(); x.filter = 'none'; x.filterAmount = 1; }); });
  else if (a === 'rmFx') setClip(c.id, (x) => { x.effects.splice(Number(b.dataset.i), 1); }, 'Remove effect'); else if (a === 'spd') setSpeed(c.id, Number(b.dataset.v)); else if (a === 'freeze') freezeFrame(S.t); else if (a === 'detach') detachAudio(c.id);
  else if (a === 'clearKf') setClip(c.id, (x) => { delete x.keyframes[b.dataset.p]; }, 'Clear keyframes'); else if (a === 'sceneBgReset') setClip(c.id, (x) => { x.scene.bg = ''; }, 'Scene background');
  else if (a === 'narrate') { b.disabled = true; narrateClips([c]).then((r) => { toast(r.done ? 'Narration added.' : (r.stopped || (r.failed[0] && r.failed[0].message) || 'No narration was created.')); build(true); }); }
  else if (a === 'saveStyle') { const name = window.prompt('Name this style', 'My style'); if (!name) return; const style = {}; ['text', 'shape', 'adjust', 'filter', 'filterAmount', 'effects', 'opacity', 'blend', 'chroma', 'sticker'].forEach((k) => { if (c[k] !== undefined) style[k] = JSON.parse(JSON.stringify(c[k])); }); if (style.text) style.text.content = M.defaultText().content; store.saveTemplate({ id: store.uid('sty'), name: name.slice(0, 60), createdAt: Date.now(), items: [], style, clipKind: c.kind }).then(() => { toast('Style saved. Use Apply style on other ' + c.kind + ' clips.'); fillStyles(); }).catch((er) => toast(er.message || 'Could not save the style.')); }
}

// Pushes model values into the controls (not into the one being edited). Cheap enough to run on every playhead tick.
function syncValues() {
  const c = prim(); if (!host || !c) return;
  host.querySelectorAll('[data-path]').forEach((el) => { if (el === document.activeElement) return; const path = el.dataset.path; if (path === 'audio.voiceFlag') { el.checked = c.audio.role === 'voice'; return; } const v = M.getPath(c, path); if (v === undefined) return; if (el.dataset.type === 'check') el.checked = !!v; else if (el.dataset.type === 'range') { const sc = Number(el.dataset.scale) || 1; const val = M.valueAt(c, path, local(c)) * sc; el.value = val; const out = host.querySelector('[data-out="' + path + '"]'); if (out) out.textContent = fmtN(val) + (out.dataset.unit || ''); } else if (el.dataset.type === 'select' || el.dataset.type === 'text') { if (!el.dataset.parse) el.value = v == null ? '' : v; } else if (el.dataset.type === 'color' && /^#[0-9a-f]{6}$/i.test(v)) el.value = v; });
  host.querySelectorAll('[data-kf]').forEach((b) => { const p = b.dataset.kf; const on_ = kfNow(c, p), has = hasKf(c, p); b.classList.toggle('is-on', on_); b.classList.toggle('is-has', !on_ && has); b.setAttribute('aria-pressed', on_); });
  const tm = host.querySelector('#tm_s'); if (tm && tm !== document.activeElement) tm.value = c.start.toFixed(3); const td = host.querySelector('#tm_d'); if (td && td !== document.activeElement) td.value = c.duration.toFixed(3);
}
void bump; void markDirty; void usageOf; void fmtSize; void setProp; void setTab;
