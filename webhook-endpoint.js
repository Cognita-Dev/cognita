// webhook-endpoint.js
//
// Paystack -> Cognita billing events.
//
// Design rules (each one exists because of a real failure mode):
//   1. Verify the HMAC signature on the RAW body before anything else.
//   2. Idempotency is keyed on a hash of the raw body, NOT on data.id.
//      Only charge.success carries data.id; subscription.* and invoice.*
//      payloads do not, so keying on it made those events fail.
//   3. An event is only marked "done" AFTER its handler succeeds. If the
//      handler throws we answer 500 so Paystack retries. Previously the
//      event was marked seen first and errors were swallowed, so a
//      transient Firestore error meant a paying customer never got their plan.
//   4. Events can arrive in any order (charge.success vs subscription.create).
//      Handlers only touch the fields they own and use partial updates.
//   5. Access is granted ONLY for a payment we initiated ourselves
//      (paymentAttempts/{reference}), with the exact amount and currency.
//      Metadata in the payload is never trusted on its own.
//   6. Events about a subscription that is no longer the account's current
//      one (an old plan after an upgrade) are ignored.

import { fsGet, fsSet, fsUpdate, fsCreate } from './firestore-rest.js';
import { getPlan } from './entitlements.js';
import {
  addOneMonth,
  saneNextDate,
  fetchSubscription,
  findSubscriptionForCustomer,
  disablePaystackSubscription,
  planIdFromPaystackPlanCode,
  resolvePaystackPlanCode,
} from './paystack-client.js';
import { lookupUser } from './emails/firebase-users.js';
import {
  sendPaymentReceiptEmail,
  sendPaymentFailedEmail,
  sendSubscriptionCancelledEmail,
} from './emails/billing-emails.js';

const HANDLED_EVENTS = new Set([
  'charge.success',
  'subscription.create',
  'subscription.disable',
  'subscription.not_renew',
  'invoice.payment_failed',
  'invoice.update',
]);

const PROCESSING_LOCK_MS = 2 * 60 * 1000;

// ─────────────────────────────────────────────────────────────
// Signature
// ─────────────────────────────────────────────────────────────

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

  const provided = String(signatureHeader).trim().toLowerCase();
  if (computedHex.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < computedHex.length; i++) {
    diff |= computedHex.charCodeAt(i) ^ provided.charCodeAt(i);
  }
  return diff === 0;
}

async function _sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────

export async function handlePaystackWebhook(request, env) {
  if (!env.PAYSTACK_SECRET_KEY) {
    console.error('[webhook] PAYSTACK_SECRET_KEY not configured.');
    return new Response('Server misconfigured.', { status: 500 });
  }

  const rawBody = await request.text();
  const signature = request.headers.get('x-paystack-signature');

  const valid = await _verifyPaystackSignature(rawBody, signature, env.PAYSTACK_SECRET_KEY);
  if (!valid) {
    console.warn('[webhook] Invalid signature, rejecting.');
    return new Response('Invalid signature.', { status: 401 });
  }

  let event;
  try {
    event = JSON.parse(rawBody);
  } catch (e) {
    return new Response('Invalid JSON.', { status: 400 });
  }

  const eventType = event && event.event;
  if (!eventType || typeof event.data !== 'object' || event.data === null) {
    return new Response('Missing event identifiers.', { status: 400 });
  }

  // Events we do not act on are acknowledged straight away.
  if (!HANDLED_EVENTS.has(eventType)) {
    return new Response('Ignored.', { status: 200 });
  }

  const eventKey = 'webhookEvents/' + eventType.replace(/\./g, '_') + '_' + (await _sha256Hex(rawBody)).slice(0, 40);

  let claim;
  try {
    claim = await _claimEvent(eventKey, env);
  } catch (e) {
    console.error('[webhook] could not claim event ' + eventType + ':', e.message);
    return new Response('Temporary failure.', { status: 500 });
  }
  if (claim === 'done') return new Response('Already processed.', { status: 200 });
  if (claim === 'busy') return new Response('Being processed.', { status: 503 });

  try {
    await _dispatch(eventType, event.data, env);
  } catch (e) {
    console.error('[webhook] handler error for ' + eventType + ':', e.message);
    try {
      await fsUpdate(eventKey, { status: 'failed', lastError: String(e.message).slice(0, 300), updatedAt: new Date().toISOString() }, env);
    } catch (_) { /* the 500 below is what matters */ }
    // 500 makes Paystack retry this event later.
    return new Response('Processing failed, please retry.', { status: 500 });
  }

  try {
    await fsUpdate(eventKey, { status: 'done', completedAt: new Date().toISOString() }, env);
  } catch (e) {
    // The work is done and every handler is idempotent, so a replay is harmless.
    console.error('[webhook] could not mark event done:', e.message);
  }
  return new Response('OK', { status: 200 });
}

