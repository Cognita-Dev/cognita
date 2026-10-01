// emails/billing-emails.js
// Payment received, payment failed, subscription cancelled.
// Called from webhook-endpoint.js and cancel-endpoint.js.
//
// Every function here catches its own errors. A problem with an email must
// never break a payment, a webhook or a cancellation.

import { getPlan, PLANS, UNLIMITED } from '../entitlements.js';
import { GRACE_PERIOD_DAYS } from '../subscription.js';
import { lookupUser, firstName } from './firebase-users.js';
import { sendEmail, claimOnce, releaseClaim, formatLagosDate, formatNaira } from './mailer.js';
import {
  buildPaymentReceiptEmail,
  buildPaymentFailedEmail,
  buildSubscriptionCancelledEmail,
} from './auth-email-templates.js';

const SIXTY_DAYS = 60 * 24 * 60 * 60;

// Plain-language descriptions of what a plan includes, built from the plan
// definitions in entitlements.js. That way the emails cannot go out of date
// when a plan changes. Order here is the order they appear in an email.
const PERKS = [
  [(p) => (p.models.chat || []).includes('advanced'), 'Advanced AI model for harder tasks'],
  [(p) => (p.models.chat || []).includes('reasoning'), 'Reasoning model for step-by-step problems'],
  [(p) => !!p.models.vision, 'Upload a picture and ask Cognita about it'],
  [(p) => !!(p.features && p.features.connectorTools), 'Connected apps: GitHub, Google, Facebook and Instagram, and Canva'],
  [(p) => !!(p.features && p.features.aiInbox), 'AI Inbox for comments and messages on your pages'],
  [(p) => !!(p.features && p.features.insightsDigest), 'Performance digests for your Facebook and Instagram pages'],
  [(p) => !!(p.features && p.features.longContext), 'Longer conversations, so Cognita remembers more of the chat'],
  [(p) => !!(p.features && p.features.designTemplates), 'Design templates for documents'],
  [(p) => !!p.models.flashcardImages, 'Pictures on flashcards'],
  [(p) => !!(p.features && p.features.prioritySupport), 'Priority support'],
];

const _count = (n) => (n >= UNLIMITED ? 'unlimited' : String(n));

/** What a plan includes, as short plain sentences. */
export function planPerks(plan) {
  const l = plan.limits || {};
  const daily =
    'Up to ' + _count(l.messagesPerDay) + ' chat messages, ' + _count(l.documentGenPerDay) + ' documents and ' +
    _count(l.imageGenPerDay) + ' images a day';
  return [daily].concat(PERKS.filter(([has]) => has(plan)).map(([, text]) => text));
}

/** What a plan has that Cognita Starter (the free plan) does not. */
export function planLosses(plan) {
  const free = PLANS.free;
  const lost = PERKS.filter(([has]) => has(plan) && !has(free)).map(([, text]) => text);
  lost.push('Higher daily limits (Starter allows ' + _count(free.limits.messagesPerDay) + ' chat messages a day)');
  return lost;
}

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
      accountEmail: email || '',
      perks: planPerks(plan),
    });

    const key = 'receipt:' + (info.reference || info.dedupeKey || info.uid + ':' + paidAt.toISOString().slice(0, 10));
    await _sendOnce(env, key, SIXTY_DAYS, email, message, 'payment receipt');
  } catch (e) {
    console.error('[billing-email] receipt failed:', e.message);
  }
}

/**
 * A recurring payment failed. { uid, email?, planId, periodEnd? } (one email per day at most)
 * periodEnd is the account's billing date. The grace period runs for
 * GRACE_PERIOD_DAYS after it (see subscription.js), which is the date the
 * email shows, but only while that date is still ahead.
 */
export async function sendPaymentFailedEmail(env, info) {
  try {
    const plan = getPlan(info.planId);
    const { email, name } = await _recipient(env, info.uid, info.email);
    let graceEndText = '';
    let graceOver = false;
    const periodEnd = info.periodEnd ? new Date(info.periodEnd) : null;
    if (periodEnd && !isNaN(periodEnd.getTime())) {
      const graceEnd = new Date(periodEnd.getTime() + GRACE_PERIOD_DAYS * 86400000);
      if (graceEnd.getTime() > Date.now()) graceEndText = formatLagosDate(graceEnd);
      else graceOver = true; // a late notice: the grace period has already run out
    }
    const message = buildPaymentFailedEmail({ name, planName: plan.name, graceEndText, graceDays: GRACE_PERIOD_DAYS, graceOver });
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
      losses: planLosses(plan),
    });
    const key = 'cancelled:' + info.uid + ':' + String(info.periodEnd || 'none').slice(0, 10);
    await _sendOnce(env, key, SIXTY_DAYS, email, message, 'subscription cancelled');
  } catch (e) {
    console.error('[billing-email] cancellation email failed:', e.message);
  }
}
