// social-scheduler.js
// Data model, storage, and the cron-triggered publish job for the Social
// Scheduler feature (schedule a Facebook or Instagram post for later).
//
// Same split as reminders/reminders-storage.js + reminders-scheduler.js,
// and deliberately reuses that exact design rather than inventing a new
// one:
//
//   - Firestore (`scheduledPosts/{postId}`) is the source of truth for
//     every scheduled post.
//   - Cloudflare KV (`COGNITA_SOCIAL_SCHEDULE`) is a separate "due index"
//     — Firestore here can't answer "what's due right now" directly (see
//     reminders-storage.js's header comment for why), so a KV key is
//     written per pending post:
//       Key:   sp:<scheduledFor minute, ISO, UTC>:<postId>
//     ISO-8601 minute strings sort lexicographically in fire-time order,
//     so `env.COGNITA_SOCIAL_SCHEDULE.list({ prefix: 'sp:' })` walks them
//     in order for free.
//   - Kept in its own KV namespace, separate from COGNITA_REMINDERS, for
//     the same reason reminders got its own namespace instead of sharing
//     COGNITA_USAGE: two unrelated features should never compete for the
//     free plan's daily KV write quota.
//
// This file does NOT talk to the Graph API directly for the *storage*
// half — publishing itself is delegated to meta-tools.js's
// publishFacebookPost/publishInstagramPost, the same functions the chat
// tools use, so there is exactly one place that knows how to make a
// Graph API post.

import { fsGet, fsSet, fsUpdate, fsDelete, fsQuery } from './firestore-rest.js';
import { listPages, publishFacebookPost, publishInstagramPost } from './meta-tools.js';

const BATCH_SIZE = 5; // see reminders-scheduler.js's identical constant for the CPU/subrequest budget reasoning this mirrors
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [10 * 60 * 1000, 30 * 60 * 1000];

// A post whose scheduled time has passed by more than this is treated as
// missed rather than published very late and out of context — same idea
// as reminders' STALE_GRACE_MS.
const STALE_GRACE_MS = 60 * 60 * 1000;

const MAX_MESSAGE_LEN = 2200; // Instagram's caption limit is the tightest of the two; enforced for both so a post never silently truncates on the provider's side
const MAX_SCHEDULED_POSTS_PER_USER = 100; // flat technical safety cap, not a plan limit

function _requireKv(env) {
  if (!env.COGNITA_SOCIAL_SCHEDULE) {
    throw new Error('Server misconfiguration: COGNITA_SOCIAL_SCHEDULE KV not bound.');
  }
  return env.COGNITA_SOCIAL_SCHEDULE;
}

function _newId() {
  return crypto.randomUUID();
}

function _minuteBucket(date) {
  return date.toISOString().slice(0, 16);
}

function _dueKey(scheduledFor, postId) {
  return 'sp:' + _minuteBucket(new Date(scheduledFor)) + ':' + postId;
}

// ── Validation ─────────────────────────────────────────────────────────

/**
 * Validates raw scheduling input from the client. Throws a user-facing
 * Error on anything invalid. Does NOT check that the Page/Instagram
 * account is actually reachable — the endpoint does that separately by
 * calling listPages(), since that also requires a network round-trip
 * this function deliberately stays free of (pure validation only).
 */
function _validateScheduleInput(input) {
  const target = input.target === 'instagram' ? 'instagram' : input.target === 'facebook' ? 'facebook' : null;
  if (!target) throw new Error('target must be "facebook" or "instagram".');

  const pageId = String(input.pageId || '').trim();
  if (!pageId) throw new Error('pageId is required.');

  const message = String(input.message || '').trim();
  if (target === 'facebook' && !message) throw new Error('A Facebook post needs text.');
  if (message.length > MAX_MESSAGE_LEN) throw new Error('That text is too long (max ' + MAX_MESSAGE_LEN + ' characters).');

  const imageUrl = String(input.imageUrl || '').trim();
  if (target === 'instagram') {
    if (!imageUrl) throw new Error('An Instagram post needs an image URL.');
    try {
      const u = new URL(imageUrl);
      if (u.protocol !== 'https:') throw new Error('bad');
    } catch (e) {
      throw new Error('imageUrl must be a valid https:// URL — Instagram cannot fetch anything else.');
    }
  }

  const link = target === 'facebook' ? String(input.link || '').trim() : '';

  const scheduledFor = new Date(input.scheduledFor);
  if (isNaN(scheduledFor.getTime())) throw new Error('scheduledFor must be a valid date/time.');
  if (scheduledFor.getTime() <= Date.now() + 60 * 1000) {
    throw new Error('Pick a time at least a minute in the future.');
  }

  return { target, pageId, message, imageUrl, link, scheduledFor };
}

