// library-endpoint.js

import { requireAuth } from './auth-middleware.js';
import { fsGet, fsQuery } from './firestore-rest.js';
import { b2GetDownloadAuthorization, b2BuildPrivateDownloadUrl } from './b2-client.js';
import {
  buildResourceSnapshot,
  buildIndexEntry,
  readResourceSnapshot,
  writeResourceSnapshot,
  readIndex,
  writeIndex,
  matchResourceEdgeCache,
  putResourceEdgeCache,
} from './library-cache.js';
import { buildExcerpt } from './excerpt-builder.js';

function _corsJsonHeaders(env) {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': env?.APP_ORIGIN || '*' };
}

function _jsonError(message, status, env) {
  return new Response(JSON.stringify({ error: message }), { status, headers: _corsJsonHeaders(env) });
}

function _jsonOk(body, status, env) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: _corsJsonHeaders(env) });
}

export async function handleLibraryList(request, env) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    return _jsonError('Not authenticated: ' + e.message, 401, env);
  }

  try {
    const url = new URL(request.url);
    const resourceType = url.searchParams.get('resourceType');

    // The published list itself is identical for every user — reuse
    // the small precomputed index (kept current by every
    // publish/edit/archive/restore/delete) instead of querying
    // Firestore's `adminResources` collection on every page load.
    // A cached index written before excerpts existed has entries with
    // no `excerpt` key at all (as opposed to one that's legitimately
    // '' for a resource that's still generating). That distinction is
    // what tells a stale pre-excerpt cache apart from a normal one, so
    // it can self-heal on the next read instead of showing a blank
    // preview for every already-published resource until it happens
    // to be re-edited.
    let publicShape = await readIndex(env);
    if (!publicShape || publicShape.some((e) => !('excerpt' in e))) {
      const published = await fsQuery('adminResources', 'status', 'published', 'updatedAt', 200, env);
      publicShape = published.map(buildIndexEntry);
      await writeIndex(env, publicShape);
    }

    const filtered = resourceType
      ? publicShape.filter((r) => r.resourceType === resourceType)
      : publicShape;

    // Only rank/label when browsing the full list — a type-filtered
    // request is already a deliberate, narrow query and doesn't need a
    // "Recommended" split imposed on top of it. This part is genuinely
    // per-user, so it still runs live rather than being cached.
    const ordered = resourceType
      ? filtered
      : await _withRecommendations(filtered, identity.uid, env);

    return _jsonOk({ resources: ordered }, 200, env);
  } catch (e) {
    console.error('[library] list failed:', e.message);
    return _jsonError('Could not load the library. Please try again.', 500, env);
  }
}

// Surfaces admin-curated content the user is likely to actually want,
// using a simple, explainable signal: whichever resourceType the user
// generates most often themselves is the type of admin content they're
// recommended first. This is a real, if modest, personalization —
// deliberately not a black-box score, so it's easy to reason about and
// to explain to a user or teammate later.
//
// A brand-new user has no generation history to match against, so
// instead of showing an empty "Recommended" section, the most recently
// published admin items are labeled "Featured" — publishedList is
// already ordered by updatedAt, so the first few are the newest.
async function _withRecommendations(list, uid, env) {
  let topType = null;
  try {
    const own = await fsQuery('resources', 'ownerId', uid, 'createdAt', 200, env);
    const counts = {};
    own.forEach((r) => {
      if (!r.resourceType) return;
      counts[r.resourceType] = (counts[r.resourceType] || 0) + 1;
    });
    let topCount = 0;
    for (const type in counts) {
      if (counts[type] > topCount) {
        topType = type;
        topCount = counts[type];
      }
    }
  } catch (e) {
    console.error('[library] could not resolve top resource type:', e.message);
  }

  if (topType) {
    const matching = list.filter((r) => r.resourceType === topType);
    const rest = list.filter((r) => r.resourceType !== topType);
    if (matching.length) {
      matching.forEach((r) => { r.recommended = true; r.recommendedReason = 'activity'; });
      return [...matching, ...rest];
    }
  }

  if (list.length) {
    const featured = list.slice(0, 3);
    featured.forEach((r) => { r.recommended = true; r.recommendedReason = 'featured'; });
  }
  return list;
}

