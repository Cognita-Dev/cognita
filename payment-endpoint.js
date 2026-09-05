// payment-endpoint.js
// POST /api/payment/initialize
// Frontend sends { planId }. The Worker determines the actual price,
// currency, and Paystack plan code from entitlements.js — never from the
// request. Returns an authorization_url for the browser to redirect to.

import { requireAuth } from './auth-middleware.js';
import { getPlan, PLAN_HIERARCHY } from './entitlements.js';
import { fsSet } from './firestore-rest.js';

export async function handlePaymentInitialize(request, env) {
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

  const requestedPlanId = body.planId;
  if (!PLAN_HIERARCHY.includes(requestedPlanId) || requestedPlanId === 'free') {
    return _jsonError('Invalid plan selected.', 400);
  }

  const plan = getPlan(requestedPlanId);
  if (!plan.paystackPlanCode) {
    return _jsonError('This plan is not available for purchase.', 400);
  }

  if (!identity.email) {
    return _jsonError('Your account has no email on file. Please sign in with an email-based method.', 400);
  }

  if (!env.PAYSTACK_SECRET_KEY) {
    console.error('[payment] PAYSTACK_SECRET_KEY not configured.');
    return _jsonError('Payments are temporarily unavailable.', 500);
  }

  // A reference we control, tied to the verified uid — used later to match
  // the webhook back to this exact attempt and prevent tampering.
  const reference = 'cog_' + identity.uid.slice(0, 8) + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

  // Record the pending attempt BEFORE calling Paystack, so that even if the
  // webhook arrives before this function returns (unlikely but possible),
  // there's already a record to reconcile against.
  try {
    await fsSet('paymentAttempts/' + reference, {
      uid: identity.uid,
      planId: requestedPlanId,
      amountKobo: plan.priceNGN * 100,
      status: 'initialized',
      createdAt: new Date().toISOString(),
    }, env);
  } catch (e) {
    console.error('[payment] could not record payment attempt:', e.message);
    return _jsonError('Could not start payment. Please try again.', 500);
  }

  try {
    const res = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + env.PAYSTACK_SECRET_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: identity.email,
        amount: plan.priceNGN * 100, // Paystack expects kobo
        currency: 'NGN',
        reference,
        plan: plan.paystackPlanCode,
        callback_url: (env.APP_ORIGIN || '') + '/payment-success.html',
        metadata: {
          uid: identity.uid,
          planId: requestedPlanId,
        },
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('[payment] Paystack initialize failed:', res.status, text.slice(0, 300));
      return _jsonError('Could not start payment. Please try again.', 502);
    }

    const data = await res.json();
    if (!data.status || !data.data?.authorization_url) {
      console.error('[payment] Unexpected Paystack response shape:', JSON.stringify(data).slice(0, 300));
      return _jsonError('Could not start payment. Please try again.', 502);
    }

    return new Response(JSON.stringify({
      authorizationUrl: data.data.authorization_url,
      reference,
    }), {
      status: 200,
      headers: _corsJsonHeaders(),
    });
  } catch (e) {
    console.error('[payment] initialize error:', e.message);
    return _jsonError('Could not reach the payment provider. Please try again.', 503);
  }
}

function _corsJsonHeaders() {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
}

function _jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: _corsJsonHeaders() });
}
