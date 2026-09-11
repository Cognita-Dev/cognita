// use-resource-endpoint.js
//
// POST /api/ready-made-resources/:id/use
//
// Copies a published curated resource into the authenticated user's
// private My Resources library.
//
// Important:
// - Does NOT call AI.
// - Does NOT consume resource-generation quota.
// - Does NOT modify the curated source.
// - Creates a completely separate user resource.
// - Copies structured content.
// - Generates fresh B2 exports for the private copy.

import { requireAuth } from './auth-middleware.js';
import { fsGet, fsSet } from './firestore-rest.js';
import { buildStructuredDocx } from './docx-builder.js';
import { buildStructuredPdf } from './pdf-builder.js';
import { buildSimplePptx } from './pptx-builder.js';
import {
  b2UploadFile,
} from './b2-client.js';

const PPTX_TYPES = new Set([
  'presentation',
]);

const SKIP_KEYS = new Set([
  'title',
]);

function _makeResourceId() {
  if (
    typeof crypto !== 'undefined' &&
    typeof crypto.randomUUID === 'function'
  ) {
    return crypto.randomUUID();
  }

  return (
    'r-' +
    Date.now() +
    '-' +
    Math.random()
      .toString(36)
      .slice(2)
  );
}

function _corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization',
    'Access-Control-Allow-Methods':
      'GET, POST, PATCH, OPTIONS',
    'Content-Type':
      'application/json',
  };
}

function _json(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: _corsHeaders(),
    }
  );
}

function _error(message, status = 400) {
  return _json(
    {
      error: message,
    },
    status
  );
}

function _base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(
    binary.length
  );

  for (
    let i = 0;
    i < binary.length;
    i += 1
  ) {
    bytes[i] =
      binary.charCodeAt(i);
  }

  return bytes;
}

