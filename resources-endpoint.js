// resources-endpoint.js

import { requireAuth } from './auth-middleware.js';
import { resolveAccount } from './subscription.js';
import { checkAndIncrement } from './usage.js';
import { getPlan, planSatisfies, MODEL_TIERS } from './entitlements.js';
import { callWithFallback } from './providers.js';
import { fsSet, fsGet, fsQuery } from './firestore-rest.js';
import { buildStructuredDocx } from './docx-builder.js';
import { buildStructuredPdf } from './pdf-builder.js';
import { buildSimplePptx } from './pptx-builder.js';
import { b2UploadFile, b2GetDownloadAuthorization, b2BuildPrivateDownloadUrl } from './b2-client.js';
import { getRecipe } from './recipes/index.js';
import { resolveEntitledTemplate } from './design-templates.js';

const PPTX_TYPES = new Set(['presentation']);
const RESOURCE_MAX_TOKENS = 6000;
const SKIP_KEYS = new Set(['title']);

function _makeResourceId() {
  return (crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'r-' + Date.now() + '-' + Math.random().toString(36).slice(2);
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
  } catch (e) {}
  const repaired = _repairTruncatedJson(clean);
  if (repaired === null) return null;
  try {
    return JSON.parse(repaired);
  } catch (e) {
    return null;
  }
}

function _repairTruncatedJson(text) {
  if (!text) return null;
  const stack = [];
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) { escape = false; }
      else if (ch === '\\') { escape = true; }
      else if (ch === '"') { inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  if (stack.length === 0 && !inString) return null;
  let repaired = text;
  if (inString) repaired += '"';
  repaired = repaired.replace(/,\s*$/, '');
  for (let i = stack.length - 1; i >= 0; i--) {
    repaired += stack[i] === '{' ? '}' : ']';
  }
  return repaired;
}

function _structuredContentToSections(content) {
  const sections = [];
  for (const key in content) {
    if (SKIP_KEYS.has(key)) continue;
    const value = content[key];
    if (value === null || typeof value === 'undefined') continue;
    const heading = key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      const items = value.map((item) => {
        if (item && typeof item === 'object') {
          return Object.values(item).filter((v) => typeof v === 'string' || typeof v === 'number').join(' — ');
        }
        return String(item);
      });
      sections.push({ heading, type: 'bullets', content: items });
    } else if (typeof value === 'object') {
      sections.push({ heading, type: 'paragraph', content: JSON.stringify(value) });
    } else if (String(value).trim()) {
      sections.push({ heading, type: 'paragraph', content: String(value) });
    }
  }
  return sections;
}

// Builds the messages array sent to the model for a fresh generation.
// customInstructions is supported generically across every resource type
// — a recipe doesn't need to know about it — it's simply appended to
// whatever prompt the recipe already builds.
function _buildGenerateMessages(recipe, fields) {
  const basePrompt = recipe.buildUserPrompt(fields);
  const userContent = fields.customInstructions && String(fields.customInstructions).trim()
    ? basePrompt + '\n\nAdditional instructions from the user (follow these carefully, in addition to everything above): ' + String(fields.customInstructions).trim()
    : basePrompt;

  return [
    { role: 'system', content: recipe.systemPrompt },
    { role: 'user', content: userContent },
  ];
}

