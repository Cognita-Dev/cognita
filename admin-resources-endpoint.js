// admin-resources-endpoint.js

import { requireAdmin } from './admin-auth.js';
import { fsSet, fsGet, fsQuery, fsDelete } from './firestore-rest.js';
import { getRecipe } from './recipes/index.js';
import { callWithFallback } from './providers.js';
import { MODEL_TIERS } from './entitlements.js';
import { buildStructuredDocx, buildSimpleDocx } from './docx-builder.js';
import { buildStructuredPdf, buildSimplePdf } from './pdf-builder.js';
import { buildSimplePptx } from './pptx-builder.js';
import { b2UploadFile } from './b2-client.js';
import { invalidatePublished, refreshPublished } from './library-cache.js';

const RESOURCE_MAX_TOKENS = 6000;

const ACTION_MAP = {
  submit_review: { from: ['draft'], to: 'in_review' },
  request_changes: { from: ['in_review', 'validated'], to: 'draft' },
  validate: { from: ['in_review'], to: 'validated' },
  publish: { from: ['validated'], to: 'published' },
  archive: { from: ['published'], to: 'archived' },
  restore: { from: ['archived'], to: 'draft' },
};

const ALL_STATUSES = ['draft', 'in_review', 'validated', 'published', 'archived'];
const PPTX_TYPES = new Set(['presentation']);
const SKIP_KEYS = new Set(['title']);

function _makeId() {
  return (crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'a-' + Date.now() + '-' + Math.random().toString(36).slice(2);
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

function _base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
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
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
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
  for (let i = stack.length - 1; i >= 0; i--) repaired += stack[i] === '{' ? '}' : ']';
  return repaired;
}

const WELL_FORMED_SECTION_TYPES = new Set([
  'paragraph', 'bullets', 'numbered', 'definition', 'example', 'formula',
]);

// True when `value` is already a proper { heading, type, content }[]
// array — e.g. a Lesson Note's "sections" — rather than some arbitrary
// array field that happens to be named "sections".
function _isWellFormedSections(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (s) => s && typeof s === 'object' && typeof s.heading === 'string' && WELL_FORMED_SECTION_TYPES.has(s.type)
    )
  );
}

// Normalizes one already-typed section into the plain
// { heading, type: 'paragraph' | 'bullets', content } shape the
// docx/pdf builders render natively. "definition" and "numbered"
// sections don't have a direct equivalent in the builders, so they're
// turned into readable bullet lines instead of being dropped.
function _normalizeWellFormedSection(section) {
  if (section.type === 'definition') {
    const items = (Array.isArray(section.content) ? section.content : []).map((entry) =>
      entry && typeof entry === 'object' ? String(entry.term || '') + ': ' + String(entry.explanation || '') : String(entry)
    );
    return { heading: section.heading, type: 'bullets', content: items };
  }
  if (section.type === 'numbered') {
    const items = (Array.isArray(section.content) ? section.content : []).map(
      (item, i) => (i + 1) + '. ' + item
    );
    return { heading: section.heading, type: 'bullets', content: items };
  }
  if (section.type === 'bullets') {
    return { heading: section.heading, type: 'bullets', content: Array.isArray(section.content) ? section.content : [] };
  }
  // paragraph, example, formula all already carry a plain string.
  return { heading: section.heading, type: 'paragraph', content: String(section.content || '') };
}

