// learna/assignments.js
// Real tasks: written, spoken, recorded on video, or coded. One submission document per attempt.
//
// Trust model
//  - Recorded speech is transcribed by the SERVER (Whisper). Pace and filler counts come from that transcript and the duration
//    Whisper reports, so a learner cannot edit them. The rubric is marked from the same transcript.
//  - A task with review 'admin' or 'both' is not complete for a certificate until a reviewer approves it.
//  - Video is stored and shown to reviewers. Nothing is inferred from it automatically.
//  - A learner can only read their own recordings. A reviewer (admin or moderator) can read any, through the Worker.
//
// Data   learna_submissions/{id}   one attempt: who, what, text or media key, measurements, status, reviewer decision
// Files  learna-sub/{uid}/{id}.bin  the recording, in B2 (same store the Note Taker uses for saved audio)

import { fsGet, fsSet, fsQuery } from '../firestore-rest.js';
import { b2UploadFile, b2DownloadFileBytes, b2DeleteAllVersions } from '../b2-client.js';
import { getPlan, MODEL_TIERS, resolveChatTier, UNLIMITED } from '../entitlements.js';
import { checkAndIncrement, refundUsage, reserveUsage, adjustUsage } from '../usage.js';
import { callWithFallback, makeSessionId } from '../providers.js';
import * as E from './engine.js';
import { transcribe } from './speech.js';
import { ok, fail, saveProgress, randomId, clean } from './http.js';
import { noteActivity } from './nudges.js';

const SUB = 'learna_submissions/';
const SPEECH_USAGE = 'learnaSpeechSeconds';
const TUTOR_USAGE = 'learnaTutor';
const HARD_MEDIA_MAX = 30 * 1024 * 1024;
const MEDIA_TYPES = { audio: ['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/mpeg', 'audio/wav'], video: ['video/webm', 'video/mp4'] };
export const mediaKey = (uid, id) => 'learna-sub/' + uid + '/' + id + '.bin';

const freshAct = () => ({ attempts: 0, hintsUsed: 0, passed: false, revealed: false, mistakes: [], lastFeedback: null });

function stepFor(course, lessonKey, activityId) {
  const f = E.flatLessons(course).find((x) => x.key === lessonKey);
  if (!f) return null;
  const st = f.lesson.steps.find((s) => s.id === activityId);
  return st && st.kind === 'activity' && st.type === 'assignment' ? { f, st } : null;
}

async function markWithModel(env, account, uid, course, st, text, opts) {
  const limit = getPlan(account.planId).limits.learnaTutorPerDay;
  let taken = false;
  if (limit < UNLIMITED) {
    const q = await checkAndIncrement(uid, TUTOR_USAGE, limit, env);
    if (!q.allowed) return { error: fail('You have used all ' + q.limit + ' tutor checks for today. They reset at midnight UTC.', 429, env, 'DAILY_LIMIT') };
    taken = true;
  }
  try {
    const key = resolveChatTier(account.planId, 'advanced');
    const tier = MODEL_TIERS[key === 'v0' ? 'advanced' : key];
    const res = await callWithFallback(tier, E.markerPrompt(course, st, text, opts), env, { maxTokens: 500, jsonMode: true, feature: 'learna-mark', sessionId: await makeSessionId('learna', uid) });
    const marked = E.parseMarker(res.text, st);
    if (!marked) throw new Error('unparseable');
    return { marked };
  } catch (e) {
    console.error('[learna] assignment marking failed:', e.message);
    if (taken) await refundUsage(uid, TUTOR_USAGE, env).catch(() => {});
    return { error: fail('The tutor could not check your work right now. This try was not counted. Please try again.', 503, env, 'ASSESSMENT_UNAVAILABLE') };
  }
}

/**
 * Handles POST /api/learna/courses/:id/assignments/submit for every format.
 * `ctx` = { env, request, uid, account, course, p }.
 */
