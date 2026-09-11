// resources-endpoint.js
// POST /api/resources/generate
// Frontend sends { resourceType, fields: {...}, designTemplateId }. The
// Worker selects the matching Recipe, resolves the requested design
// template against what the user's plan actually entitles (never trusts
// the client id directly, and never silently substitutes a different
// template than what was requested), generates structured content via the
// existing AI provider plumbing, validates it, stores it in
// Firestore, renders export file(s) in the resolved template, and
// uploads them to the dedicated Cognita Resources B2 bucket.
//
// Export format per resource type: every type gets a PDF and (except
// "presentation") a DOCX, both built from a generic structured rendering
// of the recipe's own structuredContent — real headings and bullet lists,
// not a flattened wall of text. "presentation" gets a real .pptx instead,
// since a slide deck as a Word doc doesn't make sense.
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
// Resource types that export as a real .pptx instead of the default .docx.
const PPTX_TYPES = new Set(['presentation']);
// Structured-content generation (flashcards, exams, rubrics, etc.) tends
// to run long — same reasoning as document-endpoint.js's DOCUMENT_MAX_TOKENS.
const RESOURCE_MAX_TOKENS = 6000;
// Keys that read as metadata rather than content when walking a recipe's
// structuredContent generically — skipped so they don't show up as their
// own heading in the exported file.
const SKIP_KEYS = new Set(['title']);
function _makeResourceId() {
  return (crypto && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'r-' + Date.now() + '-' + Math.random().toString(36).slice(2);
}
function _parseStructuredJson(text) {
  if (!text) return null;
  let clean = text
    .replace(/```json\s*/gi, '')
    .replace(/```/g, '')
    .trim();
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
// Same structural-repair heuristic as document-endpoint.js: closes an
// unterminated string and any still-open braces/brackets left by a
// response that got cut off mid-JSON by the token budget.
function _repairTruncatedJson(text) {
  if (!text) return null;
  const stack = [];
  let inString = false;
  let escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch);
    } else if (ch === '}' || ch === ']') {
      stack.pop();
    }
  }
  if (stack.length === 0 && !inString) return null;
  let repaired = text;
  if (inString) {
    repaired += '"';
  }
  repaired = repaired.replace(/,\s*$/, '');
  for (let i = stack.length - 1; i >= 0; i--) {
    repaired += stack[i] === '{' ? '}' : ']';
  }
  return repaired;
}
// Turns a recipe's freeform structuredContent object into the generic
// { title, sections } shape the structured docx/pdf builders expect —
// walking it the same way the frontend's renderStructuredPreview() does,
// so every resource type gets real headings and bullet lists without
// each recipe needing its own bespoke exporter.
function _structuredContentToSections(content) {
  const sections = [];
  for (const key in content) {
    if (SKIP_KEYS.has(key)) continue;
    const value = content[key];
    if (value === null || typeof value === 'undefined') continue;
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
    } else if (typeof value === 'object') {
      sections.push({
        heading,
        type: 'paragraph',
        content: JSON.stringify(value),
      });
    } else if (String(value).trim()) {
      sections.push({
        heading,
        type: 'paragraph',
        content: String(value),
      });
    }
  }
  return sections;
}
export async function handleResourceGenerate(request, env) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    return _jsonError(
      'Not authenticated: ' + e.message,
      401
    );
  }
  let body;
  try {
    body = await request.json();
  } catch (e) {
    return _jsonError(
      'Invalid JSON body.',
      400
    );
  }
  const recipe = getRecipe(body.resourceType);
  if (!recipe) {
    return _jsonError(
      'Unknown resource type: ' + body.resourceType,
      400
    );
  }
  const fields = body.fields || {};
  for (const required of recipe.requiredFields) {
    if (
      !fields[required] ||
      !String(fields[required]).trim()
    ) {
      return _jsonError(
        'Missing required field: ' + required,
        400
      );
    }
  }
  let account;
  try {
    account = await resolveAccount(
      identity.uid,
      env
    );
  } catch (e) {
    console.error(
      '[resources] account resolution failed:',
      e.message
    );
    return _jsonError(
      'Could not verify your account. Please try again.',
      500
    );
  }
  const plan = getPlan(account.planId);
  // Check the requested design template's entitlement BEFORE spending the
  // person's daily quota — a rejected template request shouldn't cost
  // them a generation they never actually got. Never silently substitute
  // a different template than what was asked for.
  const templateResolution = resolveEntitledTemplate(
    account.planId,
    body.designTemplateId,
    planSatisfies
  );
  if (!templateResolution.ok) {
    return _jsonError(
      templateResolution.error,
      403
    );
  }
  const resolvedTemplate = templateResolution.template;
  const quota = await checkAndIncrement(
    identity.uid,
    'resourceGen',
    plan.limits.resourceGenPerDay,
    env
  );
  if (!quota.allowed) {
    return _jsonError(
      'You have reached your daily resource generation limit for the ' +
      plan.name +
      ' plan (' +
      quota.limit +
      ' per day).',
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
    designTemplateId: resolvedTemplate.id,
    currentVersion: 1,
    fileReferences: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  try {
    await fsSet(
      'resources/' + resourceId,
      baseDoc,
      env
    );
  } catch (e) {
    console.error(
      '[resources] initial write failed:',
      e.message
    );
    return _jsonError(
      'Could not start generation. Please try again.',
      500
    );
  }
  const messages = [
    {
      role: 'system',
      content: recipe.systemPrompt,
    },
    {
      role: 'user',
      content: recipe.buildUserPrompt(fields),
    },
  ];
  let structuredContent;
  try {
    const result = await callWithFallback(
      MODEL_TIERS.advanced,
      messages,
      env,
      {
        maxTokens: RESOURCE_MAX_TOKENS,
        jsonMode: true,
      }
    );
    structuredContent = _parseStructuredJson(result.text);
  } catch (e) {
    console.error(
      '[resources] generation call failed:',
      e.message
    );
    await _markFailed(
      resourceId,
      baseDoc,
      env
    );
    return _jsonError(
      'Could not generate the resource. Please try again.',
      503
    );
  }
  if (!structuredContent) {
    await _markFailed(
      resourceId,
      baseDoc,
      env
    );
    return _jsonError(
      'The generated content could not be understood. Please try again.',
      503
    );
  }
  // Pass the original generation fields into the recipe validator so
  // resource-specific validators can enforce requested counts, marks,
  // sections, weeks, difficulty settings, etc.
  const validation = recipe.validate(
    structuredContent,
    fields
  );
  if (!validation.ok) {
    console.error(
      '[resources] validation failed:',
      validation.error
    );
    await _markFailed(
      resourceId,
      baseDoc,
      env
    );
    return _jsonError(
      'The generated resource did not meet quality checks. Please try again.',
      503
    );
  }
  const fileReferences = await _buildAndUploadExports(
    recipe,
    structuredContent,
    baseDoc,
    resourceId,
    resolvedTemplate.id,
    env
  );
  const finalDoc = {
    ...baseDoc,
    status: 'ready',
    structuredContent,
    fileReferences,
    updatedAt: new Date().toISOString(),
  };
  try {
    await fsSet(
      'resources/' + resourceId,
      finalDoc,
      env
    );
    await fsSet(
      'resourceVersions/' + resourceId + '_1',
      {
        resourceId,
        version: 1,
        structuredContent,
        designTemplateId: resolvedTemplate.id,
        createdAt: finalDoc.updatedAt,
      },
      env
    );
  } catch (e) {
    console.error(
      '[resources] final write failed:',
      e.message
    );
    return _jsonError(
      'The resource was generated but could not be saved. Please try again.',
      500
    );
  }
  return new Response(
    JSON.stringify({
      resource: finalDoc,
    }),
    {
      status: 200,
      headers: _corsJsonHeaders(),
    }
  );
}
// Renders + uploads every export format applicable to this recipe, in the
// resolved design template. Never throws — a failed export upload is
// logged and simply omitted from fileReferences, since the structured
// resource itself is still valid and saved even if a file render/upload
// hiccups.
async function _buildAndUploadExports(
  recipe,
  structuredContent,
  baseDoc,
  resourceId,
  templateId,
  env
) {
  const fileReferences = {};
  const title = structuredContent.title || baseDoc.title;
  if (
    PPTX_TYPES.has(recipe.resourceType) &&
    Array.isArray(structuredContent.slides)
  ) {
    // PPTX — presentation-type resources only.
    try {
      const pptxBase64 = await buildSimplePptx(
        structuredContent.slides,
        title,
        templateId
      );
      const pptxBytes = _base64ToBytes(pptxBase64);
      const pptxKey =
        'generated/' +
        resourceId +
        '/exports/' +
        recipe.resourceType +
        '.pptx';
      const pptxUpload = await b2UploadFile(
        env,
        pptxKey,
        pptxBytes,
        'application/vnd.openxmlformats-officedocument.presentationml.presentation'
      );
      fileReferences.pptx = {
        key: pptxKey,
        fileId: pptxUpload.fileId,
      };
    } catch (e) {
      console.error(
        '[resources] pptx export/upload failed:',
        e.message
      );
    }
    // Presentations also get a PDF export of the same slide content, so
    // there's always a viewable/printable fallback.
    try {
      const sections = structuredContent.slides.map((s) => ({
        heading: s.heading || '',
        type: 'bullets',
        content: Array.isArray(s.bulletPoints)
          ? s.bulletPoints
          : [String(s.bulletPoints || '')],
      }));
      const pdfBase64 = await buildStructuredPdf(
        {
          title,
          sections,
        },
        title,
        templateId
      );
      const pdfBytes = _base64ToBytes(pdfBase64);
      const pdfKey =
        'generated/' +
        resourceId +
        '/exports/' +
        recipe.resourceType +
        '.pdf';
      const pdfUpload = await b2UploadFile(
        env,
        pdfKey,
        pdfBytes,
        'application/pdf'
      );
      fileReferences.pdf = {
        key: pdfKey,
        fileId: pdfUpload.fileId,
      };
    } catch (e) {
      console.error(
        '[resources] pdf export/upload failed:',
        e.message
      );
    }
    return fileReferences;
  }
  // Every other resource type: generic structured sections -> real PDF
  // and DOCX, with actual headings and bullet lists instead of a flat
  // paragraph dump.
  const sections = _structuredContentToSections(
    structuredContent
  );
  const structuredForExport = {
    title,
    sections,
  };
  try {
    const pdfBase64 = await buildStructuredPdf(
      structuredForExport,
      title,
      templateId
    );
    const pdfBytes = _base64ToBytes(pdfBase64);
    const pdfKey =
      'generated/' +
      resourceId +
      '/exports/' +
      recipe.resourceType +
      '.pdf';
    const pdfUpload = await b2UploadFile(
      env,
      pdfKey,
      pdfBytes,
      'application/pdf'
    );
    fileReferences.pdf = {
      key: pdfKey,
      fileId: pdfUpload.fileId,
    };
  } catch (e) {
    console.error(
      '[resources] pdf export/upload failed:',
      e.message
    );
  }
  try {
    const docxBase64 = await buildStructuredDocx(
      structuredForExport,
      title
    );
    const docxBytes = _base64ToBytes(docxBase64);
    const docxKey =
      'generated/' +
      resourceId +
      '/exports/' +
      recipe.resourceType +
      '.docx';
    const docxUpload = await b2UploadFile(
      env,
      docxKey,
      docxBytes,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
    fileReferences.docx = {
      key: docxKey,
      fileId: docxUpload.fileId,
    };
  } catch (e) {
    console.error(
      '[resources] docx export/upload failed:',
      e.message
    );
  }
  return fileReferences;
}
async function _markFailed(
  resourceId,
  baseDoc,
  env
) {
  try {
    await fsSet(
      'resources/' + resourceId,
      {
        ...baseDoc,
        status: 'failed',
        updatedAt: new Date().toISOString(),
      },
      env
    );
  } catch (e) {
    console.error(
      '[resources] could not mark resource as failed:',
      e.message
    );
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
export async function handleResourceDownload(
  request,
  env,
  resourceId
) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    return _jsonError(
      'Not authenticated: ' + e.message,
      401
    );
  }
  const url = new URL(request.url);
  const requestedFormat = url.searchParams.get('format');
  let doc;
  try {
    doc = await fsGet(
      'resources/' + resourceId,
      env
    );
  } catch (e) {
    console.error(
      '[resources] lookup failed:',
      e.message
    );
    return _jsonError(
      'Could not load that resource.',
      500
    );
  }
  if (!doc) {
    return _jsonError(
      'Resource not found.',
      404
    );
  }
  if (doc.ownerId !== identity.uid) {
    return _jsonError(
      'Not authorized to access this resource.',
      403
    );
  }
  const format =
    requestedFormat &&
    doc.fileReferences &&
    doc.fileReferences[requestedFormat]
      ? requestedFormat
      : Object.keys(doc.fileReferences || {})[0];
  if (!format || !doc.fileReferences[format]) {
    return _jsonError(
      'No export file is available for this resource yet.',
      404
    );
  }
  try {
    const prefix =
      'generated/' +
      resourceId +
      '/exports/';
    const authToken =
      await b2GetDownloadAuthorization(
        env,
        prefix,
        3600
      );
    const downloadUrl =
      await b2BuildPrivateDownloadUrl(
        env,
        doc.fileReferences[format].key,
        authToken
      );
    return new Response(
      JSON.stringify({
        url: downloadUrl,
        format,
        expiresInSeconds: 3600,
      }),
      {
        status: 200,
        headers: _corsJsonHeaders(),
      }
    );
  } catch (e) {
    console.error(
      '[resources] download authorization failed:',
      e.message
    );
    return _jsonError(
      'Could not prepare the download. Please try again.',
      503
    );
  }
}
/**
 * GET /api/resources/list
 * Returns the authenticated user's own resources, most recent first.
 */
export async function handleResourceList(
  request,
  env
) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    return _jsonError(
      'Not authenticated: ' + e.message,
      401
    );
  }
  try {
    const resources = await fsQuery(
      'resources',
      'ownerId',
      identity.uid,
      'createdAt',
      50,
      env
    );
    return new Response(
      JSON.stringify({
        resources,
      }),
      {
        status: 200,
        headers: _corsJsonHeaders(),
      }
    );
  } catch (e) {
    console.error(
      '[resources] list failed:',
      e.message
    );
    return _jsonError(
      'Could not load your resources. Please try again.',
      500
    );
  }
}
function _corsJsonHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  };
}
function _jsonError(message, status) {
  return new Response(
    JSON.stringify({
      error: message,
    }),
    {
      status,
      headers: _corsJsonHeaders(),
    }
  );
}
