// reminders/reminders-storage.js
// Data model + storage for the Reminders feature.
//
// Firestore is the source of truth for everything (reminders, their
// occurrences, and push subscriptions). It CANNOT answer "what's due right
// now" directly — firestore-rest.js's fsQuery only supports one equality
// filter plus one orderBy, no range filter — so a separate Cloudflare KV
// "due index" answers that question instead:
//
//   Key:   rq:<fireAt minute, ISO, UTC>:<occurrenceId>
//   Value: '1' (unused — the key IS the data)
//
// ISO-8601 minute strings sort lexicographically in the same order as
// chronologically, so `env.COGNITA_REMINDERS.list({ prefix: 'rq:' })`
// returns occurrences in fire-time order for free, and the scheduler just
// stops reading once it hits a key whose minute is still in the future.
// One KV write at creation, one KV delete at send/cancel time — no
// read-modify-write race, which a "bucket holding a list of ids" design
// would have on Workers KV's eventually-consistent writes.
//
// Collections (top-level, `uid` field on each doc — same shape as the
// existing `resources` collection):
//   reminders/{reminderId}
//   reminderOccurrences/{occurrenceId}   (occurrenceId = `${reminderId}_${offsetId}`)
//   pushSubscriptions/{subscriptionId}   (subscriptionId = sha256(endpoint) hex)

import { fsGet, fsSet, fsUpdate, fsDelete, fsQuery } from '../firestore-rest.js';
import {
  parseDateStr,
  parseTimeStr,
  zonedTimeToUtc,
  isValidTimeZone,
  computeOffsetFireAt,
} from './timezone.js';

export const OFFSET_PRESETS = ['1_week', '1_day', 'morning_of', '1_hour', 'at_event'];
export const DEFAULT_OFFSETS = ['1_day', 'morning_of'];
export const OFFSET_LABELS = {
  '1_week': '1 week before',
  '1_day': '1 day before',
  morning_of: 'On the day (morning)',
  '1_hour': '1 hour before',
  at_event: 'At the event time',
};

// Offsets that only make sense when the reminder has a specific time.
const TIME_ONLY_OFFSETS = new Set(['1_hour', 'at_event']);

// Not a plan limit (entitlements.js governs how many *reminders* a plan
// allows) — this is a flat technical safety cap on devices per person,
// same idea as `fileUploadsPerDay` being separate from storage limits.
const MAX_SUBSCRIPTIONS_PER_USER = 8;

const CLAIM_TTL_SECONDS = 600; // generous vs. a 20-30 min cron cadence

function _requireKv(env) {
  if (!env.COGNITA_REMINDERS) {
    throw new Error('Server misconfiguration: COGNITA_REMINDERS KV not bound.');
  }
  return env.COGNITA_REMINDERS;
}

function _newId() {
  return crypto.randomUUID();
}

