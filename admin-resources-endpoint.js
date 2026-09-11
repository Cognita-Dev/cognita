// admin-resources-endpoint.js
// Admin resource CRUD: create (AI or hand-written), batch create
// (idempotent), edit, workflow transitions (Draft -> Review -> Validate ->
// Publish), listing, single fetch, delete, and version history.
//
// Every handler starts with requireAdmin() — a normal user's token is
// rejected before anything else runs. Failures here are fully isolated
// from user-facing routes: nothing in this file is imported by
// resources-endpoint.js, and every exported handler catches its own
// errors and returns a JSON response rather than throwing.

import { requireAdmin } from './admin-auth.js';
import { fsSet, fsGet, fsQuery, fsDelete } from './firestore-rest.js';
import { getRecipe } from './recipes/index.js';
import { callWithFallback } from './providers.js';
import { MODEL_TIERS } from './entitlements.js';
import { buildStructuredDocx } from './docx-builder.js';
import { buildStructuredPdf } from './pdf-builder.js';
import { buildSimplePptx } from './pptx-builder.js';
import { b2UploadFile } from './b2-client.js';

const RESOURCE_MAX_TOKENS = 6000;

// The only allowed state transitions. Anything not listed here is
// rejected with a clear error rather than silently no-op'd.
const ACTION_MAP = {
  submit_review: { from: ['draft'], to: 'in_review' },
  request_changes: { from: ['in_review', 'validated'], to: 'draft' },
  validate: { from: ['in_review'], to: 'validated' },
  publish: { from: ['validated'], to: 'published' },
  archive: { from: ['published'], to: 'archived' },
  restore: { from: ['archived'], to: 'draft' },
};

const ALL_STATUSES = ['draft', 'in_review', 'validated', 'published', 'archived'];

function _makeId() {
  return (crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'a-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}

function _corsJsonHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };
}

function _jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: _corsJsonHeaders(),
  });
}

function _jsonOk(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: _corsJsonHeaders(),
  });
}

// Same JSON-parsing/repair logic as resources-endpoint.js, duplicated here
// on purpose rather than shared, so this file never has to touch or risk
// breaking the existing user-facing endpoint. If you'd rather share one
// copy, both can later import from a small json-repair.js util.
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
    // fall through to repair attempt
  }
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

// ── Idempotency reservation ──────────────────────────────────────────
// Reserves a clientRequestId before any AI call or resource write. If the
// key was already reserved (a retry of the same batch item), returns the
// resourceId that was reserved the first time instead of a fresh one, so
// the caller can look up and return the existing resource rather than
// creating a duplicate.
//
// Note: Firestore REST here does a plain read-then-write, not a true
// transaction, so this closes the window for a client accidentally
// double-submitting the same request from two tabs at the exact same
// moment — it does not guarantee atomicity under concurrent identical
// requests arriving within milliseconds of each other. For a single-admin
// curation tool this is a reasonable tradeoff; if you ever have multiple
// admins racing on the same idempotency key, this would need a real
// Firestore transaction.
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

// ── Content generation (AI mode) ─────────────────────────────────────
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

// ── Single create ─────────────────────────────────────────────────────
// POST /api/admin/resources
// Body: { resourceType, mode: 'ai' | 'manual', fields? (ai mode),
//         manualContent? (manual mode), clientRequestId? }
export async function handleAdminResourceCreate(request, env) {
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

  try {
    const result = await _createOne(identity.uid, body, env);
    return _jsonOk({ resource: result.resource }, result.wasExisting ? 200 : 201);
  } catch (e) {
    return _jsonError(e.message, e.isBadRequest ? 400 : 500);
  }
}

// Shared logic between single-create and each batch item. Throws on
// failure with e.isBadRequest set for client-caused errors (so the caller
// can map it to the right HTTP status / per-item error).
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
    // Idempotency record pointed at a resource that no longer exists
    // (e.g. it was hard-deleted). Fall through and create a fresh one
    // under a new id rather than returning nothing.
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

const PPTX_TYPES = new Set(['presentation']);
const SKIP_KEYS = new Set(['title']);

function _base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Same generic structuredContent -> sections walk as resources-endpoint.js
// uses, kept as its own copy here so this file has no import dependency
// on that one.
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

