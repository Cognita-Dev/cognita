// reminders/test-mocks.mjs
// In-memory stand-ins for Firestore, Workers KV, Resend (mailer.js) and
// Web Push (push-vapid.js), so reminders.test.mjs can exercise the real
// reminders-storage.js / reminders-scheduler.js logic without any network
// calls. Test-only — nothing in reminders/*.js (non-test) imports this.

export const firestoreStore = new Map(); // path -> plain object
export function resetFirestore() {
  firestoreStore.clear();
}

export async function fsGet(path) {
  return firestoreStore.has(path) ? firestoreStore.get(path) : null;
}
export async function fsSet(path, obj) {
  firestoreStore.set(path, { ...obj });
}
export async function fsUpdate(path, patch) {
  const existing = firestoreStore.get(path) || {};
  firestoreStore.set(path, { ...existing, ...patch });
}
export async function fsDelete(path) {
  firestoreStore.delete(path);
}
export async function fsQuery(collectionId, fieldName, value, orderByField, limitCount, _env, direction) {
  const prefix = collectionId + '/';
  let rows = [...firestoreStore.entries()]
    .filter(([path]) => path.startsWith(prefix))
    .map(([, obj]) => obj)
    .filter((obj) => obj[fieldName] === value);

  if (orderByField) {
    rows.sort((a, b) => {
      const av = a[orderByField];
      const bv = b[orderByField];
      if (av < bv) return direction === 'ASCENDING' ? -1 : 1;
      if (av > bv) return direction === 'ASCENDING' ? 1 : -1;
      return 0;
    });
  }
  return rows.slice(0, limitCount || 50);
}

export class FakeKv {
  constructor() {
    this.map = new Map();
  }
  async get(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  async put(key, value) {
    this.map.set(key, value);
  }
  async delete(key) {
    this.map.delete(key);
  }
  async list({ prefix = '', cursor, limit = 1000 } = {}) {
    const keys = [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort();
    let startIdx = 0;
    if (cursor) startIdx = keys.indexOf(cursor) + 1;
    const page = keys.slice(startIdx, startIdx + limit);
    const list_complete = startIdx + page.length >= keys.length;
    return {
      keys: page.map((name) => ({ name })),
      list_complete,
      cursor: list_complete ? undefined : page[page.length - 1],
    };
  }
}

export const sentEmails = [];
const claimedKeys = new Set();
export function resetMailer() {
  sentEmails.length = 0;
  claimedKeys.clear();
}
export async function sendEmail(_env, to, template) {
  sentEmails.push({ to, template });
}
export async function claimOnce(_env, key) {
  if (claimedKeys.has(key)) return false;
  claimedKeys.add(key);
  return true;
}

// Scripted push results: test cases push { ok, status, gone } (or throw)
// entries; sendWebPush shifts one per call so scenario order controls
// success/failure/410 without touching the network.
export const pushResultQueue = [];
export function resetPush() {
  pushResultQueue.length = 0;
}
export async function sendWebPush(_env, _subscription, _payload) {
  const next = pushResultQueue.shift();
  if (!next) return { ok: true, status: 201, gone: false };
  if (next.throw) throw new Error(next.throw);
  return next;
}
