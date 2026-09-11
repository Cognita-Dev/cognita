// ready-made-resources-endpoint.js
//
// Public, user-facing API for Cognita's curated resource library.
//
// Only resources with status === "published" are exposed here.
// Drafts and archived resources remain admin-only.

import { requireAuth } from './auth-middleware.js';
import { fsGet, fsQuery } from './firestore-rest.js';
import {
  b2GetDownloadAuthorization,
  b2BuildPrivateDownloadUrl,
} from './b2-client.js';

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
    sortOrder: Number(resource.sortOrder) || 0,
    currentVersion: resource.currentVersion || 1,
    structuredContent: resource.structuredContent || null,
    designTemplateId: resource.designTemplateId || 'classic',
    publishedAt: resource.publishedAt || null,
    fileReferences: resource.fileReferences || {},
  };
}

function sortResources(resources) {
  return resources.sort((a, b) => {
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

/*
  GET /api/ready-made-resources

  Optional query parameters:

    ?type=worksheet
    ?subject=Biology
    ?classLevel=SS2
    ?featured=true
    ?recommended=true
    ?limit=50
*/
export async function handleReadyMadeResourceList(
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

    const type = url.searchParams.get('type');
    const subject = url.searchParams.get('subject');
    const classLevel = url.searchParams.get('classLevel');
    const featured = url.searchParams.get('featured');
    const recommended = url.searchParams.get('recommended');

    let resources;

    /*
      Firestore REST querying currently supports one equality
      field through fsQuery(), so we start with the published
      status and perform the remaining lightweight filtering
      in memory.
    */
    resources = await fsQuery(
      'readyMadeResources',
      'status',
      'published',
      'publishedAt',
      100,
      env
    );

    if (!Array.isArray(resources)) {
      resources = [];
    }

    resources = resources.filter((resource) => {
      if (type && resource.resourceType !== type) {
        return false;
      }

      if (
        subject &&
        String(resource.subject || '').toLowerCase() !==
          subject.toLowerCase()
      ) {
        return false;
      }

      if (
        classLevel &&
        String(resource.classLevel || '').toLowerCase() !==
          classLevel.toLowerCase()
      ) {
        return false;
      }

      if (
        featured !== null &&
        featured !== ''
      ) {
        if (
          Boolean(resource.featured) !==
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
          Boolean(resource.recommended) !==
          (recommended === 'true')
        ) {
          return false;
        }
      }

      return true;
    });

    resources = sortResources(resources);

    const requestedLimit = Number(
      url.searchParams.get('limit') || 50
    );

    const limit = Math.min(
      Math.max(requestedLimit || 50, 1),
      100
    );

    resources = resources
      .slice(0, limit)
      .map(publicResource);

    return json({
      resources,
      total: resources.length,
    });
  } catch (e) {
    console.error(
      '[ready-made-resources] list failed:',
      e.message
    );

    return error(
      'Could not load ready-made resources.',
      500
    );
  }
}

/*
  GET /api/ready-made-resources/:id

  Returns one published resource.
*/
export async function handleReadyMadeResourceGet(
  request,
  env,
  resourceId
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
    const resource = await fsGet(
      `readyMadeResources/${resourceId}`,
      env
    );

    if (!resource) {
      return error(
        'Resource not found.',
        404
      );
    }

    if (resource.status !== 'published') {
      return error(
        'Resource not found.',
        404
      );
    }

    return json({
      resource: publicResource(resource),
    });
  } catch (e) {
    console.error(
      '[ready-made-resources] get failed:',
      e.message
    );

    return error(
      'Could not load the resource.',
      500
    );
  }
}

/*
  POST /api/ready-made-resources/:id/download

  Body:
    {
      format: "pdf" | "docx" | "pptx"
    }

  Creates a short-lived private B2 download URL.
*/
export async function handleReadyMadeResourceDownload(
  request,
  env,
  resourceId
) {
  try {
    await requireAuth(request, env);
  } catch (e) {
    return error(
      e.message || 'Not authenticated.',
      e.status || 401
    );
  }

  let body;

  try {
    body = await request.json();
  } catch (_) {
    return error(
      'Invalid JSON body.'
    );
  }

  const format = String(
    body.format || ''
  ).toLowerCase();

  if (!['pdf', 'docx', 'pptx'].includes(format)) {
    return error(
      'Unsupported download format.'
    );
  }

  try {
    const resource = await fsGet(
      `readyMadeResources/${resourceId}`,
      env
    );

    if (!resource || resource.status !== 'published') {
      return error(
        'Resource not found.',
        404
      );
    }

    const reference =
      resource.fileReferences &&
      resource.fileReferences[format];

    if (!reference || !reference.key) {
      return error(
        `No ${format.toUpperCase()} file is available.`,
        404
      );
    }

    const authorization =
      await b2GetDownloadAuthorization(
        env,
        reference.key,
        900
      );

    const downloadUrl =
      b2BuildPrivateDownloadUrl(
        env,
        reference.key,
        authorization.authorizationToken
      );

    return json({
      format,
      downloadUrl,
      expiresIn: 900,
    });
  } catch (e) {
    console.error(
      '[ready-made-resources] download failed:',
      e.message
    );

    return error(
      'Could not prepare the download.',
      500
    );
  }
}