export async function handleResourceGenerate(request, env) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    return _jsonError('Not authenticated: ' + e.message, 401, env);
  }
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return _jsonError('Invalid JSON body.', 400, env);
  }
  const recipe = getRecipe(body.resourceType);
  if (!recipe) {
    return _jsonError('Unknown resource type: ' + body.resourceType, 400, env);
  }
  const fields = body.fields || {};
  for (const required of recipe.requiredFields) {
    if (!fields[required] || !String(fields[required]).trim()) {
      return _jsonError('Missing required field: ' + required, 400, env);
    }
  }
  let account;
  try {
    account = await resolveAccount(identity.uid, env);
  } catch (e) {
    console.error('[resources] account resolution failed:', e.message);
    return _jsonError('Could not verify your account. Please try again.', 500, env);
  }
  const plan = getPlan(account.planId);
  const templateResolution = resolveEntitledTemplate(account.planId, body.designTemplateId, planSatisfies);
  if (!templateResolution.ok) {
    return _jsonError(templateResolution.error, 403, env);
  }
  const resolvedTemplate = templateResolution.template;
  const quota = await checkAndIncrement(identity.uid, 'resourceGen', plan.limits.resourceGenPerDay, env);
  if (!quota.allowed) {
    return _jsonError(
      'You have reached your daily resource generation limit for the ' + plan.name + ' plan (' + quota.limit + ' per day).',
      429, env
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
    customInstructions: fields.customInstructions || '',
    // The full set of generation fields (questionCount, sectionCount,
    // weekCount, slideCount, totalMarks, difficulty, etc.) is preserved
    // here so that editing or regenerating this resource later can pass
    // the SAME fields back into recipe.validate() — without this, an
    // edit would validate against each recipe's fallback default count
    // instead of what was actually requested, and could fail for a
    // reason invisible in the editor UI. Explicit fields above still win
    // if a key collides, since they're spread first.
    ...fields,
    tags: [],
    visibility: 'private',
    status: 'generating',
    structuredContent: null,
    designTemplateId: resolvedTemplate.id,
    currentVersion: 1,
    fileReferences: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  try {
    await fsSet('resources/' + resourceId, baseDoc, env);
  } catch (e) {
    console.error('[resources] initial write failed:', e.message);
    return _jsonError('Could not start generation. Please try again.', 500, env);
  }
  const messages = _buildGenerateMessages(recipe, fields);
  const maxTokens = recipe.maxTokens || RESOURCE_MAX_TOKENS;
  let structuredContent;
  try {
    const result = await callWithFallback(MODEL_TIERS.advanced, messages, env, {
      maxTokens,
      jsonMode: true,
    });
    structuredContent = _parseStructuredJson(result.text);
  } catch (e) {
    console.error('[resources] generation call failed:', e.message);
    await _markFailed(resourceId, baseDoc, env);
    return _jsonError('Could not generate the resource. Please try again.', 503, env);
  }
  if (!structuredContent) {
    await _markFailed(resourceId, baseDoc, env);
    return _jsonError('The generated content could not be understood. Please try again.', 503, env);
  }
  const validation = recipe.validate(structuredContent, fields);
  if (!validation.ok) {
    console.error('[resources] validation failed:', validation.error);
    await _markFailed(resourceId, baseDoc, env);
    return _jsonError('The generated resource did not meet quality checks. Please try again.', 503, env);
  }
  const fileReferences = await _buildAndUploadExports(recipe, structuredContent, baseDoc, resourceId, resolvedTemplate.id, env);
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
      designTemplateId: resolvedTemplate.id,
      snapshotReason: 'generated',
      createdAt: finalDoc.updatedAt,
    }, env);
  } catch (e) {
    console.error('[resources] final write failed:', e.message);
    return _jsonError('The resource was generated but could not be saved. Please try again.', 500, env);
  }
  return new Response(JSON.stringify({ resource: finalDoc }), {
    status: 200,
    headers: _corsJsonHeaders(env),
  });
}