async function _sha256Hex(text) {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function _minuteBucket(date) {
  return date.toISOString().slice(0, 16); // "2026-09-22T07:00"
}

function _dueKey(fireAt, occurrenceId) {
  return 'rq:' + _minuteBucket(fireAt) + ':' + occurrenceId;
}

// ── Validation ──────────────────────────────────────────────────────────

const MAX_TITLE_LEN = 120;
const MAX_NOTES_LEN = 1000;

/**
 * Validates and normalizes raw reminder input from the client. Throws a
 * user-facing Error on anything invalid. Returns the computed event UTC
 * instant, local calendar date parts, and the deduped/validated offset list.
 */
function _validateReminderInput(input) {
  const title = String(input.title || '').trim();
  if (!title) throw new Error('Title is required.');
  if (title.length > MAX_TITLE_LEN) throw new Error('Title is too long.');

  const notes = String(input.notes || '').trim().slice(0, MAX_NOTES_LEN);

  const dateParts = parseDateStr(input.date);
  if (!dateParts) throw new Error('Enter a valid date.');

  const allDay = !input.time;
  let timeParts = { h: 0, mi: 0 };
  if (!allDay) {
    const parsed = parseTimeStr(input.time);
    if (!parsed) throw new Error('Enter a valid time.');
    timeParts = parsed;
  }

  const timezone = String(input.timezone || '').trim();
  if (!isValidTimeZone(timezone)) throw new Error('Unrecognized timezone.');

  const eventUtc = zonedTimeToUtc(dateParts.y, dateParts.m, dateParts.d, timeParts.h, timeParts.mi, timezone);

  let offsets = Array.isArray(input.offsets) && input.offsets.length ? input.offsets : DEFAULT_OFFSETS;
  offsets = [...new Set(offsets)].filter((o) => OFFSET_PRESETS.includes(o));
  if (allDay) offsets = offsets.filter((o) => !TIME_ONLY_OFFSETS.has(o));
  if (!offsets.length) offsets = allDay ? ['1_day'] : DEFAULT_OFFSETS;

  const channels = {
    push: !!(input.channels && input.channels.push),
    email: !!(input.channels && input.channels.email),
  };
  if (!channels.push && !channels.email) channels.push = true; // must pick something

  return { title, notes, dateParts, timeParts, allDay, timezone, eventUtc, offsets, channels };
}

// ── Occurrences ─────────────────────────────────────────────────────────

/** Builds (but does not save) the occurrence records for a reminder. */
function _buildOccurrences(reminderId, uid, { eventUtc, dateParts, timezone, offsets, channels, allDay }, now) {
  const occurrences = [];
  for (const offsetId of offsets) {
    const fireAt = computeOffsetFireAt(offsetId, eventUtc, dateParts, timezone, allDay);
    if (!fireAt) continue;
    const occurrenceId = reminderId + '_' + offsetId;
    const isPast = fireAt.getTime() <= now.getTime();
    occurrences.push({
      id: occurrenceId,
      reminderId,
      uid,
      offsetId,
      label: OFFSET_LABELS[offsetId] || offsetId,
      fireAt: fireAt.toISOString(),
      channels,
      status: isPast ? 'skipped' : 'pending',
      attempts: 0,
      lastError: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
  }
  return occurrences;
}

async function _saveOccurrences(env, occurrences) {
  const kv = _requireKv(env);
  for (const occ of occurrences) {
    await fsSet('reminderOccurrences/' + occ.id, occ, env);
    if (occ.status === 'pending') {
      await kv.put(_dueKey(new Date(occ.fireAt), occ.id), '1');
    }
  }
}

/** Deletes every occurrence doc + due-index entry belonging to one reminder. */
async function _clearOccurrences(env, reminderId, offsetIds) {
  const kv = _requireKv(env);
  for (const offsetId of offsetIds) {
    const occurrenceId = reminderId + '_' + offsetId;
    const occ = await fsGet('reminderOccurrences/' + occurrenceId, env);
    if (occ && occ.fireAt) {
      await kv.delete(_dueKey(new Date(occ.fireAt), occurrenceId)).catch(() => {});
    }
    await fsDelete('reminderOccurrences/' + occurrenceId, env);
  }
}

// ── Reminders CRUD ──────────────────────────────────────────────────────

/**
 * Creates a reminder and its occurrences. Returns { reminder, skipped }
 * where `skipped` lists any offsets whose fire time was already in the
 * past (so the endpoint can tell the user).
 */
export async function createReminder(env, uid, input) {
  const parsed = _validateReminderInput(input);
  const now = new Date();
  const id = _newId();

  const reminder = {
    id,
    uid,
    title: parsed.title,
    notes: parsed.notes,
    eventAt: parsed.eventUtc.toISOString(),
    allDay: parsed.allDay,
    timezone: parsed.timezone,
    channels: parsed.channels,
    offsets: parsed.offsets,
    status: 'active',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  const occurrences = _buildOccurrences(id, uid, parsed, now);
  await fsSet('reminders/' + id, reminder, env);
  await _saveOccurrences(env, occurrences);

  const skipped = occurrences.filter((o) => o.status === 'skipped').map((o) => o.label);
  return { reminder, occurrences, skipped };
}

/** Fetches one reminder, verifying it belongs to `uid`. Returns null if not found/not owned. */
export async function getOwnedReminder(env, uid, reminderId) {
  const reminder = await fsGet('reminders/' + reminderId, env);
  if (!reminder || reminder.uid !== uid) return null;
  return reminder;
}

export async function updateReminder(env, uid, reminderId, input) {
  const existing = await getOwnedReminder(env, uid, reminderId);
  if (!existing) throw Object.assign(new Error('Reminder not found.'), { isNotFound: true });

  const parsed = _validateReminderInput({
    title: input.title ?? existing.title,
    notes: input.notes ?? existing.notes,
    date: input.date, // date/time/timezone must always be resent by the edit form
    time: input.time,
    timezone: input.timezone ?? existing.timezone,
    offsets: input.offsets ?? existing.offsets,
    channels: input.channels ?? existing.channels,
  });

  const now = new Date();
  await _clearOccurrences(env, reminderId, existing.offsets);

  const reminder = {
    ...existing,
    title: parsed.title,
    notes: parsed.notes,
    eventAt: parsed.eventUtc.toISOString(),
    allDay: parsed.allDay,
    timezone: parsed.timezone,
    channels: parsed.channels,
    offsets: parsed.offsets,
    updatedAt: now.toISOString(),
  };
  const occurrences = _buildOccurrences(reminderId, uid, parsed, now);
  await fsSet('reminders/' + reminderId, reminder, env);
  await _saveOccurrences(env, occurrences);

  const skipped = occurrences.filter((o) => o.status === 'skipped').map((o) => o.label);
  return { reminder, occurrences, skipped };
}

export async function deleteReminder(env, uid, reminderId) {
  const existing = await getOwnedReminder(env, uid, reminderId);
  if (!existing) throw Object.assign(new Error('Reminder not found.'), { isNotFound: true });
  await _clearOccurrences(env, reminderId, existing.offsets);
  await fsDelete('reminders/' + reminderId, env);
}

/**
 * Every reminder belonging to uid, soonest event first. The cap is generous
 * because this is oldest-first: with a small cap, a long-time user's newest
 * (upcoming) reminders would be the ones cut off.
 */
export async function listReminders(env, uid, limit = 500) {
  const rows = await fsQuery('reminders', 'uid', uid, 'eventAt', limit, env, 'ASCENDING');
  return rows;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A reminder still "counts" until its event is over (all-day events last the whole day). */
function _isStillUpcoming(reminder, nowMs) {
  const endMs = new Date(reminder.eventAt).getTime() + (reminder.allDay ? DAY_MS : 0);
  return endMs >= nowMs;
}

// Plan limits are about reminders that can still fire. Reminders whose date
// has passed stay visible under "Past" but must not keep using up the limit
// (nothing ever flips their status away from 'active').
export async function countActiveReminders(env, uid) {
  const rows = await listReminders(env, uid, 500);
  const nowMs = Date.now();
  return rows.filter((r) => r.status === 'active' && _isStillUpcoming(r, nowMs)).length;
}

// ── Push subscriptions ──────────────────────────────────────────────────

export async function subscriptionIdFromEndpoint(endpoint) {
  return _sha256Hex(endpoint);
}

export async function upsertSubscription(env, uid, { endpoint, p256dh, auth, userAgent }) {
  if (!endpoint || !p256dh || !auth) throw new Error('Incomplete push subscription.');
  const id = await subscriptionIdFromEndpoint(endpoint);
  const existing = await fsGet('pushSubscriptions/' + id, env);
  const now = new Date().toISOString();

  if (!existing) {
    const current = await fsQuery('pushSubscriptions', 'uid', uid, 'createdAt', 50, env, 'ASCENDING'); // same direction as listSubscriptions, so one index serves both
    if (current.length >= MAX_SUBSCRIPTIONS_PER_USER) {
      throw Object.assign(
        new Error('Too many devices have notifications turned on. Turn it off on an old device first.'),
        { isLimit: true }
      );
    }
  } else if (existing.uid !== uid) {
    // Same browser, different signed-in person than before (existing.uid
    // is stale — e.g. someone signed out and a new person signed in on
    // this device). Re-key it to the new owner rather than leaving it
    // attached to whoever registered it first.
  }

  await fsSet(
    'pushSubscriptions/' + id,
    {
      id,
      uid,
      endpoint,
      p256dh,
      auth,
      userAgent: String(userAgent || '').slice(0, 200),
      createdAt: existing ? existing.createdAt : now,
      lastSeen: now,
    },
    env
  );
  return id;
}

export async function removeSubscriptionByEndpoint(env, uid, endpoint) {
  const id = await subscriptionIdFromEndpoint(endpoint);
  const existing = await fsGet('pushSubscriptions/' + id, env);
  if (!existing || existing.uid !== uid) return false;
  await fsDelete('pushSubscriptions/' + id, env);
  return true;
}

export async function listSubscriptions(env, uid) {
  return fsQuery('pushSubscriptions', 'uid', uid, 'createdAt', 50, env, 'ASCENDING');
}

export async function deleteSubscriptionById(env, id) {
  await fsDelete('pushSubscriptions/' + id, env).catch(() => {});
}

// ── Scheduler support ───────────────────────────────────────────────────

/**
 * Lists up to `limit` occurrence IDs whose fire time is due (<= now),
 * oldest first, plus their raw due-index KV keys (the caller deletes
 * these once each occurrence has been handled).
 */
export async function listDueOccurrences(env, now, limit) {
  const kv = _requireKv(env);
  const nowBucket = _minuteBucket(now);
  const due = [];
  let cursor;

  // Cap how many KV list pages we walk per run too — belt-and-braces
  // against the 10ms CPU budget on the free plan even if a future bucket
  // is somehow preceded by a huge run of already-claimed-but-undeleted keys.
  for (let page = 0; page < 5 && due.length < limit; page++) {
    const result = await kv.list({ prefix: 'rq:', cursor, limit: 50 });
    for (const key of result.keys) {
      const bucket = key.name.slice(3, 19); // "rq:" is 3 chars, minute bucket is 16 chars
      if (bucket > nowBucket) return due; // list() is lexicographic — everything after this is also future
      const occurrenceId = key.name.slice(20);
      due.push({ occurrenceId, kvKey: key.name });
      if (due.length >= limit) break;
    }
    if (result.list_complete || !result.cursor) break;
    cursor = result.cursor;
  }
  return due;
}

export async function removeDueIndexEntry(env, kvKey) {
  const kv = _requireKv(env);
  await kv.delete(kvKey).catch(() => {});
}

/** Short-lived claim so an overlapping cron run can't send the same occurrence twice. */
export async function claimOccurrence(env, occurrenceId) {
  const kv = _requireKv(env);
  const key = 'claim:' + occurrenceId;
  const existing = await kv.get(key);
  if (existing) return false;
  await kv.put(key, '1', { expirationTtl: CLAIM_TTL_SECONDS });
  return true;
}

export async function getOccurrence(env, occurrenceId) {
  return fsGet('reminderOccurrences/' + occurrenceId, env);
}

export async function updateOccurrenceStatus(env, occurrenceId, patch) {
  await fsUpdate('reminderOccurrences/' + occurrenceId, { ...patch, updatedAt: new Date().toISOString() }, env);
}

export async function getReminder(env, reminderId) {
  return fsGet('reminders/' + reminderId, env);
}
