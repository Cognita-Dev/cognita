// resources-endpoint.js

import { requireAuth, describeAuthError } from './auth-middleware.js';
import { resolveAccount } from './subscription.js';
import { checkAndIncrement, refundUsage } from './usage.js';
import { getPlan, planSatisfies, planHasFlashcardImages, MODEL_TIERS } from './entitlements.js';
import { callWithFallback } from './providers.js';
import { fsSet, fsGet, fsQuery, fsUpdate } from './firestore-rest.js';
import { buildStructuredDocx, buildSimpleDocx } from './docx-builder.js';
import { buildStructuredPdf, buildSimplePdf, buildFlashcardsPdf, buildFlashcardsPdfBytes } from './pdf-builder.js';
import { buildSimplePptx } from './pptx-builder.js';
import { b2UploadFile, b2DownloadFileBytes } from './b2-client.js';
import { getRecipe } from './recipes/index.js';
import { resolveEntitledTemplate } from './design-templates.js';
import { signDownloadToken, verifyDownloadToken } from './download-proxy.js';
import { generateIllustrationBase64, isImageSafetyError } from './image-endpoint.js';

// Highest card position that can get a picture. Pictures are made one per
// request (see handleResourceCardImage), so this is only a sanity bound —
// the per-day plan quota in entitlements.js is the real limit.
const MAX_CARD_IMAGES_PER_GENERATION = 20;

// How long the signed image links we hand the browser stay valid.
const CARD_IMAGE_URL_TTL_SECONDS = 6 * 60 * 60;

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

// ── Flashcard images ─────────────────────────────────────────────────
//
// Why images are NOT stored inside the Firestore document: a generated
// picture is ~300-500 KB once base64-encoded, and Firestore refuses any
// single document over 1 MB. A deck with a handful of images blew past
// that limit, which is why saving the finished deck failed. Instead each
// image is uploaded to Backblaze B2 and the card only stores a tiny
// reference: card.image = { type, key, fileId }. The browser then loads
// the picture through a signed link (see handleResourceImageProxy).