// ── Edit: the owner directly edits structuredContent (e.g. via the
//    "Edit" control on the result preview) — no AI call involved. ──
// POST /api/resources/:id/edit
// Body: { structuredContent }
export async function handleResourceEdit(request, env, resourceId) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    return _jsonError('Not authenticated: ' + e.message, 401, env);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return _jsonError('Invalid JSON body.', 400, env);
  }

  if (!body.structuredContent || typeof body.structuredContent !== 'object') {
    return _jsonError('structuredContent is required and must be an object.', 400, env);
  }

  let doc;
  try {
    doc = await fsGet('resources/' + resourceId, env);
  } catch (e) {
    return _jsonError('Could not load that resource.', 500, env);
  }
  if (!doc) return _jsonError('Resource not found.', 404, env);
  if (doc.ownerId !== identity.uid) {
    return _jsonError('Not authorized to edit this resource.', 403, env);
  }

  const recipe = getRecipe(doc.resourceType);
  if (!recipe) {
    return _jsonError('Unknown resource type on this resource: ' + doc.resourceType, 500, env);
  }

  // doc itself now carries the original generation fields (questionCount,
  // sectionCount, etc. — see baseDoc in handleResourceGenerate), so this
  // validates against what was actually requested rather than a default.
  const validation = recipe.validate(body.structuredContent, doc);
  if (!validation.ok) {
    return _jsonError('Edited content did not pass validation: ' + validation.error, 422, env);
  }

  const now = new Date().toISOString();
  const nextVersion = (doc.currentVersion || 1) + 1;

  const fileReferences = await _buildAndUploadExports(
    recipe, body.structuredContent, doc, resourceId, doc.designTemplateId, env
  );

  const updated = {
    ...doc,
    structuredContent: body.structuredContent,
    fileReferences,
    currentVersion: nextVersion,
    updatedAt: now,
  };

  try {
    await fsSet('resources/' + resourceId, updated, env);
    await fsSet('resourceVersions/' + resourceId + '_' + nextVersion, {
      resourceId,
      version: nextVersion,
      structuredContent: body.structuredContent,
      designTemplateId: doc.designTemplateId,
      snapshotReason: 'edited',
      createdAt: now,
    }, env);
  } catch (e) {
    console.error('[resources] edit save failed:', e.message);
    return _jsonError('Could not save your edit. Please try again.', 500, env);
  }

  return new Response(JSON.stringify({ resource: updated }), {
    status: 200,
    headers: _corsJsonHeaders(env),
  });
}

