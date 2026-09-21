// cancel-endpoint.js

import { requireAuth, describeAuthError } from './auth-middleware.js';
import { fsGet, fsUpdate } from './firestore-rest.js';
import { sendSubscriptionCancelledEmail } from './emails/billing-emails.js';

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

  let account;
  try {
    account = await fsGet('accounts/' + identity.uid, env);
  } catch (e) {
    console.error('[cancel] account lookup failed:', e.message);
    return _jsonError('Could not load your account. Please try again.', 500, env);
  }

  if (!account || account.planId === 'free') {
    return _jsonError('You do not have an active paid subscription to cancel.', 400, env);
  }

  if (account.status === 'cancelled') {
    return new Response(JSON.stringify({
      status: 'cancelled',
      periodEnd: account.periodEnd,
      message: 'Your subscription is already set to cancel at the end of the current period.',
    }), { status: 200, headers: _corsJsonHeaders(env) });
  }

  if (!account.paystackSubscriptionCode) {
    console.error('[cancel] active paid account with no paystackSubscriptionCode: uid=' + identity.uid);
    return _jsonError(
      'Could not find your subscription details. Please contact support so we can cancel this for you.',
      500, env
    );
  }

  let emailToken;
  try {
    const subRes = await fetch(
      'https://api.paystack.co/subscription/' + encodeURIComponent(account.paystackSubscriptionCode),
      { headers: { Authorization: 'Bearer ' + env.PAYSTACK_SECRET_KEY } }
    );
    if (!subRes.ok) {
      const text = await subRes.text().catch(() => '');
      throw new Error('Paystack subscription lookup failed (' + subRes.status + '): ' + text.slice(0, 200));
    }
    const subData = await subRes.json();
    emailToken = subData?.data?.email_token;
    if (!emailToken) throw new Error('No email_token in Paystack subscription response.');
  } catch (e) {
    console.error('[cancel] could not fetch subscription details:', e.message);
    return _jsonError('Could not process cancellation right now. Please try again.', 502, env);
  }

  try {
    const disableRes = await fetch('https://api.paystack.co/subscription/disable', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + env.PAYSTACK_SECRET_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        code: account.paystackSubscriptionCode,
        token: emailToken,
      }),
    });

    if (!disableRes.ok) {
      const text = await disableRes.text().catch(() => '');
      throw new Error('Paystack disable failed (' + disableRes.status + '): ' + text.slice(0, 200));
    }
  } catch (e) {
    console.error('[cancel] Paystack disable call failed:', e.message);
    return _jsonError('Could not cancel your subscription right now. Please try again.', 502, env);
  }

  try {
    await fsUpdate('accounts/' + identity.uid, {
      status: 'cancelled',
      updatedAt: new Date().toISOString(),
    }, env);
  } catch (e) {
    console.error('[cancel] Paystack cancelled but Firestore update failed:', e.message);
  }

  await sendSubscriptionCancelledEmail(env, {
    uid: identity.uid,
    email: identity.email,
    planId: account.planId,
    periodEnd: account.periodEnd,
  });

  return new Response(JSON.stringify({
    status: 'cancelled',
    periodEnd: account.periodEnd,
    message: 'Your subscription has been cancelled. You\'ll keep access until ' + _formatDate(account.periodEnd) + '.',
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