async function _claimEvent(eventKey, env) {
  const now = Date.now();
  const fresh = { status: 'processing', startedAt: new Date(now).toISOString() };

  if (await fsCreate(eventKey, fresh, env)) return 'claimed';

  const existing = await fsGet(eventKey, env);
  if (!existing) {
    return (await fsCreate(eventKey, fresh, env)) ? 'claimed' : 'busy';
  }
  if (existing.status === 'done') return 'done';
  if (existing.status === 'processing') {
    const started = new Date(existing.startedAt || 0).getTime();
    if (now - started < PROCESSING_LOCK_MS) return 'busy';
  }
  // 'failed', or a 'processing' lock left behind by a crashed run: take over.
  await fsUpdate(eventKey, { status: 'processing', startedAt: fresh.startedAt }, env);
  return 'claimed';
}

async function _dispatch(eventType, data, env) {
  if (eventType === 'charge.success') return applyChargeSuccess(data, env);
  if (eventType === 'subscription.create') return _handleSubscriptionCreate(data, env);
  if (eventType === 'subscription.disable' || eventType === 'subscription.not_renew') return _handleSubscriptionCancelled(data, env);
  if (eventType === 'invoice.payment_failed') return _handlePaymentFailed(data, env);
  if (eventType === 'invoice.update') return _handleRenewalSuccess(data, env);
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

async function _recordIssue(kind, id, details, env) {
  console.error('[billing-issue] ' + kind + ' ' + id + ' ' + JSON.stringify(details).slice(0, 400));
  try {
    await fsSet('billingIssues/' + String(kind + '_' + id).replace(/[^A-Za-z0-9_.=-]/g, '_').slice(0, 200), {
      kind,
      ...details,
      createdAt: new Date().toISOString(),
    }, env);
  } catch (e) {
    console.error('[billing-issue] could not record issue:', e.message);
  }
}

function _validDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/** customer code -> uid, falling back to the customer's email. */
async function _resolveUid({ customerCode, email }, env) {
  if (customerCode) {
    const idx = await fsGet('customerCodeIndex/' + customerCode, env);
    if (idx && idx.uid) return idx.uid;
  }
  if (email) {
    const user = await lookupUser(env, { email });
    if (user && user.uid) {
      if (customerCode) await fsSet('customerCodeIndex/' + customerCode, { uid: user.uid }, env);
      return user.uid;
    }
  }
  return null;
}

function _isCurrentSubscription(account, eventSubscriptionCode) {
  const stored = account && account.paystackSubscriptionCode;
  if (!stored || !eventSubscriptionCode) return true; // nothing to compare against
  return stored === eventSubscriptionCode;
}

// ─────────────────────────────────────────────────────────────
// charge.success: the FIRST payment for a plan we initiated.
// Also called by the "verify" endpoint so a missed webhook cannot strand a payment.
// Returns { applied, reason }.
// ─────────────────────────────────────────────────────────────

export async function applyChargeSuccess(data, env) {
  const reference = data.reference;
  if (!reference) return { applied: false, reason: 'no_reference' };
  if (data.status && data.status !== 'success') return { applied: false, reason: 'not_success' };

  const attempt = await fsGet('paymentAttempts/' + reference, env);
  if (!attempt) {
    // Renewals and card-update charges have Paystack-made references and no
    // attempt. Renewals are handled through invoice.update.
    return { applied: false, reason: 'no_attempt' };
  }
  if (attempt.status === 'completed') return { applied: false, reason: 'already_completed' };

  const uid = attempt.uid;
  const planId = attempt.planId;
  const plan = getPlan(planId);
  if (!uid || planId === 'free' || planId === 'admin' || !plan.paystackPlanCode) {
    await _recordIssue('bad_attempt', reference, { reference, uid: uid || null, planId: planId || null }, env);
    return { applied: false, reason: 'bad_attempt' };
  }

  const metaUid = data.metadata && data.metadata.uid;
  if (metaUid && metaUid !== uid) {
    await _recordIssue('uid_mismatch', reference, { reference, uid, metaUid }, env);
    return { applied: false, reason: 'uid_mismatch' };
  }

  const currency = data.currency || 'NGN';
  if (data.amount !== attempt.amountKobo || currency !== (attempt.currency || 'NGN')) {
    await _recordIssue('amount_mismatch', reference, {
      reference, uid, planId,
      expectedKobo: attempt.amountKobo, paidKobo: data.amount === undefined ? null : data.amount,
      currency,
    }, env);
    return { applied: false, reason: 'amount_mismatch' };
  }

  const paidAt = _validDate(data.paid_at) || new Date();
  const periodEnd = addOneMonth(paidAt).toISOString();
  const customerCode = data.customer && data.customer.customer_code;
  const planCode = resolvePaystackPlanCode(planId, env);

  const update = {
    uid,
    planId,
    status: 'active',
    periodEnd,
    lastPaymentReference: reference,
    lastPaymentAt: paidAt.toISOString(),
    updatedAt: new Date().toISOString(),
  };
  if (customerCode) update.paystackCustomerCode = customerCode;
  if (planCode) update.paystackPlanCode = planCode;

  // Partial update: never wipes fields owned by subscription.create.
  await fsUpdate('accounts/' + uid, update, env);
  if (customerCode) await fsSet('customerCodeIndex/' + customerCode, { uid }, env);

  // Best effort: pick up the subscription code if Paystack has already made it.
  // If it has not, subscription.create will attach it.
  if (customerCode && planCode) {
    try {
      const sub = await findSubscriptionForCustomer(env, customerCode, planCode);
      if (sub && sub.subscription_code) {
        await _attachSubscription(env, uid, {
          subscriptionCode: sub.subscription_code,
          customerCode,
          planCode,
          nextPaymentDate: sub.next_payment_date,
        });
      }
    } catch (e) {
      console.warn('[webhook] could not look up subscription after charge:', e.message);
    }
  }

  await fsUpdate('paymentAttempts/' + reference, { status: 'completed', completedAt: new Date().toISOString() }, env);

  await sendPaymentReceiptEmail(env, {
    uid,
    email: data.customer && data.customer.email,
    planId,
    amountKobo: data.amount,
    reference,
    paidAt: paidAt.toISOString(),
    periodEnd,
  });

  return { applied: true, reason: 'ok' };
}

// ─────────────────────────────────────────────────────────────
// Linking the Paystack subscription to the account
// ─────────────────────────────────────────────────────────────

async function _attachSubscription(env, uid, { subscriptionCode, customerCode, planCode, nextPaymentDate }) {
  const account = await fsGet('accounts/' + uid, env);
  const oldCode = account && account.paystackSubscriptionCode;
  const planId = planIdFromPaystackPlanCode(planCode, env);

  const update = {
    paystackSubscriptionCode: subscriptionCode,
    updatedAt: new Date().toISOString(),
  };
  if (planCode) update.paystackPlanCode = planCode;
  if (customerCode) update.paystackCustomerCode = customerCode;

  // Prefer Paystack's own next charge date once the account is already on this plan.
  const next = saneNextDate(nextPaymentDate, new Date());
  if (next && account && account.status === 'active' && planId && account.planId === planId) {
    update.periodEnd = next;
  }

  await fsUpdate('accounts/' + uid, update, env);

  // Switching plans (or paying again after a failed payment) creates a NEW
  // Paystack subscription. Stop the old one, otherwise the customer is billed twice.
  if (oldCode && oldCode !== subscriptionCode && String(oldCode).startsWith('SUB_')) {
    try {
      await disablePaystackSubscription(env, oldCode);
    } catch (e) {
      await _recordIssue('old_subscription_not_disabled', oldCode, { uid, oldCode, newCode: subscriptionCode, error: e.message }, env);
    }
  }
}

async function _handleSubscriptionCreate(data, env) {
  const subscriptionCode = data.subscription_code;
  const planCode = data.plan && data.plan.plan_code;
  const customerCode = data.customer && data.customer.customer_code;
  const email = data.customer && data.customer.email;

  if (!subscriptionCode) return;
  if (!planIdFromPaystackPlanCode(planCode, env)) return; // not one of our plans

  const uid = await _resolveUid({ customerCode, email }, env);
  if (!uid) {
    // Throwing makes Paystack retry, by which time charge.success will have indexed the customer.
    throw new Error('subscription.create: no account found for customer ' + (customerCode || email));
  }

  await _attachSubscription(env, uid, {
    subscriptionCode,
    customerCode,
    planCode,
    nextPaymentDate: data.next_payment_date,
  });
}

// ─────────────────────────────────────────────────────────────
// Renewal, failure, cancellation
// ─────────────────────────────────────────────────────────────

async function _handleRenewalSuccess(data, env) {
  if (data.status !== 'success' || data.paid === false) return;

  const customerCode = data.customer && data.customer.customer_code;
  const email = data.customer && data.customer.email;
  const eventSubCode = data.subscription && data.subscription.subscription_code;

  const uid = await _resolveUid({ customerCode, email }, env);
  if (!uid) throw new Error('invoice.update: no account found for customer ' + (customerCode || email));

  const account = await fsGet('accounts/' + uid, env);
  if (!account) throw new Error('invoice.update: account missing for ' + uid);
  if (!_isCurrentSubscription(account, eventSubCode)) return;

  // The account may have been downgraded to free by the expiry logic while
  // this renewal was in flight, so work the plan out from the plan code.
  let planId = ['plus', 'studio'].includes(account.planId) ? account.planId : null;
  if (!planId) planId = planIdFromPaystackPlanCode(account.paystackPlanCode, env);

  const subCode = eventSubCode || account.paystackSubscriptionCode;
  let fetched = null;
  if (subCode && String(subCode).startsWith('SUB_')) {
    try { fetched = await fetchSubscription(env, subCode); } catch (e) {
      console.warn('[webhook] renewal: could not fetch subscription:', e.message);
    }
  }
  if (!planId && fetched && fetched.plan) planId = planIdFromPaystackPlanCode(fetched.plan.plan_code, env);
  if (!planId) {
    await _recordIssue('renewal_unknown_plan', data.invoice_code || uid, { uid, invoice: data.invoice_code || null }, env);
    return;
  }

  const paidAt = _validDate(data.paid_at) || new Date();
  const periodEnd = saneNextDate(fetched && fetched.next_payment_date, paidAt) || addOneMonth(paidAt).toISOString();

  const expectedKobo = getPlan(planId).priceNGN * 100;
  if (data.amount !== undefined && data.amount !== expectedKobo) {
    await _recordIssue('renewal_amount_differs', data.invoice_code || uid, { uid, planId, expectedKobo, paidKobo: data.amount }, env);
  }

  // A customer who cancelled but was charged anyway keeps 'cancelled' (no
  // further renewals) with the extra period they paid for.
  const status = account.status === 'cancelled' ? 'cancelled' : 'active';
  await fsUpdate('accounts/' + uid, {
    planId,
    status,
    periodEnd,
    lastPaymentAt: paidAt.toISOString(),
    updatedAt: new Date().toISOString(),
  }, env);

  await sendPaymentReceiptEmail(env, {
    uid,
    email,
    planId,
    amountKobo: data.amount,
    paidAt: paidAt.toISOString(),
    periodEnd,
    renewal: true,
    dedupeKey: 'invoice:' + (data.invoice_code || paidAt.toISOString()),
  });
}

async function _handleSubscriptionCancelled(data, env) {
  const customerCode = data.customer && data.customer.customer_code;
  const email = data.customer && data.customer.email;

  const uid = await _resolveUid({ customerCode, email }, env);
  if (!uid) return; // nothing of ours to update

  const account = await fsGet('accounts/' + uid, env);
  if (!account) return;
  if (!_isCurrentSubscription(account, data.subscription_code)) return; // an old, replaced subscription

  if (account.status === 'expired' || account.status === 'none') return;

  const periodEnd = account.periodEnd || saneNextDate(data.next_payment_date, new Date()) || new Date().toISOString();
  await fsUpdate('accounts/' + uid, {
    status: 'cancelled',
    periodEnd,
    updatedAt: new Date().toISOString(),
  }, env);

  await sendSubscriptionCancelledEmail(env, {
    uid,
    email,
    planId: account.planId,
    periodEnd,
  });
}

async function _handlePaymentFailed(data, env) {
  const customerCode = data.customer && data.customer.customer_code;
  const email = data.customer && data.customer.email;
  const eventSubCode = data.subscription && data.subscription.subscription_code;

  const uid = await _resolveUid({ customerCode, email }, env);
  if (!uid) return;

  const account = await fsGet('accounts/' + uid, env);
  if (!account) return;
  if (!_isCurrentSubscription(account, eventSubCode)) return;

  // Only an active subscription moves to past_due. Never resurrect or
  // override cancelled/expired accounts.
  if (account.status !== 'active') return;

  await fsUpdate('accounts/' + uid, {
    status: 'past_due',
    updatedAt: new Date().toISOString(),
  }, env);

  await sendPaymentFailedEmail(env, {
    uid,
    email,
    planId: account.planId,
  });
}
