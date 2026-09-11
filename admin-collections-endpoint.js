// admin-collections-endpoint.js
//
// Admin CRUD for curated resource collections.
//
// Firestore:
// collections/<id>
//
// Status:
// draft -> published -> archived

import { requireAdmin } from './admin-middleware.js';
import {
  fsGet,
  fsSet,
  fsUpdate,
  fsQuery,
} from './firestore-rest.js';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function error(message, status = 400) {
  return json({ error: message }, status);
}

function id() {
  return (
    'collection-' +
    Date.now().toString(36) +
    '-' +
    crypto.randomUUID().slice(0, 8)
  );
}

const MAX_RESOURCES = 100;

function cleanString(value, max = 500) {
  return String(value || '')
    .trim()
    .slice(0, max);
}

function cleanTags(value) {
  if (Array.isArray(value)) {
    return [
      ...new Set(
        value
          .map((tag) =>
            cleanString(tag, 60)
          )
          .filter(Boolean)
      ),
    ].slice(0, 30);
  }

  return String(value || '')
    .split(',')
    .map((tag) =>
      cleanString(tag, 60)
    )
    .filter(Boolean)
    .slice(0, 30);
}

async function validateResourceIds(
  resourceIds,
  env
) {
  const ids = [
    ...new Set(
      (Array.isArray(resourceIds)
        ? resourceIds
        : []
      )
        .map((value) =>
          cleanString(value, 200)
        )
        .filter(Boolean)
    ),
  ].slice(0, MAX_RESOURCES);

  const resources = [];

  for (const resourceId of ids) {
    const resource = await fsGet(
      `readyMadeResources/${resourceId}`,
      env
    );

    if (!resource) {
      throw new Error(
        `Resource not found: ${resourceId}`
      );
    }

    if (resource.status !== 'published') {
      throw new Error(
        `Resource is not published: ${resource.title || resourceId}`
      );
    }

    resources.push(resource);
  }

  return {
    ids,
    resources,
  };
}

/*
  GET /api/admin/collections
*/
export async function handleAdminCollectionList(
  request,
  env
) {
  try {
    await requireAdmin(request, env);
  } catch (e) {
    return error(
      e.message,
      e.status || 401
    );
  }

  try {
    const url = new URL(request.url);
    const status =
      url.searchParams.get('status');

    let collections;

    if (status) {
      collections = await fsQuery(
        'collections',
        'status',
        status,
        'updatedAt',
        100,
        env
      );
    } else {
      collections = await fsQuery(
        'collections',
        'source',
        'curated',
        'updatedAt',
        100,
        env
      );
    }

    return json({
      collections: Array.isArray(collections)
        ? collections
        : [],
    });
  } catch (e) {
    console.error(
      '[admin-collections] list failed:',
      e.message
    );

    return error(
      'Could not load collections.',
      500
    );
  }
}

/*
  GET /api/admin/collections/:id
*/
export async function handleAdminCollectionGet(
  request,
  env,
  collectionId
) {
  try {
    await requireAdmin(request, env);
  } catch (e) {
    return error(
      e.message,
      e.status || 401
    );
  }

  const collection = await fsGet(
    `collections/${collectionId}`,
    env
  );

  if (!collection) {
    return error(
      'Collection not found.',
      404
    );
  }

  return json({ collection });
}

/*
  POST /api/admin/collections
*/
export async function handleAdminCollectionCreate(
  request,
  env
) {
  let identity;

  try {
    identity = await requireAdmin(
      request,
      env
    );
  } catch (e) {
    return error(
      e.message,
      e.status || 401
    );
  }

  let body;

  try {
    body = await request.json();
  } catch (_) {
    return error('Invalid JSON body.');
  }

  const title = cleanString(
    body.title,
    160
  );

  if (!title) {
    return error(
      'Collection title is required.'
    );
  }

  try {
    const validated =
      await validateResourceIds(
        body.resourceIds,
        env
      );

    const collectionId = id();
    const now =
      new Date().toISOString();

    const collection = {
      id: collectionId,
      title,
      description: cleanString(
        body.description,
        1000
      ),
      subject: cleanString(
        body.subject,
        120
      ),
      educationalLevel: cleanString(
        body.educationalLevel,
        120
      ),
      classLevel: cleanString(
        body.classLevel,
        120
      ),
      curriculum: cleanString(
        body.curriculum,
        120
      ),
      tags: cleanTags(body.tags),
      resourceIds: validated.ids,
      status: 'draft',
      featured: Boolean(body.featured),
      recommended: Boolean(
        body.recommended
      ),
      sortOrder:
        Number(body.sortOrder) || 0,
      source: 'curated',
      createdBy: identity.uid,
      updatedBy: identity.uid,
      createdAt: now,
      updatedAt: now,
      publishedAt: null,
    };

    await fsSet(
      `collections/${collectionId}`,
      collection,
      env
    );

    return json({
      collection,
    }, 201);
  } catch (e) {
    console.error(
      '[admin-collections] create failed:',
      e.message
    );

    return error(
      e.message ||
        'Could not create collection.',
      400
    );
  }
}