// ── CRUD ───────────────────────────────────────────────────────────────

export async function countScheduledPosts(env, uid) {
  const rows = await fsQuery('scheduledPosts', 'uid', uid, 'scheduledFor', MAX_SCHEDULED_POSTS_PER_USER + 1, env, 'ASCENDING');
  return rows.filter((r) => r.status === 'pending').length;
}

/**
 * Creates a scheduled post. `pageName`/`instagramUsername` are passed in
 * by the endpoint (already fetched via listPages for the picker UI) so
 * they can be shown in the scheduled-posts list without a second Graph
 * API round-trip on every page load.
 */
export async function createScheduledPost(env, uid, input, pageLabel) {
  const parsed = _validateScheduleInput(input);

  const pending = await countScheduledPosts(env, uid);
  if (pending >= MAX_SCHEDULED_POSTS_PER_USER) {
    throw Object.assign(new Error('You have too many posts already scheduled. Cancel some before scheduling more.'), { isLimit: true });
  }

  const now = new Date();
  const id = _newId();
  const post = {
    id,
    uid,
    target: parsed.target,
    pageId: parsed.pageId,
    pageLabel: pageLabel || parsed.pageId,
    message: parsed.message,
    imageUrl: parsed.imageUrl || null,
    link: parsed.link || null,
    scheduledFor: parsed.scheduledFor.toISOString(),
    status: 'pending',
    attempts: 0,
    lastError: null,
    publishedPostId: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };

  await fsSet('scheduledPosts/' + id, post, env);
  const kv = _requireKv(env);
  await kv.put(_dueKey(post.scheduledFor, id), '1');

  return post;
}

/** Fetches one scheduled post, verifying it belongs to `uid`. Returns null if not found/not owned. */
export async function getOwnedScheduledPost(env, uid, postId) {
  const post = await fsGet('scheduledPosts/' + postId, env);
  if (!post || post.uid !== uid) return null;
  return post;
}

/** Lists a user's scheduled posts, most-soon-first, newest-created first within the same minute. */
export async function listScheduledPosts(env, uid, limit = 50) {
  return fsQuery('scheduledPosts', 'uid', uid, 'scheduledFor', limit, env, 'ASCENDING');
}

/**
 * Cancels a pending post: removes it from the due index so the scheduler
 * will never pick it up, and marks it canceled (kept, not deleted, so it
 * still shows in the user's history).
 */
export async function cancelScheduledPost(env, uid, postId) {
  const post = await getOwnedScheduledPost(env, uid, postId);
  if (!post) throw Object.assign(new Error('Scheduled post not found.'), { isNotFound: true });
  if (post.status !== 'pending') {
    throw Object.assign(new Error('Only a pending post can be canceled.'), { isConflict: true });
  }

  const kv = _requireKv(env);
  await kv.delete(_dueKey(post.scheduledFor, postId)).catch(() => {});
  await fsUpdate('scheduledPosts/' + postId, { status: 'canceled', updatedAt: new Date().toISOString() }, env);
  return true;
}

// ── Scheduler support (mirrors reminders-storage.js's equivalents) ─────

export async function listDuePosts(env, now, limit) {
  const kv = _requireKv(env);
  const nowBucket = _minuteBucket(now);
  const due = [];
  let cursor;

  for (let page = 0; page < 5 && due.length < limit; page++) {
    const result = await kv.list({ prefix: 'sp:', cursor, limit: 50 });
    for (const key of result.keys) {
      const bucket = key.name.slice(3, 19); // "sp:" is 3 chars, minute bucket is 16 chars
      if (bucket > nowBucket) return due; // list() is lexicographic — everything after this is also future
      const postId = key.name.slice(20);
      due.push({ postId, kvKey: key.name });
      if (due.length >= limit) break;
    }
    if (!result.cursor || result.list_complete) break;
    cursor = result.cursor;
  }
  return due;
}

