// studio/store.js
// Local persistence for Cognita Studio: project JSON and uploaded image blobs in IndexedDB.
// Everything here stays on the device. Nothing is uploaded unless a future export-to-cloud step does it.

const DB_NAME = 'cognita-studio';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) { reject(new Error('IndexedDB unavailable')); return; }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function tx(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    const r = fn(s);
    t.oncomplete = () => resolve(r && 'result' in r ? r.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage write was blocked'));
  });
}

export const isStorageAvailable = () => 'indexedDB' in window;
export const saveProject = (p) => tx('projects', 'readwrite', (s) => s.put(p));
export const getProject = (id) => tx('projects', 'readonly', (s) => s.get(id));
export const deleteProject = (id) => tx('projects', 'readwrite', (s) => s.delete(id));
export const listProjects = async () => {
  const all = (await tx('projects', 'readonly', (s) => s.getAll())) || [];
  return all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
};
export const putAsset = (a) => tx('assets', 'readwrite', (s) => s.put(a));
export const getAsset = (id) => tx('assets', 'readonly', (s) => s.get(id));
export const deleteAsset = (id) => tx('assets', 'readwrite', (s) => s.delete(id));

export async function storageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const { usage, quota } = await navigator.storage.estimate();
      return { usage, quota };
    }
  } catch (_) { /* ignore */ }
  return null;
}

export const uid = (p = 'id') => p + '_' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
