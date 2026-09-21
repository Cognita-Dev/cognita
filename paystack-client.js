// paystack-client.js
// Small, shared helpers for talking to Paystack and for plan-code handling.
// Everything that calls api.paystack.co from more than one place lives here.

import { PLANS } from './entitlements.js';

const API = 'https://api.paystack.co';
const PAID_PLAN_IDS = ['plus', 'studio'];

/**
 * The Paystack plan code for one of our plans.
 * Test-mode plan codes are hard-coded in entitlements.js. LIVE mode uses
 * different plan codes, so for a live secret key we REQUIRE the Worker
 * variables PAYSTACK_PLAN_PLUS / PAYSTACK_PLAN_STUDIO and never fall back
 * to the test codes. Returns null when no usable code exists.
 */
export function resolvePaystackPlanCode(planId, env) {
  const override = env && env['PAYSTACK_PLAN_' + String(planId).toUpperCase()];
  if (override) return String(override).trim();
  const isLive = String((env && env.PAYSTACK_SECRET_KEY) || '').startsWith('sk_live_');
  if (isLive) return null;
  return (PLANS[planId] && PLANS[planId].paystackPlanCode) || null;
}

/** Reverse lookup: Paystack plan code -> our plan id ('plus' | 'studio' | null). */
export function planIdFromPaystackPlanCode(code, env) {
  if (!code) return null;
  for (const id of PAID_PLAN_IDS) {
    if (resolvePaystackPlanCode(id, env) === code) return id;
  }
  return null;
}

export async function paystackFetch(path, env, options = {}) {
  const res = await fetch(API + path, {
    ...options,
    headers: {
      Authorization: 'Bearer ' + env.PAYSTACK_SECRET_KEY,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* leave null */ }
  if (!res.ok || (json && json.status === false)) {
    const err = new Error('Paystack ' + path.split('?')[0] + ' failed (' + res.status + '): ' + text.slice(0, 200));
    err.httpStatus = res.status;
    throw err;
  }
  return json;
}

/**
 * Paystack bills monthly plans on the same day of the next month, and
 * subscriptions started on the 29th-31st bill on the 28th. This mirrors
 * that rule so our period end matches the real next charge date.
 */
export function addOneMonth(input) {
  const d = input instanceof Date ? input : new Date(input);
  const base = isNaN(d.getTime()) ? new Date() : d;
  const day = Math.min(base.getUTCDate(), 28);
  return new Date(Date.UTC(
    base.getUTCFullYear(), base.getUTCMonth() + 1, day,
    base.getUTCHours(), base.getUTCMinutes(), base.getUTCSeconds()
  ));
}

/** A date string is usable as a period end if it parses and is between `after` and ~35 days later. */
export function saneNextDate(value, after) {
  if (!value) return null;
  const t = new Date(value).getTime();
  const from = (after instanceof Date ? after : new Date(after || Date.now())).getTime();
  if (isNaN(t) || t <= from || t > from + 35 * 86400000) return null;
  return new Date(t).toISOString();
}

export async function fetchSubscription(env, codeOrId) {
  const json = await paystackFetch('/subscription/' + encodeURIComponent(codeOrId), env);
  return json.data;
}

const INACTIVE_SUB_STATUSES = ['cancelled', 'complete', 'completed', 'non-renewing'];

/**
 * Stops a subscription renewing. Safe to call on one that is already
 * stopped (returns { alreadyInactive: true }). Throws on real failures.
 * Returns { alreadyInactive, nextPaymentDate, planCode }.
 */
export async function disablePaystackSubscription(env, code) {
  const sub = await fetchSubscription(env, code);
  const info = {
    nextPaymentDate: sub && sub.next_payment_date ? sub.next_payment_date : null,
    planCode: sub && sub.plan ? sub.plan.plan_code : null,
  };
  if (sub && INACTIVE_SUB_STATUSES.includes(String(sub.status))) {
    return { alreadyInactive: true, ...info };
  }
  if (!sub || !sub.email_token) throw new Error('No email_token on Paystack subscription ' + code);
  await paystackFetch('/subscription/disable', env, {
    method: 'POST',
    body: JSON.stringify({ code, token: sub.email_token }),
  });
  return { alreadyInactive: false, ...info };
}

/**
 * Finds a customer's live subscription on a given plan straight from
 * Paystack. Used to recover the subscription code when we never stored it.
 */
export async function findSubscriptionForCustomer(env, customerCode, planCode) {
  const cust = await paystackFetch('/customer/' + encodeURIComponent(customerCode), env);
  const customerId = cust && cust.data && cust.data.id;
  if (!customerId) return null;
  const list = await paystackFetch('/subscription?perPage=50&customer=' + encodeURIComponent(customerId), env);
  const rows = (list && list.data) || [];
  const usable = rows.filter((s) =>
    ['active', 'attention', 'non-renewing'].includes(String(s.status)) &&
    (!planCode || (s.plan && s.plan.plan_code === planCode)));
  usable.sort((a, b) => {
    const rank = (s) => (s.status === 'non-renewing' ? 1 : 0);
    return rank(a) - rank(b) || new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
  });
  return usable[0] || null;
}

export async function verifyTransaction(env, reference) {
  const json = await paystackFetch('/transaction/verify/' + encodeURIComponent(reference), env);
  return json.data;
}

export async function fetchPlan(env, planCode) {
  const json = await paystackFetch('/plan/' + encodeURIComponent(planCode), env);
  return json.data;
}