/*
  PATCH /api/admin/collections/:id
*/
export async function handleAdminCollectionUpdate(
  request,
  env,
  collectionId
) {
  let identity;

  try {
    identity = await requireAdmin(
      request,
      env
    );
  } catch (e) {
    return error(
      e.message,
      e.status || 401
    );
  }

  const existing = await fsGet(
    `collections/${collectionId}`,
    env
  );

  if (!existing) {
    return error(
      'Collection not found.',
      404
    );
  }

  let body;

  try {
    body = await request.json();
  } catch (_) {
    return error('Invalid JSON body.');
  }

  try {
    const updates = {
      updatedBy: identity.uid,
      updatedAt:
        new Date().toISOString(),
    };

    if ('title' in body) {
      updates.title = cleanString(
        body.title,
        160
      );

      if (!updates.title) {
        return error(
          'Collection title is required.'
        );
      }
    }

    if ('description' in body) {
      updates.description =
        cleanString(
          body.description,
          1000
        );
    }

    for (const field of [
      'subject',
      'educationalLevel',
      'classLevel',
      'curriculum',
    ]) {
      if (field in body) {
        updates[field] =
          cleanString(
            body[field],
            120
          );
      }
    }

    if ('tags' in body) {
      updates.tags = cleanTags(
        body.tags
      );
    }

    if ('resourceIds' in body) {
      const validated =
        await validateResourceIds(
          body.resourceIds,
          env
        );

      updates.resourceIds =
        validated.ids;
    }

    if ('featured' in body) {
      updates.featured =
        Boolean(body.featured);
    }

    if ('recommended' in body) {
      updates.recommended =
        Boolean(body.recommended);
    }

    if ('sortOrder' in body) {
      updates.sortOrder =
        Number(body.sortOrder) || 0;
    }

    const updated = {
      ...existing,
      ...updates,
    };

    await fsSet(
      `collections/${collectionId}`,
      updated,
      env
    );

    return json({
      collection: updated,
    });
  } catch (e) {
    console.error(
      '[admin-collections] update failed:',
      e.message
    );

    return error(
      e.message ||
        'Could not update collection.',
      400
    );
  }
}

/*
  POST /api/admin/collections/:id/publish
*/
export async function handleAdminCollectionPublish(
  request,
  env,
  collectionId
) {
  let identity;

  try {
    identity = await requireAdmin(
      request,
      env
    );
  } catch (e) {
    return error(
      e.message,
      e.status || 401
    );
  }

  const collection = await fsGet(
    `collections/${collectionId}`,
    env
  );

  if (!collection) {
    return error(
      'Collection not found.',
      404
    );
  }

  try {
    const validated =
      await validateResourceIds(
        collection.resourceIds,
        env
      );

    if (!validated.ids.length) {
      return error(
        'A collection must contain at least one published resource.'
      );
    }

    const updated = {
      ...collection,
      resourceIds: validated.ids,
      status: 'published',
      publishedAt:
        collection.publishedAt ||
        new Date().toISOString(),
      updatedBy: identity.uid,
      updatedAt:
        new Date().toISOString(),
    };

    await fsSet(
      `collections/${collectionId}`,
      updated,
      env
    );

    return json({
      collection: updated,
    });
  } catch (e) {
    return error(
      e.message,
      400
    );
  }
}

/*
  POST /api/admin/collections/:id/archive
*/
export async function handleAdminCollectionArchive(
  request,
  env,
  collectionId
) {
  let identity;

  try {
    identity = await requireAdmin(
      request,
      env
    );
  } catch (e) {
    return error(
      e.message,
      e.status || 401
    );
  }

  const collection = await fsGet(
    `collections/${collectionId}`,
    env
  );

  if (!collection) {
    return error(
      'Collection not found.',
      404
    );
  }

  const updated = {
    ...collection,
    status: 'archived',
    updatedBy: identity.uid,
    updatedAt:
      new Date().toISOString(),
  };

  await fsSet(
    `collections/${collectionId}`,
    updated,
    env
  );

  return json({
    collection: updated,
  });
}
