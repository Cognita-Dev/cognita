// account-endpoint.js
// GET /api/account  -> plan name, status, renewal date, entitlement flags
// GET /api/usage    -> today's usage counters vs. limits
// Both endpoints derive everything from the verified uid. The frontend
// never sends or receives a raw planId string it could tamper with in a
// way that matters — these are read-only, informational responses used
// purely to render UI (e.g. "12 messages left today").
import { requireAuth } from './auth-middleware.js';
import { resolveAccountWithRole } from './subscription.js';
import { getUsageBatch } from './usage.js';
import { getPlan } from './entitlements.js';

export async function handleAccountRequest(request, env) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    return _jsonError('Not authenticated: ' + e.message, 401, env);
  }
  let account;
  try {
    // resolveAccountWithRole (not resolveAccount) so a verified
    // admins/{uid} role: 'admin' doc surfaces the unlimited, v0-enabled
    // 'admin' plan here too — this is what lets the frontend unlock the
    // v0 quality option and drop the usage bars for admins specifically
    // (never moderators, never plain users).
    account = await resolveAccountWithRole(identity.uid, env);
  } catch (e) {
    console.error('[account] resolution failed:', e.message);
    return _jsonError('Could not load your account. Please try again.', 500, env);
  }
  const plan = getPlan(account.planId);
  return new Response(JSON.stringify({
    planId: account.planId,
    planName: plan.name,
    status: account.status,
    periodEnd: account.periodEnd,
    email: identity.email,
    // 'admin' | 'moderator' | null — lets the frontend show curation
    // nav / an "Admin" badge without a separate round trip. Never used
    // by itself to grant access; every actual permission check happens
    // server-side against the verified uid on the relevant endpoint.
    role: account.role || null,
    // The frontend needs these to know exactly which features/tiers to
    // unlock in the UI (image understanding, quality levels, document
    // export, design templates) — without them, gating either locks
    // everyone out or silently lets everyone in.
    models: {
      vision: plan.models.vision,
      chat: plan.models.chat,
    },
    features: {
      documentExport: plan.features.documentExport,
      designTemplates: plan.features.designTemplates,
    },
  }), {
    status: 200,
    headers: _corsJsonHeaders(env),
  });
}

export async function handleUsageRequest(request, env) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    return _jsonError('Not authenticated: ' + e.message, 401, env);
  }
  let account;
  try {
    account = await resolveAccountWithRole(identity.uid, env);
  } catch (e) {
    console.error('[usage] account resolution failed:', e.message);
    return _jsonError('Could not load your usage. Please try again.', 500, env);
  }
  const plan = getPlan(account.planId);
  const used = await getUsageBatch(identity.uid, [
    'messages',
    'advancedModel',
    'imageGen',
    'documentGen',
    'resourceGen',
  ], env);
  return new Response(JSON.stringify({
    planName: plan.name,
    role: account.role || null,
    usage: {
      messages: { used: used.messages, limit: plan.limits.messagesPerDay },
      advancedModel: { used: used.advancedModel, limit: plan.limits.advancedModelPerDay },
      imageGen: { used: used.imageGen, limit: plan.limits.imageGenPerDay },
      documentGen: { used: used.documentGen, limit: plan.limits.documentGenPerDay },
      resourceGen: { used: used.resourceGen, limit: plan.limits.resourceGenPerDay },
    },
  }), {
    status: 200,
    headers: _corsJsonHeaders(env),
  });
}

function _corsJsonHeaders(env) {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': env?.APP_ORIGIN || '*' };
}
function _jsonError(message, status, env) {
  return new Response(JSON.stringify({ error: message }), { status, headers: _corsJsonHeaders(env) });
}
