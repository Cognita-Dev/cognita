// studio/store.js
// Local persistence for Cognita Studio, all in IndexedDB on this device:
//   projects   project JSON (v1 or v2; v1 is migrated in memory when opened)
//   assets     media blobs, narration blobs ("narr_<key>"), cached waveform peaks
//   recovery   one rolling crash-recovery snapshot per project
//   templates  user styles and templates
// Nothing here uploads anything.

const DB_NAME = 'cognita-studio';
const DB_VERSION = 2;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('IndexedDB unavailable')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (ev) => {
      const db = req.result; const old = ev.oldVersion || 0;
      // v1: projects + assets. Existing records are left exactly as they were.
      if (old < 1) { db.createObjectStore('projects', { keyPath: 'id' }); db.createObjectStore('assets', { keyPath: 'id' }); }
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' });
      // v2: recovery snapshots and templates
      if (old < 2) { db.createObjectStore('recovery', { keyPath: 'id' }); db.createObjectStore('templates', { keyPath: 'id' }); }
    };
    req.onsuccess = () => { const db = req.result; db.onversionchange = () => { db.close(); dbPromise = null; }; resolve(db); };
    req.onerror = () => { dbPromise = null; reject(req.error); };
    req.onblocked = () => { /* another tab holds the old version open; the request resumes when it closes */ };
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    let t;
    try { t = db.transaction(store, mode); } catch (e) { reject(e); return; }
    const s = t.objectStore(store);
    const r = fn(s);
    t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage write was blocked'));
  });
}

export const isQuotaError = (e) => !!e && (e.name === 'QuotaExceededError' || e.code === 22 || /quota/i.test(String(e.message || '')));
// Wraps a write so a full disk becomes a clear error with code STORAGE.
async function guarded(fn) {
  try { return await fn(); } catch (e) {
    if (isQuotaError(e)) throw Object.assign(new Error('This device is out of storage space. Delete a project or some media, then try again.'), { code: 'STORAGE', cause: e });
    throw e;
  }
}

export const isStorageAvailable = () => 'indexedDB' in window;
export const saveProject = (p) => guarded(() => tx('projects', 'readwrite', (s) => s.put(p)));
export const getProject = (id) => tx('projects', 'readonly', (s) => s.get(id));
export const deleteProjectRecord = (id) => tx('projects', 'readwrite', (s) => s.delete(id));
export const listProjects = async () => {
  const all = (await tx('projects', 'readonly', (s) => s.getAll())) || [];
  return all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
};
export const putAsset = (a) => guarded(() => tx('assets', 'readwrite', (s) => s.put(a)));
export const getAsset = (id) => tx('assets', 'readonly', (s) => s.get(id));
export const deleteAsset = (id) => tx('assets', 'readwrite', (s) => s.delete(id));
export const hasAsset = async (id) => { const k = await tx('assets', 'readonly', (s) => s.count(id)); return k > 0; };

// ── recovery snapshots ──
export const saveRecovery = (projectId, project) => guarded(() => tx('recovery', 'readwrite', (s) => s.put({ id: projectId, ts: Date.now(), project })));
export const getRecovery = (projectId) => tx('recovery', 'readonly', (s) => s.get(projectId));
export const clearRecovery = (projectId) => tx('recovery', 'readwrite', (s) => s.delete(projectId));
export const listRecovery = async () => (await tx('recovery', 'readonly', (s) => s.getAll())) || [];

// ── templates ──
export const saveTemplate = (t) => guarded(() => tx('templates', 'readwrite', (s) => s.put(t)));
export const deleteTemplate = (id) => tx('templates', 'readwrite', (s) => s.delete(id));
export const listTemplates = async () => ((await tx('templates', 'readonly', (s) => s.getAll())) || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

// ── asset references (v1 and v2 projects) ──
export function assetIdsOf(p) {
  const ids = new Set();
  (p.assets || []).forEach((a) => a && a.id && ids.add(a.id));
  if (p.v === 2) (p.clips || []).forEach((c) => { if (c.assetId) ids.add(c.assetId); if (c.bg && c.bg.key) ids.add(c.bg.key); if (c.scene) { if (c.scene.image) ids.add(c.scene.image); if (c.scene.video) ids.add(c.scene.video); } });
  else (p.scenes || []).forEach((s) => { if (s.image) ids.add(s.image); if (s.video) ids.add(s.video); if (s.narr && s.narr.key) ids.add('narr_' + s.narr.key); });
  if (p.legacyV1) assetIdsOf(p.legacyV1).forEach((i) => ids.add(i));
  return ids;
}
// Deletes a project and only the blobs that no other project still uses, so duplicates and shared narration stay intact.
export async function deleteProjectAndAssets(id) {
  const all = await listProjects();
  const target = all.find((p) => p.id === id);
  const mine = target ? assetIdsOf(target) : new Set();
  const others = new Set(); all.filter((p) => p.id !== id).forEach((p) => assetIdsOf(p).forEach((i) => others.add(i)));
  let freed = 0;
  for (const aid of mine) if (!others.has(aid)) { try { await deleteAsset(aid); freed++; } catch (_) { /* ignore */ } }
  await deleteProjectRecord(id); try { await clearRecovery(id); } catch (_) { /* ignore */ }
  return freed;
}
// Removes assets that no project references (for example after a Replace). Returns how many were removed.
export async function sweepOrphans() {
  const all = await listProjects(); const used = new Set(); all.forEach((p) => assetIdsOf(p).forEach((i) => used.add(i)));
  const keys = (await tx('assets', 'readonly', (s) => s.getAllKeys())) || []; let n = 0;
  for (const k of keys) if (!used.has(k)) { try { await deleteAsset(k); n++; } catch (_) { /* ignore */ } }
  return n;
}

export async function storageEstimate() {
  try { if (navigator.storage && navigator.storage.estimate) { const { usage, quota } = await navigator.storage.estimate(); return { usage, quota }; } } catch (_) { /* ignore */ }
  return null;
}
// Asks the browser not to evict Studio data under storage pressure. Safe to call repeatedly.
export async function requestPersist() {
  try { if (navigator.storage && navigator.storage.persist) { if (navigator.storage.persisted && await navigator.storage.persisted()) return true; return await navigator.storage.persist(); } } catch (_) { /* ignore */ }
  return false;
}

export const uid = (p = 'id') => p + '_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
