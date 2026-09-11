// collections-endpoint.js
// Admin management of Collections — named groupings of published
// adminResources for the user-facing library. A collection tracks its
// own member resource ids directly (resourceIds: string[]) rather than
// relying on a Firestore array-contains query, since the REST client in
// firestore-rest.js only supports single equality filters.

import { requireAdmin } from './admin-auth.js';
import { requireAuth } from './auth-middleware.js';
import { fsSet, fsGet, fsQuery, fsDelete } from './firestore-rest.js';

function _makeId() {
  return (crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'c-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}

function _corsJsonHeaders() {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
}

function _jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: _corsJsonHeaders() });
}

function _jsonOk(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: _corsJsonHeaders() });
}

// ── Admin: create ─────────────────────────────────────────────────────
// POST /api/admin/collections
// Body: { name, description? }
export async function handleCollectionCreate(request, env) {
  let identity;
  try {
    identity = await requireAdmin(request, env);
  } catch (e) {
    return _jsonError('Not authorized: ' + e.message, e.isForbidden ? 403 : 401);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return _jsonError('Invalid JSON body.', 400);
  }

  const name = String(body.name || '').trim();
  if (!name) return _jsonError('name is required.', 400);

  const id = _makeId();
  const now = new Date().toISOString();
  const doc = {
    id,
    name,
    description: String(body.description || '').trim(),
    visibility: 'draft', // draft | published
    resourceIds: [],
    createdBy: identity.uid,
    createdAt: now,
    updatedAt: now,
  };

  try {
    await fsSet('collections/' + id, doc, env);
  } catch (e) {
    console.error('[collections] create failed:', e.message);
    return _jsonError('Could not create the collection.', 500);
  }

  return _jsonOk({ collection: doc }, 201);
}

// ── Admin: edit (name/description/visibility) ────────────────────────
// POST /api/admin/collections/:id
// Body: { name?, description?, visibility? }
export async function handleCollectionEdit(request, env, collectionId) {
  try {
    await requireAdmin(request, env);
  } catch (e) {
    return _jsonError('Not authorized: ' + e.message, e.isForbidden ? 403 : 401);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return _jsonError('Invalid JSON body.', 400);
  }

  let doc;
  try {
    doc = await fsGet('collections/' + collectionId, env);
  } catch (e) {
    return _jsonError('Could not load that collection.', 500);
  }
  if (!doc) return _jsonError('Collection not found.', 404);

  if (body.visibility !== undefined && !['draft', 'published'].includes(body.visibility)) {
    return _jsonError('visibility must be "draft" or "published".', 400);
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
    return _jsonError('Could not save the collection.', 500);
  }

  return _jsonOk({ collection: updated });
}

// ── Admin: add/remove a resource from a collection ───────────────────
// POST /api/admin/collections/:id/resources
// Body: { action: 'add' | 'remove', resourceId }
// Idempotent: adding an already-present id, or removing an already-absent
// id, both succeed without error — the end state is what matters.
export async function handleCollectionResourceEdit(request, env, collectionId) {
  try {
    await requireAdmin(request, env);
  } catch (e) {
    return _jsonError('Not authorized: ' + e.message, e.isForbidden ? 403 : 401);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return _jsonError('Invalid JSON body.', 400);
  }

  const { action, resourceId } = body;
  if (!['add', 'remove'].includes(action)) {
    return _jsonError('action must be "add" or "remove".', 400);
  }
  if (!resourceId) {
    return _jsonError('resourceId is required.', 400);
  }

  let collectionDoc;
  try {
    collectionDoc = await fsGet('collections/' + collectionId, env);
  } catch (e) {
    return _jsonError('Could not load that collection.', 500);
  }
  if (!collectionDoc) return _jsonError('Collection not found.', 404);

  if (action === 'add') {
    // Only published resources belong in a collection users can see —
    // but the collection itself may still be draft, so this only checks
    // the resource's own status, not the collection's visibility.
    let resourceDoc;
    try {
      resourceDoc = await fsGet('adminResources/' + resourceId, env);
    } catch (e) {
      return _jsonError('Could not load that resource.', 500);
    }
    if (!resourceDoc) return _jsonError('Resource not found.', 404);
    if (resourceDoc.status !== 'published') {
      return _jsonError('Only published resources can be added to a collection.', 409);
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
    return _jsonError('Could not update the collection.', 500);
  }

  return _jsonOk({ collection: updated });
}

// ── Admin: list all collections (any visibility) ─────────────────────
// GET /api/admin/collections
export async function handleAdminCollectionList(request, env) {
  try {
    await requireAdmin(request, env);
  } catch (e) {
    return _jsonError('Not authorized: ' + e.message, e.isForbidden ? 403 : 401);
  }

  try {
    const [drafts, published] = await Promise.all([
      fsQuery('collections', 'visibility', 'draft', 'updatedAt', 100, env),
      fsQuery('collections', 'visibility', 'published', 'updatedAt', 100, env),
    ]);
    const collections = [...drafts, ...published].sort(
      (a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')
    );
    return _jsonOk({ collections });
  } catch (e) {
    console.error('[collections] admin list failed:', e.message);
    return _jsonError('Could not load collections.', 500);
  }
}

// ── Admin: delete a collection ────────────────────────────────────────
// DELETE /api/admin/collections/:id
// Deleting a collection never deletes its member resources — it only
// removes the grouping.
export async function handleCollectionDelete(request, env, collectionId) {
  try {
    await requireAdmin(request, env);
  } catch (e) {
    return _jsonError('Not authorized: ' + e.message, e.isForbidden ? 403 : 401);
  }

  try {
    await fsDelete('collections/' + collectionId, env);
  } catch (e) {
    console.error('[collections] delete failed:', e.message);
    return _jsonError('Could not delete the collection.', 500);
  }

  return _jsonOk({ deleted: true });
}

// ── User-facing: list published collections ──────────────────────────
// GET /api/library/collections
export async function handlePublicCollectionList(request, env) {
  try {
    await requireAuth(request, env);
  } catch (e) {
    return _jsonError('Not authenticated: ' + e.message, 401);
  }

  try {
    const collections = await fsQuery('collections', 'visibility', 'published', 'updatedAt', 100, env);
    return _jsonOk({ collections });
  } catch (e) {
    console.error('[collections] public list failed:', e.message);
    return _jsonError('Could not load collections.', 500);
  }
}
