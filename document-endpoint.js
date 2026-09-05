// document-endpoint.js
// POST /api/document
// Frontend sends { topic, docType: 'letter'|'report'|'essay'|'memo' }.
// The Worker generates the content AND builds the .docx file server-side,
// then returns it as a base64 payload for the browser to download.
// This endpoint is plan-gated: Free users get plain text only, no .docx export.

import { requireAuth } from './auth-middleware.js';
import { resolveAccount, assertPlan } from './subscription.js';
import { checkAndIncrement } from './usage.js';
import { getPlan, MODEL_TIERS } from './entitlements.js';
import { callWithFallback } from './providers.js';
import { buildSimpleDocx } from './docx-builder.js';

const DOC_SYSTEM_PROMPT =
  'You write polished, professional documents. Write ONLY the document ' +
  'content itself — no preamble like "Here is your document," no meta ' +
  'commentary, no markdown formatting symbols. Use plain paragraphs ' +
  'separated by blank lines, and use a single blank line before section ' +
  'headings written in plain text (no # symbols).';

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

  // Generate the content.
  const messages = [
    { role: 'system', content: DOC_SYSTEM_PROMPT },
    { role: 'user', content: 'Write a ' + docType + ' about: ' + topic },
  ];

  let content;
  try {
    const result = await callWithFallback(MODEL_TIERS.advanced, messages, env);
    content = result.text;
  } catch (e) {
    console.error('[document] generation failed:', e.message);
    return _jsonError('Could not generate the document. Please try again.', 503);
  }

  // Free plan: return plain text only, no file export.
  if (!plan.features.documentExport) {
    return new Response(JSON.stringify({ format: 'text', content }), {
      status: 200,
      headers: _corsJsonHeaders(),
    });
  }

  // Paid plans: build an actual .docx file server-side.
  try {
    const docxBase64 = await buildSimpleDocx(content, _titleFor(docType, topic));
    return new Response(JSON.stringify({
      format: 'docx',
      filename: _titleFor(docType, topic).replace(/[^a-z0-9]+/gi, '_').toLowerCase() + '.docx',
      content: docxBase64,
    }), {
      status: 200,
      headers: _corsJsonHeaders(),
    });
  } catch (e) {
    console.error('[document] docx build failed:', e.message);
    // Fall back to plain text rather than failing outright — the user still
    // gets their content even if the file wrapper fails.
    return new Response(JSON.stringify({ format: 'text', content }), {
      status: 200,
      headers: _corsJsonHeaders(),
    });
  }
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
