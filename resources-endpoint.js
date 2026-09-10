// resources-endpoint.js
// POST /api/resources/generate
// Frontend sends { resourceType, fields: {...} }. The Worker selects the
// matching Recipe, generates structured content via the existing AI
// provider plumbing, validates it, stores it in Firestore, renders export
// file(s), and uploads them to the dedicated Cognita Resources B2 bucket.
//
// Export format per resource type: every type gets a PDF (built from the
// same plain-text rendering used for DOCX, so it can never drift out of
// sync with the structured content). Additionally, "presentation" gets a
// real .pptx instead of a .docx, since a lesson plan as a Word doc makes
// sense but a slide deck as a Word doc does not.

import { requireAuth } from './auth-middleware.js';
import { resolveAccount } from './subscription.js';
import { checkAndIncrement } from './usage.js';
import { getPlan, MODEL_TIERS } from './entitlements.js';
import { callWithFallback } from './providers.js';
import { fsSet, fsGet, fsQuery } from './firestore-rest.js';
import { buildSimpleDocx } from './docx-builder.js';
import { buildSimplePdf } from './pdf-builder.js';
import { buildSimplePptx } from './pptx-builder.js';
import { b2UploadFile, b2GetDownloadAuthorization, b2BuildPrivateDownloadUrl } from './b2-client.js';
import { getRecipe } from './recipes/index.js';

// Resource types that export as a real .pptx instead of the default .docx.
const PPTX_TYPES = new Set(['presentation']);

