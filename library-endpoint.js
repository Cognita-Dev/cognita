// library-endpoint.js
// User-facing read access to admin-curated, published resources. This is
// the ONLY entry point normal users have into adminResources — it never
// requires admin rights (just a signed-in user via requireAuth), and it
// never returns anything whose status isn't 'published', no matter what
// query params are sent. Draft/in_review/validated/archived content is
// unreachable from here even if the id is guessed directly.

import { requireAuth } from './auth-middleware.js';
import { fsGet, fsQuery } from './firestore-rest.js';
import { b2GetDownloadAuthorization, b2BuildPrivateDownloadUrl } from './b2-client.js';

function _corsJsonHeaders() {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
}

function _jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: _corsJsonHeaders() });
}

function _jsonOk(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: _corsJsonHeaders() });
}

// GET /api/library/resources?resourceType=... (optional filter)
export async function handleLibraryList(request, env) {
  try {
    await requireAuth(request, env);
  } catch (e) {
    return _jsonError('Not authenticated: ' + e.message, 401);
  }

  try {
    const published = await fsQuery('adminResources', 'status', 'published', 'updatedAt', 200, env);

    const url = new URL(request.url);
    const resourceType = url.searchParams.get('resourceType');
    const filtered = resourceType
      ? published.filter((r) => r.resourceType === resourceType)
      : published;

    // Strip internal fields (createdBy, fields, lastEditedBy) that are
    // admin bookkeeping, not something the library UI needs to render.
    const publicShape = filtered.map((r) => ({
      id: r.id,
      resourceType: r.resourceType,
      title: r.structuredContent?.title || 'Untitled',
      designTemplateId: r.designTemplateId,
      publishedAt: r.publishedAt,
      updatedAt: r.updatedAt,
    }));

    return _jsonOk({ resources: publicShape });
  } catch (e) {
    console.error('[library] list failed:', e.message);
    return _jsonError('Could not load the library. Please try again.', 500);
  }
}

// GET /api/library/resources/:id
// Returns full structuredContent + fileReferences for one published
// resource — refuses anything not currently published, even to a
// signed-in user who has the raw id.
export async function handleLibraryGet(request, env, resourceId) {
  try {
    await requireAuth(request, env);
  } catch (e) {
    return _jsonError('Not authenticated: ' + e.message, 401);
  }

  let doc;
  try {
    doc = await fsGet('adminResources/' + resourceId, env);
  } catch (e) {
    return _jsonError('Could not load that resource.', 500);
  }

  if (!doc || doc.status !== 'published') {
    // Same 404 whether it doesn't exist or just isn't published — never
    // reveal that a draft/in-review resource exists at this id.
    return _jsonError('Resource not found.', 404);
  }

  return _jsonOk({
    resource: {
      id: doc.id,
      resourceType: doc.resourceType,
      structuredContent: doc.structuredContent,
      designTemplateId: doc.designTemplateId,
      fileReferences: doc.fileReferences,
      publishedAt: doc.publishedAt,
    },
  });
}

// POST /api/library/resources/:id/download?format=docx|pdf|pptx
// Same scoped-B2-URL pattern as handleResourceDownload in
// resources-endpoint.js, but gated on "is this published" rather than
// "do you own it" — library resources belong to everyone once published.
export async function handleLibraryDownload(request, env, resourceId) {
  try {
    await requireAuth(request, env);
  } catch (e) {
    return _jsonError('Not authenticated: ' + e.message, 401);
  }

  let doc;
  try {
    doc = await fsGet('adminResources/' + resourceId, env);
  } catch (e) {
    return _jsonError('Could not load that resource.', 500);
  }
  if (!doc || doc.status !== 'published') {
    return _jsonError('Resource not found.', 404);
  }

  const url = new URL(request.url);
  const requestedFormat = url.searchParams.get('format');
  const format = requestedFormat && doc.fileReferences && doc.fileReferences[requestedFormat]
    ? requestedFormat
    : Object.keys(doc.fileReferences || {})[0];

  if (!format || !doc.fileReferences[format]) {
    return _jsonError('No export file is available for this resource yet.', 404);
  }

  try {
    const prefix = 'adminGenerated/' + resourceId + '/exports/';
    const authToken = await b2GetDownloadAuthorization(env, prefix, 3600);
    const downloadUrl = await b2BuildPrivateDownloadUrl(env, doc.fileReferences[format].key, authToken);
    return _jsonOk({ url: downloadUrl, format, expiresInSeconds: 3600 });
  } catch (e) {
    console.error('[library] download authorization failed:', e.message);
    return _jsonError('Could not prepare the download. Please try again.', 503);
  }
}

// GET /api/library/collections/:id
// A published collection's own metadata plus its member resources, in
// the same trimmed public shape as handleLibraryList — filters out any
// member id that somehow points at a non-published resource (e.g. it was
// unpublished after being added), rather than trusting the stored list.
export async function handleLibraryCollectionGet(request, env, collectionId) {
  try {
    await requireAuth(request, env);
  } catch (e) {
    return _jsonError('Not authenticated: ' + e.message, 401);
  }

  let collectionDoc;
  try {
    collectionDoc = await fsGet('collections/' + collectionId, env);
  } catch (e) {
    return _jsonError('Could not load that collection.', 500);
  }
  if (!collectionDoc || collectionDoc.visibility !== 'published') {
    return _jsonError('Collection not found.', 404);
  }

  const ids = Array.isArray(collectionDoc.resourceIds) ? collectionDoc.resourceIds : [];
  const docs = await Promise.all(ids.map((id) => fsGet('adminResources/' + id, env).catch(() => null)));

  const resources = docs
    .filter((r) => r && r.status === 'published')
    .map((r) => ({
      id: r.id,
      resourceType: r.resourceType,
      title: r.structuredContent?.title || 'Untitled',
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
  });
}
