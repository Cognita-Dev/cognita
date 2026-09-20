// document-endpoint.js

import { requireAuth, describeAuthError } from './auth-middleware.js';
import { resolveAccount, assertPlan } from './subscription.js';
import { checkAndIncrement } from './usage.js';
import { getPlan, MODEL_TIERS } from './entitlements.js';
import { callWithFallback } from './providers.js';
import { buildStructuredDocx } from './docx-builder.js';
import { buildStructuredPdf } from './pdf-builder.js';
import { buildSimplePptx } from './pptx-builder.js';
import { saveGeneratedFileToB2 } from './chat-storage.js';

const DOC_FORMATS = ['docx', 'pdf', 'pptx'];
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
    const _authErr = describeAuthError(e);
    return _jsonError(_authErr.message, _authErr.status, env);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return _jsonError('Invalid JSON body.', 400, env);
  }

  const topic = (body.topic || '').trim();
  const docType = ['letter', 'report', 'essay', 'memo'].includes(body.docType) ? body.docType : 'report';
  const format = DOC_FORMATS.includes(body.format) ? body.format : 'docx';
  const conversationId = typeof body.conversationId === 'string' ? body.conversationId.trim() : '';
  if (!topic) return _jsonError('Missing topic.', 400, env);
  if (topic.length > 800) return _jsonError('Topic description is too long (max 800 characters).', 400, env);

  let account;
  try {
    account = await resolveAccount(identity.uid, env);
  } catch (e) {
    console.error('[document] account resolution failed:', e.message);
    return _jsonError('Could not verify your account. Please try again.', 500, env);
  }

  const plan = getPlan(account.planId);

  const quota = await checkAndIncrement(identity.uid, 'documentGen', plan.limits.documentGenPerDay, env);
  if (!quota.allowed) {
    return _jsonError(
      'You have reached your daily document generation limit for the ' + plan.name + ' plan (' + quota.limit + ' per day).',
      429, env
    );
  }

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
    return _jsonError('Could not generate the document. Please try again.', 503, env);
  }

  const title = structured.title || _titleFor(docType, topic);

  if (!plan.features.documentExport) {
    return new Response(JSON.stringify({ format: 'text', content: _flattenToPlainText(structured) }), {
      status: 200,
      headers: _corsJsonHeaders(env),
    });
  }

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

    const filename = filenameBase + '.' + extension;
    const mimeType = _mimeTypeFor(extension);

    let fileId;
    if (conversationId) {
      try {
        const saved = await saveGeneratedFileToB2(env, identity.uid, conversationId, filename, mimeType, fileBase64);
        fileId = saved.fileId;
      } catch (e) {
        console.error('[document] could not persist generated file to storage:', e.message);
      }
    }

    return new Response(JSON.stringify({
      format,
      filename,
      content: fileBase64,
      fileId: fileId || undefined,
      conversationId: fileId ? conversationId : undefined,
      degraded: generationDegraded || undefined,
    }), {
      status: 200,
      headers: _corsJsonHeaders(env),
    });
  } catch (e) {
    console.error('[document] file build failed:', e.message);
    return new Response(JSON.stringify({ format: 'text', content: _flattenToPlainText(structured) }), {
      status: 200,
      headers: _corsJsonHeaders(env),
    });
  }
}

function _mimeTypeFor(extension) {
  if (extension === 'pdf') return 'application/pdf';
  if (extension === 'pptx') return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
}

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

function _tryParseJsonWithRepair(text) {
  try {
    return JSON.parse(text);
  } catch (e) {}

  const repaired = _repairTruncatedJson(text);
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

function _corsJsonHeaders(env) {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': env?.APP_ORIGIN || '*' };
}

function _jsonError(message, status, env) {
  return new Response(JSON.stringify({ error: message }), { status, headers: _corsJsonHeaders(env) });
}