function _bytesToBase64(bytes) {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function _cardImageKey(resourceId, cardIndex) {
  return 'generated/' + resourceId + '/images/card-' + (cardIndex + 1) + '-' +
    Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + '.jpg';
}

// Uploads one base64 JPEG to B2 and returns the small reference to store.
async function _uploadCardImage(base64, resourceId, cardIndex, env) {
  const key = _cardImageKey(resourceId, cardIndex);
  const upload = await b2UploadFile(env, key, _base64ToBytes(base64), 'image/jpeg');
  return { type: 'image/jpeg', key, fileId: upload.fileId };
}

// Generates + uploads the image for ONE card. Tries the AI-written prompt
// first; if the safety filter rejects it (or anything else goes wrong) it
// falls back to a plain, neutral picture about the deck's topic. Returns
// the base64 on success (so the PDF export can reuse it without a second
// download) or null if the card should simply go without a picture.
async function _generateOneCardImage(card, index, deckTitle, resourceId, env) {
  const attempts = [String(card.imagePrompt || '').trim()];
  if (deckTitle) {
    attempts.push(
      'a simple, neutral educational illustration about "' + deckTitle +
      '", showing only objects, symbols or a diagram, with no people'
    );
  }

  for (const prompt of attempts) {
    if (!prompt) continue;
    try {
      const base64 = await generateIllustrationBase64(prompt, env, { classroomSafe: true });
      if (!base64) continue;
      card.image = await _uploadCardImage(base64, resourceId, index, env);
      return base64;
    } catch (e) {
      console.error(
        '[resources] card image ' + (index + 1) + ' failed' +
        (isImageSafetyError(e) ? ' (safety filter)' : '') + ': ' + e.message
      );
    }
  }
  return null;
}

// Removes every `image` field from a copy of the content (used before
// sending the deck to the AI for a revision, so we don't waste tokens on
// image references it can't use).
function _stripCardImages(content) {
  if (!content || !Array.isArray(content.cards)) return content;
  return {
    ...content,
    cards: content.cards.map((card) => {
      if (!card || typeof card !== 'object') return card;
      const { image, ...rest } = card;
      return rest;
    }),
  };
}

// After an edit or an AI revision, re-attaches each card's existing image
// (matched by its imagePrompt, or failing that its front text). Anything
// image-related that came from the browser or the AI is discarded first —
// only references already saved on the server are ever trusted.
function _restoreCardImages(newContent, oldContent) {
  if (!newContent || !Array.isArray(newContent.cards)) return;
  const byPrompt = new Map();
  const byFront = new Map();
  if (oldContent && Array.isArray(oldContent.cards)) {
    oldContent.cards.forEach((c) => {
      if (!c || !c.image) return;
      if (typeof c.imagePrompt === 'string' && c.imagePrompt.trim()) byPrompt.set(c.imagePrompt.trim(), c.image);
      if (typeof c.front === 'string' && c.front.trim()) byFront.set(c.front.trim(), c.image);
    });
  }
  newContent.cards.forEach((card) => {
    if (!card || typeof card !== 'object') return;
    delete card.image;
    const p = typeof card.imagePrompt === 'string' ? card.imagePrompt.trim() : '';
    const f = typeof card.front === 'string' ? card.front.trim() : '';
    const img = (p && byPrompt.get(p)) || (f && byFront.get(f)) || null;
    if (img) card.image = { ...img };
  });
}

// Decks saved before this fix may still carry a picture inline as base64
// (image.data). Move any of those into B2 so re-saving the deck can never
// hit Firestore's 1 MB limit. Returns a Map of cardIndex -> base64.
async function _offloadInlineCardImages(content, resourceId, env) {
  const imageData = new Map();
  if (!content || !Array.isArray(content.cards)) return imageData;
  await Promise.all(content.cards.map(async (card, index) => {
    if (!card || !card.image || !card.image.data) return;
    const base64 = card.image.data;
    try {
      card.image = await _uploadCardImage(base64, resourceId, index, env);
      imageData.set(index, base64);
    } catch (e) {
      console.error('[resources] could not move inline image to B2:', e.message);
      delete card.image; // better a card without a picture than an oversized document
    }
  }));
  return imageData;
}

// Returns a copy of the content where every card that has a B2 image
// reference also carries `image.data` (base64) — needed ONLY to draw the
// pictures into the PDF export. Never saved anywhere. Images we already
// hold in memory (`known`) are not downloaded again.
async function _hydrateCardImages(content, env, known) {
  if (!content || !Array.isArray(content.cards)) return content;
  const cards = await Promise.all(content.cards.map(async (card, index) => {
    if (!card || !card.image || !card.image.key) return card;
    let data = known && known.get(index);
    if (!data) {
      try {
        const res = await b2DownloadFileBytes(env, card.image.key);
        if (res) data = _bytesToBase64(new Uint8Array(await res.arrayBuffer()));
      } catch (e) {
        console.error('[resources] could not load card image for export:', e.message);
      }
    }
    return data ? { ...card, image: { ...card.image, data } } : card;
  }));
  return { ...content, cards };
}

// Returns a copy of the resource where each card image also has a
// short-lived signed `url` the browser can put straight into an <img>.
// The URL is created fresh on every response and is never saved.
async function _signedCardImage(image, resourceId, origin, env) {
  const token = await signDownloadToken(
    env,
    { scope: 'card-image', resourceId, key: image.key },
    CARD_IMAGE_URL_TTL_SECONDS
  );
  return {
    ...image,
    url: origin + '/api/resources/' + resourceId + '/image?token=' + encodeURIComponent(token),
  };
}

async function _withSignedImageUrls(doc, request, env) {
  const sc = doc && doc.structuredContent;
  if (!sc || !Array.isArray(sc.cards)) return doc;
  if (!sc.cards.some((c) => c && c.image && c.image.key)) return doc;

  const origin = new URL(request.url).origin;
  const cards = await Promise.all(sc.cards.map(async (card) => {
    if (!card || !card.image || !card.image.key) return card;
    return { ...card, image: await _signedCardImage(card.image, doc.id, origin, env) };
  }));
  return { ...doc, structuredContent: { ...sc, cards } };
}

async function _signedResourceResponse(resource, request, env) {
  let out = resource;
  try {
    out = await _withSignedImageUrls(resource, request, env);
  } catch (e) {
    console.error('[resources] could not sign image links:', e.message);
  }
  return new Response(JSON.stringify({ resource: out }), {
    status: 200,
    headers: _corsJsonHeaders(env),
  });
}

export async function handleResourceGenerate(request, env) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    const _authErr = describeAuthError(e);
    return _jsonError(_authErr.message, _authErr.status, env);
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
  // The form's "number of questions" box is sent as `questionCount`, but the
  // flashcards recipe reads `cardCount`. Without this bridge the requested
  // number was ignored and the default (15) was used instead.
  if (recipe.resourceType === 'flashcards' && !fields.cardCount && fields.questionCount) {
    fields.cardCount = fields.questionCount;
  }
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
  // Pictures are NOT made here. Making them inside this request would use
  // far more processing time and outgoing calls than a Cloudflare free-plan
  // Worker is allowed. Instead the deck is saved right away (text only) and
  // the app then asks for one picture per card, one small request at a time
  // (see handleResourceCardImage).

  const fileReferences = await _buildAndUploadExports(recipe, structuredContent, baseDoc, resourceId, resolvedTemplate.id, env);
  const finalDoc = {
    ...baseDoc,
    status: 'ready',
    // Types like scheme_of_work don't collect a "topic" field, so
    // baseDoc.title falls back to 'Untitled' at creation time. Once the
    // AI has actually generated content, prefer its own title (e.g.
    // "First Term — Living Things...") over that placeholder.
    title: (structuredContent.title && structuredContent.title.trim()) || baseDoc.title,
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
  return _signedResourceResponse(finalDoc, request, env);
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
    const _authErr = describeAuthError(e);
    return _jsonError(_authErr.message, _authErr.status, env);
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

  // Card pictures are looked up from what the server already has saved,
  // never taken from the browser.
  _restoreCardImages(body.structuredContent, doc.structuredContent);
  const inlineImages = await _offloadInlineCardImages(body.structuredContent, resourceId, env);

  const now = new Date().toISOString();
  const nextVersion = (doc.currentVersion || 1) + 1;

  const fileReferences = await _buildAndUploadExports(
    recipe, body.structuredContent, doc, resourceId, doc.designTemplateId, env, inlineImages
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

  return _signedResourceResponse(updated, request, env);
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
    const _authErr = describeAuthError(e);
    return _jsonError(_authErr.message, _authErr.status, env);
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
    JSON.stringify(_stripCardImages(doc.structuredContent)) +
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

  _restoreCardImages(revisedContent, doc.structuredContent);
  const inlineImages = await _offloadInlineCardImages(revisedContent, resourceId, env);

  const now = new Date().toISOString();
  const nextVersion = (doc.currentVersion || 1) + 1;

  const fileReferences = await _buildAndUploadExports(
    recipe, revisedContent, doc, resourceId, doc.designTemplateId, env, inlineImages
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

  return _signedResourceResponse(updated, request, env);
}

async function _buildAndUploadExports(recipe, structuredContent, baseDoc, resourceId, templateId, env, knownImages) {
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
  // Flashcards get their own PDF layout (one block per card, with a real
  // illustration when the card has one — see resources-endpoint.js's
  // _attachCardImages) instead of falling through to the generic
  // plain-text export below, which would flatten each card to a single
  // line and drop any image entirely. docx export still uses the plain
  // text formatter for now — the .docx builder here doesn't support
  // embedded images yet — so a card's illustration only appears in the
  // PDF, not the Word export.
  if (recipe.resourceType === 'flashcards' && Array.isArray(structuredContent.cards)) {
    try {
      // The PDF needs the actual picture bytes; the saved deck only holds
      // B2 references, so pull them in for this one build.
      // Putting pictures into the PDF is expensive (lots of processing), so
      // it is off by default to stay inside the Workers free plan. Set the
      // variable PDF_INCLUDE_CARD_IMAGES to "true" on a paid plan to turn
      // it back on.
      const pdfContent = env.PDF_INCLUDE_CARD_IMAGES === 'true'
        ? await _hydrateCardImages(structuredContent, env, knownImages)
        : _stripCardImages(structuredContent);
      const pdfBytes = await buildFlashcardsPdfBytes(pdfContent, title, templateId);
      const pdfKey = 'generated/' + resourceId + '/exports/' + recipe.resourceType + '.pdf';
      const pdfUpload = await b2UploadFile(env, pdfKey, pdfBytes, 'application/pdf');
      fileReferences.pdf = { key: pdfKey, fileId: pdfUpload.fileId };
    } catch (e) {
      console.error('[resources] flashcards pdf export/upload failed:', e.message);
    }
    if (typeof recipe.toPlainTextParagraphs === 'function') {
      try {
        const plainText = recipe.toPlainTextParagraphs(structuredContent);
        const docxBase64 = await buildSimpleDocx(plainText, title, templateId);
        const docxBytes = _base64ToBytes(docxBase64);
        const docxKey = 'generated/' + resourceId + '/exports/' + recipe.resourceType + '.docx';
        const docxUpload = await b2UploadFile(
          env, docxKey, docxBytes,
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        );
        fileReferences.docx = { key: docxKey, fileId: docxUpload.fileId };
      } catch (e) {
        console.error('[resources] flashcards docx export/upload failed:', e.message);
      }
    }
    return fileReferences;
  }

  if (typeof recipe.toPlainTextParagraphs === 'function') {
    const plainText = recipe.toPlainTextParagraphs(structuredContent);
    try {
      const pdfBase64 = await buildSimplePdf(plainText, title, templateId);
      const pdfBytes = _base64ToBytes(pdfBase64);
      const pdfKey = 'generated/' + resourceId + '/exports/' + recipe.resourceType + '.pdf';
      const pdfUpload = await b2UploadFile(env, pdfKey, pdfBytes, 'application/pdf');
      fileReferences.pdf = { key: pdfKey, fileId: pdfUpload.fileId };
    } catch (e) {
      console.error('[resources] pdf export/upload failed:', e.message);
    }
    try {
      const docxBase64 = await buildSimpleDocx(plainText, title, templateId);
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

  // Fallback for any recipe that doesn't (yet) provide its own
  // toPlainTextParagraphs formatter — generic key-flattening so export
  // still produces something rather than nothing.
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
    const docxBase64 = await buildStructuredDocx(structuredForExport, title, templateId);
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
    const _authErr = describeAuthError(e);
    return _jsonError(_authErr.message, _authErr.status, env);
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
    // Route the browser through our own /file proxy (see
    // handleResourceFileProxy below) instead of handing back Backblaze's
    // own download URL, so the address bar shows our domain, not B2's.
    const token = await signDownloadToken(env, { scope: 'resource', resourceId, format }, 3600);
    const origin = new URL(request.url).origin;
    const filename = _downloadFilename(doc, format);
    const downloadUrl = origin + '/api/resources/' + resourceId + '/file' +
      '?token=' + encodeURIComponent(token) +
      '&filename=' + encodeURIComponent(filename);
    return new Response(JSON.stringify({ url: downloadUrl, format, expiresInSeconds: 3600 }), {
      status: 200,
      headers: _corsJsonHeaders(env),
    });
  } catch (e) {
    console.error('[resources] download authorization failed:', e.message);
    return _jsonError('Could not prepare the download. Please try again.', 503, env);
  }
}

// GET /api/resources/:id/file?token=...&filename=...
// The actual byte-streaming route the browser lands on when it follows the
// URL handed back by handleResourceDownload above. Auth here is the signed
// token (a plain <a href> navigation can't carry an Authorization header),
// which is re-checked against the real resource before anything is served.
export async function handleResourceFileProxy(request, env, resourceId) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');

  let payload;
  try {
    payload = await verifyDownloadToken(env, token);
  } catch (e) {
    return _jsonError('This download link is invalid or has expired. Please download again.', 401, env);
  }

  if (payload.scope !== 'resource' || payload.resourceId !== resourceId) {
    return _jsonError('This download link is invalid.', 401, env);
  }

  let doc;
  try {
    doc = await fsGet('resources/' + resourceId, env);
  } catch (e) {
    console.error('[resources] file proxy lookup failed:', e.message);
    return _jsonError('Could not load that resource.', 500, env);
  }
  if (!doc) {
    return _jsonError('Resource not found.', 404, env);
  }

  const format = payload.format;
  const ref = doc.fileReferences && doc.fileReferences[format];
  if (!ref) {
    return _jsonError('No export file is available for this resource yet.', 404, env);
  }

  try {
    const upstream = await b2DownloadFileBytes(env, ref.key);
    if (!upstream) {
      return _jsonError('That file could not be found. Please try downloading again.', 404, env);
    }

    const requestedFilename = url.searchParams.get('filename');
    const filename = requestedFilename || _downloadFilename(doc, format);

    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': _mimeTypeForFormat(format),
        'Content-Disposition': 'attachment; filename="' + filename.replace(/"/g, '') + '"',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': env.APP_ORIGIN || '*',
      },
    });
  } catch (e) {
    console.error('[resources] file proxy fetch failed:', e.message);
    return _jsonError('Could not prepare the download. Please try again.', 503, env);
  }
}

// POST /api/resources/:id/cards/:index/image
// Makes the picture for ONE flashcard. The app calls this once per card,
// one after another, right after a deck is generated. Keeping each request
// small (one picture) is what lets image decks work on the Cloudflare free
// plan: each request stays well inside its processing-time and
// outgoing-call limits, no matter how many cards the deck has.
//
// Everything is decided here on the server: ownership, the plan's image
// entitlement and the daily quota. The browser only says "card number N".
export async function handleResourceCardImage(request, env, resourceId, indexText) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    const _authErr = describeAuthError(e);
    return _jsonError(_authErr.message, _authErr.status, env);
  }

  const index = Number(indexText);
  if (!Number.isInteger(index) || index < 0 || index >= MAX_CARD_IMAGES_PER_GENERATION) {
    return _jsonError('Invalid card number.', 400, env);
  }

  let doc;
  try {
    doc = await fsGet('resources/' + resourceId, env);
  } catch (e) {
    console.error('[resources] card image lookup failed:', e.message);
    return _jsonError('Could not load that resource.', 500, env);
  }
  if (!doc) return _jsonError('Resource not found.', 404, env);
  if (doc.ownerId !== identity.uid) {
    return _jsonError('Not authorized to modify this resource.', 403, env);
  }

  const recipe = getRecipe(doc.resourceType);
  if (!recipe || !recipe.supportsCardImages) {
    return _jsonError('This resource type does not support card images.', 400, env);
  }

  const cards = doc.structuredContent && doc.structuredContent.cards;
  const card = Array.isArray(cards) ? cards[index] : null;
  if (!card) return _jsonError('Card not found.', 404, env);

  const origin = new URL(request.url).origin;

  // Already has a picture — just hand back a fresh link (safe to retry).
  if (card.image && card.image.key) {
    const image = await _signedCardImage(card.image, resourceId, origin, env);
    return new Response(JSON.stringify({ index, image }), { status: 200, headers: _corsJsonHeaders(env) });
  }

  const imagePrompt = typeof card.imagePrompt === 'string' ? card.imagePrompt.trim() : '';
  if (!imagePrompt) return _jsonError('This card has no image description.', 400, env);

  let account;
  try {
    account = await resolveAccount(identity.uid, env);
  } catch (e) {
    console.error('[resources] account resolution failed:', e.message);
    return _jsonError('Could not verify your account. Please try again.', 500, env);
  }
  const plan = getPlan(account.planId);
  if (!planHasFlashcardImages(plan.id)) {
    return _jsonError('Flashcard images are available on paid plans.', 403, env);
  }

  const quota = await checkAndIncrement(identity.uid, 'flashcardImage', plan.limits.flashcardImagePerDay, env);
  if (!quota.allowed) {
    return _jsonError('Daily image limit reached for the ' + plan.name + ' plan.', 429, env);
  }

  const scratch = { imagePrompt };
  const deckTitle = String((doc.structuredContent && doc.structuredContent.title) || '').trim();
  await _generateOneCardImage(scratch, index, deckTitle, resourceId, env);

  if (!scratch.image) {
    try { await refundUsage(identity.uid, 'flashcardImage', env); } catch (e) {}
    return new Response(JSON.stringify({ index, image: null, failed: true }), {
      status: 200,
      headers: _corsJsonHeaders(env),
    });
  }

  // Re-read right before saving, so an edit made while the picture was
  // being drawn is not overwritten with an older copy of the deck.
  try {
    const fresh = await fsGet('resources/' + resourceId, env);
    const freshCards = fresh && fresh.structuredContent && fresh.structuredContent.cards;
    if (!Array.isArray(freshCards) || !freshCards[index] || freshCards[index].front !== card.front) {
      return new Response(JSON.stringify({ index, image: null, failed: true }), {
        status: 200,
        headers: _corsJsonHeaders(env),
      });
    }
    freshCards[index].image = scratch.image;
    await fsUpdate('resources/' + resourceId, {
      structuredContent: fresh.structuredContent,
      updatedAt: new Date().toISOString(),
    }, env);
  } catch (e) {
    console.error('[resources] card image save failed:', e.message);
    return _jsonError('The picture was made but could not be saved. Please try again.', 500, env);
  }

  const image = await _signedCardImage(scratch.image, resourceId, origin, env);
  return new Response(JSON.stringify({ index, image }), { status: 200, headers: _corsJsonHeaders(env) });
}

