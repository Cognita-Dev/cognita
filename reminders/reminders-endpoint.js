// reminders/reminders-endpoint.js
// All routes require requireAuth — a user can only ever touch their own
// reminders/subscriptions (every read/write here is scoped by the verified
// uid, never by anything the client sends).

import { requireAuth, describeAuthError } from '../auth-middleware.js';
import { resolveAccountWithRole } from '../subscription.js';
import { getPlan } from '../entitlements.js';
import { sendWebPush } from './push-vapid.js';
import { sendEmail } from '../emails/mailer.js';
import { buildReminderEmail } from '../emails/auth-email-templates.js';
import {
  createReminder,
  updateReminder,
  deleteReminder,
  listReminders,
  countActiveReminders,
  upsertSubscription,
  removeSubscriptionByEndpoint,
  listSubscriptions,
} from './reminders-storage.js';

function _headers(env) {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': env?.APP_ORIGIN || '*' };
}
function _ok(body, env, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: _headers(env) });
}
function _err(message, status, env) {
  return new Response(JSON.stringify({ error: message }), { status, headers: _headers(env) });
}

async function _authed(request, env) {
  return requireAuth(request, env); // throws — callers catch via describeAuthError
}

// Simple per-uid rate limit for creation, reusing the existing usage KV
// (same pattern as account-email-endpoint.js's per-IP limiter) so this
// doesn't need its own bookkeeping.
async function _createAllowed(env, uid) {
  if (!env.COGNITA_USAGE) return true;
  const hour = new Date().toISOString().slice(0, 13);
  const key = 'reminders:create:' + uid + ':' + hour;
  const used = parseInt((await env.COGNITA_USAGE.get(key)) || '0', 10);
  if (used >= 20) return false;
  await env.COGNITA_USAGE.put(key, String(used + 1), { expirationTtl: 3700 });
  return true;
}

function _reminderResponseShape(r) {
  return {
    id: r.id,
    title: r.title,
    notes: r.notes,
    eventAt: r.eventAt,
    allDay: r.allDay,
    timezone: r.timezone,
    channels: r.channels,
    offsets: r.offsets,
    status: r.status,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

/** POST /api/reminders */
export async function handleReminderCreate(request, env) {
  let identity;
  try {
    identity = await _authed(request, env);
  } catch (e) {
    const { status, message } = describeAuthError(e);
    return _err(message, status, env);
  }

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return _err('Invalid request.', 400, env);
  }

  try {
    if (!(await _createAllowed(env, identity.uid))) {
      return _err('Too many reminders created recently. Try again shortly.', 429, env);
    }

    const account = await resolveAccountWithRole(identity.uid, env);
    const limit = getPlan(account.planId).limits.activeReminders;
    const activeCount = await countActiveReminders(env, identity.uid);
    if (activeCount >= limit) {
      return _err(
        'You have reached your plan\u2019s limit of ' + limit + ' active reminders. Delete one or upgrade your plan.',
        403,
        env
      );
    }

    const { reminder, skipped } = await createReminder(env, identity.uid, body || {});
    return _ok({ reminder: _reminderResponseShape(reminder), skipped }, env, 201);
  } catch (e) {
    if (e.isLimit) return _err(e.message, 403, env);
    console.error('[reminders] create failed:', e.message);
    return _err(e.message && e.message.length < 200 ? e.message : 'Could not create the reminder.', 400, env);
  }
}

/** GET /api/reminders */
export async function handleReminderList(request, env) {
  let identity;
  try {
    identity = await _authed(request, env);
  } catch (e) {
    const { status, message } = describeAuthError(e);
    return _err(message, status, env);
  }

  try {
    const rows = await listReminders(env, identity.uid);
    return _ok({ reminders: rows.map(_reminderResponseShape) }, env);
  } catch (e) {
    console.error('[reminders] list failed:', e.message);
    return _err('Could not load reminders right now.', 502, env);
  }
}

/** PATCH /api/reminders/:id */
export async function handleReminderUpdate(request, env, reminderId) {
  let identity;
  try {
    identity = await _authed(request, env);
  } catch (e) {
    const { status, message } = describeAuthError(e);
    return _err(message, status, env);
  }

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return _err('Invalid request.', 400, env);
  }

  try {
    const { reminder, skipped } = await updateReminder(env, identity.uid, reminderId, body || {});
    return _ok({ reminder: _reminderResponseShape(reminder), skipped }, env);
  } catch (e) {
    if (e.isNotFound) return _err('Reminder not found.', 404, env);
    console.error('[reminders] update failed:', e.message);
    return _err(e.message && e.message.length < 200 ? e.message : 'Could not update the reminder.', 400, env);
  }
}

