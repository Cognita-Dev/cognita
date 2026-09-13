// collections-endpoint.js

import { requireAdmin } from './admin-auth.js';
import { requireAuth } from './auth-middleware.js';
import { fsSet, fsGet, fsQuery, fsDelete } from './firestore-rest.js';

function _makeId() {
  return (crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'c-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}

function _corsJsonHeaders(env) {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': env?.APP_ORIGIN || '*' };
}

function _jsonError(message, status, env) {
  return new Response(JSON.stringify({ error: message }), { status, headers: _corsJsonHeaders(env) });
}

function _jsonOk(body, status, env) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: _corsJsonHeaders(env) });
}

export async function handleCollectionCreate(request, env) {
  let identity;
  try {
    identity = await requireAdmin(request, env);
  } catch (e) {
    return _jsonError('Not authorized: ' + e.message, e.isForbidden ? 403 : 401, env);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return _jsonError('Invalid JSON body.', 400, env);
  }

  const name = String(body.name || '').trim();
  if (!name) return _jsonError('name is required.', 400, env);

  const id = _makeId();
  const now = new Date().toISOString();
  const doc = {
    id,
    name,
    description: String(body.description || '').trim(),
    visibility: 'draft',
    resourceIds: [],
    createdBy: identity.uid,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await fsSet('collections/' + id, doc, env);
  } catch (e) {
    console.error('[collections] create failed:', e.message);
    return _jsonError('Could not create the collection.', 500, env);
  }

  return _jsonOk({ collection: doc }, 201, env);
}

export async function handleCollectionEdit(request, env, collectionId) {
  try {
    await requireAdmin(request, env);
  } catch (e) {
    return _jsonError('Not authorized: ' + e.message, e.isForbidden ? 403 : 401, env);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return _jsonError('Invalid JSON body.', 400, env);
  }

  let doc;
  try {
    doc = await fsGet('collections/' + collectionId, env);
  } catch (e) {
    return _jsonError('Could not load that collection.', 500, env);
  }
  if (!doc) return _jsonError('Collection not found.', 404, env);

  if (body.visibility !== undefined && !['draft', 'published'].includes(body.visibility)) {
    return _jsonError('visibility must be "draft" or "published".', 400, env);
  }

  const updated = {
    ...doc,
    name: body.name !== undefined ? String(body.name).trim() || doc.name : doc.name,
    description: body.description !== undefined ? String(body.description).trim() : doc.description,
    visibility: body.visibility !== undefined ? body.visibility : doc.visibility,
    updatedAt: new Date().toISOString(),
  };

  try {
    await fsSet('collections/' + collectionId, updated, env);
  } catch (e) {
    return _jsonError('Could not save the collection.', 500, env);
  }

  return _jsonOk({ collection: updated }, 200, env);
}

export async function handleCollectionResourceEdit(request, env, collectionId) {
  try {
    await requireAdmin(request, env);
  } catch (e) {
    return _jsonError('Not authorized: ' + e.message, e.isForbidden ? 403 : 401, env);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return _jsonError('Invalid JSON body.', 400, env);
  }

  const { action, resourceId } = body;
  if (!['add', 'remove'].includes(action)) {
    return _jsonError('action must be "add" or "remove".', 400, env);
  }
  if (!resourceId) {
    return _jsonError('resourceId is required.', 400, env);
  }

  let collectionDoc;
  try {
    collectionDoc = await fsGet('collections/' + collectionId, env);
  } catch (e) {
    return _jsonError('Could not load that collection.', 500, env);
  }
  if (!collectionDoc) return _jsonError('Collection not found.', 404, env);

  if (action === 'add') {
    let resourceDoc;
    try {
      resourceDoc = await fsGet('adminResources/' + resourceId, env);
    } catch (e) {
      return _jsonError('Could not load that resource.', 500, env);
    }
    if (!resourceDoc) return _jsonError('Resource not found.', 404, env);
    if (resourceDoc.status !== 'published') {
      return _jsonError('Only published resources can be added to a collection.', 409, env);
    }
  }

  const currentIds = Array.isArray(collectionDoc.resourceIds) ? collectionDoc.resourceIds : [];
  const nextIds = action === 'add'
    ? (currentIds.includes(resourceId) ? currentIds : [...currentIds, resourceId])
    : currentIds.filter((id) => id !== resourceId);

  const updated = {
    ...collectionDoc,
    resourceIds: nextIds,
    updatedAt: new Date().toISOString(),
  };

  try {
    await fsSet('collections/' + collectionId, updated, env);
  } catch (e) {
    console.error('[collections] resource edit failed:', e.message);
    return _jsonError('Could not update the collection.', 500, env);
  }

  return _jsonOk({ collection: updated }, 200, env);
}

export async function handleAdminCollectionList(request, env) {
  try {
    await requireAdmin(request, env);
  } catch (e) {
    return _jsonError('Not authorized: ' + e.message, e.isForbidden ? 403 : 401, env);
  }

  try {
    const [drafts, published] = await Promise.all([
      fsQuery('collections', 'visibility', 'draft', 'updatedAt', 100, env),
      fsQuery('collections', 'visibility', 'published', 'updatedAt', 100, env),
    ]);
    const collections = [...drafts, ...published].sort(
      (a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')
    );
    return _jsonOk({ collections }, 200, env);
  } catch (e) {
    console.error('[collections] admin list failed:', e.message);
    return _jsonError('Could not load collections.', 500, env);
  }
}

export async function handleCollectionDelete(request, env, collectionId) {
  try {
    await requireAdmin(request, env);
  } catch (e) {
    return _jsonError('Not authorized: ' + e.message, e.isForbidden ? 403 : 401, env);
  }

  try {
    await fsDelete('collections/' + collectionId, env);
  } catch (e) {
    console.error('[collections] delete failed:', e.message);
    return _jsonError('Could not delete the collection.', 500, env);
  }

  return _jsonOk({ deleted: true }, 200, env);
}

export async function handlePublicCollectionList(request, env) {
  try {
    await requireAuth(request, env);
  } catch (e) {
    return _jsonError('Not authenticated: ' + e.message, 401, env);
  }

  try {
    const collections = await fsQuery('collections', 'visibility', 'published', 'updatedAt', 100, env);
    return _jsonOk({ collections }, 200, env);
  } catch (e) {
    console.error('[collections] public list failed:', e.message);
    return _jsonError('Could not load collections.', 500, env);
  }
}