export async function handleLibraryGet(request, env, resourceId, ctx) {
  try {
    await requireAuth(request, env);
  } catch (e) {
    return _jsonError('Not authenticated: ' + e.message, 401, env);
  }

  // A published resource's content is identical for every user, so a
  // hit here skips KV and Firestore entirely — most repeat reads never
  // reach any storage layer at all.
  const cached = await matchResourceEdgeCache(resourceId);
  if (cached) return cached;

  // Edge miss — try the small precomputed KV snapshot next (written
  // once when the resource was published/edited), before falling back
  // to a live Firestore read.
  let resource = await readResourceSnapshot(env, resourceId);

  if (!resource) {
    let doc;
    try {
      doc = await fsGet('adminResources/' + resourceId, env);
    } catch (e) {
      return _jsonError('Could not load that resource.', 500, env);
    }

    if (!doc || doc.status !== 'published') {
      return _jsonError('Resource not found.', 404, env);
    }

    resource = buildResourceSnapshot(doc);
    // Backfills the KV snapshot for anything published before this
    // cache existed, so the next miss won't need Firestore either.
    const backfill = writeResourceSnapshot(env, doc);
    if (ctx) ctx.waitUntil(backfill); else await backfill;
  }

  const response = _jsonOk({ resource }, 200, env);
  response.headers.set('Cache-Control', 'public, max-age=300');

  const cachePut = putResourceEdgeCache(resourceId, response.clone());
  if (ctx) ctx.waitUntil(cachePut); else await cachePut;

  return response;
}

export async function handleLibraryDownload(request, env, resourceId) {
  try {
    await requireAuth(request, env);
  } catch (e) {
    return _jsonError('Not authenticated: ' + e.message, 401, env);
  }

  let doc;
  try {
    doc = await fsGet('adminResources/' + resourceId, env);
  } catch (e) {
    return _jsonError('Could not load that resource.', 500, env);
  }
  if (!doc || doc.status !== 'published') {
    return _jsonError('Resource not found.', 404, env);
  }

  const url = new URL(request.url);
  const requestedFormat = url.searchParams.get('format');
  const format = requestedFormat && doc.fileReferences && doc.fileReferences[requestedFormat]
    ? requestedFormat
    : Object.keys(doc.fileReferences || {})[0];

  if (!format || !doc.fileReferences[format]) {
    return _jsonError('No export file is available for this resource yet.', 404, env);
  }

  try {
    const prefix = 'adminGenerated/' + resourceId + '/exports/';
    const authToken = await b2GetDownloadAuthorization(env, prefix, 3600);
    const downloadUrl = await b2BuildPrivateDownloadUrl(env, doc.fileReferences[format].key, authToken);
    return _jsonOk({ url: downloadUrl, format, expiresInSeconds: 3600 }, 200, env);
  } catch (e) {
    console.error('[library] download authorization failed:', e.message);
    return _jsonError('Could not prepare the download. Please try again.', 503, env);
  }
}

export async function handleLibraryCollectionGet(request, env, collectionId) {
  try {
    await requireAuth(request, env);
  } catch (e) {
    return _jsonError('Not authenticated: ' + e.message, 401, env);
  }

  let collectionDoc;
  try {
    collectionDoc = await fsGet('collections/' + collectionId, env);
  } catch (e) {
    return _jsonError('Could not load that collection.', 500, env);
  }
  if (!collectionDoc || collectionDoc.visibility !== 'published') {
    return _jsonError('Collection not found.', 404, env);
  }

  const ids = Array.isArray(collectionDoc.resourceIds) ? collectionDoc.resourceIds : [];
  const docs = await Promise.all(ids.map((id) => fsGet('adminResources/' + id, env).catch(() => null)));

  const resources = docs
    .filter((r) => r && r.status === 'published')
    .map((r) => ({
      id: r.id,
      resourceType: r.resourceType,
      title: r.structuredContent?.title || 'Untitled',
      excerpt: buildExcerpt(r.structuredContent),
      designTemplateId: r.designTemplateId,
      publishedAt: r.publishedAt,
    }));

  return _jsonOk({
    collection: {
      id: collectionDoc.id,
      name: collectionDoc.name,
      description: collectionDoc.description,
    },
    resources,
  }, 200, env);
}
