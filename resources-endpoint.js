// resources-endpoint.js
// POST /api/resources/generate
// Frontend sends { resourceType, fields: {...} }. The Worker selects the
// matching Recipe, generates structured content via the existing AI
// provider plumbing, validates it, stores it in Firestore, renders a docx,
// and uploads that docx to the dedicated Cognita Resources B2 bucket.

import { requireAuth } from './auth-middleware.js';
import { resolveAccount } from './subscription.js';
import { checkAndIncrement } from './usage.js';
import { getPlan, MODEL_TIERS } from './entitlements.js';
import { callWithFallback } from './providers.js';
import { fsSet, fsGet } from './firestore-rest.js';
import { buildSimpleDocx } from './docx-builder.js';
import { b2UploadFile, b2GetDownloadAuthorization, b2BuildPrivateDownloadUrl } from './b2-client.js';
import { getRecipe } from './recipes/index.js';

function _makeResourceId() {
  return (crypto && crypto.randomUUID) ? crypto.randomUUID() : 'r-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}

// Strips code fences if the model wraps its JSON in them anyway, then parses.
// Returns null on failure rather than throwing, so the caller can respond
// with a clean error instead of a 500.
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

  // Resources generation is metered separately from chat, reusing the same
  // checkAndIncrement mechanism. Limit key added to entitlements.js below.
  const quota = await checkAndIncrement(identity.uid, 'resourceGen', plan.limits.resourceGenPerDay, env);
  if (!quota.allowed) {
    return _jsonError(
      'You have reached your daily resource generation limit for the ' + plan.name + ' plan (' + quota.limit + ' per day).',
      429
    );
  }

  const resourceId = _makeResourceId();

  // Mark as generating immediately so the resource shows up in "My
  // Resources" even if generation fails partway — the status field reflects
  // the truth rather than the resource silently not existing.
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

  // Generate structured content via the existing provider plumbing —
  // same callWithFallback used by chat/document, just a different tier
  // and system prompt.
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

  // Render + upload the docx export.
  let fileReferences = {};
  try {
    const plainText = recipe.toPlainTextParagraphs(structuredContent);
    const docxBase64 = await buildSimpleDocx(plainText, structuredContent.title || baseDoc.title);
    const docxBytes = _base64ToBytes(docxBase64);
    const key = 'generated/' + resourceId + '/exports/' + recipe.resourceType + '.docx';

    const uploadResult = await b2UploadFile(
      env,
      key,
      docxBytes,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );

    fileReferences.docx = { key, fileId: uploadResult.fileId };
  } catch (e) {
    // The structured resource is still valid and saved even if the export
    // upload fails — we don't fail the whole generation over a storage
    // hiccup. Export can be retried later without regenerating content.
    console.error('[resources] docx export/upload failed:', e.message);
  }

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

/**
 * POST /api/resources/:id/download
 * Returns a short-lived, scoped download URL for the resource's docx —
 * never a raw B2 URL, and only ever for a resource the requester owns.
 */
export async function handleResourceDownload(request, env, resourceId) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    return _jsonError('Not authenticated: ' + e.message, 401);
  }

  let doc;
  try {
    doc = await fsGet('resources/' + resourceId, env);
  } catch (e) {
    console.error('[resources] lookup failed:', e.message);
    return _jsonError('Could not load that resource.', 500);
  }

  if (!doc) return _jsonError('Resource not found.', 404);
  if (doc.ownerId !== identity.uid) return _jsonError('Not authorized to access this resource.', 403);
  if (!doc.fileReferences || !doc.fileReferences.docx) {
    return _jsonError('No export file is available for this resource yet.', 404);
  }

  try {
    const prefix = 'generated/' + resourceId + '/exports/';
    const authToken = await b2GetDownloadAuthorization(env, prefix, 3600); // 1 hour
    const url = await b2BuildPrivateDownloadUrl(env, doc.fileReferences.docx.key, authToken);
    return new Response(JSON.stringify({ url, expiresInSeconds: 3600 }), {
      status: 200,
      headers: _corsJsonHeaders(),
    });
  } catch (e) {
    console.error('[resources] download authorization failed:', e.message);
    return _jsonError('Could not prepare the download. Please try again.', 503);
  }
}

function _corsJsonHeaders() {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
}

function _jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: _corsJsonHeaders() });
}