function _structuredContentToSections(content) {
  // Recipes like Lesson Note already produce a well-formed sections
  // array — one real sub-topic per entry, with its own heading and
  // full content. Running that through the generic key-flattening
  // logic below collapsed each section into a single summary line
  // (e.g. "Definition of Whole Numbers — definition") under one
  // meta-heading literally called "Sections", discarding the actual
  // taught content. When the shape is already well-formed, use it
  // directly instead, keeping introduction/summary as their own
  // untitled/"Summary" paragraphs around it.
  if (_isWellFormedSections(content.sections)) {
    const out = [];
    if (typeof content.introduction === 'string' && content.introduction.trim()) {
      out.push({ heading: '', type: 'paragraph', content: content.introduction });
    }
    content.sections.forEach((s) => out.push(_normalizeWellFormedSection(s)));
    if (typeof content.summary === 'string' && content.summary.trim()) {
      out.push({ heading: 'Summary', type: 'paragraph', content: content.summary });
    }
    return out;
  }

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

async function _reserveIdempotency(adminUid, clientRequestId, env) {
  if (!clientRequestId) return { reserved: true, existingResourceId: null };

  const key = 'adminIdempotency/' + adminUid + '_' + clientRequestId;
  const existing = await fsGet(key, env);

  if (existing && existing.resourceId) {
    return { reserved: false, existingResourceId: existing.resourceId };
  }

  const resourceId = _makeId();
  await fsSet(key, {
    adminUid,
    clientRequestId,
    resourceId,
    createdAt: new Date().toISOString(),
  }, env);

  return { reserved: true, existingResourceId: null, resourceId };
}

async function _generateViaAi(recipe, fields, env) {
  for (const required of recipe.requiredFields) {
    if (!fields[required] || !String(fields[required]).trim()) {
      throw Object.assign(new Error('Missing required field: ' + required), { isBadRequest: true });
    }
  }

  const messages = [
    { role: 'system', content: recipe.systemPrompt },
    { role: 'user', content: recipe.buildUserPrompt(fields) },
  ];

  const result = await callWithFallback(MODEL_TIERS.advanced, messages, env, {
    maxTokens: RESOURCE_MAX_TOKENS,
    jsonMode: true,
  });

  const structuredContent = _parseStructuredJson(result.text);
  if (!structuredContent) {
    throw new Error('The generated content could not be understood.');
  }

  return structuredContent;
}

export async function handleAdminResourceCreate(request, env) {
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

  try {
    const result = await _createOne(identity.uid, body, env);
    return _jsonOk({ resource: result.resource }, result.wasExisting ? 200 : 201, env);
  } catch (e) {
    return _jsonError(e.message, e.isBadRequest ? 400 : 500, env);
  }
}

async function _createOne(adminUid, body, env) {
  const resourceType = body.resourceType;
  const mode = body.mode;

  if (!resourceType) {
    throw Object.assign(new Error('resourceType is required.'), { isBadRequest: true });
  }
  if (mode !== 'ai' && mode !== 'manual') {
    throw Object.assign(new Error('mode must be "ai" or "manual".'), { isBadRequest: true });
  }

  const recipe = getRecipe(resourceType);
  if (!recipe) {
    throw Object.assign(new Error('Unknown resource type: ' + resourceType), { isBadRequest: true });
  }

  const idempotency = await _reserveIdempotency(adminUid, body.clientRequestId, env);
  if (!idempotency.reserved) {
    const existing = await fsGet('adminResources/' + idempotency.existingResourceId, env);
    if (existing) {
      return { resource: existing, wasExisting: true };
    }
  }

  const resourceId = idempotency.resourceId || _makeId();

  let structuredContent;
  if (mode === 'ai') {
    structuredContent = await _generateViaAi(recipe, body.fields || {}, env);
  } else {
    structuredContent = body.manualContent;
    if (!structuredContent || typeof structuredContent !== 'object') {
      throw Object.assign(new Error('manualContent must be an object.'), { isBadRequest: true });
    }
    if (!structuredContent.title || !String(structuredContent.title).trim()) {
      throw Object.assign(new Error('manualContent.title is required.'), { isBadRequest: true });
    }
  }

  const now = new Date().toISOString();
  const doc = {
    id: resourceId,
    resourceType,
    createdMode: mode,
    createdBy: adminUid,
    lastEditedBy: adminUid,
    status: 'draft',
    structuredContent,
    fields: mode === 'ai' ? (body.fields || {}) : {},
    fileReferences: {},
    designTemplateId: body.designTemplateId || 'classic',
    collectionIds: [],
    currentVersion: 1,
    createdAt: now,
    updatedAt: now,
  };

  await fsSet('adminResources/' + resourceId, doc, env);

  return { resource: doc, wasExisting: false };
}

async function _buildAndUploadAdminExports(doc, resourceId, env) {
  const fileReferences = {};
  const content = doc.structuredContent;
  const title = content.title || 'Untitled';
  const templateId = doc.designTemplateId || 'classic';
  const basePrefix = 'adminGenerated/' + resourceId + '/exports/';

  if (PPTX_TYPES.has(doc.resourceType) && Array.isArray(content.slides)) {
    try {
      const pptxBase64 = await buildSimplePptx(content.slides, title, templateId);
      const pptxKey = basePrefix + doc.resourceType + '.pptx';
      const pptxUpload = await b2UploadFile(
        env, pptxKey, _base64ToBytes(pptxBase64),
        'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      );
      fileReferences.pptx = { key: pptxKey, fileId: pptxUpload.fileId };
    } catch (e) {
      console.error('[admin-resources] pptx export/upload failed:', e.message);
    }

    try {
      const sections = content.slides.map((s) => ({
        heading: s.heading || '',
        type: 'bullets',
        content: Array.isArray(s.bulletPoints) ? s.bulletPoints : [String(s.bulletPoints || '')],
      }));
      const pdfBase64 = await buildStructuredPdf({ title, sections }, title, templateId);
      const pdfKey = basePrefix + doc.resourceType + '.pdf';
      const pdfUpload = await b2UploadFile(env, pdfKey, _base64ToBytes(pdfBase64), 'application/pdf');
      fileReferences.pdf = { key: pdfKey, fileId: pdfUpload.fileId };
    } catch (e) {
      console.error('[admin-resources] pdf export/upload failed:', e.message);
    }

    return fileReferences;
  }

  const recipe = getRecipe(doc.resourceType);

  if (recipe && typeof recipe.toPlainTextParagraphs === 'function') {
    const plainText = recipe.toPlainTextParagraphs(content);
    try {
      const pdfBase64 = await buildSimplePdf(plainText, title, templateId);
      const pdfKey = basePrefix + doc.resourceType + '.pdf';
      const pdfUpload = await b2UploadFile(env, pdfKey, _base64ToBytes(pdfBase64), 'application/pdf');
      fileReferences.pdf = { key: pdfKey, fileId: pdfUpload.fileId };
    } catch (e) {
      console.error('[admin-resources] pdf export/upload failed:', e.message);
    }

    try {
      const docxBase64 = await buildSimpleDocx(plainText, title, templateId);
      const docxKey = basePrefix + doc.resourceType + '.docx';
      const docxUpload = await b2UploadFile(
        env, docxKey, _base64ToBytes(docxBase64),
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      );
      fileReferences.docx = { key: docxKey, fileId: docxUpload.fileId };
    } catch (e) {
      console.error('[admin-resources] docx export/upload failed:', e.message);
    }

    return fileReferences;
  }

  // Fallback for any resource type that doesn't (yet) provide its own
  // toPlainTextParagraphs formatter.
  const structuredForExport = { title, sections: _structuredContentToSections(content) };

  try {
    const pdfBase64 = await buildStructuredPdf(structuredForExport, title, templateId);
    const pdfKey = basePrefix + doc.resourceType + '.pdf';
    const pdfUpload = await b2UploadFile(env, pdfKey, _base64ToBytes(pdfBase64), 'application/pdf');
    fileReferences.pdf = { key: pdfKey, fileId: pdfUpload.fileId };
  } catch (e) {
    console.error('[admin-resources] pdf export/upload failed:', e.message);
  }

  try {
    const docxBase64 = await buildStructuredDocx(structuredForExport, title, templateId);
    const docxKey = basePrefix + doc.resourceType + '.docx';
    const docxUpload = await b2UploadFile(
      env, docxKey, _base64ToBytes(docxBase64),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
    fileReferences.docx = { key: docxKey, fileId: docxUpload.fileId };
  } catch (e) {
    console.error('[admin-resources] docx export/upload failed:', e.message);
  }

  return fileReferences;
}

export async function handleAdminResourceBatchCreate(request, env) {
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

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return _jsonError('items must be a non-empty array.', 400, env);
  }
  if (body.items.length > 50) {
    return _jsonError('A batch is limited to 50 items at a time.', 400, env);
  }

  const results = [];
  const seenInThisBatch = new Map();

  for (let i = 0; i < body.items.length; i++) {
    const item = body.items[i];
    const clientRequestId = item.clientRequestId || null;

    if (clientRequestId && seenInThisBatch.has(clientRequestId)) {
      results.push({
        index: i,
        clientRequestId,
        ok: true,
        resource: seenInThisBatch.get(clientRequestId),
        note: 'Duplicate clientRequestId within this batch — reused the earlier result.',
      });
      continue;
    }

    try {
      const result = await _createOne(identity.uid, item, env);
      results.push({
        index: i,
        clientRequestId,
        ok: true,
        resource: result.resource,
        wasExisting: result.wasExisting,
      });
      if (clientRequestId) seenInThisBatch.set(clientRequestId, result.resource);
    } catch (e) {
      console.error('[admin-resources] batch item ' + i + ' failed:', e.message);
      results.push({
        index: i,
        clientRequestId,
        ok: false,
        error: e.message,
      });
    }
  }

  return _jsonOk({ results }, 200, env);
}

export async function handleAdminResourceEdit(request, env, resourceId) {
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

  let doc;
  try {
    doc = await fsGet('adminResources/' + resourceId, env);
  } catch (e) {
    return _jsonError('Could not load that resource.', 500, env);
  }
  if (!doc) return _jsonError('Resource not found.', 404, env);

  const now = new Date().toISOString();
  const wasReleased = doc.status === 'validated' || doc.status === 'published';

  if (wasReleased) {
    try {
      await fsSet('adminResourceVersions/' + resourceId + '_' + doc.currentVersion, {
        resourceId,
        version: doc.currentVersion,
        status: doc.status,
        structuredContent: doc.structuredContent,
        designTemplateId: doc.designTemplateId,
        snapshotReason: 'edited-after-' + doc.status,
        createdAt: now,
      }, env);
    } catch (e) {
      console.error('[admin-resources] version snapshot failed:', e.message);
      return _jsonError('Could not preserve the previous version. Edit was not applied.', 500, env);
    }
  }

  const updated = {
    ...doc,
    structuredContent: body.structuredContent !== undefined ? body.structuredContent : doc.structuredContent,
    designTemplateId: body.designTemplateId !== undefined ? body.designTemplateId : doc.designTemplateId,
    collectionIds: Array.isArray(body.collectionIds) ? body.collectionIds : doc.collectionIds,
    status: wasReleased ? 'draft' : doc.status,
    currentVersion: wasReleased ? doc.currentVersion + 1 : doc.currentVersion,
    lastEditedBy: identity.uid,
    updatedAt: now,
  };

  try {
    await fsSet('adminResources/' + resourceId, updated, env);
  } catch (e) {
    return _jsonError('Could not save the edit. Please try again.', 500, env);
  }

  // Editing a resource that was validated/published resets it to
  // draft (above) — if it had been published, it must stop being
  // servable from the library cache the instant that happens, not
  // whenever the cache would otherwise have expired.
  if (doc.status === 'published') {
    await invalidatePublished(env, resourceId);
  }

  return _jsonOk({ resource: updated }, 200, env);
}

export async function handleAdminResourceTransition(request, env, resourceId) {
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

  const action = body.action;
  const rule = ACTION_MAP[action];
  if (!rule) {
    return _jsonError('Unknown action: ' + action, 400, env);
  }

  let doc;
  try {
    doc = await fsGet('adminResources/' + resourceId, env);
  } catch (e) {
    return _jsonError('Could not load that resource.', 500, env);
  }
  if (!doc) return _jsonError('Resource not found.', 404, env);

  if (!rule.from.includes(doc.status)) {
    return _jsonError(
      'Cannot ' + action + ' a resource that is currently "' + doc.status + '". ' +
      'Allowed from: ' + rule.from.join(', ') + '.',
      409, env
    );
  }

  if (action === 'validate') {
    const recipe = getRecipe(doc.resourceType);
    if (!recipe) {
      return _jsonError('Unknown resource type on this resource: ' + doc.resourceType, 500, env);
    }
    const check = recipe.validate(doc.structuredContent, doc.fields || {});
    if (!check.ok) {
      return _jsonError('Validation failed: ' + check.error, 422, env);
    }
  }

  const now = new Date().toISOString();
  const updated = {
    ...doc,
    status: rule.to,
    lastEditedBy: identity.uid,
    updatedAt: now,
  };

  if (action === 'publish') {
    try {
      await fsSet('adminResourceVersions/' + resourceId + '_' + doc.currentVersion, {
        resourceId,
        version: doc.currentVersion,
        status: 'published',
        structuredContent: doc.structuredContent,
        designTemplateId: doc.designTemplateId,
        snapshotReason: 'published',
        createdAt: now,
      }, env);
    } catch (e) {
      console.error('[admin-resources] publish snapshot failed:', e.message);
      return _jsonError('Could not save the published version. Please try again.', 500, env);
    }
    updated.publishedAt = now;
    updated.fileReferences = await _buildAndUploadAdminExports(doc, resourceId, env);
  }

  try {
    await fsSet('adminResources/' + resourceId, updated, env);
  } catch (e) {
    return _jsonError('Could not save the transition. Please try again.', 500, env);
  }

  // Keep the library cache in lockstep with what just changed, right
  // here at the moment of change — not on a timer, so a user can never
  // be served a stale cached copy after a publish/archive/restore.
  if (action === 'publish') {
    await refreshPublished(env, updated);
  } else if (action === 'archive' || action === 'restore') {
    await invalidatePublished(env, resourceId);
  }

  return _jsonOk({ resource: updated }, 200, env);
}

export async function handleAdminResourceList(request, env) {
  try {
    await requireAdmin(request, env);
  } catch (e) {
    return _jsonError('Not authorized: ' + e.message, e.isForbidden ? 403 : 401, env);
  }

  const url = new URL(request.url);
  const status = url.searchParams.get('status');

  try {
    let resources;
    if (status) {
      if (!ALL_STATUSES.includes(status)) {
        return _jsonError('Unknown status filter: ' + status, 400, env);
      }
      resources = await fsQuery('adminResources', 'status', status, 'updatedAt', 100, env);
    } else {
      const batches = await Promise.all(
        ALL_STATUSES.map((s) => fsQuery('adminResources', 'status', s, 'updatedAt', 100, env))
      );
      resources = batches.flat().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    }
    return _jsonOk({ resources }, 200, env);
  } catch (e) {
    console.error('[admin-resources] list failed:', e.message);
    return _jsonError('Could not load resources.', 500, env);
  }
}

export async function handleAdminResourceGet(request, env, resourceId) {
  try {
    await requireAdmin(request, env);
  } catch (e) {
    return _jsonError('Not authorized: ' + e.message, e.isForbidden ? 403 : 401, env);
  }

  try {
    const doc = await fsGet('adminResources/' + resourceId, env);
    if (!doc) return _jsonError('Resource not found.', 404, env);
    return _jsonOk({ resource: doc }, 200, env);
  } catch (e) {
    return _jsonError('Could not load that resource.', 500, env);
  }
}

export async function handleAdminResourceVersions(request, env, resourceId) {
  try {
    await requireAdmin(request, env);
  } catch (e) {
    return _jsonError('Not authorized: ' + e.message, e.isForbidden ? 403 : 401, env);
  }

  try {
    const versions = await fsQuery('adminResourceVersions', 'resourceId', resourceId, 'version', 100, env);
    return _jsonOk({ versions }, 200, env);
  } catch (e) {
    console.error('[admin-resources] versions fetch failed:', e.message);
    return _jsonError('Could not load version history.', 500, env);
  }
}

export async function handleAdminResourceDelete(request, env, resourceId) {
  let identity;
  try {
    identity = await requireAdmin(request, env);
  } catch (e) {
    return _jsonError('Not authorized: ' + e.message, e.isForbidden ? 403 : 401, env);
  }

  let doc;
  try {
    doc = await fsGet('adminResources/' + resourceId, env);
  } catch (e) {
    return _jsonError('Could not load that resource.', 500, env);
  }
  if (!doc) return _jsonOk({ deleted: true }, 200, env);

  if (doc.status !== 'draft' && doc.status !== 'archived') {
    return _jsonError(
      'Cannot delete a resource in status "' + doc.status + '". Archive it first.',
      409, env
    );
  }

  try {
    await fsDelete('adminResources/' + resourceId, env);
  } catch (e) {
    console.error('[admin-resources] delete failed:', e.message);
    return _jsonError('Could not delete that resource. Please try again.', 500, env);
  }

  await invalidatePublished(env, resourceId);

  return _jsonOk({ deleted: true }, 200, env);
}