export async function submitAssignment(ctx) {
  const { env, request, uid, account, course, p } = ctx;
  const plan = getPlan(account.planId);
  const ct = String(request.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  const isMedia = ct.startsWith('audio/') || ct.startsWith('video/');
  let body = {}, bytes = null, lessonKey, activityId, durationMs = 0;
  if (isMedia) {
    lessonKey = request.headers.get('X-Learna-Lesson'); activityId = request.headers.get('X-Learna-Activity'); durationMs = Number(request.headers.get('X-Duration-Ms') || 0);
    const cap = Math.min(plan.limits.learnaSubmissionMB * 1048576, HARD_MEDIA_MAX);
    if (cap <= 0) return fail('Submitting recordings is not included in ' + plan.name + '.', 403, env, 'PLAN_REQUIRED');
    if (Number(request.headers.get('Content-Length') || 0) > cap) return fail('This recording is larger than the ' + Math.round(cap / 1048576) + ' MB ' + plan.name + ' allows. Record a shorter one.', 413, env, 'TOO_LARGE');
    bytes = new Uint8Array(await request.arrayBuffer());
    if (!bytes.length) return fail('No recording received.', 400, env);
    if (bytes.length > cap) return fail('This recording is larger than the ' + Math.round(cap / 1048576) + ' MB ' + plan.name + ' allows. Record a shorter one.', 413, env, 'TOO_LARGE');
  } else {
    if (ct && ct !== 'application/json') return fail('That kind of file is not supported. Use the recorder in Cognita.', 415, env, 'BAD_FORMAT');
    body = await request.json().catch(() => ({}));
    lessonKey = body.lesson; activityId = body.activity;
  }
  const found = stepFor(course, String(lessonKey || ''), String(activityId || ''));
  if (!found) return fail('That task does not exist. Reload the lesson.', 404, env, 'OUT_OF_SYNC');
  const { f, st } = found;
  if (!E.isUnlocked(course, p, f.key)) return fail('Finish the earlier lessons first.', 403, env, 'LESSON_LOCKED');
  const ls = E.lessonState(p, f.key, f.lesson.rev);
  const a = ls.acts[st.id] || (ls.acts[st.id] = freshAct());
  if (a.review === 'pending') return fail('This task is waiting for a reviewer. You can send a new version after you hear back.', 409, env, 'PENDING_REVIEW');
  if (a.review === 'approved' || (a.review === 'auto' && a.passed)) return fail('This task is already complete.', 409, env, 'ALREADY_DONE');
  const redo = a.review === 'changes';
  if (!redo && a.attempts >= st.maxAttempts) return fail('You have used every try on this task.', 409, env, 'ALREADY_DONE');
  if (redo && (a.resubmits || 0) >= 10) return fail('This task has been resubmitted many times. Ask your reviewer for guidance.', 409, env);

  if (isMedia) {
    if (st.format === 'text' || st.format === 'code') return fail('This task is written, not recorded.', 400, env);
    if (!MEDIA_TYPES[st.format] || !MEDIA_TYPES[st.format].includes(ct)) return fail('That ' + st.format + ' format is not supported. Use the recorder in Cognita.', 415, env, 'BAD_FORMAT');
  } else if (['audio', 'video'].includes(st.format)) return fail('This task needs a recording.', 400, env, 'NEEDS_RECORDING');

  const id = randomId(10);
  const sub = {
    kind: 'submission', id, uid, courseId: course.id, courseVersion: course.version, lesson: f.key, activity: st.id, taskTitle: st.title, lessonTitle: f.lesson.title,
    format: st.format, review: st.review, attempt: a.attempts + 1, createdAt: new Date().toISOString(), status: 'pending',
  };
  let outcome = { correct: true, feedback: '' }, checklist = null, metrics = null, usageUndo = null;

  // ── marking ──
  if (st.format === 'text') {
    const text = clean(body.text, 6000);
    if (E.countWords(text) < (st.minWords || 1)) return ok({ result: { correct: false, invalid: true, feedback: 'Write a little more. This task needs at least ' + st.minWords + ' words.' } }, env);
    sub.text = text;
    if (st.review !== 'admin') {
      const m = await markWithModel(env, account, uid, course, st, text, {});
      if (m.error) return m.error;
      const d = E.decideOpen(st, m.marked.met);
      outcome = { correct: d.correct, feedback: m.marked.feedback };
      checklist = st.rubric.map((r) => ({ label: r.label, met: m.marked.met[r.id] === true }));
    } else outcome = { correct: true, feedback: 'Submitted. A reviewer will read it.' };
  } else if (st.format === 'code') {
    const source = clean(body.source, 12000);
    if (!source) return ok({ result: { correct: false, invalid: true, feedback: 'Write your code first.' } }, env);
    const ch = a.challenge && a.challenge.nonce === body.nonce ? a.challenge : null;
    if ((st.hidden || []).length && !ch) return ok({ result: { correct: false, invalid: true, needChallenge: true, feedback: 'Run your code again so the tests can start fresh.' } }, env);
    const r = E.checkCodeResults(st, body.results, ch);
    delete a.challenge;
    if (r.invalid) { await saveProgress(env, uid, course, p); return ok({ result: { correct: false, invalid: true, needChallenge: r.needChallenge, feedback: r.feedback } }, env); }
    checklist = r.checklist; outcome = { correct: r.correct, feedback: r.feedback };
    sub.text = source; sub.flags = E.scanCodeSource(st, source);
    if (r.correct && sub.flags.length) a.flagged = sub.flags;
  } else {
    // audio or video
    const seconds = Math.round(durationMs / 1000);
    const maxS = st.format === 'video' ? Math.min(st.maxSeconds, plan.limits.learnaVideoSeconds || st.maxSeconds) : st.maxSeconds;
    if (st.format === 'video' && !(plan.limits.learnaVideoSeconds > 0)) return fail('Video tasks are not included in ' + plan.name + '.', 403, env, 'PLAN_REQUIRED');
    if (seconds && st.minSeconds && seconds < st.minSeconds - 1) return ok({ result: { correct: false, invalid: true, feedback: 'Record at least ' + st.minSeconds + ' seconds. Yours was ' + seconds + '.' } }, env);
    if (seconds && maxS && seconds > maxS + 2) return ok({ result: { correct: false, invalid: true, feedback: 'Keep it under ' + maxS + ' seconds. Yours was ' + seconds + '.' } }, env);
    sub.mediaType = ct; sub.mediaBytes = bytes.length; sub.seconds = seconds;
    const needsAuto = st.format === 'audio' && st.review !== 'admin';
    if (needsAuto) {
      const limit = plan.limits.learnaSpeechSecondsPerDay;
      const estimate = Math.max(5, Math.min(200, seconds || 30));
      let reservation = null;
      if (limit < UNLIMITED) {
        try { reservation = await reserveUsage(uid, SPEECH_USAGE, estimate, limit, env); } catch (_) { return fail('Could not check your speaking allowance. Please try again.', 503, env, 'QUOTA_UNAVAILABLE'); }
        if (!reservation.allowed) return fail('You have used today\u2019s speaking-check time. It resets at midnight UTC. You can record again tomorrow.', 429, env, 'DAILY_LIMIT');
      }
      usageUndo = async () => { if (reservation) await adjustUsage(uid, SPEECH_USAGE, -estimate, reservation.day, env).catch(() => {}); };
      let tr;
      try { tr = await transcribe(env, bytes, st.lang || 'en-NG'); }
      catch (e) { console.error('[learna] transcription failed:', e.message); await usageUndo(); return fail('Your recording could not be checked right now. This try was not counted. Please try again.', 503, env, 'ASSESSMENT_UNAVAILABLE'); }
      if (reservation && tr.seconds && Math.round(tr.seconds) !== estimate) await adjustUsage(uid, SPEECH_USAGE, Math.round(tr.seconds) - estimate, reservation.day, env).catch(() => {});
      sub.transcript = tr.text.slice(0, 6000);
      metrics = E.speechMetrics(tr.text, tr.seconds || seconds || 1); sub.metrics = metrics;
      if (E.countWords(tr.text) < 8) {
        await saveProgress(env, uid, course, p);
        return ok({ result: { correct: false, invalid: true, feedback: 'Very little speech was heard. Check that your microphone is working and the room is quiet, then record again.', transcript: tr.text } }, env);
      }
      const ruleRes = E.evaluateMetricRules(st, metrics);
      let rubricRes = [], feedback = '', rubricOk = true;
      if ((st.rubric || []).length) {
        const m = await markWithModel(env, account, uid, course, st, tr.text, { transcript: true, metrics });
        if (m.error) { if (usageUndo) await usageUndo(); return m.error; }
        rubricRes = st.rubric.map((r) => ({ label: r.label, met: m.marked.met[r.id] === true }));
        rubricOk = E.decideOpen(st, m.marked.met).correct; feedback = m.marked.feedback;
      }
      const rulesOk = ruleRes.every((r) => r.met);
      checklist = [...ruleRes.map((r) => ({ label: r.label, met: r.met })), ...rubricRes];
      const notes = [];
      if (ruleRes.some((r) => r.metric === 'wpm' || r.id === 'pace')) notes.push('Pace: ' + metrics.wpm + ' words per minute.');
      if (ruleRes.some((r) => r.id === 'fillers')) notes.push('Filler words: ' + metrics.fillerTotal + (Object.keys(metrics.fillers).length ? ' (' + Object.entries(metrics.fillers).map(([k, v]) => k + ' x' + v).join(', ') + ')' : '') + '.');
      outcome = { correct: rulesOk && rubricOk, feedback: [feedback, ...notes].filter(Boolean).join(' ') || (rulesOk ? 'Your recording meets the checklist.' : 'Check the measured items below.') };
    } else outcome = { correct: true, feedback: 'Submitted. A reviewer will watch it.' };
  }

  // ── store and update progress ──
  const needsReview = st.review === 'admin' || st.review === 'both';
  if (!outcome.correct) {
    // A failed automatic attempt is recorded, but its recording is not kept.
    sub.status = 'auto_failed'; sub.checklist = checklist; sub.feedback = outcome.feedback;
    await fsSet(SUB + id, sub, env);
    a.attempts += 1; a.lastFeedback = outcome.feedback.slice(0, 500); a.submissionId = a.submissionId || null;
    a.mistakes = [...(a.mistakes || []), sub.text ? sub.text.slice(0, 120) : 'attempt ' + a.attempts].slice(-3);
    if (redo) a.resubmits = (a.resubmits || 0) + 1;
    if (a.attempts >= st.maxAttempts && !redo) a.revealed = true;
    await saveProgress(env, uid, course, p);
    return ok({ result: { correct: false, feedback: outcome.feedback, checklist, metrics, attemptsLeft: Math.max(0, st.maxAttempts - a.attempts), revealed: a.revealed ? E.revealFor(st) : null }, act: E.actView(a), canAdvance: E.canAdvance(st, ls) }, env);
  }
  if (bytes) {
    try { await b2UploadFile(env, mediaKey(uid, id), bytes, ct); sub.mediaKey = mediaKey(uid, id); }
    catch (e) { console.error('[learna] media upload failed:', e.message); if (usageUndo) await usageUndo(); return fail('Your recording could not be saved. This try was not counted. Please try again.', 502, env, 'STORAGE_FAILED'); }
  }
  sub.status = needsReview ? 'pending' : 'auto_passed'; sub.checklist = checklist; sub.feedback = outcome.feedback;
  await fsSet(SUB + id, sub, env);
  a.attempts += 1; a.passed = true; a.revealed = false; a.submissionId = id; a.lastFeedback = outcome.feedback.slice(0, 500); a.score = null;
  a.review = needsReview ? 'pending' : 'auto'; a.reviewNote = null;
  if (redo) a.resubmits = (a.resubmits || 0) + 1;
  if (a.review === 'pending') a.passed = true; // the learner may carry on; the certificate waits for approval
  await noteActivity(env, p);
  await saveProgress(env, uid, course, p);
  return ok({ result: { correct: true, feedback: outcome.feedback, checklist, metrics, pendingReview: needsReview }, act: E.actView(a), canAdvance: E.canAdvance(st, ls), submissionId: id }, env, 201);
}

// ── Reading ─────────────────────────────────────────────────────────────
export const publicSubmission = (s, { admin = false } = {}) => ({
  id: s.id, courseId: s.courseId, lesson: s.lesson, activity: s.activity, taskTitle: s.taskTitle, lessonTitle: s.lessonTitle, format: s.format, status: s.status, attempt: s.attempt,
  createdAt: s.createdAt, feedback: s.feedback || null, checklist: s.checklist || null, metrics: s.metrics || null, seconds: s.seconds || null, hasMedia: !!s.mediaKey, mediaType: s.mediaType || null,
  review: s.reviewDecision ? { decision: s.reviewDecision, note: s.reviewNote || '', at: s.reviewedAt } : null,
  ...(admin ? { uid: s.uid, text: s.text || null, transcript: s.transcript || null, flags: s.flags || [], reviewedBy: s.reviewedBy || null, courseVersion: s.courseVersion } : { text: s.text || null, transcript: s.transcript || null }),
});

export async function listMine(env, uid, courseId) {
  const rows = await fsQuery('learna_submissions', 'uid', uid, null, 100, env);
  return rows.filter((r) => r.kind === 'submission' && r.courseId === courseId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).map((r) => publicSubmission(r));
}

/** Streams a recording to its owner, or to a reviewer. `isReviewer` comes from admin-auth, never from the request. */
export async function getMedia(env, uid, isReviewer, id) {
  if (!/^[a-f0-9]{20}$/.test(id)) return fail('Not found.', 404, env);
  const s = await fsGet(SUB + id, env);
  if (!s || !s.mediaKey || (s.uid !== uid && !isReviewer)) return fail('Not found.', 404, env);
  const res = await b2DownloadFileBytes(env, s.mediaKey);
  if (!res) return fail('This recording is no longer stored.', 404, env);
  return new Response(res.body, { status: 200, headers: { 'Content-Type': s.mediaType || 'application/octet-stream', 'Cache-Control': 'private, no-store', 'Access-Control-Allow-Origin': env?.APP_ORIGIN || '*' } });
}

export async function deleteSubmissionMedia(env, uid, id) { await b2DeleteAllVersions(env, mediaKey(uid, id)).catch(() => {}); }