// ── Regenerate: the owner gives a follow-up instruction and the model
//    revises the existing content, keeping the same schema. Counts
//    against the same daily resourceGen quota as a fresh generation,
//    since it is a real model call. ──
// POST /api/resources/:id/regenerate
// Body: { instruction }
export async function handleResourceRegenerate(request, env, resourceId) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    return _jsonError('Not authenticated: ' + e.message, 401, env);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return _jsonError('Invalid JSON body.', 400, env);
  }

  const instruction = String(body.instruction || '').trim();
  if (!instruction) {
    return _jsonError('instruction is required.', 400, env);
  }

  let doc;
  try {
    doc = await fsGet('resources/' + resourceId, env);
  } catch (e) {
    return _jsonError('Could not load that resource.', 500, env);
  }
  if (!doc) return _jsonError('Resource not found.', 404, env);
  if (doc.ownerId !== identity.uid) {
    return _jsonError('Not authorized to modify this resource.', 403, env);
  }
  if (!doc.structuredContent) {
    return _jsonError('This resource has no content yet to revise.', 409, env);
  }

  const recipe = getRecipe(doc.resourceType);
  if (!recipe) {
    return _jsonError('Unknown resource type on this resource: ' + doc.resourceType, 500, env);
  }

  let account;
  try {
    account = await resolveAccount(identity.uid, env);
  } catch (e) {
    console.error('[resources] account resolution failed:', e.message);
    return _jsonError('Could not verify your account. Please try again.', 500, env);
  }
  const plan = getPlan(account.planId);
  const quota = await checkAndIncrement(identity.uid, 'resourceGen', plan.limits.resourceGenPerDay, env);
  if (!quota.allowed) {
    return _jsonError(
      'You have reached your daily resource generation limit for the ' + plan.name + ' plan (' + quota.limit + ' per day).',
      429, env
    );
  }

  const revisionPrompt =
    'Here is the current content as JSON, following the required schema:\n' +
    JSON.stringify(doc.structuredContent) +
    '\n\nRevise it according to this instruction from the user, while keeping ' +
    'the exact same JSON schema described in the system prompt. Keep any ' +
    'existing content the instruction does not ask you to change, unless it ' +
    'is factually wrong. Do not shorten or remove unrelated content just ' +
    'because you are revising one part.\n\nInstruction: ' + instruction;

  const messages = [
    { role: 'system', content: recipe.systemPrompt },
    { role: 'user', content: revisionPrompt },
  ];
  const maxTokens = recipe.maxTokens || RESOURCE_MAX_TOKENS;

  let revisedContent;
  try {
    const result = await callWithFallback(MODEL_TIERS.advanced, messages, env, {
      maxTokens,
      jsonMode: true,
    });
    revisedContent = _parseStructuredJson(result.text);
  } catch (e) {
    console.error('[resources] regenerate call failed:', e.message);
    return _jsonError('Could not regenerate the resource. Please try again.', 503, env);
  }
  if (!revisedContent) {
    return _jsonError('The revised content could not be understood. Please try again.', 503, env);
  }

  const validation = recipe.validate(revisedContent, doc);
  if (!validation.ok) {
    console.error('[resources] regenerate validation failed:', validation.error);
    return _jsonError('The revised resource did not meet quality checks. Please try again.', 503, env);
  }

  const now = new Date().toISOString();
  const nextVersion = (doc.currentVersion || 1) + 1;

  const fileReferences = await _buildAndUploadExports(
    recipe, revisedContent, doc, resourceId, doc.designTemplateId, env
  );

  const updated = {
    ...doc,
    structuredContent: revisedContent,
    fileReferences,
    currentVersion: nextVersion,
    lastInstruction: instruction,
    updatedAt: now,
  };

  try {
    await fsSet('resources/' + resourceId, updated, env);
    await fsSet('resourceVersions/' + resourceId + '_' + nextVersion, {
      resourceId,
      version: nextVersion,
      structuredContent: revisedContent,
      designTemplateId: doc.designTemplateId,
      snapshotReason: 'regenerated: ' + instruction.slice(0, 120),
      createdAt: now,
    }, env);
  } catch (e) {
    console.error('[resources] regenerate save failed:', e.message);
    return _jsonError('The resource was revised but could not be saved. Please try again.', 500, env);
  }

  return new Response(JSON.stringify({ resource: updated }), {
    status: 200,
    headers: _corsJsonHeaders(env),
  });
}

