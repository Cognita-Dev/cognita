// edit-resource-endpoint.js
//
// GET    /api/resources/:id
// PATCH  /api/resources/:id
// GET    /api/resources/:id/versions
//
// Owner-only resource editing and versioning.
//
// Editing never calls AI and never consumes generation quota.
// Every successful save creates a new resourceVersions/<id>_<version>
// document and regenerates the downloadable exports in B2.

import { requireAuth } from './auth-middleware.js';
import { fsGet, fsSet, fsQuery } from './firestore-rest.js';
import {
  buildStructuredDocx,
} from './docx-builder.js';
import {
  buildStructuredPdf,
} from './pdf-builder.js';
import {
  buildSimplePptx,
} from './pptx-builder.js';
import {
  b2UploadFile,
} from './b2-client.js';

const PPTX_TYPES = new Set(['presentation']);

const CONTENT_TYPES = {
  docx:
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  pptx:
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const MAX_JSON_BYTES = 700000;
const MAX_TITLE_LENGTH = 240;
const MAX_DESCRIPTION_LENGTH = 2000;

const SKIP_KEYS = new Set(['title']);

function _corsJsonHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };
}

function _json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: _corsJsonHeaders(),
  });
}

function _error(message, status) {
  return _json({ error: message }, status);
}

function _base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function _structuredContentToSections(content) {
  const sections = [];

  for (const key in content) {
    if (SKIP_KEYS.has(key)) continue;

    const value = content[key];

    if (value === null || typeof value === 'undefined') {
      continue;
    }

    const heading = key
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, (c) => c.toUpperCase());

    if (Array.isArray(value)) {
      if (value.length === 0) continue;

      const items = value.map((item) => {
        if (item && typeof item === 'object') {
          return Object.values(item)
            .filter(
              (v) =>
                typeof v === 'string' ||
                typeof v === 'number'
            )
            .join(' — ');
        }

        return String(item);
      });

      sections.push({
        heading,
        type: 'bullets',
        content: items,
      });

      continue;
    }

    if (typeof value === 'object') {
      sections.push({
        heading,
        type: 'paragraph',
        content: JSON.stringify(value),
      });

      continue;
    }

    if (String(value).trim()) {
      sections.push({
        heading,
        type: 'paragraph',
        content: String(value),
      });
    }
  }

  return sections;
}

async function _buildAndUploadExports(
  doc,
  structuredContent,
  env
) {
  const resourceId = doc.id;
  const resourceType = doc.resourceType;
  const templateId = doc.designTemplateId;
  const title =
    structuredContent.title ||
    doc.title ||
    'Cognita Resource';

  const fileReferences = {};

  if (
    PPTX_TYPES.has(resourceType) &&
    Array.isArray(structuredContent.slides)
  ) {
    try {
      const pptxBase64 = await buildSimplePptx(
        structuredContent.slides,
        title,
        templateId
      );

      const pptxKey =
        'generated/' +
        resourceId +
        '/exports/' +
        resourceType +
        '.pptx';

      const upload = await b2UploadFile(
        env,
        pptxKey,
        _base64ToBytes(pptxBase64),
        CONTENT_TYPES.pptx
      );

      fileReferences.pptx = {
        key: pptxKey,
        fileId: upload.fileId,
      };
    } catch (e) {
      console.error(
        '[resource-edit] pptx export failed:',
        e.message
      );
    }

    try {
      const sections =
        structuredContent.slides.map((slide) => ({
          heading: slide.heading || '',
          type: 'bullets',
          content: Array.isArray(slide.bulletPoints)
            ? slide.bulletPoints
            : [
                String(
                  slide.bulletPoints || ''
                ),
              ],
        }));

      const pdfBase64 = await buildStructuredPdf(
        {
          title,
          sections,
        },
        title,
        templateId
      );

      const pdfKey =
        'generated/' +
        resourceId +
        '/exports/' +
        resourceType +
        '.pdf';

      const upload = await b2UploadFile(
        env,
        pdfKey,
        _base64ToBytes(pdfBase64),
        CONTENT_TYPES.pdf
      );

      fileReferences.pdf = {
        key: pdfKey,
        fileId: upload.fileId,
      };
    } catch (e) {
      console.error(
        '[resource-edit] presentation PDF export failed:',
        e.message
      );
    }

    return fileReferences;
  }

  const sections =
    _structuredContentToSections(
      structuredContent
    );

  const exportData = {
    title,
    sections,
  };

  try {
    const pdfBase64 =
      await buildStructuredPdf(
        exportData,
        title,
        templateId
      );

    const pdfKey =
      'generated/' +
      resourceId +
      '/exports/' +
      resourceType +
      '.pdf';

    const upload = await b2UploadFile(
      env,
      pdfKey,
      _base64ToBytes(pdfBase64),
      CONTENT_TYPES.pdf
    );

    fileReferences.pdf = {
      key: pdfKey,
      fileId: upload.fileId,
    };
  } catch (e) {
    console.error(
      '[resource-edit] PDF export failed:',
      e.message
    );
  }

  try {
    const docxBase64 =
      await buildStructuredDocx(
        exportData,
        title
      );

    const docxKey =
      'generated/' +
      resourceId +
      '/exports/' +
      resourceType +
      '.docx';

    const upload = await b2UploadFile(
      env,
      docxKey,
      _base64ToBytes(docxBase64),
      CONTENT_TYPES.docx
    );

    fileReferences.docx = {
      key: docxKey,
      fileId: upload.fileId,
    };
  } catch (e) {
    console.error(
      '[resource-edit] DOCX export failed:',
      e.message
    );
  }

  return fileReferences;
}

