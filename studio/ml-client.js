// studio/ml-client.js
// Talks to the isolated on-device model frame (studio-ml-frame.html). LOCAL: nothing here uses the network except the frame loading
// its own model files from this site. The frame is <iframe sandbox="allow-scripts">: an opaque origin with no access to this page,
// and its own Content-Security-Policy (see vercel.json). Messages are accepted only from that frame's window and only with the
// random token this module generated for the session.
// The frame is created on first use and removed after a few idle minutes so the models do not hold memory all session.

const FRAME_URL = '/studio-ml-frame.html';
const READY_TIMEOUT_MS = 25000;
const IDLE_MS = 4 * 60 * 1000;

let frame = null, token = '', readyP = null, seq = 0, idleTimer = 0, runtimeInfo = null;
const pending = new Map();

const abortError = () => Object.assign(new Error('Cancelled'), { name: 'AbortError' });

export function mlSupported() {
  if (typeof WebAssembly !== 'object') return { ok: false, reason: 'This browser cannot run on-device models (WebAssembly is missing).' };
  if (typeof window === 'undefined' || !window.postMessage) return { ok: false, reason: 'This browser cannot run on-device models.' };
  return { ok: true, reason: '' };
}

function randomToken() {
  const a = new Uint8Array(16); (window.crypto || window.msCrypto).getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

function onMessage(e) {
  if (!frame || e.source !== frame.contentWindow) return;
  const m = e.data; if (!m || typeof m !== 'object') return;
  if (m.type === 'ready') { if (m.token === token && frame._ready) frame._ready(m); return; }
  if (m.type === 'startup-error') { if (m.token === token && frame._fail) frame._fail(new Error(m.message || 'The on-device models did not start.')); return; }
  const job = pending.get(m.id); if (!job) return;
  if (m.type === 'progress') { if (job.onProgress) { try { job.onProgress(m); } catch (_) { /* ignore */ } } return; }
  pending.delete(m.id);
  if (m.type === 'done') job.resolve(m.result);
  else if (m.type === 'error') job.reject(Object.assign(new Error(m.message || 'The on-device model failed.'), { name: m.name === 'AbortError' ? 'AbortError' : 'Error' }));
  touch();
}

function touch() {
  clearTimeout(idleTimer);
  if (!frame) return;
  idleTimer = setTimeout(() => { if (!pending.size) disposeMl(); else touch(); }, IDLE_MS);
}

export function disposeMl() {
  clearTimeout(idleTimer);
  pending.forEach((j) => j.reject(abortError())); pending.clear();
  if (frame) { try { frame.remove(); } catch (_) { /* ignore */ } }
  window.removeEventListener('message', onMessage);
  frame = null; readyP = null; token = ''; runtimeInfo = null;
}

function ensureFrame() {
  const sup = mlSupported(); if (!sup.ok) return Promise.reject(new Error(sup.reason));
  if (readyP) return readyP;
  token = randomToken();
  const f = document.createElement('iframe');
  f.setAttribute('sandbox', 'allow-scripts'); // no allow-same-origin: opaque origin, no storage, no access to this page
  f.setAttribute('title', 'On-device models'); f.setAttribute('aria-hidden', 'true'); f.tabIndex = -1; f.referrerPolicy = 'no-referrer';
  f.style.cssText = 'position:absolute;width:0;height:0;border:0;visibility:hidden;pointer-events:none';
  frame = f; window.addEventListener('message', onMessage);
  readyP = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { disposeMl(); reject(new Error('The on-device models did not start. Check your connection and try again.')); }, READY_TIMEOUT_MS);
    f._ready = (info) => { clearTimeout(timer); runtimeInfo = info; resolve(info); };
    f._fail = (e) => { clearTimeout(timer); disposeMl(); reject(e); };
    f.addEventListener('load', () => { try { f.contentWindow.postMessage({ op: 'hello', token }, '*'); } catch (_) { /* ignore */ } });
    f.addEventListener('error', () => { clearTimeout(timer); disposeMl(); reject(new Error('The on-device models could not be loaded.')); });
  });
  f.src = FRAME_URL;
  document.body.appendChild(f);
  return readyP;
}

// Sends one request and resolves with the frame's result. `signal` cancels it; `onProgress({what, loaded, total, indeterminate, work})` reports.
export async function call(op, payload = {}, { onProgress, signal, transfer } = {}) {
  if (signal && signal.aborted) throw abortError();
  await ensureFrame();
  if (signal && signal.aborted) throw abortError();
  const id = 'r' + (++seq);
  return new Promise((resolve, reject) => {
    const job = { resolve, reject, onProgress };
    pending.set(id, job);
    const onAbort = () => { if (!pending.has(id)) return; pending.delete(id); try { frame.contentWindow.postMessage({ op: 'cancel', id: id + 'c', target: id, token }, '*'); } catch (_) { /* ignore */ } reject(abortError()); };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    const done = () => { if (signal) signal.removeEventListener('abort', onAbort); };
    job.resolve = (v) => { done(); resolve(v); }; job.reject = (e) => { done(); reject(e); };
    try { frame.contentWindow.postMessage({ ...payload, op, id, token }, '*', transfer || []); }
    catch (e) { pending.delete(id); done(); reject(e); }
    touch();
  });
}

// Downloads and starts a model without running it (so the first real job is not slow). model: 'whisper' | 'matte'.
export const loadModel = (model, opts) => call('load', { model }, opts);

// Speech to text. pcm: Float32Array, 16 kHz mono, up to 30 s. Returns { language, segments:[{start,end,text}], dropped }.
export function transcribePcm(pcm, { lang = 'auto', onProgress, signal } = {}) {
  const copy = new Float32Array(pcm); // the frame takes ownership of the buffer
  return call('transcribe', { pcm: copy.buffer, lang }, { onProgress, signal, transfer: [copy.buffer] });
}

// Background mattes. pixels: ArrayBuffer of count * 320 * 320 * 4 RGBA bytes. Returns { count, size, alpha: ArrayBuffer(count*size*size) }.
export function matteFrames(pixels, count, { onProgress, signal } = {}) {
  return call('matte', { pixels, count }, { onProgress, signal, transfer: [pixels] });
}

export const MATTE_SIZE = 320;
export const runtime = () => runtimeInfo;
