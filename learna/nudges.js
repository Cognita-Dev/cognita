// learna/nudges.js
// Learner notifications for Learna, sent through Cognita's existing web push (reminders/push-vapid.js and the saved push subscriptions).
//
// Principles, taken from how learning platforms handle reminders (Open edX, Gainsight, Skillsoft documentation and nudge research):
//   - Send only when there is a real reason: a reviewer decided on your work, your certificate is ready, or you stopped part way through a course.
//   - Space inactivity reminders out and then STOP. Two messages at most per stretch of inactivity: after 3 days and after 10 days.
//     Coming back resets the count. A learner who ignores both gets nothing more until they return.
//   - Never daily. At most one message every 48 hours across all courses and at most 4 in any 30 days.
//   - Quiet hours (21:00 to 07:00 in the learner's own time zone). A message that falls in them waits for the morning.
//   - The learner can turn each kind off. No push subscription or permission means nothing is sent, and no email is sent instead.
//   - Messages name the real next step (the lesson, the task), not slogans.
//
// Storage:
//   KV COGNITA_REMINDERS   lq:{ISO due time}:{uid}:{courseId}   a due marker, value { stage }
//   Firestore learna_prefs/{uid}   { nudges, reviewAlerts, tz, lastSentAt, sent: [ISO...] }

import { fsGet, fsSet } from '../firestore-rest.js';
import { listSubscriptions, deleteSubscriptionById } from '../reminders/reminders-storage.js';
import { sendWebPush } from '../reminders/push-vapid.js';
import { flatLessons, percentComplete } from './engine.js';
import { loadCourseMap } from './course-store.js';

export const STAGE_DELAYS_DAYS = { 1: 3, 2: 10 };
export const MIN_GAP_HOURS = 48;
export const MAX_PER_30_DAYS = 4;
export const QUIET = { start: 21, end: 7 };
const DAY = 86400000;
const BATCH = 3;

export const prefsPath = (uid) => 'learna_prefs/' + uid;
export const DEFAULT_PREFS = { nudges: true, reviewAlerts: true, tz: 'Africa/Lagos' };

export async function getPrefs(env, uid) {
  const p = await fsGet(prefsPath(uid), env).catch(() => null);
  return { ...DEFAULT_PREFS, sent: [], lastSentAt: null, ...(p || {}) };
}

export function cleanTz(tz) {
  try { new Intl.DateTimeFormat('en-GB', { timeZone: String(tz) }); return String(tz); } catch (_) { return DEFAULT_PREFS.tz; }
}

export async function savePrefs(env, uid, body) {
  const cur = await getPrefs(env, uid);
  const next = { ...cur, uid };
  if (typeof body.nudges === 'boolean') next.nudges = body.nudges;
  if (typeof body.reviewAlerts === 'boolean') next.reviewAlerts = body.reviewAlerts;
  if (body.tz) next.tz = cleanTz(body.tz);
  await fsSet(prefsPath(uid), next, env);
  if (next.nudges === false) await clearAllDue(env, uid);
  return next;
}

export function localHour(date, tz) {
  try { return parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false }).format(date), 10) % 24; } catch (_) { return date.getUTCHours(); }
}
export const inQuietHours = (date, tz) => { const h = localHour(date, tz); return h >= QUIET.start || h < QUIET.end; };

/** The next moment after `from` that is outside quiet hours (walks forward by the hour, at most 24 steps). */
export function nextAllowed(from, tz) {
  let d = new Date(from.getTime());
  for (let i = 0; i < 25 && inQuietHours(d, tz); i++) d = new Date(d.getTime() + 3600000);
  return d;
}

/** Whether global limits allow a message now. */
export function withinCaps(prefs, now = new Date()) {
  const sent = (prefs.sent || []).map((s) => new Date(s).getTime()).filter((t) => now.getTime() - t < 30 * DAY);
  if (sent.length >= MAX_PER_30_DAYS) return { ok: false, retryAfter: new Date(Math.min(...sent) + 30 * DAY) };
  const last = sent.length ? Math.max(...sent) : 0;
  if (last && now.getTime() - last < MIN_GAP_HOURS * 3600000) return { ok: false, retryAfter: new Date(last + MIN_GAP_HOURS * 3600000) };
  return { ok: true };
}

