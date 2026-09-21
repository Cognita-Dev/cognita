// emails/billing-emails.js
// Payment received, payment failed, subscription cancelled.
// Called from webhook-endpoint.js and cancel-endpoint.js.
//
// Every function here catches its own errors. A problem with an email must
// never break a payment, a webhook or a cancellation.

import { getPlan } from '../entitlements.js';
import { lookupUser, firstName } from './firebase-users.js';
import { sendEmail, claimOnce, releaseClaim, formatLagosDate, formatNaira } from './mailer.js';
import {
  buildPaymentReceiptEmail,
  buildPaymentFailedEmail,
  buildSubscriptionCancelledEmail,
} from './auth-email-templates.js';

const SIXTY_DAYS = 60 * 24 * 60 * 60;

// Works out who to write to. Prefers the address the payment provider
// gave us, and asks Firebase for the rest (the name, or the address itself).
async function _recipient(env, uid, knownEmail) {
  let email = knownEmail || null;
  let name = '';
  if (uid) {
    try {
      const user = await lookupUser(env, { uid });
      if (user) {
        if (!email) email = user.email;
        name = firstName(user.displayName);
      }
    } catch (e) {
      console.warn('[billing-email] could not look up user:', e.message);
    }
  }
  return { email, name };
}

async function _sendOnce(env, claimKey, ttl, to, message, label) {
  if (!to) {
    console.warn('[billing-email] no address for ' + label + ', skipping.');
    return;
  }
  if (!(await claimOnce(env, claimKey, ttl))) return; // already sent
  try {
    await sendEmail(env, to, message);
  } catch (e) {
    await releaseClaim(env, claimKey);
    throw e;
  }
}

/**
 * First payment or a renewal went through.
 * { uid, email?, planId, amountKobo?, reference?, paidAt?, periodEnd?, renewal? }
 */
export async function sendPaymentReceiptEmail(env, info) {
  try {
    const plan = getPlan(info.planId);
    const { email, name } = await _recipient(env, info.uid, info.email);
    const paidAt = info.paidAt ? new Date(info.paidAt) : new Date();

    const message = buildPaymentReceiptEmail({
      name,
      planName: plan.name,
      amountText: formatNaira(info.amountKobo),
      dateText: formatLagosDate(paidAt),
      periodEndText: info.periodEnd ? formatLagosDate(info.periodEnd) : '',
      reference: info.renewal ? '' : info.reference || '',
      renewal: !!info.renewal,
    });

    const key = 'receipt:' + (info.reference || info.dedupeKey || info.uid + ':' + paidAt.toISOString().slice(0, 10));
    await _sendOnce(env, key, SIXTY_DAYS, email, message, 'payment receipt');
  } catch (e) {
    console.error('[billing-email] receipt failed:', e.message);
  }
}

/** A recurring payment failed. { uid, email?, planId } (one email per day at most) */
export async function sendPaymentFailedEmail(env, info) {
  try {
    const plan = getPlan(info.planId);
    const { email, name } = await _recipient(env, info.uid, info.email);
    const message = buildPaymentFailedEmail({ name, planName: plan.name });
    const key = 'payfail:' + info.uid + ':' + new Date().toISOString().slice(0, 10);
    await _sendOnce(env, key, SIXTY_DAYS, email, message, 'payment failed');
  } catch (e) {
    console.error('[billing-email] payment failed email failed:', e.message);
  }
}

/**
 * A subscription was cancelled. { uid, email?, planId, periodEnd? }
 * Cancelling from the app also triggers a Paystack event, so both routes
 * land here. The claim key makes sure only one email goes out.
 */
export async function sendSubscriptionCancelledEmail(env, info) {
  try {
    const plan = getPlan(info.planId);
    const { email, name } = await _recipient(env, info.uid, info.email);
    const message = buildSubscriptionCancelledEmail({
      name,
      planName: plan.name,
      accessUntilText: info.periodEnd ? formatLagosDate(info.periodEnd) : '',
    });
    const key = 'cancelled:' + info.uid + ':' + String(info.periodEnd || 'none').slice(0, 10);
    await _sendOnce(env, key, SIXTY_DAYS, email, message, 'subscription cancelled');
  } catch (e) {
    console.error('[billing-email] cancellation email failed:', e.message);
  }
}