async function _loadOwnedResource(
  request,
  env,
  resourceId
) {
  let identity;

  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    return {
      errorResponse: _error(
        'Not authenticated: ' + e.message,
        401
      ),
    };
  }

  let resource;

  try {
    resource = await fsGet(
      'resources/' + resourceId,
      env
    );
  } catch (e) {
    console.error(
      '[resource-edit] resource lookup failed:',
      e.message
    );

    return {
      errorResponse: _error(
        'Could not load that resource.',
        500
      ),
    };
  }

  if (!resource) {
    return {
      errorResponse: _error(
        'Resource not found.',
        404
      ),
    };
  }

  if (resource.ownerId !== identity.uid) {
    return {
      errorResponse: _error(
        'Not authorized to access this resource.',
        403
      ),
    };
  }

  return {
    identity,
    resource,
  };
}

/**
 * GET /api/resources/:id
 */
export async function handleResourceGet(
  request,
  env,
  resourceId
) {
  const result =
    await _loadOwnedResource(
      request,
      env,
      resourceId
    );

  if (result.errorResponse) {
    return result.errorResponse;
  }

  return _json({
    resource: result.resource,
  });
}

/**
 * GET /api/resources/:id/versions
 */
export async function handleResourceVersions(
  request,
  env,
  resourceId
) {
  const result =
    await _loadOwnedResource(
      request,
      env,
      resourceId
    );

  if (result.errorResponse) {
    return result.errorResponse;
  }

  try {
    const versions = await fsQuery(
      'resourceVersions',
      'resourceId',
      resourceId,
      'createdAt',
      100,
      env
    );

    const normalized = (versions || [])
      .sort(
        (a, b) =>
          Number(b.version || 0) -
          Number(a.version || 0)
      )
      .map((version) => ({
        resourceId: version.resourceId,
        version: version.version,
        designTemplateId:
          version.designTemplateId,
        createdAt: version.createdAt,
        structuredContent:
          version.structuredContent,
      }));

    return _json({
      versions: normalized,
    });
  } catch (e) {
    console.error(
      '[resource-edit] version lookup failed:',
      e.message
    );

    return _error(
      'Could not load resource versions.',
      500
    );
  }
}

/**
 * PATCH /api/resources/:id
 *
 * Body:
 * {
 *   title,
 *   description,
 *   structuredContent,
 *   baseVersion
 * }
 */
