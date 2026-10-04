// js/sandbox-client.js
// Browser side of the Tier 1 agent sandbox.
//
// What it does:
//   - owns ONE hidden <iframe sandbox="allow-scripts" src="/sandbox-frame">
//     (opaque origin, no Cognita cookies/tokens, restricted network; see
//     sandbox-frame.html and its CSP in vercel.json);
//   - runs a tool call the Worker handed over (run(call, handlers)) and
//     streams its output as it happens;
//   - keeps each conversation's workspace in this browser (IndexedDB), so the
//     files are still there after a reload and are never sent to Cognita's
//     servers unless the person downloads or the model reads them back
//     through a tool result;
//   - exports a file for download.
//
// It never handles an auth token and never sends one to the frame.

const FRAME_URL = '/sandbox-frame';
const DB_NAME = 'cognita-sandbox';
const STORE = 'workspaces';
const KEEP_WORKSPACES = 5;                       // most recently used
const KEEP_DAYS = 14;
const HARD_EXTRA_MS = 15000;                     // grace over the call timeout before the frame is replaced

let _db = null;
function _openDb() {
  if (_db) return _db;
  _db = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(STORE, { keyPath: 'id' }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch (_) { resolve(null); }
  });
  return _db;
}
async function _idb(mode, fn) {
  const db = await _openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, mode);
      const out = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(out && 'result' in out ? out.result : null);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch (_) { resolve(null); }
  });
}
async function _saveWorkspace(id, snapshot) {
  await _idb('readwrite', (s) => s.put({ id, savedAt: Date.now(), snapshot }));
  _prune();
}
async function _loadWorkspace(id) {
  const row = await _idb('readonly', (s) => s.get(id));
  return row && row.snapshot ? row.snapshot : null;
}
async function _prune() {
  const rows = await _idb('readonly', (s) => s.getAll());
  if (!Array.isArray(rows)) return;
  const cutoff = Date.now() - KEEP_DAYS * 86400000;
  rows.sort((a, b) => b.savedAt - a.savedAt);
  const drop = rows.filter((r, i) => i >= KEEP_WORKSPACES || r.savedAt < cutoff).map((r) => r.id);
  if (drop.length) await _idb('readwrite', (s) => { drop.forEach((id) => s.delete(id)); });
}

/** Removes every saved workspace, for example on sign-out. */
export async function clearAllSandboxWorkspaces() {
  await _idb('readwrite', (s) => s.clear());
}

export class SandboxClient {
  constructor() {
    this.frame = null;
    this.ready = null;
    this.currentWorkspace = null;     // conversation id whose files are loaded in the frame
    this.pending = new Map();         // call id -> handlers
    this.waiters = new Map();         // request id -> resolve
    this.seq = 0;
    this._onMessage = this._onMessage.bind(this);
    window.addEventListener('message', this._onMessage);
  }