function _structuredContentToSections(
  content
) {
  const sections = [];

  if (
    !content ||
    typeof content !== 'object'
  ) {
    return sections;
  }

  for (const key in content) {
    if (
      SKIP_KEYS.has(key)
    ) {
      continue;
    }

    const value = content[key];

    if (
      value === null ||
      typeof value === 'undefined'
    ) {
      continue;
    }

    const heading = String(key)
      .replace(
        /([A-Z])/g,
        ' $1'
      )
      .replace(
        /^./,
        (char) =>
          char.toUpperCase()
      );

    if (Array.isArray(value)) {
      if (!value.length) {
        continue;
      }

      const items =
        value.map((item) => {
          if (
            item &&
            typeof item ===
              'object'
          ) {
            return Object.values(
              item
            )
              .filter(
                (value) =>
                  typeof value ===
                    'string' ||
                  typeof value ===
                    'number'
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

    if (
      typeof value === 'object'
    ) {
      sections.push({
        heading,
        type: 'paragraph',
        content:
          JSON.stringify(value),
      });

      continue;
    }

    if (
      String(value).trim()
    ) {
      sections.push({
        heading,
        type: 'paragraph',
        content: String(value),
      });
    }
  }

  return sections;
}

async function _buildExports(
  resource,
  resourceId,
  env
) {
  const references = {};

  const structuredContent =
    resource.structuredContent ||
    {};

  const title =
    structuredContent.title ||
    resource.title ||
    'Cognita Resource';

  const templateId =
    resource.designTemplateId ||
    'default';

  if (
    PPTX_TYPES.has(
      resource.resourceType
    ) &&
    Array.isArray(
      structuredContent.slides
    )
  ) {
    try {
      const pptxBase64 =
        await buildSimplePptx(
          structuredContent.slides,
          title,
          templateId
        );

      const bytes =
        _base64ToBytes(
          pptxBase64
        );

      const key =
        'generated/' +
        resourceId +
        '/exports/' +
        resource.resourceType +
        '.pptx';

      const upload =
        await b2UploadFile(
          env,
          key,
          bytes,
          'application/vnd.openxmlformats-officedocument.presentationml.presentation'
        );

      references.pptx = {
        key,
        fileId:
          upload.fileId,
      };
    } catch (error) {
      console.error(
        '[use-resource] pptx export failed:',
        error.message
      );
    }

    try {
      const sections =
        structuredContent.slides.map(
          (slide) => ({
            heading:
              slide.heading ||
              '',
            type: 'bullets',
            content:
              Array.isArray(
                slide.bulletPoints
              )
                ? slide.bulletPoints
                : [
                    String(
                      slide.bulletPoints ||
                        ''
                    ),
                  ],
          })
        );

      const pdfBase64 =
        await buildStructuredPdf(
          {
            title,
            sections,
          },
          title,
          templateId
        );

      const bytes =
        _base64ToBytes(
          pdfBase64
        );

      const key =
        'generated/' +
        resourceId +
        '/exports/' +
        resource.resourceType +
        '.pdf';

      const upload =
        await b2UploadFile(
          env,
          key,
          bytes,
          'application/pdf'
        );

      references.pdf = {
        key,
        fileId:
          upload.fileId,
      };
    } catch (error) {
      console.error(
        '[use-resource] pdf export failed:',
        error.message
      );
    }

    return references;
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

    const bytes =
      _base64ToBytes(
        pdfBase64
      );

    const key =
      'generated/' +
      resourceId +
      '/exports/' +
      resource.resourceType +
      '.pdf';

    const upload =
      await b2UploadFile(
        env,
        key,
        bytes,
        'application/pdf'
      );

    references.pdf = {
      key,
      fileId:
        upload.fileId,
    };
  } catch (error) {
    console.error(
      '[use-resource] pdf export failed:',
      error.message
    );
  }

  try {
    const docxBase64 =
      await buildStructuredDocx(
        exportData,
        title,
        templateId
      );

    const bytes =
      _base64ToBytes(
        docxBase64
      );

    const key =
      'generated/' +
      resourceId +
      '/exports/' +
      resource.resourceType +
      '.docx';

    const upload =
      await b2UploadFile(
        env,
        key,
        bytes,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      );

    references.docx = {
      key,
      fileId:
        upload.fileId,
    };
  } catch (error) {
    console.error(
      '[use-resource] docx export failed:',
      error.message
    );
  }

  return references;
}

export async function handleUseReadyMadeResource(
  request,
  env,
  sourceResourceId
) {
  let identity;

  try {
    identity =
      await requireAuth(
        request,
        env
      );
  } catch (error) {
    return _error(
      'Not authenticated: ' +
        error.message,
      401
    );
  }

  if (!sourceResourceId) {
    return _error(
      'A resource id is required.',
      400
    );
  }

  let source;

  try {
    source =
      await fsGet(
        'readyMadeResources/' +
          sourceResourceId,
        env
      );
  } catch (error) {
    console.error(
      '[use-resource] source lookup failed:',
      error.message
    );

    return _error(
      'Could not load the resource.',
      500
    );
  }

  if (!source) {
    return _error(
      'This resource does not exist.',
      404
    );
  }

  if (
    source.status !==
    'published'
  ) {
    return _error(
      'This resource is not available.',
      404
    );
  }

  if (
    !source.structuredContent
  ) {
    return _error(
      'This resource does not contain usable content.',
      409
    );
  }

  const resourceId =
    _makeResourceId();

  const now =
    new Date().toISOString();

  const resource = {
    id: resourceId,

    ownerId:
      identity.uid,

    resourceType:
      source.resourceType,

    title:
      source.title ||
      'Untitled Resource',

    description:
      source.description ||
      '',

    subject:
      source.subject ||
      '',

    educationalLevel:
      source.educationalLevel ||
      '',

    classLevel:
      source.classLevel ||
      '',

    curriculum:
      source.curriculum ||
      '',

    topic:
      source.topic ||
      '',

    tags: Array.isArray(
      source.tags
    )
      ? [...source.tags]
      : [],

    visibility:
      'private',

    status:
      'ready',

    source:
      'ready-made',

    sourceResourceId:
      source.id,

    structuredContent:
      source.structuredContent,

    designTemplateId:
      source.designTemplateId ||
      'default',

    currentVersion: 1,

    fileReferences: {},

    createdAt: now,
    updatedAt: now,
  };

  try {
    resource.fileReferences =
      await _buildExports(
        resource,
        resourceId,
        env
      );
  } catch (error) {
    console.error(
      '[use-resource] export generation failed:',
      error.message
    );
  }

  try {
    await fsSet(
      'resources/' +
        resourceId,
      resource,
      env
    );

    await fsSet(
      'resourceVersions/' +
        resourceId +
        '_1',
      {
        resourceId,
        version: 1,
        structuredContent:
          resource.structuredContent,
        designTemplateId:
          resource.designTemplateId,
        createdAt: now,
      },
      env
    );
  } catch (error) {
    console.error(
      '[use-resource] resource save failed:',
      error.message
    );

    return _error(
      'The resource could not be added to your library.',
      500
    );
  }

  return _json({
    resource,
    sourceResourceId:
      sourceResourceId,
    message:
      'Resource added to My Resources.',
  });
}
