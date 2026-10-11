// studio/narration.js
// Browser side of narration. Asks the Worker for one MP3 per scene caption, keeps it on the device so re-exports are free,
// and reports exact durations so the engine can fit every scene to its speech.

import { WORKER_URL } from './storyboard.js';
import { getAsset, putAsset } from './store.js';
import { narrKey, validNarr, audioContextClass } from './engine.js';

export const LANG_CODES = { 'English (Nigeria)': 'en-NG', 'English (UK)': 'en-GB', 'English (US)': 'en-US', French: 'fr-FR' };
export const langCodeFor = (name) => LANG_CODES[name] || null;

const authed = (path, init) => window.Auth.authedFetch(WORKER_URL + path, init);

export async function loadStatus() {
  if (!navigator.onLine) return { narration: { allowed: false, offline: true, voices: [] } };
  try {
    const res = await authed('/api/studio/status');
    if (!res.ok) throw new Error('status ' + res.status);
    return await res.json();
  } catch (e) { return { narration: { allowed: false, error: true, voices: [] } }; }
}

const buffers = new Map();
let dctx = null;
const decoder = () => { if (!dctx) { const AC = audioContextClass(); dctx = new AC(); } return dctx; };
const decode = (arr) => new Promise((res, rej) => { const p = decoder().decodeAudioData(arr, res, rej); if (p && p.catch) p.catch(rej); });

export async function getBuffer(key) {
  if (buffers.has(key)) return buffers.get(key);
  const rec = await getAsset('narr_' + key).catch(() => null);
  if (!rec || !rec.blob) return null;
  try { const b = await decode(await rec.blob.arrayBuffer()); buffers.set(key, b); return b; } catch (_) { return null; }
}

// Loads every narration clip the project needs. `missing` lists scenes whose audio is no longer on this device.
export async function loadBuffers(project) {
  const map = new Map(); const missing = [];
  for (const s of project.scenes) {
    if (!validNarr(project, s)) continue;
    const b = await getBuffer(s.narr.key);
    if (b) map.set(s.narr.key, b); else missing.push(s.id);
  }
  return { buffers: map, missing };
}

export const MESSAGES = {
  PLAN_REQUIRED: 'Narration in exported videos is part of the Cognita Studio plan.',
  DAILY_LIMIT: 'You have used today\u2019s narration allowance. It resets at midnight UTC.',
  TTS_FAILED: 'The narration voice is not available right now. Nothing was counted.',
  TTS_NOT_CONFIGURED: 'Narration is switched off right now.',
  NO_VOICE: 'There is no narration voice for this language yet.',
  TOO_LONG: 'This caption is too long to narrate. Shorten it or split the scene.',
};

export async function synthesizeScene(project, scene, signal) {
  const text = (scene.caption || '').trim();
  const res = await authed('/api/studio/tts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, body: JSON.stringify({ text, lang: project.lang, voice: project.voice, rate: project.rate || 1 }) });
  if (!res.ok) {
    let d = {}; try { d = await res.json(); } catch (_) { /* ignore */ }
    throw Object.assign(new Error(MESSAGES[d.code] || d.error || 'Narration failed.'), { code: d.code, status: res.status });
  }
  const blob = await res.blob();
  let buf;
  try { buf = await decode(await blob.arrayBuffer()); } catch (_) { throw Object.assign(new Error('The narration audio could not be played on this device.'), { code: 'DECODE' }); }
  const key = narrKey(project, scene);
  try { await putAsset({ id: 'narr_' + key, blob, kind: 'narration' }); } catch (_) { /* kept in memory for this session */ }
  buffers.set(key, buf);
  const left = parseInt(res.headers.get('X-Studio-Chars-Left'), 10);
  return { narr: { key, dur: buf.duration, voice: project.voice, rate: project.rate || 1, engine: res.headers.get('X-Studio-Engine') || '' }, left: Number.isFinite(left) && left >= 0 ? left : null };
}