export async function removeDueIndexEntry(env, kvKey) {
  const kv = _requireKv(env);
  await kv.delete(kvKey).catch(() => {});
}

const CLAIM_TTL_SECONDS = 600;

export async function claimPost(env, postId) {
  const kv = _requireKv(env);
  const key = 'claim:' + postId;
  const existing = await kv.get(key);
  if (existing) return false;
  await kv.put(key, '1', { expirationTtl: CLAIM_TTL_SECONDS });
  return true;
}

export async function releasePostClaim(env, postId) {
  const kv = _requireKv(env);
  await kv.delete('claim:' + postId).catch(() => {});
}

async function _updatePostStatus(env, postId, patch) {
  await fsUpdate('scheduledPosts/' + postId, { ...patch, updatedAt: new Date().toISOString() }, env);
}

// ── The actual publish, at fire time ────────────────────────────────────

async function _publishDuePost(env, postId, now) {
  const post = await fsGet('scheduledPosts/' + postId, env);
  if (!post || post.status !== 'pending') return; // already handled or canceled since being indexed

  const scheduledMs = new Date(post.scheduledFor).getTime();
  // Leftover index key pointing at a still-future post (shouldn't happen,
  // but a stale KV entry is cheap to just skip rather than trust blindly).
  if (scheduledMs > now.getTime() + 60 * 1000) return;

  if (scheduledMs + STALE_GRACE_MS < now.getTime()) {
    await _updatePostStatus(env, postId, { status: 'missed' });
    return;
  }

  await _updatePostStatus(env, postId, { status: 'publishing' });

  try {
    const pages = await listPages(post.uid, env);
    const page = pages.find((p) => p.id === post.pageId);
    if (!page) throw new Error('That Facebook Page is no longer connected.');

    let publishedPostId;
    if (post.target === 'facebook') {
      publishedPostId = await publishFacebookPost(page.pageAccessToken, page.id, { message: post.message, link: post.link });
    } else {
      if (!page.instagram) throw new Error('That Page no longer has a linked Instagram account.');
      publishedPostId = await publishInstagramPost(page.pageAccessToken, page.instagram.id, { imageUrl: post.imageUrl, caption: post.message });
    }

    await _updatePostStatus(env, postId, { status: 'published', publishedPostId, attempts: post.attempts + 1, lastError: null });
    return;
  } catch (e) {
    // NOT_CONNECTED / NEEDS_RECONNECT from getValidToken (inside
    // listPages) mean retrying won't help until the user reconnects —
    // fail immediately instead of burning all 3 attempts on a connection
    // that is definitely not coming back on its own.
    const isConnectionIssue = e.message === 'NOT_CONNECTED' || e.message === 'NEEDS_RECONNECT';
    const attempts = post.attempts + 1;

    if (isConnectionIssue || attempts >= MAX_ATTEMPTS) {
      await _updatePostStatus(env, postId, {
        status: 'failed',
        attempts,
        lastError: isConnectionIssue
          ? 'Your Facebook connection needs to be reconnected in Account Settings > Connections.'
          : e.message,
      });
      return;
    }

    const delayMs = RETRY_DELAYS_MS[Math.min(attempts - 1, RETRY_DELAYS_MS.length - 1)];
    const retryAt = new Date(now.getTime() + delayMs);
    await _updatePostStatus(env, postId, { status: 'pending', attempts, lastError: e.message });
    const kv = _requireKv(env);
    await kv.put(_dueKey(retryAt.toISOString(), postId), '1');
  }
}

/** Entry point called from worker.js's scheduled() handler, alongside runReminderScheduler. */
export async function runSocialScheduler(env) {
  if (!env.COGNITA_SOCIAL_SCHEDULE) {
    console.error('[social-scheduler] COGNITA_SOCIAL_SCHEDULE KV not bound — skipping run.');
    return;
  }

  const now = new Date();
  const due = await listDuePosts(env, now, BATCH_SIZE);

  for (const { postId, kvKey } of due) {
    const claimed = await claimPost(env, postId);
    if (!claimed) continue; // another overlapping run already holds this one
    await removeDueIndexEntry(env, kvKey);

    try {
      await _publishDuePost(env, postId, now);
    } catch (e) {
      console.error('[social-scheduler] failed to process', postId, ':', e.message);
    } finally {
      await releasePostClaim(env, postId);
    }
  }
}
