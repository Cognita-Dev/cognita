// reminders/reminders-scheduler.js
// Runs from worker.js's scheduled() handler on the cron trigger.
//
// Free-plan budget: 10ms CPU time and 50 subrequests per invocation. Each
// occurrence costs 2 Firestore reads, 0-2 sends (push + email), and a
// couple of KV ops — comfortably inside the subrequest budget for a small
// batch, and native WebCrypto (VAPID sign + RFC 8291 encrypt) is fast
// enough in practice that a batch of BATCH_SIZE rarely gets close to the
// CPU ceiling. If you ever see "Exceeded CPU Time Limits" in the Cloudflare
// dashboard for this Worker, lower BATCH_SIZE below — the rest of what's
// due just waits for the next tick, nothing is lost.
const BATCH_SIZE = 5;

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 10 * 60 * 1000; // 10 minutes

import {
  listDueOccurrences,
  removeDueIndexEntry,
  claimOccurrence,
  getOccurrence,
  getReminder,
  updateOccurrenceStatus,
  listSubscriptions,
  deleteSubscriptionById,
} from './reminders-storage.js';
import { sendWebPush } from './push-vapid.js';
import { sendEmail, claimOnce } from '../emails/mailer.js';
import { buildReminderEmail } from '../emails/auth-email-templates.js';

function _formatWhen(reminder) {
  const d = new Date(reminder.eventAt);
  try {
    const dateText = d.toLocaleDateString('en-GB', {
      timeZone: reminder.timezone,
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    });
    if (reminder.allDay) return dateText;
    const timeText = d.toLocaleTimeString('en-GB', {
      timeZone: reminder.timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    return dateText + ', ' + timeText;
  } catch (_) {
    return d.toISOString();
  }
}

async function _sendPush(env, uid, reminder, occurrence) {
  const subs = await listSubscriptions(env, uid);
  if (!subs.length) return { attempted: false, anySent: false };

  let anySent = false;
  for (const sub of subs) {
    try {
      const result = await sendWebPush(env, sub, {
        title: reminder.title,
        body: occurrence.label + (reminder.allDay ? '' : ' \u2014 ' + _formatWhen(reminder)),
        url: '/app.html?view=reminders',
      });
      if (result.ok) anySent = true;
      if (result.gone) await deleteSubscriptionById(env, sub.id);
    } catch (_) {
      // one device failing shouldn't stop the others
    }
  }
  return { attempted: true, anySent };
}

async function _sendEmailChannel(env, identityEmail, reminder, occurrence) {
  if (!identityEmail) return { attempted: false, sent: false };
  // A reminder can be edited after an email was already queued for the old
  // occurrence; keying the claim off occurrence id + fireAt makes a stale
  // retry harmless even if the same occurrence id were ever reused.
  const claimKey = 'reminderMail:' + occurrence.id + ':' + occurrence.fireAt;
  if (!(await claimOnce(env, claimKey, 3 * 24 * 60 * 60))) {
    return { attempted: true, sent: true }; // already sent — treat as success, don't resend
  }
  try {
    await sendEmail(
      env,
      identityEmail,
      buildReminderEmail({
        title: reminder.title,
        whenText: occurrence.label + ': ' + _formatWhen(reminder),
        notes: reminder.notes,
        url: 'https://app.cognita.com.ng/app.html?view=reminders',
      })
    );
    return { attempted: true, sent: true };
  } catch (e) {
    return { attempted: true, sent: false, error: e.message };
  }
}

/** Looks up the account's email without importing auth (Firestore/Firebase user record already used elsewhere). */
async function _lookupEmail(env, uid) {
  try {
    const { lookupUser } = await import('../emails/firebase-users.js');
    const user = await lookupUser(env, { uid });
    return user && user.email ? user.email : null;
  } catch (_) {
    return null;
  }
}

async function _processOccurrence(env, occurrenceId, now) {
  const occurrence = await getOccurrence(env, occurrenceId);
  if (!occurrence || occurrence.status !== 'pending') return; // already handled (e.g. reminder was edited)

  const reminder = await getReminder(env, occurrence.reminderId);
  if (!reminder || reminder.status !== 'active') {
    await updateOccurrenceStatus(env, occurrenceId, { status: 'skipped' });
    return;
  }

  // Very late (cron was down): if the event itself already happened, don't
  // send a stale "starts tomorrow" notice — mark it missed instead.
  if (new Date(reminder.eventAt).getTime() < now.getTime() - 60 * 1000) {
    await updateOccurrenceStatus(env, occurrenceId, { status: 'missed' });
    return;
  }

  await updateOccurrenceStatus(env, occurrenceId, { status: 'sending' });

  let anySucceeded = false;
  let lastError = null;

  if (occurrence.channels.push) {
    const pushResult = await _sendPush(env, occurrence.uid, reminder, occurrence);
    if (pushResult.anySent) anySucceeded = true;
    else if (pushResult.attempted) lastError = 'Push delivery failed for every device.';
    else lastError = 'No device has notifications turned on.';
  }

  if (occurrence.channels.email) {
    const email = await _lookupEmail(env, occurrence.uid);
    const emailResult = await _sendEmailChannel(env, email, reminder, occurrence);
    if (emailResult.sent) anySucceeded = true;
    else if (emailResult.attempted) lastError = emailResult.error || 'Email delivery failed.';
  }

  if (anySucceeded) {
    await updateOccurrenceStatus(env, occurrenceId, { status: 'sent', attempts: occurrence.attempts + 1, lastError: null });
    return;
  }

  const attempts = occurrence.attempts + 1;
  if (attempts >= MAX_ATTEMPTS) {
    await updateOccurrenceStatus(env, occurrenceId, { status: 'failed', attempts, lastError });
    return;
  }

  // Retry: back to pending, re-indexed a bit later so this tick's budget
  // isn't burned retrying the same thing immediately.
  const retryAt = new Date(now.getTime() + RETRY_DELAY_MS);
  await updateOccurrenceStatus(env, occurrenceId, { status: 'pending', attempts, lastError });
  const kv = env.COGNITA_REMINDERS;
  await kv.put('rq:' + retryAt.toISOString().slice(0, 16) + ':' + occurrenceId, '1');
}

/** Entry point called from worker.js's scheduled() handler. */
export async function runReminderScheduler(env) {
  if (!env.COGNITA_REMINDERS) {
    console.error('[reminders-scheduler] COGNITA_REMINDERS KV not bound — skipping run.');
    return;
  }

  const now = new Date();
  const due = await listDueOccurrences(env, now, BATCH_SIZE);

  for (const { occurrenceId, kvKey } of due) {
    const claimed = await claimOccurrence(env, occurrenceId);
    // Always drop the due-index entry once claimed (or already claimed by
    // an overlapping run) — retries get their own fresh key with a later
    // bucket, so this key's job is done either way.
    await removeDueIndexEntry(env, kvKey);
    if (!claimed) continue;

    try {
      await _processOccurrence(env, occurrenceId, now);
    } catch (e) {
      console.error('[reminders-scheduler] failed to process', occurrenceId, ':', e.message);
    }
  }
}