function _makeResourceId() {
  return (crypto && crypto.randomUUID) ? crypto.randomUUID() : 'r-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}

function _parseStructuredJson(text) {
  if (!text) return null;
  let clean = text.replace(/```json\s*/gi, '').replace(/```/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end === -1) return null;
  clean = clean.slice(start, end + 1);
  try {
    return JSON.parse(clean);
  } catch (e) {
    return null;
  }
}

export async function handleResourceGenerate(request, env) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    return _jsonError('Not authenticated: ' + e.message, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return _jsonError('Invalid JSON body.', 400);
  }

  const recipe = getRecipe(body.resourceType);
  if (!recipe) {
    return _jsonError('Unknown resource type: ' + body.resourceType, 400);
  }

  const fields = body.fields || {};
  for (const required of recipe.requiredFields) {
    if (!fields[required] || !String(fields[required]).trim()) {
      return _jsonError('Missing required field: ' + required, 400);
    }
  }

  let account;
  try {
    account = await resolveAccount(identity.uid, env);
  } catch (e) {
    console.error('[resources] account resolution failed:', e.message);
    return _jsonError('Could not verify your account. Please try again.', 500);
  }

  const plan = getPlan(account.planId);

  const quota = await checkAndIncrement(identity.uid, 'resourceGen', plan.limits.resourceGenPerDay, env);
  if (!quota.allowed) {
    return _jsonError(
      'You have reached your daily resource generation limit for the ' + plan.name + ' plan (' + quota.limit + ' per day).',
      429
    );
  }

  const resourceId = _makeResourceId();

  const baseDoc = {
    id: resourceId,
    ownerId: identity.uid,
    resourceType: recipe.resourceType,
    title: fields.topic || 'Untitled',
    subject: fields.subject || '',
    educationalLevel: fields.educationalLevel || '',
    classLevel: fields.classLevel || '',
    curriculum: fields.curriculum || '',
    topic: fields.topic || '',
    tags: [],
    visibility: 'private',
    status: 'generating',
    structuredContent: null,
    currentVersion: 1,
    fileReferences: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  try {
    await fsSet('resources/' + resourceId, baseDoc, env);
  } catch (e) {
    console.error('[resources] initial write failed:', e.message);
    return _jsonError('Could not start generation. Please try again.', 500);
  }

  const messages = [
    { role: 'system', content: recipe.systemPrompt },
    { role: 'user', content: recipe.buildUserPrompt(fields) },
  ];

  let structuredContent;
  try {
    const result = await callWithFallback(MODEL_TIERS.advanced, messages, env);
    structuredContent = _parseStructuredJson(result.text);
  } catch (e) {
    console.error('[resources] generation call failed:', e.message);
    await _markFailed(resourceId, baseDoc, env);
    return _jsonError('Could not generate the resource. Please try again.', 503);
  }

  if (!structuredContent) {
    await _markFailed(resourceId, baseDoc, env);
    return _jsonError('The generated content could not be understood. Please try again.', 503);
  }

  const validation = recipe.validate(structuredContent);
  if (!validation.ok) {
    console.error('[resources] validation failed:', validation.error);
    await _markFailed(resourceId, baseDoc, env);
    return _jsonError('The generated resource did not meet quality checks. Please try again.', 503);
  }

  const fileReferences = await _buildAndUploadExports(recipe, structuredContent, baseDoc, resourceId, env);

  const finalDoc = {
    ...baseDoc,
    status: 'ready',
    structuredContent,
    fileReferences,
    updatedAt: new Date().toISOString(),
  };

  try {
    await fsSet('resources/' + resourceId, finalDoc, env);
    await fsSet('resourceVersions/' + resourceId + '_1', {
      resourceId,
      version: 1,
      structuredContent,
      createdAt: finalDoc.updatedAt,
    }, env);
  } catch (e) {
    console.error('[resources] final write failed:', e.message);
    return _jsonError('The resource was generated but could not be saved. Please try again.', 500);
  }

  return new Response(JSON.stringify({ resource: finalDoc }), {
    status: 200,
    headers: _corsJsonHeaders(),
  });
}

// Renders + uploads every export format applicable to this recipe. Never
// throws — a failed export upload is logged and simply omitted from
// fileReferences, since the structured resource itself is still valid and
// saved even if a file render/upload hiccups.
async function _buildAndUploadExports(recipe, structuredContent, baseDoc, resourceId, env) {
  const fileReferences = {};
  const plainText = recipe.toPlainTextParagraphs(structuredContent);
  const title = structuredContent.title || baseDoc.title;

  // PDF — built for every resource type.
  try {
    const pdfBase64 = await buildSimplePdf(plainText, title);
    const pdfBytes = _base64ToBytes(pdfBase64);
    const pdfKey = 'generated/' + resourceId + '/exports/' + recipe.resourceType + '.pdf';
    const pdfUpload = await b2UploadFile(env, pdfKey, pdfBytes, 'application/pdf');
    fileReferences.pdf = { key: pdfKey, fileId: pdfUpload.fileId };
  } catch (e) {
    console.error('[resources] pdf export/upload failed:', e.message);
  }

  if (PPTX_TYPES.has(recipe.resourceType) && Array.isArray(structuredContent.slides)) {
    // PPTX — presentation-type resources only.
    try {
      const pptxBase64 = await buildSimplePptx(structuredContent.slides, title);
      const pptxBytes = _base64ToBytes(pptxBase64);
      const pptxKey = 'generated/' + resourceId + '/exports/' + recipe.resourceType + '.pptx';
      const pptxUpload = await b2UploadFile(
        env,
        pptxKey,
        pptxBytes,
        'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      );
      fileReferences.pptx = { key: pptxKey, fileId: pptxUpload.fileId };
    } catch (e) {
      console.error('[resources] pptx export/upload failed:', e.message);
    }
  } else {
    // DOCX — every other resource type.
    try {
      const docxBase64 = await buildSimpleDocx(plainText, title);
      const docxBytes = _base64ToBytes(docxBase64);
      const docxKey = 'generated/' + resourceId + '/exports/' + recipe.resourceType + '.docx';
      const docxUpload = await b2UploadFile(
        env,
        docxKey,
        docxBytes,
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      );
      fileReferences.docx = { key: docxKey, fileId: docxUpload.fileId };
    } catch (e) {
      console.error('[resources] docx export/upload failed:', e.message);
    }
  }

  return fileReferences;
}

async function _markFailed(resourceId, baseDoc, env) {
  try {
    await fsSet('resources/' + resourceId, { ...baseDoc, status: 'failed', updatedAt: new Date().toISOString() }, env);
  } catch (e) {
    console.error('[resources] could not mark resource as failed:', e.message);
  }
}

function _base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const DOWNLOAD_CONTENT_TYPES = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pdf: 'application/pdf',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/**
 * POST /api/resources/:id/download?format=docx|pdf|pptx
 * Returns a short-lived, scoped download URL for the requested export
 * format — never a raw B2 URL, and only ever for a resource the requester
 * owns. Defaults to whichever format actually exists if none is specified.
 */
export async function handleResourceDownload(request, env, resourceId) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    return _jsonError('Not authenticated: ' + e.message, 401);
  }

  const url = new URL(request.url);
  const requestedFormat = url.searchParams.get('format');

  let doc;
  try {
    doc = await fsGet('resources/' + resourceId, env);
  } catch (e) {
    console.error('[resources] lookup failed:', e.message);
    return _jsonError('Could not load that resource.', 500);
  }

  if (!doc) return _jsonError('Resource not found.', 404);
  if (doc.ownerId !== identity.uid) return _jsonError('Not authorized to access this resource.', 403);

  const format = requestedFormat && doc.fileReferences && doc.fileReferences[requestedFormat]
    ? requestedFormat
    : Object.keys(doc.fileReferences || {})[0];

  if (!format || !doc.fileReferences[format]) {
    return _jsonError('No export file is available for this resource yet.', 404);
  }

  try {
    const prefix = 'generated/' + resourceId + '/exports/';
    const authToken = await b2GetDownloadAuthorization(env, prefix, 3600);
    const downloadUrl = await b2BuildPrivateDownloadUrl(env, doc.fileReferences[format].key, authToken);
    return new Response(JSON.stringify({ url: downloadUrl, format, expiresInSeconds: 3600 }), {
      status: 200,
      headers: _corsJsonHeaders(),
    });
  } catch (e) {
    console.error('[resources] download authorization failed:', e.message);
    return _jsonError('Could not prepare the download. Please try again.', 503);
  }
}

/**
 * GET /api/resources/list
 * Returns the authenticated user's own resources, most recent first.
 */
export async function handleResourceList(request, env) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    return _jsonError('Not authenticated: ' + e.message, 401);
  }

  try {
    const resources = await fsQuery('resources', 'ownerId', identity.uid, 'createdAt', 50, env);
    return new Response(JSON.stringify({ resources }), {
      status: 200,
      headers: _corsJsonHeaders(),
    });
  } catch (e) {
    console.error('[resources] list failed:', e.message);
    return _jsonError('Could not load your resources. Please try again.', 500);
  }
}

function _corsJsonHeaders() {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
}

function _jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: _corsJsonHeaders() });
}
