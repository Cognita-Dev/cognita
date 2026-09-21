// webhook-endpoint.js

import { fsGet, fsSet, fsUpdate } from './firestore-rest.js';
import { PLAN_HIERARCHY } from './entitlements.js';
import {
  sendPaymentReceiptEmail,
  sendPaymentFailedEmail,
  sendSubscriptionCancelledEmail,
} from './emails/billing-emails.js';

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
  } catch (e) {
    console.error('[webhook] handler error for ' + eventType + ':', e.message);
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

  const uid = attempt?.uid || metadata.uid;
  const planId = attempt?.planId || metadata.planId;

  if (!uid || !PLAN_HIERARCHY.includes(planId)) {
    console.error('[webhook] charge.success with unresolvable uid/planId. reference=' + reference);
    return;
  }

  const expectedAmount = attempt?.amountKobo;
  if (expectedAmount != null && data.amount !== expectedAmount) {
    console.error('[webhook] Amount mismatch for reference ' + reference + ': expected ' + expectedAmount + ', got ' + data.amount);
    return;
  }

  const periodEnd = new Date();
  periodEnd.setDate(periodEnd.getDate() + 30);

  await fsSet('accounts/' + uid, {
    uid,
    planId,
    status: 'active',
    periodEnd: periodEnd.toISOString(),
    paystackCustomerCode: data.customer?.customer_code || null,
    paystackSubscriptionCode: data.plan_object?.plan_code || null,
    updatedAt: new Date().toISOString(),
  }, env);

  if (data.customer?.customer_code) {
    await fsSet('customerCodeIndex/' + data.customer.customer_code, { uid }, env);
  }
  if (attempt) {
    await fsUpdate('paymentAttempts/' + reference, { status: 'completed' }, env);
  }

  await sendPaymentReceiptEmail(env, {
    uid,
    email: data.customer?.email,
    planId,
    amountKobo: data.amount,
    reference,
    paidAt: data.paid_at,
    periodEnd: periodEnd.toISOString(),
  });
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

  const renewedAccount = await fsGet('accounts/' + uid, env);
  await sendPaymentReceiptEmail(env, {
    uid,
    email: data.customer?.email,
    planId: renewedAccount?.planId,
    amountKobo: data.amount,
    paidAt: data.paid_at,
    periodEnd: periodEnd.toISOString(),
    renewal: true,
  });
}

async function _handleSubscriptionCancelled(data, env) {
  const customerCode = data.customer?.customer_code;
  if (!customerCode) return;

  const uid = await _findUidByCustomerCode(customerCode, env);
  if (!uid) return;

  const account = await fsGet('accounts/' + uid, env);
  await fsUpdate('accounts/' + uid, {
    status: 'cancelled',
    periodEnd: account?.periodEnd || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, env);

  await sendSubscriptionCancelledEmail(env, {
    uid,
    email: data.customer?.email,
    planId: account?.planId,
    periodEnd: account?.periodEnd,
  });
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

  const failedAccount = await fsGet('accounts/' + uid, env);
  await sendPaymentFailedEmail(env, {
    uid,
    email: data.customer?.email,
    planId: failedAccount?.planId,
  });
}

async function _findUidByCustomerCode(customerCode, env) {
  const indexDoc = await fsGet('customerCodeIndex/' + customerCode, env);
  return indexDoc?.uid || null;
}
