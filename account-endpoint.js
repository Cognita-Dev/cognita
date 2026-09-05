// account-endpoint.js
// GET /api/account  -> plan name, status, renewal date
// GET /api/usage    -> today's usage counters vs. limits
// Both endpoints derive everything from the verified uid. The frontend
// never sends or receives a raw planId string it could tamper with in a
// way that matters — these are read-only, informational responses used
// purely to render UI (e.g. "12 messages left today").

import { requireAuth } from './auth-middleware.js';
import { resolveAccount } from './subscription.js';
import { getUsageBatch } from './usage.js';
import { getPlan } from './entitlements.js';

export async function handleAccountRequest(request, env) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    return _jsonError('Not authenticated: ' + e.message, 401);
  }

  let account;
  try {
    account = await resolveAccount(identity.uid, env);
  } catch (e) {
    console.error('[account] resolution failed:', e.message);
    return _jsonError('Could not load your account. Please try again.', 500);
  }

  const plan = getPlan(account.planId);

  return new Response(JSON.stringify({
    planId: account.planId,
    planName: plan.name,
    status: account.status,
    periodEnd: account.periodEnd,
    email: identity.email,
  }), {
    status: 200,
    headers: _corsJsonHeaders(),
  });
}

export async function handleUsageRequest(request, env) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    return _jsonError('Not authenticated: ' + e.message, 401);
  }

  let account;
  try {
    account = await resolveAccount(identity.uid, env);
  } catch (e) {
    console.error('[usage] account resolution failed:', e.message);
    return _jsonError('Could not load your usage. Please try again.', 500);
  }

  const plan = getPlan(account.planId);

  const used = await getUsageBatch(identity.uid, [
    'messages',
    'advancedModel',
    'imageGen',
    'documentGen',
  ], env);

  return new Response(JSON.stringify({
    planName: plan.name,
    usage: {
      messages: { used: used.messages, limit: plan.limits.messagesPerDay },
      advancedModel: { used: used.advancedModel, limit: plan.limits.advancedModelPerDay },
      imageGen: { used: used.imageGen, limit: plan.limits.imageGenPerDay },
      documentGen: { used: used.documentGen, limit: plan.limits.documentGenPerDay },
    },
  }), {
    status: 200,
    headers: _corsJsonHeaders(),
  });
}

function _corsJsonHeaders() {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
}

function _jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: _corsJsonHeaders() });
}