const kv = (env) => env.COGNITA_REMINDERS;
const dueKey = (iso, uid, courseId) => 'lq:' + iso + ':' + uid + ':' + courseId;

export async function scheduleStage(env, uid, courseId, stage, fromIso) {
  const days = STAGE_DELAYS_DAYS[stage];
  if (!days || !kv(env)) return null;
  const at = new Date(new Date(fromIso).getTime() + days * DAY).toISOString();
  const key = dueKey(at, uid, courseId);
  await kv(env).put(key, JSON.stringify({ stage }), { expirationTtl: (days + 8) * 86400 });
  return key;
}

export async function clearDue(env, key) { if (key && kv(env)) await kv(env).delete(key).catch(() => {}); }

async function clearAllDue(env, uid) {
  if (!kv(env)) return;
  const l = await kv(env).list({ prefix: 'lq:', limit: 200 }).catch(() => ({ keys: [] }));
  for (const k of l.keys) if (k.name.split(':').slice(-2)[0] === uid || k.name.includes(':' + uid + ':')) await kv(env).delete(k.name).catch(() => {});
}

/**
 * Call whenever the learner does something that counts as activity (enrol, finish a lesson, submit a task).
 * It replaces any waiting inactivity reminder with a fresh stage-1 one. `progress.nudgeKey` remembers the old marker.
 */
export async function noteActivity(env, progress) {
  if (!kv(env)) return;
  try {
    if (progress.nudgeKey) await clearDue(env, progress.nudgeKey);
    progress.nudgeKey = progress.status === 'active' ? await scheduleStage(env, progress.uid, progress.courseId, 1, new Date().toISOString()) : null;
  } catch (e) { console.error('[learna-nudges] schedule failed:', e.message); }
}

async function push(env, uid, payload, deps = {}) {
  const list = deps.listSubscriptions || listSubscriptions, send = deps.sendWebPush || sendWebPush, drop = deps.deleteSubscriptionById || deleteSubscriptionById;
  const subs = await list(env, uid).catch(() => []);
  if (!subs.length) return { sent: 0, subs: 0 };
  let sent = 0;
  for (const sub of subs) {
    try {
      const r = await send(env, sub, payload, { ttlSeconds: 2 * 86400 });
      if (r.ok) sent++;
      if (r.gone) await drop(env, sub.id);
    } catch (_) { /* one device failing must not stop the rest */ }
  }
  return { sent, subs: subs.length };
}

async function record(env, uid, prefs) {
  const now = new Date().toISOString();
  const keep = (prefs.sent || []).filter((s) => Date.now() - new Date(s).getTime() < 30 * DAY);
  await fsSet(prefsPath(uid), { ...prefs, uid, sent: [...keep, now].slice(-10), lastSentAt: now }, env);
}

const courseUrl = (courseId, lesson) => '/app.html?view=learna&course=' + encodeURIComponent(courseId) + (lesson ? '&lesson=' + encodeURIComponent(lesson) : '');

/** A reviewer decided on a task. Sent at once, because it is the thing the learner is waiting for. Respects the learner's choices. */
export async function notifyReview(env, uid, course, taskTitle, decision, deps) {
  const prefs = await getPrefs(env, uid);
  if (prefs.reviewAlerts === false) return { sent: false, reason: 'off' };
  const approved = decision === 'approve';
  const r = await push(env, uid, {
    title: approved ? 'Your task was approved' : 'Your reviewer left feedback',
    body: approved ? taskTitle + ' in ' + course.title + ' is approved.' : 'Read the feedback on ' + taskTitle + ' in ' + course.title + ' and try again.',
    url: courseUrl(course.id), tag: 'learna-review-' + course.id,
  }, deps);
  return { sent: r.sent > 0, reason: r.subs ? null : 'no-subscription' };
}

