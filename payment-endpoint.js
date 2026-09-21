// payment-endpoint.js

import { requireAuth, describeAuthError } from './auth-middleware.js';
import { getPlan, PLAN_HIERARCHY } from './entitlements.js';
import { fsSet, fsGet } from './firestore-rest.js';
import { getAccount } from './subscription.js';
import { resolvePaystackPlanCode, fetchPlan, verifyTransaction } from './paystack-client.js';
import { applyChargeSuccess } from './webhook-endpoint.js';

export async function handlePaymentInitialize(request, env) {
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

  const requestedPlanId = body && body.planId;
  if (!PLAN_HIERARCHY.includes(requestedPlanId) || requestedPlanId === 'free') {
    return _jsonError('Invalid plan selected.', 400, env);
  }

  const plan = getPlan(requestedPlanId);
  if (!plan.paystackPlanCode) {
    return _jsonError('This plan is not available for purchase.', 400, env);
  }

  if (!identity.email) {
    return _jsonError('Your account has no email on file. Please sign in with an email-based method.', 400, env);
  }

  if (!env.PAYSTACK_SECRET_KEY) {
    console.error('[payment] PAYSTACK_SECRET_KEY not configured.');
    return _jsonError('Payments are temporarily unavailable.', 500, env);
  }

  // Test and live mode use different plan codes. With a live key the plan
  // codes MUST come from PAYSTACK_PLAN_PLUS / PAYSTACK_PLAN_STUDIO.
  const paystackPlanCode = resolvePaystackPlanCode(requestedPlanId, env);
  if (!paystackPlanCode) {
    console.error('[payment] No Paystack plan code configured for "' + requestedPlanId + '". Set PAYSTACK_PLAN_' + requestedPlanId.toUpperCase() + '.');
    return _jsonError('Payments are temporarily unavailable.', 500, env);
  }

  // Never start a second paid subscription for someone already on that plan.
  try {
    const account = await getAccount(identity.uid, env);
    if (account.status === 'active' && account.planId === requestedPlanId) {
      return _jsonError('You are already subscribed to ' + plan.name + '.', 409, env);
    }
  } catch (e) {
    console.error('[payment] account lookup failed:', e.message);
    return _jsonError('Could not start payment. Please try again.', 500, env);
  }

  // What Paystack will actually charge is the amount on ITS plan, not ours.
  // If the two ever differ (a typo when creating the live plan), stop before taking money.
  const expectedKobo = plan.priceNGN * 100;
  try {
    const remote = await fetchPlan(env, paystackPlanCode);
    if (!remote || remote.amount !== expectedKobo || String(remote.currency || 'NGN') !== 'NGN') {
      console.error('[payment] Paystack plan ' + paystackPlanCode + ' does not match ' + requestedPlanId +
        ': expected ' + expectedKobo + ' NGN kobo, Paystack has ' + (remote && remote.amount) + ' ' + (remote && remote.currency));
      return _jsonError('Payments are temporarily unavailable.', 500, env);
    }
  } catch (e) {
    console.error('[payment] could not verify Paystack plan:', e.message);
    return _jsonError('Could not reach the payment provider. Please try again.', 503, env);
  }

  const uidPart = String(identity.uid).replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
  const reference = 'cog-' + uidPart + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);

  try {
    await fsSet('paymentAttempts/' + reference, {
      uid: identity.uid,
      planId: requestedPlanId,
      paystackPlanCode,
      amountKobo: expectedKobo,
      currency: 'NGN',
      status: 'initialized',
      createdAt: new Date().toISOString(),
    }, env);
  } catch (e) {
    console.error('[payment] could not record payment attempt:', e.message);
    return _jsonError('Could not start payment. Please try again.', 500, env);
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
        amount: expectedKobo,
        currency: 'NGN',
        reference,
        plan: paystackPlanCode,
        callback_url: (env.APP_ORIGIN || '') + '/payment-success.html',
        metadata: {
          uid: identity.uid,
          planId: requestedPlanId,
          cancel_action: (env.APP_ORIGIN || '') + '/payment-failed.html',
        },
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('[payment] Paystack initialize failed:', res.status, text.slice(0, 300));
      return _jsonError('Could not start payment. Please try again.', 502, env);
    }

    const data = await res.json();
    if (!data.status || !data.data || !data.data.authorization_url) {
      console.error('[payment] Unexpected Paystack response shape:', JSON.stringify(data).slice(0, 300));
      return _jsonError('Could not start payment. Please try again.', 502, env);
    }

    return new Response(JSON.stringify({
      authorizationUrl: data.data.authorization_url,
      reference,
    }), {
      status: 200,
      headers: _corsJsonHeaders(env),
    });
  } catch (e) {
    console.error('[payment] initialize error:', e.message);
    return _jsonError('Could not reach the payment provider. Please try again.', 503, env);
  }
}

/**
 * GET /api/payment/status?reference=...
 * Used by payment-success.html. Tells the signed-in user whether THIS
 * payment has been applied. If the webhook has not landed yet it asks
 * Paystack directly (server to server) and applies the payment itself,
 * so a delayed or misconfigured webhook cannot strand a paid customer.
 */
export async function handlePaymentStatus(request, env) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    const _authErr = describeAuthError(e);
    return _jsonError(_authErr.message, _authErr.status, env);
  }

  const reference = new URL(request.url).searchParams.get('reference') || '';
  if (!/^[A-Za-z0-9.=-]{8,100}$/.test(reference)) {
    return _jsonError('Invalid payment reference.', 400, env);
  }

  let attempt;
  try {
    attempt = await fsGet('paymentAttempts/' + reference, env);
  } catch (e) {
    console.error('[payment-status] lookup failed:', e.message);
    return _jsonError('Could not check your payment. Please try again.', 500, env);
  }
  if (!attempt || attempt.uid !== identity.uid) {
    return _jsonError('Payment not found.', 404, env);
  }

  const plan = getPlan(attempt.planId);
  const ok = () => _json({ status: 'success', planId: attempt.planId, planName: plan.name }, env);

  if (attempt.status === 'completed') return ok();

  let tx;
  try {
    tx = await verifyTransaction(env, reference);
  } catch (e) {
    console.warn('[payment-status] verify failed:', e.message);
    return _json({ status: 'pending' }, env);
  }

  const txStatus = tx && tx.status;
  if (txStatus === 'success') {
    try {
      const result = await applyChargeSuccess(tx, env);
      if (result.applied || result.reason === 'already_completed') return ok();
      if (result.reason === 'amount_mismatch' || result.reason === 'uid_mismatch' || result.reason === 'bad_attempt') {
        return _json({ status: 'review' }, env);
      }
      return _json({ status: 'pending' }, env);
    } catch (e) {
      console.error('[payment-status] apply failed:', e.message);
      return _json({ status: 'pending' }, env);
    }
  }
  if (['failed', 'abandoned', 'reversed'].includes(txStatus)) {
    return _json({ status: 'failed' }, env);
  }
  return _json({ status: 'pending' }, env);
}

function _json(obj, env) {
  return new Response(JSON.stringify(obj), { status: 200, headers: _corsJsonHeaders(env) });
}

function _corsJsonHeaders(env) {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': env?.APP_ORIGIN || '*' };
}

function _jsonError(message, status, env) {
  return new Response(JSON.stringify({ error: message }), { status, headers: _corsJsonHeaders(env) });
}