// GET /api/resources/:id/image?token=...
// Streams one flashcard picture from B2. Like the file proxy above, auth
// is the signed token (an <img> tag can't send an Authorization header).
// The token is only ever issued to the resource's owner, is tied to one
// exact image, and expires — so no database lookup is needed here.
export async function handleResourceImageProxy(request, env, resourceId) {
  const token = new URL(request.url).searchParams.get('token');

  let payload;
  try {
    payload = await verifyDownloadToken(env, token);
  } catch (e) {
    return _jsonError('This image link is invalid or has expired.', 401, env);
  }

  const expectedPrefix = 'generated/' + resourceId + '/images/';
  if (
    payload.scope !== 'card-image' ||
    payload.resourceId !== resourceId ||
    typeof payload.key !== 'string' ||
    !payload.key.startsWith(expectedPrefix)
  ) {
    return _jsonError('This image link is invalid.', 401, env);
  }

  try {
    const upstream = await b2DownloadFileBytes(env, payload.key);
    if (!upstream) return _jsonError('Image not found.', 404, env);
    return new Response(upstream.body, {
      status: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'private, max-age=3600',
        'Access-Control-Allow-Origin': env.APP_ORIGIN || '*',
      },
    });
  } catch (e) {
    console.error('[resources] image proxy fetch failed:', e.message);
    return _jsonError('Could not load that image.', 503, env);
  }
}

function _downloadFilename(doc, format) {
  const base = (doc.structuredContent && doc.structuredContent.title) || doc.title || 'resource';
  const clean = base.replace(/[^a-z0-9]+/gi, '_').toLowerCase().replace(/^_+|_+$/g, '');
  return (clean || 'resource') + '.' + format;
}

function _mimeTypeForFormat(format) {
  if (format === 'pdf') return 'application/pdf';
  if (format === 'pptx') return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
}

export async function handleResourceList(request, env) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    const _authErr = describeAuthError(e);
    return _jsonError(_authErr.message, _authErr.status, env);
  }
  try {
    const raw = await fsQuery('resources', 'ownerId', identity.uid, 'createdAt', 50, env);
    const resources = await Promise.all(raw.map(async (r) => {
      try { return await _withSignedImageUrls(r, request, env); } catch (e) { return r; }
    }));
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
