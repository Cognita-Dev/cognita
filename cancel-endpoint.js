// cancel-endpoint.js
// POST /api/subscription/cancel
// Frontend sends nothing but the auth token. The Worker looks up the
// user's actual Paystack subscription code from Firestore — never from
// the request — and tells Paystack to disable it. Access continues until
// the current billing period ends; the webhook (subscription.disable)
// will later confirm and reconcile, but we also update our own record
// immediately so the UI doesn't lag waiting for that round trip.

import { requireAuth } from './auth-middleware.js';
import { fsGet, fsUpdate } from './firestore-rest.js';

export async function handleSubscriptionCancel(request, env) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    return _jsonError('Not authenticated: ' + e.message, 401);
  }

  if (!env.PAYSTACK_SECRET_KEY) {
    console.error('[cancel] PAYSTACK_SECRET_KEY not configured.');
    return _jsonError('Could not process cancellation right now.', 500);
  }

  let account;
  try {
    account = await fsGet('accounts/' + identity.uid, env);
  } catch (e) {
    console.error('[cancel] account lookup failed:', e.message);
    return _jsonError('Could not load your account. Please try again.', 500);
  }

  if (!account || account.planId === 'free') {
    return _jsonError('You do not have an active paid subscription to cancel.', 400);
  }

  if (account.status === 'cancelled') {
    return new Response(JSON.stringify({
      status: 'cancelled',
      periodEnd: account.periodEnd,
      message: 'Your subscription is already set to cancel at the end of the current period.',
    }), { status: 200, headers: _corsJsonHeaders() });
  }

  if (!account.paystackSubscriptionCode) {
    // No subscription code on file — this shouldn't normally happen for an
    // active paid account, but if it does, we still let the user's access
    // expire naturally at periodEnd rather than leaving them stuck with no
    // way to stop future billing from our side. Flag it for manual review.
    console.error('[cancel] active paid account with no paystackSubscriptionCode: uid=' + identity.uid);
    return _jsonError(
      'Could not find your subscription details. Please contact support so we can cancel this for you.',
      500
    );
  }

  // Paystack requires the subscription's email token to disable it via the
  // public disable endpoint. We fetch the subscription first to get it,
  // rather than storing it separately — one less secret to manage.
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
    return _jsonError('Could not process cancellation right now. Please try again.', 502);
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
    return _jsonError('Could not cancel your subscription right now. Please try again.', 502);
  }

  // Update our own record immediately — access continues until periodEnd,
  // which is unchanged. The eventual subscription.disable webhook will see
  // status already 'cancelled' and simply confirm, not double-process,
  // since resolveAccount's expiry logic depends on status + periodEnd,
  // not on the webhook being the sole writer.
  try {
    await fsUpdate('accounts/' + identity.uid, {
      status: 'cancelled',
      updatedAt: new Date().toISOString(),
    }, env);
  } catch (e) {
    // Paystack-side cancellation already succeeded at this point — the
    // subscription WILL stop billing regardless of whether this write
    // succeeds. Log loudly so it can be reconciled manually if needed,
    // but don't tell the user cancellation failed when it didn't.
    console.error('[cancel] Paystack cancelled but Firestore update failed:', e.message);
  }

  return new Response(JSON.stringify({
    status: 'cancelled',
    periodEnd: account.periodEnd,
    message: 'Your subscription has been cancelled. You\'ll keep access until ' + _formatDate(account.periodEnd) + '.',
  }), { status: 200, headers: _corsJsonHeaders() });
}

function _formatDate(iso) {
  if (!iso) return 'the end of your current billing period';
  return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function _corsJsonHeaders() {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
}

function _jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), { status, headers: _corsJsonHeaders() });
}
