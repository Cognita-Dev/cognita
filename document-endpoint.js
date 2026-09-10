// document-endpoint.js
// POST /api/document
// Frontend sends { topic, docType: 'letter'|'report'|'essay'|'memo', format: 'docx'|'pdf'|'pptx' }.
// The Worker asks the model for a structured JSON representation of the
// document (title + sections, each either a paragraph or a bullet list),
// then builds the actual file server-side from that structure.
// This endpoint is plan-gated: Free users get plain text only, no file export.

import { requireAuth } from './auth-middleware.js';
import { resolveAccount, assertPlan } from './subscription.js';
import { checkAndIncrement } from './usage.js';
import { getPlan, MODEL_TIERS } from './entitlements.js';
import { callWithFallback } from './providers.js';
import { buildStructuredDocx } from './docx-builder.js';
import { buildStructuredPdf } from './pdf-builder.js';
import { buildSimplePptx } from './pptx-builder.js';

const DOC_FORMATS = ['docx', 'pdf', 'pptx'];

// Long structured documents (a full report with several sections, each
// with headings and bullet lists) routinely need more than the app-wide
// chat default of 2048 tokens. Too low a budget here is what was causing
// generations to cut off mid-JSON, which then failed to parse and fell
// back to dumping the raw, broken JSON text as the document's content.
const DOCUMENT_MAX_TOKENS = 6000;

const DOC_SYSTEM_PROMPT =
  'You write polished, professional documents and return them as STRICT JSON ' +
  'only — no markdown fences, no commentary before or after the JSON. ' +
  'Match this exact shape:\n' +
  '{"title": "string", "sections": [{"heading": "string or empty string", ' +
  '"type": "paragraph" or "bullets", "content": "string" (for paragraph) ' +
  'or ["string", ...] (for bullets)}]}\n' +
  'Use "bullets" sections wherever a list is more readable than prose ' +
  '(action items, key points, steps). A letter should still use "heading": "" ' +
  'sections for its salutation/body/closing rather than one giant paragraph. ' +
  'Every paragraph should be plain text with no markdown symbols (no #, no **, no -). ' +
  'Keep the document focused and complete — do not pad it with filler, since ' +
  'you have a limited output budget and an unfinished document is not usable.';

export async function handleDocumentRequest(request, env) {
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

  const topic = (body.topic || '').trim();
  const docType = ['letter', 'report', 'essay', 'memo'].includes(body.docType) ? body.docType : 'report';
  const format = DOC_FORMATS.includes(body.format) ? body.format : 'docx';
  if (!topic) return _jsonError('Missing topic.', 400);
  if (topic.length > 800) return _jsonError('Topic description is too long (max 800 characters).', 400);

  let account;
  try {
    account = await resolveAccount(identity.uid, env);
  } catch (e) {
    console.error('[document] account resolution failed:', e.message);
    return _jsonError('Could not verify your account. Please try again.', 500);
  }

  const plan = getPlan(account.planId);

  const quota = await checkAndIncrement(identity.uid, 'documentGen', plan.limits.documentGenPerDay, env);
  if (!quota.allowed) {
    return _jsonError(
      'You have reached your daily document generation limit for the ' + plan.name + ' plan (' + quota.limit + ' per day).',
      429
    );
  }

  // Generate the structured content.
  const messages = [
    { role: 'system', content: DOC_SYSTEM_PROMPT },
    { role: 'user', content: 'Write a ' + docType + ' about: ' + topic },
  ];

  let structured;
  let generationDegraded = false;
  try {
    const result = await callWithFallback(MODEL_TIERS.advanced, messages, env, {
      maxTokens: DOCUMENT_MAX_TOKENS,
      jsonMode: true,
    });
    const parsed = _parseStructuredDocument(result.text, topic);
    structured = parsed.structured;
    generationDegraded = parsed.degraded;
  } catch (e) {
    console.error('[document] generation failed:', e.message);
    return _jsonError('Could not generate the document. Please try again.', 503);
  }

  const title = structured.title || _titleFor(docType, topic);

  // Free plan: return plain text only, no file export.
  if (!plan.features.documentExport) {
    return new Response(JSON.stringify({ format: 'text', content: _flattenToPlainText(structured) }), {
      status: 200,
      headers: _corsJsonHeaders(),
    });
  }

  // Paid plans: build the actual file server-side, in the requested format.
  try {
    const filenameBase = title.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
    let fileBase64;
    let extension;

    if (format === 'pdf') {
      fileBase64 = await buildStructuredPdf(structured, title);
      extension = 'pdf';
    } else if (format === 'pptx') {
      fileBase64 = await buildSimplePptx(_structuredToSlides(structured, title), title);
      extension = 'pptx';
    } else {
      fileBase64 = await buildStructuredDocx(structured, title);
      extension = 'docx';
    }

    return new Response(JSON.stringify({
      format,
      filename: filenameBase + '.' + extension,
      content: fileBase64,
      degraded: generationDegraded || undefined,
    }), {
      status: 200,
      headers: _corsJsonHeaders(),
    });
  } catch (e) {
    console.error('[document] file build failed:', e.message);
    // Fall back to plain text rather than failing outright — the user still
    // gets their content even if the file wrapper fails.
    return new Response(JSON.stringify({ format: 'text', content: _flattenToPlainText(structured) }), {
      status: 200,
      headers: _corsJsonHeaders(),
    });
  }
}