  // ── Frame lifecycle ────────────────────────────────────────────────
  _ensureFrame() {
    if (this.frame && this.ready) return this.ready;
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');   // no allow-same-origin: opaque origin
    iframe.setAttribute('aria-hidden', 'true');
    iframe.setAttribute('tabindex', '-1');
    iframe.title = 'Code sandbox';
    iframe.style.cssText = 'position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none;left:-10px;top:-10px';
    this.frame = iframe;
    this.currentWorkspace = null;
    this.ready = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('The sandbox did not start.')), 15000);
      this._readyResolve = () => { clearTimeout(t); resolve(); };
    });
    iframe.src = FRAME_URL;
    document.body.appendChild(iframe);
    return this.ready;
  }

  _destroyFrame(reason) {
    if (this.frame) { try { this.frame.remove(); } catch (_) {} }
    this.frame = null; this.ready = null; this.currentWorkspace = null;
    this.pending.forEach((h) => h.reject && h.reject(new Error(reason || 'The sandbox was reset.')));
    this.pending.clear();
    this.waiters.forEach((w) => w({ ok: false }));
    this.waiters.clear();
  }

  _post(msg, transfer) {
    if (!this.frame || !this.frame.contentWindow) throw new Error('The sandbox is not running.');
    this.frame.contentWindow.postMessage(msg, '*', transfer || []);
  }

  _request(msg, transfer) {
    return new Promise((resolve) => {
      const id = 'r' + (++this.seq);
      this.waiters.set(id, resolve);
      try { this._post({ ...msg, id }, transfer); } catch (_) { this.waiters.delete(id); resolve({ ok: false }); }
    });
  }

  _onMessage(ev) {
    if (!this.frame || ev.source !== this.frame.contentWindow) return;   // only our own frame
    const m = ev.data;
    if (!m || typeof m !== 'object') return;
    if (m.t === 'ready') { if (this._readyResolve) this._readyResolve(); return; }
    if (m.t === 'out') { const h = this.pending.get(m.id); if (h && h.onOutput) h.onOutput(m.stream === 'stderr' ? 'stderr' : 'stdout', String(m.text || '')); return; }
    if (m.t === 'status') { const h = this.pending.get(m.id); if (h && h.onStatus) h.onStatus(String(m.text || '')); return; }
    if (m.t === 'result') { const h = this.pending.get(m.id); if (h) h.resolve(m); return; }
    if (m.t === 'loaded' || m.t === 'exported' || m.t === 'warmed') {
      const w = this.waiters.get(m.id); if (w) { this.waiters.delete(m.id); w(m); }
    }
  }

  // ── Workspaces ─────────────────────────────────────────────────────
  async _useWorkspace(conversationId) {
    if (this.currentWorkspace === conversationId) return;
    const snapshot = await _loadWorkspace(conversationId);
    const transfer = snapshot && Array.isArray(snapshot.files) ? snapshot.files.map((f) => f.data).filter((b) => b instanceof ArrayBuffer) : [];
    await this._request({ t: 'load', snapshot: snapshot || {} }, transfer);
    this.currentWorkspace = conversationId;
  }

  // ── Running a call ─────────────────────────────────────────────────
  /**
   * Runs one tool call (the descriptor the Worker sent) and resolves with
   * { result, cancelled }. Never rejects for an ordinary failure: a crash,
   * timeout or missing support comes back as a failed result the model can
   * read, exactly like a command that exited with an error.
   * handlers: { onOutput(stream, text), onStatus(text) }
   */
  async run(call, conversationId, handlers = {}) {
    const timeoutMs = (call.limits && call.limits.timeoutMs) || 20000;
    try {
      await this._ensureFrame();
      await this._useWorkspace(conversationId);
    } catch (e) {
      this._destroyFrame();
      return { result: _failure(call, 'The code sandbox could not start in this browser. ' + (e && e.message ? e.message : '')), cancelled: false };
    }

    const started = performance.now();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (payload) => {
        if (settled) return; settled = true;
        clearTimeout(hardTimer);
        this.pending.delete(call.id);
        resolve(payload);
      };
      // If the frame itself stops answering (not just the code inside it), replace it.
      const hardTimer = setTimeout(() => {
        this._destroyFrame();
        finish({ result: { ..._failure(call, 'The sandbox stopped responding and was reset. Files from before this run are kept.'), exitCode: 124, durationMs: Math.round(performance.now() - started) }, cancelled: false });
      }, timeoutMs + HARD_EXTRA_MS);

      this.pending.set(call.id, {
        onOutput: handlers.onOutput, onStatus: handlers.onStatus,
        resolve: async (m) => {
          if (m.snapshot) await _saveWorkspace(conversationId, m.snapshot);
          finish({ result: m.result, cancelled: !!(m.result && m.result.cancelled) });
        },
        reject: (err) => finish({ result: _failure(call, err.message), cancelled: false }),
      });
      try {
        this._post({ t: 'call', call: { id: call.id, name: call.name, args: call.args, limits: call.limits } });
      } catch (e) {
        finish({ result: _failure(call, e.message), cancelled: false });
      }
    });
  }

  /** Stops the call that is running (used by the Stop button). */
  cancel(callId) {
    try { this._post({ t: 'cancel', id: callId }); } catch (_) { /* nothing running */ }
  }

  /** Starts loading Python ahead of the first run so it feels faster. Safe to ignore failure. */
  async warm() {
    try { await this._ensureFrame(); await this._request({ t: 'warm' }); } catch (_) { /* optional */ }
  }

  // ── Files the person asked to keep ─────────────────────────────────
  /** Returns a Blob for a workspace file, or null if it no longer exists. */
  async exportFile(conversationId, path) {
    try {
      await this._ensureFrame();
      await this._useWorkspace(conversationId);
    } catch (_) { return null; }
    const res = await this._request({ t: 'export', path });
    if (!res || !res.ok) return null;
    return new Blob([res.data], { type: _mimeFor(path) });
  }

  async downloadFile(conversationId, path, filename) {
    const blob = await this.exportFile(conversationId, path);
    if (!blob) return false;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename || path.split('/').pop() || 'file';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    return true;
  }
}

function _failure(call, message) {
  return { command: call && call.summary ? call.summary : (call && call.name) || 'sandbox', cwd: '/workspace', stdout: '', stderr: message, exitCode: 1, durationMs: 0 };
}

const MIME = {
  csv: 'text/csv', json: 'application/json', txt: 'text/plain', md: 'text/markdown', html: 'text/html',
  py: 'text/x-python', js: 'text/javascript', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  svg: 'image/svg+xml', pdf: 'application/pdf', xml: 'application/xml', log: 'text/plain', zip: 'application/zip',
};
function _mimeFor(path) {
  const ext = String(path).split('.').pop().toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}
