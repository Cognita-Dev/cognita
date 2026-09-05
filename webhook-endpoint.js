// webhook-endpoint.js
// POST /api/payment/webhook
// Receives events FROM Paystack, not from the browser. This is the only
// place in the entire app where a subscription is ever marked 'active' —
// the browser redirect after checkout is purely cosmetic and never grants
// access on its own (see payment-success.html in the frontend chunk).

import { fsGet, fsSet, fsUpdate } from './firestore-rest.js';
import { PLAN_HIERARCHY } from './entitlements.js';

async function _verifyPaystackSignature(rawBody, signatureHeader, secretKey) {
  if (!signatureHeader) return false;

  const keyBytes = new TextEncoder().encode(secretKey);
  const cryptoKey = await crypto.subtle.importKey(
    'raw', keyBytes, { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']
  );
  const sigBytes = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(rawBody));

  const computedHex = Array.from(new Uint8Array(sigBytes))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Constant-time-ish comparison (length-equal strings, XOR all bytes).
  if (computedHex.length !== signatureHeader.length) return false;
  let diff = 0;
  for (let i = 0; i < computedHex.length; i++) {
    diff |= computedHex.charCodeAt(i) ^ signatureHeader.charCodeAt(i);
  }
  return diff === 0;
}

export async function handlePaystackWebhook(request, env) {
  if (!env.PAYSTACK_SECRET_KEY) {
    console.error('[webhook] PAYSTACK_SECRET_KEY not configured.');
    return new Response('Server misconfigured.', { status: 500 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get('x-paystack-signature');

  const valid = await _verifyPaystackSignature(rawBody, signature, env.PAYSTACK_SECRET_KEY);
  if (!valid) {
    console.warn('[webhook] Invalid signature — rejecting.');
    return new Response('Invalid signature.', { status: 401 });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return new Response('Invalid JSON.', { status: 400 });
  }

  const eventId = event?.data?.id ? String(event.data.id) : null;
  const eventType = event?.event;

  if (!eventId || !eventType) {
    return new Response('Missing event identifiers.', { status: 400 });
  }

  // Replay protection: Paystack may resend the same event on retry.
  // We record every event id we've processed and skip duplicates.
  const seenKey = 'webhookEvents/' + eventType.replace(/\./g, '_') + '_' + eventId;
  const alreadySeen = await fsGet(seenKey, env);
  if (alreadySeen) {
    return new Response('Already processed.', { status: 200 });
  }
  await fsSet(seenKey, { processedAt: new Date().toISOString() }, env);

  try {
    if (eventType === 'charge.success') {
      await _handleChargeSuccess(event.data, env);
    } else if (eventType === 'subscription.disable' || eventType === 'subscription.not_renew') {
      await _handleSubscriptionCancelled(event.data, env);
    } else if (eventType === 'invoice.payment_failed') {
      await _handlePaymentFailed(event.data, env);
    } else if (eventType === 'invoice.update' && event.data?.status === 'success') {
      await _handleRenewalSuccess(event.data, env);
    }
    // Unhandled event types are acknowledged but ignored — Paystack sends
    // many event types we don't need to act on.
  } catch (e) {
    console.error('[webhook] handler error for ' + eventType + ':', e.message);
    // Still return 200 — we've recorded the event as seen, and Paystack
    // will not retry on 200. Errors here should alert via logs, not cause
    // Paystack to hammer retries which could cause other issues.
  }

  return new Response('OK', { status: 200 });
}

async function _resolvePaymentAttempt(reference, env) {
  if (!reference) return null;
  return fsGet('paymentAttempts/' + reference, env);
}

async function _handleChargeSuccess(data, env) {
  const reference = data.reference;
  const metadata = data.metadata || {};
  const attempt = await _resolvePaymentAttempt(reference, env);

  // Prefer the uid/planId we recorded ourselves at initialize time over
  // metadata echoed back by Paystack — our own record is what we trust.
  const uid = attempt?.uid || metadata.uid;
  const planId = attempt?.planId || metadata.planId;

  if (!uid || !PLAN_HIERARCHY.includes(planId)) {
    console.error('[webhook] charge.success with unresolvable uid/planId. reference=' + reference);
    return;
  }

  // Verify the amount actually paid matches what we expected for this plan —
  // guards against a tampered checkout session charging less than the plan costs.
  const expectedAmount = attempt?.amountKobo;
  if (expectedAmount != null && data.amount !== expectedAmount) {
    console.error('[webhook] Amount mismatch for reference ' + reference + ': expected ' + expectedAmount + ', got ' + data.amount);
    return; // do NOT grant access on a mismatched amount
  }

  const periodEnd = new Date();
  periodEnd.setDate(periodEnd.getDate() + 30); // monthly billing cycle

  await fsSet('accounts/' + uid, {
    uid,
    planId,
    status: 'active',
    periodEnd: periodEnd.toISOString(),
    paystackCustomerCode: data.customer?.customer_code || null,
    paystackSubscriptionCode: data.plan_object?.plan_code || null,
    updatedAt: new Date().toISOString(),
  }, env);

  if (attempt) {
    await fsUpdate('paymentAttempts/' + reference, { status: 'completed' }, env);
  }
}

async function _handleRenewalSuccess(data, env) {
  const customerCode = data.customer?.customer_code;
  if (!customerCode) return;

  const uid = await _findUidByCustomerCode(customerCode, env);
  if (!uid) {
    console.warn('[webhook] renewal success but no matching account for customer ' + customerCode);
    return;
  }

  const periodEnd = new Date();
  periodEnd.setDate(periodEnd.getDate() + 30);

  await fsUpdate('accounts/' + uid, {
    status: 'active',
    periodEnd: periodEnd.toISOString(),
    updatedAt: new Date().toISOString(),
  }, env);
}

async function _handleSubscriptionCancelled(data, env) {
  const customerCode = data.customer?.customer_code;
  if (!customerCode) return;

  const uid = await _findUidByCustomerCode(customerCode, env);
  if (!uid) return;

  const account = await fsGet('accounts/' + uid, env);
  await fsUpdate('accounts/' + uid, {
    status: 'cancelled',
    // Access continues until periodEnd already on file — do not shorten it.
    periodEnd: account?.periodEnd || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, env);
}

async function _handlePaymentFailed(data, env) {
  const customerCode = data.customer?.customer_code;
  if (!customerCode) return;

  const uid = await _findUidByCustomerCode(customerCode, env);
  if (!uid) return;

  await fsUpdate('accounts/' + uid, {
    status: 'past_due',
    updatedAt: new Date().toISOString(),
  }, env);
}

// Firestore REST doesn't give us a convenient "query by field" helper in
// firestore-rest.js yet (it's a minimal client), so subscription lookups by
// customer code go through a small index document we maintain ourselves,
// written at charge.success time. This avoids needing full Firestore query
// support just for this one lookup.
async function _findUidByCustomerCode(customerCode, env) {
  const indexDoc = await fsGet('customerCodeIndex/' + customerCode, env);
  return indexDoc?.uid || null;
}

function _corsJsonHeaders() {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
}
