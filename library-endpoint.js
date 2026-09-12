// library-endpoint.js

import { requireAuth } from './auth-middleware.js';
import { fsGet, fsQuery } from './firestore-rest.js';
import { b2GetDownloadAuthorization, b2BuildPrivateDownloadUrl } from './b2-client.js';

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
  try {
    await requireAuth(request, env);
  } catch (e) {
    return _jsonError('Not authenticated: ' + e.message, 401, env);
  }

  try {
    const published = await fsQuery('adminResources', 'status', 'published', 'updatedAt', 200, env);

    const url = new URL(request.url);
    const resourceType = url.searchParams.get('resourceType');
    const filtered = resourceType
      ? published.filter((r) => r.resourceType === resourceType)
      : published;

    const publicShape = filtered.map((r) => ({
      id: r.id,
      resourceType: r.resourceType,
      title: r.structuredContent?.title || 'Untitled',
      designTemplateId: r.designTemplateId,
      publishedAt: r.publishedAt,
      updatedAt: r.updatedAt,
    }));

    return _jsonOk({ resources: publicShape }, 200, env);
  } catch (e) {
    console.error('[library] list failed:', e.message);
    return _jsonError('Could not load the library. Please try again.', 500, env);
  }
}

export async function handleLibraryGet(request, env, resourceId) {
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

  return _jsonOk({
    resource: {
      id: doc.id,
      resourceType: doc.resourceType,
      structuredContent: doc.structuredContent,
      designTemplateId: doc.designTemplateId,
      fileReferences: doc.fileReferences,
      publishedAt: doc.publishedAt,
    },
  }, 200, env);
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
