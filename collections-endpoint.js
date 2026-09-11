// collections-endpoint.js
//
// Public API for Cognita's curated resource collections.
//
// Firestore:
// collections/<id>
//
// A collection references published ready-made resources by ID.
// Individual resources remain owned by readyMadeResources/<id>.

import { requireAuth } from './auth-middleware.js';
import { fsGet, fsQuery } from './firestore-rest.js';

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

function publicResource(resource) {
  return {
    id: resource.id,
    resourceType: resource.resourceType,
    title: resource.title,
    description: resource.description || '',
    subject: resource.subject || '',
    educationalLevel: resource.educationalLevel || '',
    classLevel: resource.classLevel || '',
    curriculum: resource.curriculum || '',
    topic: resource.topic || '',
    tags: Array.isArray(resource.tags) ? resource.tags : [],
    featured: !!resource.featured,
    recommended: !!resource.recommended,
    currentVersion: resource.currentVersion || 1,
    structuredContent: resource.structuredContent || null,
    designTemplateId: resource.designTemplateId || 'default',
    publishedAt: resource.publishedAt || null,
    fileReferences: resource.fileReferences || {},
  };
}

function publicCollection(collection, resources = []) {
  return {
    id: collection.id,
    title: collection.title,
    description: collection.description || '',
    subject: collection.subject || '',
    educationalLevel: collection.educationalLevel || '',
    classLevel: collection.classLevel || '',
    curriculum: collection.curriculum || '',
    tags: Array.isArray(collection.tags)
      ? collection.tags
      : [],
    featured: !!collection.featured,
    recommended: !!collection.recommended,
    sortOrder: Number(collection.sortOrder) || 0,
    resourceIds: Array.isArray(collection.resourceIds)
      ? collection.resourceIds
      : [],
    resources,
    resourceCount: resources.length,
    publishedAt: collection.publishedAt || null,
  };
}

function sortCollections(collections) {
  return collections.sort((a, b) => {
    if (!!b.featured !== !!a.featured) {
      return b.featured ? 1 : -1;
    }

    if (!!b.recommended !== !!a.recommended) {
      return b.recommended ? 1 : -1;
    }

    const orderA = Number(a.sortOrder) || 0;
    const orderB = Number(b.sortOrder) || 0;

    if (orderA !== orderB) {
      return orderA - orderB;
    }

    return String(b.publishedAt || '').localeCompare(
      String(a.publishedAt || '')
    );
  });
}

async function getPublishedResources(resourceIds, env) {
  const ids = Array.isArray(resourceIds)
    ? resourceIds
    : [];

  if (!ids.length) return [];

  const uniqueIds = [...new Set(ids)];

  const resources = await Promise.all(
    uniqueIds.map(async (id) => {
      try {
        const resource = await fsGet(
          `readyMadeResources/${id}`,
          env
        );

        if (
          !resource ||
          resource.status !== 'published'
        ) {
          return null;
        }

        return resource;
      } catch (e) {
        console.error(
          '[collections] resource lookup failed:',
          e.message
        );

        return null;
      }
    })
  );

  const byId = new Map(
    resources
      .filter(Boolean)
      .map((resource) => [
        resource.id,
        resource,
      ])
  );

  return ids
    .map((id) => byId.get(id))
    .filter(Boolean);
}

/*
  GET /api/collections

  Optional:
    ?subject=Biology
    ?classLevel=SS2
    ?featured=true
    ?recommended=true
    ?limit=50
*/
export async function handleCollectionList(
  request,
  env
) {
  try {
    await requireAuth(request, env);
  } catch (e) {
    return error(
      e.message || 'Not authenticated.',
      e.status || 401
    );
  }

  try {
    const url = new URL(request.url);

    const subject = url.searchParams.get('subject');
    const classLevel =
      url.searchParams.get('classLevel');
    const featured =
      url.searchParams.get('featured');
    const recommended =
      url.searchParams.get('recommended');

    let collections = await fsQuery(
      'collections',
      'status',
      'published',
      'publishedAt',
      100,
      env
    );

    if (!Array.isArray(collections)) {
      collections = [];
    }

    collections = collections.filter(
      (collection) => {
        if (
          subject &&
          String(collection.subject || '')
            .toLowerCase() !==
            subject.toLowerCase()
        ) {
          return false;
        }

        if (
          classLevel &&
          String(collection.classLevel || '')
            .toLowerCase() !==
            classLevel.toLowerCase()
        ) {
          return false;
        }

        if (
          featured !== null &&
          featured !== ''
        ) {
          if (
            Boolean(collection.featured) !==
            (featured === 'true')
          ) {
            return false;
          }
        }

        if (
          recommended !== null &&
          recommended !== ''
        ) {
          if (
            Boolean(collection.recommended) !==
            (recommended === 'true')
          ) {
            return false;
          }
        }

        return true;
      }
    );

    collections = sortCollections(collections);

    const requestedLimit = Number(
      url.searchParams.get('limit') || 50
    );

    const limit = Math.min(
      Math.max(requestedLimit || 50, 1),
      100
    );

    const selected = collections.slice(
      0,
      limit
    );

    const result = await Promise.all(
      selected.map(async (collection) => {
        const resources =
          await getPublishedResources(
            collection.resourceIds,
            env
          );

        return publicCollection(
          collection,
          resources.map(publicResource)
        );
      })
    );

    return json({
      collections: result,
      total: result.length,
    });
  } catch (e) {
    console.error(
      '[collections] list failed:',
      e.message
    );

    return error(
      'Could not load collections.',
      500
    );
  }
}

/*
  GET /api/collections/:id
*/
export async function handleCollectionGet(
  request,
  env,
  collectionId
) {
  try {
    await requireAuth(request, env);
  } catch (e) {
    return error(
      e.message || 'Not authenticated.',
      e.status || 401
    );
  }

  try {
    const collection = await fsGet(
      `collections/${collectionId}`,
      env
    );

    if (
      !collection ||
      collection.status !== 'published'
    ) {
      return error(
        'Collection not found.',
        404
      );
    }

    const resources =
      await getPublishedResources(
        collection.resourceIds,
        env
      );

    return json({
      collection: publicCollection(
        collection,
        resources.map(publicResource)
      ),
    });
  } catch (e) {
    console.error(
      '[collections] get failed:',
      e.message
    );

    return error(
      'Could not load the collection.',
      500
    );
  }
}