// Renders + uploads publish-time exports for an admin resource. Never
// throws — any single format's failure is logged and just omitted from
// the returned fileReferences, so publishing itself always succeeds once
// the version snapshot is saved.
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
    const docxBase64 = await buildStructuredDocx(structuredForExport, title);
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

// ── Batch create (idempotent) ─────────────────────────────────────────
// POST /api/admin/resources/batch
// Body: { items: [{ resourceType, mode, fields?, manualContent?,
//                    clientRequestId?, designTemplateId? }, ...] }
// Always responds 200 with a per-item result array — a partial failure
// is not a request-level failure.
export async function handleAdminResourceBatchCreate(request, env) {
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

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return _jsonError('items must be a non-empty array.', 400);
  }
  if (body.items.length > 50) {
    return _jsonError('A batch is limited to 50 items at a time.', 400);
  }

  const results = [];
  // Guards against the client accidentally sending the same
  // clientRequestId twice within one batch payload — the second copy is
  // treated as a duplicate of the first rather than reserved twice.
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

  return _jsonOk({ results });
}

// ── Edit ───────────────────────────────────────────────────────────────
// POST /api/admin/resources/:id
// Body: { structuredContent?, designTemplateId?, collectionIds? }
export async function handleAdminResourceEdit(request, env, resourceId) {
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

  let doc;
  try {
    doc = await fsGet('adminResources/' + resourceId, env);
  } catch (e) {
    return _jsonError('Could not load that resource.', 500);
  }
  if (!doc) return _jsonError('Resource not found.', 404);

  const now = new Date().toISOString();
  const wasReleased = doc.status === 'validated' || doc.status === 'published';

  if (wasReleased) {
    // Preserve what was actually validated/published before it's touched.
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
      return _jsonError('Could not preserve the previous version. Edit was not applied.', 500);
    }
  }

  const updated = {
    ...doc,
    structuredContent: body.structuredContent !== undefined ? body.structuredContent : doc.structuredContent,
    designTemplateId: body.designTemplateId !== undefined ? body.designTemplateId : doc.designTemplateId,
    collectionIds: Array.isArray(body.collectionIds) ? body.collectionIds : doc.collectionIds,
    // Editing a released resource sends it back to draft — it must be
    // re-validated and re-published deliberately, never left "published"
    // with content that was never checked.
    status: wasReleased ? 'draft' : doc.status,
    currentVersion: wasReleased ? doc.currentVersion + 1 : doc.currentVersion,
    lastEditedBy: identity.uid,
    updatedAt: now,
  };

  try {
    await fsSet('adminResources/' + resourceId, updated, env);
  } catch (e) {
    return _jsonError('Could not save the edit. Please try again.', 500);
  }

  return _jsonOk({ resource: updated });
}

// ── Workflow transitions ─────────────────────────────────────────────
// POST /api/admin/resources/:id/transition
// Body: { action: 'submit_review' | 'request_changes' | 'validate' |
//                  'publish' | 'archive' | 'restore' }
export async function handleAdminResourceTransition(request, env, resourceId) {
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

  const action = body.action;
  const rule = ACTION_MAP[action];
  if (!rule) {
    return _jsonError('Unknown action: ' + action, 400);
  }

  let doc;
  try {
    doc = await fsGet('adminResources/' + resourceId, env);
  } catch (e) {
    return _jsonError('Could not load that resource.', 500);
  }
  if (!doc) return _jsonError('Resource not found.', 404);

  if (!rule.from.includes(doc.status)) {
    return _jsonError(
      'Cannot ' + action + ' a resource that is currently "' + doc.status + '". ' +
      'Allowed from: ' + rule.from.join(', ') + '.',
      409
    );
  }

  // "validate" actually checks the content against the recipe's own
  // validator, not just a status flip. Hand-written content has to pass
  // the same bar as AI-generated content before it can be published.
  if (action === 'validate') {
    const recipe = getRecipe(doc.resourceType);
    if (!recipe) {
      return _jsonError('Unknown resource type on this resource: ' + doc.resourceType, 500);
    }
    const check = recipe.validate(doc.structuredContent, doc.fields || {});
    if (!check.ok) {
      return _jsonError('Validation failed: ' + check.error, 422);
    }
  }

  const now = new Date().toISOString();
  const updated = {
    ...doc,
    status: rule.to,
    lastEditedBy: identity.uid,
    updatedAt: now,
  };

  // Publishing snapshots the exact content being published, so the
  // library always has a stable, addressable version even if it's edited
  // again later.
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
      return _jsonError('Could not save the published version. Please try again.', 500);
    }
    updated.publishedAt = now;
    updated.fileReferences = await _buildAndUploadAdminExports(doc, resourceId, env);
  }

  try {
    await fsSet('adminResources/' + resourceId, updated, env);
  } catch (e) {
    return _jsonError('Could not save the transition. Please try again.', 500);
  }

  return _jsonOk({ resource: updated });
}