async function _buildAndUploadExports(recipe, structuredContent, baseDoc, resourceId, templateId, env) {
  const fileReferences = {};
  const title = structuredContent.title || baseDoc.title;
  if (PPTX_TYPES.has(recipe.resourceType) && Array.isArray(structuredContent.slides)) {
    try {
      const pptxBase64 = await buildSimplePptx(structuredContent.slides, title, templateId);
      const pptxBytes = _base64ToBytes(pptxBase64);
      const pptxKey = 'generated/' + resourceId + '/exports/' + recipe.resourceType + '.pptx';
      const pptxUpload = await b2UploadFile(
        env, pptxKey, pptxBytes,
        'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      );
      fileReferences.pptx = { key: pptxKey, fileId: pptxUpload.fileId };
    } catch (e) {
      console.error('[resources] pptx export/upload failed:', e.message);
    }
    try {
      const sections = structuredContent.slides.map((s) => ({
        heading: s.heading || '',
        type: 'bullets',
        content: Array.isArray(s.bulletPoints) ? s.bulletPoints : [String(s.bulletPoints || '')],
      }));
      const pdfBase64 = await buildStructuredPdf({ title, sections }, title, templateId);
      const pdfBytes = _base64ToBytes(pdfBase64);
      const pdfKey = 'generated/' + resourceId + '/exports/' + recipe.resourceType + '.pdf';
      const pdfUpload = await b2UploadFile(env, pdfKey, pdfBytes, 'application/pdf');
      fileReferences.pdf = { key: pdfKey, fileId: pdfUpload.fileId };
    } catch (e) {
      console.error('[resources] pdf export/upload failed:', e.message);
    }
    return fileReferences;
  }
  const sections = _structuredContentToSections(structuredContent);
  const structuredForExport = { title, sections };
  try {
    const pdfBase64 = await buildStructuredPdf(structuredForExport, title, templateId);
    const pdfBytes = _base64ToBytes(pdfBase64);
    const pdfKey = 'generated/' + resourceId + '/exports/' + recipe.resourceType + '.pdf';
    const pdfUpload = await b2UploadFile(env, pdfKey, pdfBytes, 'application/pdf');
    fileReferences.pdf = { key: pdfKey, fileId: pdfUpload.fileId };
  } catch (e) {
    console.error('[resources] pdf export/upload failed:', e.message);
  }
  try {
    const docxBase64 = await buildStructuredDocx(structuredForExport, title);
    const docxBytes = _base64ToBytes(docxBase64);
    const docxKey = 'generated/' + resourceId + '/exports/' + recipe.resourceType + '.docx';
    const docxUpload = await b2UploadFile(
      env, docxKey, docxBytes,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
    fileReferences.docx = { key: docxKey, fileId: docxUpload.fileId };
  } catch (e) {
    console.error('[resources] docx export/upload failed:', e.message);
  }
  return fileReferences;
}

async function _markFailed(resourceId, baseDoc, env) {
  try {
    await fsSet('resources/' + resourceId, {
      ...baseDoc,
      status: 'failed',
      updatedAt: new Date().toISOString(),
    }, env);
  } catch (e) {
    console.error('[resources] could not mark resource as failed:', e.message);
  }
}

function _base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function handleResourceDownload(request, env, resourceId) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    return _jsonError('Not authenticated: ' + e.message, 401, env);
  }
  const url = new URL(request.url);
  const requestedFormat = url.searchParams.get('format');
  let doc;
  try {
    doc = await fsGet('resources/' + resourceId, env);
  } catch (e) {
    console.error('[resources] lookup failed:', e.message);
    return _jsonError('Could not load that resource.', 500, env);
  }
  if (!doc) {
    return _jsonError('Resource not found.', 404, env);
  }
  if (doc.ownerId !== identity.uid) {
    return _jsonError('Not authorized to access this resource.', 403, env);
  }
  const format = requestedFormat && doc.fileReferences && doc.fileReferences[requestedFormat]
    ? requestedFormat
    : Object.keys(doc.fileReferences || {})[0];
  if (!format || !doc.fileReferences[format]) {
    return _jsonError('No export file is available for this resource yet.', 404, env);
  }
  try {
    const prefix = 'generated/' + resourceId + '/exports/';
    const authToken = await b2GetDownloadAuthorization(env, prefix, 3600);
    const downloadUrl = await b2BuildPrivateDownloadUrl(env, doc.fileReferences[format].key, authToken);
    return new Response(JSON.stringify({ url: downloadUrl, format, expiresInSeconds: 3600 }), {
      status: 200,
      headers: _corsJsonHeaders(env),
    });
  } catch (e) {
    console.error('[resources] download authorization failed:', e.message);
    return _jsonError('Could not prepare the download. Please try again.', 503, env);
  }
}

export async function handleResourceList(request, env) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    return _jsonError('Not authenticated: ' + e.message, 401, env);
  }
  try {
    const resources = await fsQuery('resources', 'ownerId', identity.uid, 'createdAt', 50, env);
    return new Response(JSON.stringify({ resources }), {
      status: 200,
      headers: _corsJsonHeaders(env),
    });
  } catch (e) {
    console.error('[resources] list failed:', e.message);
    return _jsonError('Could not load your resources. Please try again.', 500, env);
  }
}

function _corsJsonHeaders(env) {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': env?.APP_ORIGIN || '*' };
}

function _jsonError(message, status, env) {
  return new Response(JSON.stringify({ error: message }), { status, headers: _corsJsonHeaders(env) });
}