/** DELETE /api/reminders/:id */
export async function handleReminderDelete(request, env, reminderId) {
  let identity;
  try {
    identity = await _authed(request, env);
  } catch (e) {
    const { status, message } = describeAuthError(e);
    return _err(message, status, env);
  }

  try {
    await deleteReminder(env, identity.uid, reminderId);
    return _ok({ deleted: true }, env);
  } catch (e) {
    if (e.isNotFound) return _err('Reminder not found.', 404, env);
    console.error('[reminders] delete failed:', e.message);
    return _err('Could not delete the reminder.', 502, env);
  }
}

/** POST /api/reminders/subscribe   body: { endpoint, keys: {p256dh, auth}, userAgent } */
export async function handleSubscribe(request, env) {
  let identity;
  try {
    identity = await _authed(request, env);
  } catch (e) {
    const { status, message } = describeAuthError(e);
    return _err(message, status, env);
  }

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return _err('Invalid request.', 400, env);
  }

  const endpoint = String((body && body.endpoint) || '');
  const p256dh = body && body.keys && body.keys.p256dh;
  const auth = body && body.keys && body.keys.auth;
  if (!endpoint || !endpoint.startsWith('https://') || endpoint.length > 2000) {
    return _err('Invalid subscription.', 400, env);
  }

  try {
    await upsertSubscription(env, identity.uid, {
      endpoint,
      p256dh,
      auth,
      userAgent: request.headers.get('User-Agent') || '',
    });
    return _ok({ subscribed: true }, env);
  } catch (e) {
    if (e.isLimit) return _err(e.message, 403, env);
    console.error('[reminders] subscribe failed:', e.message);
    return _err(e.message && e.message.length < 200 ? e.message : 'Could not turn on notifications.', 400, env);
  }
}

/** POST /api/reminders/unsubscribe   body: { endpoint } */
export async function handleUnsubscribe(request, env) {
  let identity;
  try {
    identity = await _authed(request, env);
  } catch (e) {
    const { status, message } = describeAuthError(e);
    return _err(message, status, env);
  }

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return _err('Invalid request.', 400, env);
  }

  const endpoint = String((body && body.endpoint) || '');
  if (!endpoint) return _err('Missing endpoint.', 400, env);

  try {
    await removeSubscriptionByEndpoint(env, identity.uid, endpoint);
    return _ok({ unsubscribed: true }, env);
  } catch (e) {
    console.error('[reminders] unsubscribe failed:', e.message);
    return _err('Could not turn off notifications.', 502, env);
  }
}

/** POST /api/reminders/test-notification — sends "it works" to every channel the user has set up. */
export async function handleTestNotification(request, env) {
  let identity;
  try {
    identity = await _authed(request, env);
  } catch (e) {
    const { status, message } = describeAuthError(e);
    return _err(message, status, env);
  }

  const results = { push: [], email: false };

  try {
    const subs = await listSubscriptions(env, identity.uid);
    for (const sub of subs) {
      try {
        const result = await sendWebPush(env, sub, {
          title: 'Cognita reminders',
          body: 'Notifications are turned on for this device.',
          url: '/app.html?view=reminders',
        });
        results.push.push({ ok: result.ok, gone: result.gone });
        if (result.gone) {
          const { deleteSubscriptionById } = await import('./reminders-storage.js');
          await deleteSubscriptionById(env, sub.id);
        }
      } catch (e) {
        results.push.push({ ok: false, error: e.message });
      }
    }

    if (identity.email) {
      try {
        await sendEmail(env, identity.email, buildReminderEmail({
          title: 'Test reminder',
          whenText: 'Right now',
          notes: 'This is a test email from Cognita Reminders. If you got this, email reminders are working.',
          url: 'https://app.cognita.com.ng/app.html?view=reminders',
        }));
        results.email = true;
      } catch (e) {
        results.email = false;
      }
    }

    if (!subs.length && !identity.email) {
      return _err('No device notifications or email address available to test.', 400, env);
    }
    return _ok(results, env);
  } catch (e) {
    console.error('[reminders] test notification failed:', e.message);
    return _err('Could not send a test notification right now.', 502, env);
  }
}