// ── List (admin view — all statuses, not just this admin's own) ────────
// GET /api/admin/resources?status=draft   (status is optional)
export async function handleAdminResourceList(request, env) {
  try {
    await requireAdmin(request, env);
  } catch (e) {
    return _jsonError('Not authorized: ' + e.message, e.isForbidden ? 403 : 401);
  }

  const url = new URL(request.url);
  const status = url.searchParams.get('status');

  try {
    let resources;
    if (status) {
      if (!ALL_STATUSES.includes(status)) {
        return _jsonError('Unknown status filter: ' + status, 400);
      }
      resources = await fsQuery('adminResources', 'status', status, 'updatedAt', 100, env);
    } else {
      // No single-filter option in fsQuery for "everything" — run one
      // query per status and merge, since Firestore's REST query API here
      // only supports one equality filter at a time.
      const batches = await Promise.all(
        ALL_STATUSES.map((s) => fsQuery('adminResources', 'status', s, 'updatedAt', 100, env))
      );
      resources = batches.flat().sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    }
    return _jsonOk({ resources });
  } catch (e) {
    console.error('[admin-resources] list failed:', e.message);
    return _jsonError('Could not load resources.', 500);
  }
}

// ── Get single ────────────────────────────────────────────────────────
// GET /api/admin/resources/:id
export async function handleAdminResourceGet(request, env, resourceId) {
  try {
    await requireAdmin(request, env);
  } catch (e) {
    return _jsonError('Not authorized: ' + e.message, e.isForbidden ? 403 : 401);
  }

  try {
    const doc = await fsGet('adminResources/' + resourceId, env);
    if (!doc) return _jsonError('Resource not found.', 404);
    return _jsonOk({ resource: doc });
  } catch (e) {
    return _jsonError('Could not load that resource.', 500);
  }
}

// ── Version history ──────────────────────────────────────────────────
// GET /api/admin/resources/:id/versions
export async function handleAdminResourceVersions(request, env, resourceId) {
  try {
    await requireAdmin(request, env);
  } catch (e) {
    return _jsonError('Not authorized: ' + e.message, e.isForbidden ? 403 : 401);
  }

  try {
    const versions = await fsQuery('adminResourceVersions', 'resourceId', resourceId, 'version', 100, env);
    return _jsonOk({ versions });
  } catch (e) {
    console.error('[admin-resources] versions fetch failed:', e.message);
    return _jsonError('Could not load version history.', 500);
  }
}

// ── Delete ────────────────────────────────────────────────────────────
// DELETE /api/admin/resources/:id
// Only draft or archived resources can be hard-deleted — anything that
// was ever validated/published keeps its version history and must be
// archived instead, never erased outright.
export async function handleAdminResourceDelete(request, env, resourceId) {
  let identity;
  try {
    identity = await requireAdmin(request, env);
  } catch (e) {
    return _jsonError('Not authorized: ' + e.message, e.isForbidden ? 403 : 401);
  }

  let doc;
  try {
    doc = await fsGet('adminResources/' + resourceId, env);
  } catch (e) {
    return _jsonError('Could not load that resource.', 500);
  }
  if (!doc) return _jsonOk({ deleted: true }); // already gone — idempotent delete

  if (doc.status !== 'draft' && doc.status !== 'archived') {
    return _jsonError(
      'Cannot delete a resource in status "' + doc.status + '". Archive it first.',
      409
    );
  }

  try {
    await fsDelete('adminResources/' + resourceId, env);
  } catch (e) {
    console.error('[admin-resources] delete failed:', e.message);
    return _jsonError('Could not delete that resource. Please try again.', 500);
  }

  return _jsonOk({ deleted: true });
}