export async function notifyCertificateReady(env, uid, course, deps) {
  const prefs = await getPrefs(env, uid);
  if (prefs.reviewAlerts === false) return { sent: false, reason: 'off' };
  const r = await push(env, uid, { title: 'Your certificate is ready to claim', body: 'You have met every requirement for ' + course.title + '.', url: courseUrl(course.id), tag: 'learna-cert-' + course.id }, deps);
  return { sent: r.sent > 0 };
}

export function inactivityMessage(course, progress, stage) {
  const flat = flatLessons(course);
  const f = flat.find((x) => x.key === progress.current.lesson) || flat[0];
  const pct = percentComplete(course, progress);
  const done = Object.values(progress.lessons || {}).filter((l) => l.status === 'done').length;
  if (stage === 1) return { title: 'Pick up ' + course.title, body: 'Next: ' + f.lesson.title + ' (about ' + f.lesson.minutes + ' minutes). You are ' + pct + '% through.', url: courseUrl(course.id, f.key), tag: 'learna-nudge-' + course.id };
  return { title: course.title + ' is saved where you left it', body: done + ' lesson' + (done === 1 ? '' : 's') + ' done. Your place is kept and there is no deadline.', url: courseUrl(course.id, f.key), tag: 'learna-nudge-' + course.id };
}

/**
 * Runs from the scheduled handler. Handles at most BATCH due inactivity markers per run.
 * Returns a small report (useful in tests and logs).
 */
export async function runLearnaNudges(env, now = new Date(), deps = {}) {
  const report = { checked: 0, sent: 0, skipped: [] };
  if (!kv(env)) return report;
  const nowIso = now.toISOString();
  const l = await kv(env).list({ prefix: 'lq:', limit: 50 });
  const due = l.keys.filter((k) => k.name.slice(3, 27) <= nowIso).slice(0, BATCH);
  if (!due.length) return report;
  const courses = await loadCourseMap(env);
  for (const k of due) {
    report.checked++;
    const parts = k.name.slice(28).split(':');           // after "lq:" + 24-char ISO + ":"
    const uid = parts[0], courseId = parts.slice(1).join(':');
    let stage = 1;
    try { const v = await kv(env).get(k.name); if (v) stage = JSON.parse(v).stage || 1; } catch (_) { /* default stage */ }
    await kv(env).delete(k.name).catch(() => {});        // at most once: a crash loses one reminder, never repeats it
    try {
      const entry = courses.get(courseId);
      const progress = await fsGet('learna_progress/' + uid + '_' + courseId, env);
      if (!entry || !entry.course || !progress || progress.status !== 'active') { report.skipped.push('inactive-course'); continue; }
      const idleDays = (now.getTime() - new Date(progress.lastActivityAt).getTime()) / DAY;
      if (idleDays < STAGE_DELAYS_DAYS[stage] - 0.5) { report.skipped.push('active-again'); continue; }
      const prefs = await getPrefs(env, uid);
      if (prefs.nudges === false) { report.skipped.push('off'); continue; }
      const caps = withinCaps(prefs, now);
      if (!caps.ok) { await kv(env).put(dueKey(nextAllowed(caps.retryAfter, prefs.tz).toISOString(), uid, courseId), JSON.stringify({ stage }), { expirationTtl: 40 * 86400 }); report.skipped.push('cap'); continue; }
      if (inQuietHours(now, prefs.tz)) { await kv(env).put(dueKey(nextAllowed(now, prefs.tz).toISOString(), uid, courseId), JSON.stringify({ stage }), { expirationTtl: 3 * 86400 }); report.skipped.push('quiet'); continue; }
      const msg = inactivityMessage(entry.course, progress, stage);
      const r = await push(env, uid, msg, deps);
      if (!r.subs) { report.skipped.push('no-subscription'); continue; }
      if (r.sent) { await record(env, uid, prefs); report.sent++; }
      if (STAGE_DELAYS_DAYS[stage + 1]) {
        const key = await scheduleStage(env, uid, courseId, stage + 1, progress.lastActivityAt);
        await fsSet('learna_progress/' + uid + '_' + courseId, { ...progress, nudgeKey: key }, env);
      }
    } catch (e) { console.error('[learna-nudges] failed:', e.message); report.skipped.push('error'); }
  }
  return report;
}