export async function handleResourceUpdate(
  request,
  env,
  resourceId
) {
  const result =
    await _loadOwnedResource(
      request,
      env,
      resourceId
    );

  if (result.errorResponse) {
    return result.errorResponse;
  }

  const existing = result.resource;

  if (existing.status === 'generating') {
    return _error(
      'This resource is still being generated.',
      409
    );
  }

  if (existing.status === 'archived') {
    return _error(
      'Archived resources cannot be edited.',
      409
    );
  }

  let body;

  try {
    body = await request.json();
  } catch (e) {
    return _error(
      'Invalid JSON body.',
      400
    );
  }

  const baseVersion = Number(
    body.baseVersion
  );

  if (
    Number.isFinite(baseVersion) &&
    baseVersion !==
      Number(existing.currentVersion || 1)
  ) {
    return _json(
      {
        error:
          'This resource has changed since you opened it. Reload it before saving.',
        code: 'VERSION_CONFLICT',
        currentVersion:
          existing.currentVersion || 1,
      },
      409
    );
  }

  const title = String(
    body.title ??
      existing.title ??
      ''
  ).trim();

  const description = String(
    body.description ??
      existing.description ??
      ''
  ).trim();

  if (!title) {
    return _error(
      'A resource title is required.',
      400
    );
  }

  if (
    title.length >
    MAX_TITLE_LENGTH
  ) {
    return _error(
      'The title is too long.',
      400
    );
  }

  if (
    description.length >
    MAX_DESCRIPTION_LENGTH
  ) {
    return _error(
      'The description is too long.',
      400
    );
  }

  const structuredContent =
    body.structuredContent;

  if (
    !structuredContent ||
    typeof structuredContent !== 'object' ||
    Array.isArray(structuredContent)
  ) {
    return _error(
      'Structured content must be a JSON object.',
      400
    );
  }

  let serialized;

  try {
    serialized =
      JSON.stringify(
        structuredContent
      );
  } catch (e) {
    return _error(
      'The content could not be serialized.',
      400
    );
  }

  if (
    new TextEncoder()
      .encode(serialized)
      .byteLength >
    MAX_JSON_BYTES
  ) {
    return _error(
      'The resource content is too large.',
      413
    );
  }

  const nextContent = {
    ...structuredContent,
    title,
  };

  const nextVersion =
    Number(
      existing.currentVersion || 1
    ) + 1;

  const now =
    new Date().toISOString();

  const nextDoc = {
    ...existing,
    title,
    description,
    structuredContent:
      nextContent,
    currentVersion:
      nextVersion,
    status: 'generating',
    updatedAt: now,
  };

  try {
    await fsSet(
      'resources/' + resourceId,
      nextDoc,
      env
    );
  } catch (e) {
    console.error(
      '[resource-edit] pre-save failed:',
      e.message
    );

    return _error(
      'Could not save the resource.',
      500
    );
  }

  let fileReferences;

  try {
    fileReferences =
      await _buildAndUploadExports(
        nextDoc,
        nextContent,
        env
      );
  } catch (e) {
    console.error(
      '[resource-edit] export generation failed:',
      e.message
    );

    fileReferences =
      existing.fileReferences || {};
  }

  const finalDoc = {
    ...nextDoc,
    status: 'ready',
    fileReferences,
    updatedAt:
      new Date().toISOString(),
  };

  try {
    await fsSet(
      'resources/' + resourceId,
      finalDoc,
      env
    );

    await fsSet(
      'resourceVersions/' +
        resourceId +
        '_' +
        nextVersion,
      {
        resourceId,
        version: nextVersion,
        title,
        description,
        structuredContent:
          nextContent,
        designTemplateId:
          existing.designTemplateId ||
          'classic',
        createdAt:
          finalDoc.updatedAt,
      },
      env
    );
  } catch (e) {
    console.error(
      '[resource-edit] final save failed:',
      e.message
    );

    return _error(
      'The resource was edited but could not be finalized.',
      500
    );
  }

  return _json({
    resource: finalDoc,
    version: nextVersion,
  });
}