// Parses the model's JSON response into { structured: { title, sections }, degraded }.
// Tries, in order:
//   1. Parse as-is.
//   2. Strip code fences / leading-trailing junk, parse again.
//   3. Attempt a structural repair (close an unterminated string, close
//      any open braces/brackets, drop a dangling trailing comma) and parse.
//   4. Only if all of that fails, degrade to a single plain-text paragraph
//      section — and flag `degraded: true` so the caller can tell this
//      happened, instead of silently shipping a broken document.
function _parseStructuredDocument(rawText, topic) {
  const cleaned = String(rawText || '').trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/, '')
    .replace(/```\s*$/, '');

  const parsed = _tryParseJsonWithRepair(cleaned);
  if (parsed && Array.isArray(parsed.sections)) {
    const sections = parsed.sections.map((s) => {
      const type = s.type === 'bullets' ? 'bullets' : 'paragraph';
      return {
        heading: typeof s.heading === 'string' ? s.heading : '',
        type,
        content: type === 'bullets'
          ? (Array.isArray(s.content) ? s.content.map(String) : [String(s.content || '')])
          : String(s.content || ''),
      };
    });
    return { structured: { title: typeof parsed.title === 'string' ? parsed.title : '', sections }, degraded: false };
  }

  // Last-resort fallback: treat the raw response as plain text paragraphs.
  // (This still triggers if the model returned genuinely non-JSON prose
  // instead of ignoring the system prompt's JSON instruction outright.)
  const paragraphs = String(rawText || '').split(/\n\s*\n/).map((p) => p.replace(/\n/g, ' ').trim()).filter(Boolean);
  return {
    structured: {
      title: '',
      sections: paragraphs.length
        ? paragraphs.map((p) => ({ heading: '', type: 'paragraph', content: p }))
        : [{ heading: '', type: 'paragraph', content: 'Could not generate content for: ' + topic }],
    },
    degraded: true,
  };
}

// Attempts JSON.parse; on failure, attempts a structural repair of
// truncated JSON (the common case: the model's output got cut off by the
// token budget mid-string or mid-object) and retries once.
function _tryParseJsonWithRepair(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    // fall through to repair attempt
  }

  const repaired = _repairTruncatedJson(text);
  if (repaired === null) return null;

  try {
    return JSON.parse(repaired);
  } catch (e) {
    return null;
  }
}

// Walks the text tracking string/escape state and open-bracket depth.
// If the text ends mid-string, closes the string. Strips a dangling
// trailing comma. Then closes any still-open braces/brackets in the
// correct (reverse) order. This recovers the common truncation shape —
// a complete-enough JSON document cut off partway through its last
// value — without attempting anything more elaborate.
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

  if (stack.length === 0 && !inString) return null; // nothing to repair — parse just failed for another reason

  let repaired = text;
  if (inString) repaired += '"';
  repaired = repaired.replace(/,\s*$/, '');

  for (let i = stack.length - 1; i >= 0; i--) {
    repaired += stack[i] === '{' ? '}' : ']';
  }
  return repaired;
}

function _flattenToPlainText(structured) {
  const parts = [];
  structured.sections.forEach((s) => {
    if (s.heading) parts.push(s.heading);
    if (s.type === 'bullets') {
      parts.push(s.content.map((item) => '- ' + item).join('\n'));
    } else {
      parts.push(s.content);
    }
  });
  return parts.join('\n\n');
}

// Converts the structured doc/report/letter/memo shape into slides for
// pptx export: a title slide, then one slide per section (bullets used
// as-is; a paragraph section becomes a single-bullet slide so it still
// reads reasonably on a slide rather than as a dense paragraph).
function _structuredToSlides(structured, title) {
  const slides = [{ heading: title, bulletPoints: [] }];
  structured.sections.forEach((s) => {
    slides.push({
      heading: s.heading || title,
      bulletPoints: s.type === 'bullets' ? s.content : [s.content],
    });
  });
  return slides;
}

function _titleFor(docType, topic) {
  const words = topic.split(/\s+/).slice(0, 8).join(' ');
  return docType.charAt(0).toUpperCase() + docType.slice(1) + ' - ' + words;
}

function _corsJsonHeaders() {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
}

function _jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: _corsJsonHeaders() });
}
