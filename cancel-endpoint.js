// cancel-endpoint.js

import { requireAuth, describeAuthError } from './auth-middleware.js';
import { fsUpdate } from './firestore-rest.js';
import { getAccount } from './subscription.js';
import { sendSubscriptionCancelledEmail } from './emails/billing-emails.js';
import {
  disablePaystackSubscription,
  findSubscriptionForCustomer,
  resolvePaystackPlanCode,
  saneNextDate,
} from './paystack-client.js';

export async function handleSubscriptionCancel(request, env) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    const _authErr = describeAuthError(e);
    return _jsonError(_authErr.message, _authErr.status, env);
  }

  if (!env.PAYSTACK_SECRET_KEY) {
    console.error('[cancel] PAYSTACK_SECRET_KEY not configured.');
    return _jsonError('Could not process cancellation right now.', 500, env);
  }

  // getAccount applies expiry rules, so an already-expired plan is seen as free.
  let account;
  try {
    account = await getAccount(identity.uid, env);
  } catch (e) {
    console.error('[cancel] account lookup failed:', e.message);
    return _jsonError('Could not load your account. Please try again.', 500, env);
  }

  if (!account || account.planId === 'free' || account.status === 'expired' || account.status === 'none') {
    return _jsonError('You do not have an active paid subscription to cancel.', 400, env);
  }

  if (account.status === 'cancelled') {
    return new Response(JSON.stringify({
      status: 'cancelled',
      periodEnd: account.periodEnd,
      message: 'Your subscription is already set to cancel at the end of the current period.',
    }), { status: 200, headers: _corsJsonHeaders(env) });
  }

  // The code must be a real subscription code (SUB_...). Older records could
  // hold nothing, or a plan code by mistake, so recover it from Paystack.
  let subscriptionCode = String(account.paystackSubscriptionCode || '').startsWith('SUB_')
    ? account.paystackSubscriptionCode
    : null;

  if (!subscriptionCode && account.paystackCustomerCode) {
    try {
      const planCode = account.paystackPlanCode || resolvePaystackPlanCode(account.planId, env);
      const found = await findSubscriptionForCustomer(env, account.paystackCustomerCode, planCode);
      if (found && found.subscription_code) {
        subscriptionCode = found.subscription_code;
        try {
          await fsUpdate('accounts/' + identity.uid, {
            paystackSubscriptionCode: subscriptionCode,
            updatedAt: new Date().toISOString(),
          }, env);
        } catch (e) {
          console.warn('[cancel] could not save recovered subscription code:', e.message);
        }
      }
    } catch (e) {
      console.error('[cancel] subscription recovery failed:', e.message);
      return _jsonError('Could not process cancellation right now. Please try again.', 502, env);
    }
  }

  if (!subscriptionCode) {
    console.error('[cancel] active paid account with no findable subscription: uid=' + identity.uid);
    return _jsonError(
      'Could not find your subscription details. Please contact support so we can cancel this for you.',
      500, env
    );
  }

  let result;
  try {
    result = await disablePaystackSubscription(env, subscriptionCode);
  } catch (e) {
    console.error('[cancel] Paystack disable failed:', e.message);
    return _jsonError('Could not cancel your subscription right now. Please try again.', 502, env);
  }

  // Keep access until the date Paystack would have charged next.
  const periodEnd = saneNextDate(result.nextPaymentDate, new Date()) || account.periodEnd;

  try {
    await fsUpdate('accounts/' + identity.uid, {
      status: 'cancelled',
      periodEnd: periodEnd || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, env);
  } catch (e) {
    // Paystack has stopped billing; the subscription.not_renew webhook will bring Firestore in line.
    console.error('[cancel] Paystack cancelled but Firestore update failed:', e.message);
  }

  await sendSubscriptionCancelledEmail(env, {
    uid: identity.uid,
    email: identity.email,
    planId: account.planId,
    periodEnd,
  });

  return new Response(JSON.stringify({
    status: 'cancelled',
    periodEnd,
    message: 'Your subscription has been cancelled. You\'ll keep access until ' + _formatDate(periodEnd) + '.',
  }), { status: 200, headers: _corsJsonHeaders(env) });
}

function _formatDate(iso) {
  if (!iso) return 'the end of your current billing period';
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function _corsJsonHeaders(env) {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': env?.APP_ORIGIN || '*' };
}

function _jsonError(message, status, env) {
  return new Response(JSON.stringify({ error: message }), { status, headers: _corsJsonHeaders(env) });
}
