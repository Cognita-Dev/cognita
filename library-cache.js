// library-cache.js
//
// Read-through cache for published library (admin-curated) content.
// Firestore's `adminResources` collection stays the source of truth —
// this just means a user opening or browsing published content almost
// never has to wait on a live Firestore read to get there:
//
//   1. A small "snapshot" of each published resource (and a small
//      index of the whole published list) is written to Workers KV
//      ONCE, at the moment an admin actually publishes/edits/archives
//      it — not recomputed from scratch on every read.
//   2. The single-resource GET response is additionally cached in
//      Cloudflare's edge Cache API, since that content is identical
//      for every user (unlike the list, which is personalized per
//      requester) — so most repeat reads never even reach this Worker's
//      logic, let alone Firestore.
//
// If the KV namespace isn't bound (e.g. running before it's been
// created), every function here degrades to a no-op / cache-miss —
// the endpoints fall back to Firestore exactly as before.

import { buildExcerpt } from './excerpt-builder.js';

const RESOURCE_PREFIX = 'resource:';
const INDEX_KEY = 'index';

function _kv(env) {
  return env.COGNITA_LIBRARY_CACHE || null;
}

// The exact shape handleLibraryGet returns for a single published
// resource — kept in one place so the KV snapshot, the edge-cached
// response, and a live Firestore read all produce an identical shape.
export function buildResourceSnapshot(doc) {
  return {
    id: doc.id,
    resourceType: doc.resourceType,
    structuredContent: doc.structuredContent,
    designTemplateId: doc.designTemplateId,
    fileReferences: doc.fileReferences,
    publishedAt: doc.publishedAt,
  };
}

// The exact shape handleLibraryList returns per item in the browse list.
// `excerpt` is computed once here — at publish/edit time, the same
// moment the rest of this entry is computed — rather than on every
// read, and rather than requiring a browsing user's client to fetch
// each resource's full content just to show a preview.
export function buildIndexEntry(doc) {
  return {
    id: doc.id,
    resourceType: doc.resourceType,
    title: doc.structuredContent?.title || 'Untitled',
    excerpt: buildExcerpt(doc.structuredContent),
    designTemplateId: doc.designTemplateId,
    publishedAt: doc.publishedAt,
    updatedAt: doc.updatedAt,
  };
}

// A fixed, synthetic cache key independent of whatever hostname the
// request actually arrived on (workers.dev vs a custom domain) — the
// Cache API keys entries by Request, so this keeps one canonical key
// per resource no matter how it's reached.
function resourceCacheKey(resourceId) {
  return new Request('https://cognita-library-cache.internal/resource/' + resourceId);
}

export async function matchResourceEdgeCache(resourceId) {
  try {
    return await caches.default.match(resourceCacheKey(resourceId));
  } catch (e) {
    console.error('[library-cache] edge cache read failed:', e.message);
    return null;
  }
}

export async function putResourceEdgeCache(resourceId, response) {
  try {
    await caches.default.put(resourceCacheKey(resourceId), response);
  } catch (e) {
    console.error('[library-cache] edge cache write failed:', e.message);
  }
}

export async function purgeResourceEdgeCache(resourceId) {
  try {
    await caches.default.delete(resourceCacheKey(resourceId));
  } catch (e) {
    console.error('[library-cache] edge cache purge failed:', e.message);
  }
}

export async function readResourceSnapshot(env, resourceId) {
  const kv = _kv(env);
  if (!kv) return null;
  try {
    return await kv.get(RESOURCE_PREFIX + resourceId, 'json');
  } catch (e) {
    console.error('[library-cache] snapshot read failed:', e.message);
    return null;
  }
}

export async function writeResourceSnapshot(env, doc) {
  const kv = _kv(env);
  if (!kv) return;
  try {
    await kv.put(RESOURCE_PREFIX + doc.id, JSON.stringify(buildResourceSnapshot(doc)));
  } catch (e) {
    console.error('[library-cache] snapshot write failed:', e.message);
  }
}

export async function deleteResourceSnapshot(env, resourceId) {
  const kv = _kv(env);
  if (!kv) return;
  try {
    await kv.delete(RESOURCE_PREFIX + resourceId);
  } catch (e) {
    console.error('[library-cache] snapshot delete failed:', e.message);
  }
}

export async function readIndex(env) {
  const kv = _kv(env);
  if (!kv) return null;
  try {
    return await kv.get(INDEX_KEY, 'json');
  } catch (e) {
    console.error('[library-cache] index read failed:', e.message);
    return null;
  }
}

export async function writeIndex(env, entries) {
  const kv = _kv(env);
  if (!kv) return;
  try {
    await kv.put(INDEX_KEY, JSON.stringify(entries));
  } catch (e) {
    console.error('[library-cache] index write failed:', e.message);
  }
}

// Adds/updates a resource's entry in the cached index in place (newest
// first), or removes it if it's no longer published — so a single
// publish/archive/edit only costs one small KV read+write instead of
// re-querying and rebuilding the whole list from Firestore.
export async function upsertIndexEntry(env, doc) {
  const current = (await readIndex(env)) || [];
  const withoutThis = current.filter((e) => e.id !== doc.id);
  const next = doc.status === 'published'
    ? [buildIndexEntry(doc), ...withoutThis]
    : withoutThis;
  await writeIndex(env, next);
}

export async function removeIndexEntry(env, resourceId) {
  const current = (await readIndex(env)) || [];
  await writeIndex(env, current.filter((e) => e.id !== resourceId));
}

// Called from every admin write path that can change what a user sees
// in the library (publish, edit-that-unpublishes, archive, restore,
// delete) so the KV snapshot/index and the edge cache can never go
// stale — invalidation happens at the moment of change, not on a timer.
export async function invalidatePublished(env, resourceId) {
  await deleteResourceSnapshot(env, resourceId);
  await removeIndexEntry(env, resourceId);
  await purgeResourceEdgeCache(resourceId);
}

// Called after a resource is (re)published, so the very next read —
// by anyone — is already a cache hit instead of a first-time miss.
export async function refreshPublished(env, doc) {
  await writeResourceSnapshot(env, doc);
  await upsertIndexEntry(env, doc);
  await purgeResourceEdgeCache(doc.id);
}
