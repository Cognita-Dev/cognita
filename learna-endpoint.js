// learna-endpoint.js
// Learna: course-aware learning inside Cognita. One entry point, handleLearnaRequest,
// routed from worker.js for every /api/learna/* path.
//
// Trust model: the browser sends only "which course", "which lesson/activity" and
// the learner's answer. The uid comes from the verified token, the plan from
// resolveAccountWithRole, and every grade, position and progress change is
// decided here from the course data in learna/. The browser never receives
// answer keys, rubric exemplars or test expectations.
//
// Course limit (Plus = 2): a course is "taken" while its progress record is
// active. Each active course on a limited plan holds a slot document,
// learna_slots/{uid}_{n}, created with fsCreate (atomic, create-only), so two
// parallel enrol requests can never both take the last slot. Finishing a
// course frees its slot. Studio and Admin have no slot documents.
//
// Data:  learna_progress/{uid}_{courseId}   enrolment + position + activity results
//        learna_slots/{uid}_{n}             Plus course slots

import { requireAuth, describeAuthError } from './auth-middleware.js';
import { resolveAccountWithRole } from './subscription.js';
import { getPlan, planSatisfies, MODEL_TIERS, UNLIMITED, resolveChatTier } from './entitlements.js';
import { fsGet, fsSet, fsCreate, fsDelete, fsQuery } from './firestore-rest.js';
import { checkAndIncrement, refundUsage } from './usage.js';
import { callWithFallback, makeSessionId } from './providers.js';
import * as E from './learna/engine.js';

const TUTOR_USAGE = 'learnaTutor';
const MAX_SLOT_SCAN = 10;

const headers = (env) => ({ 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': env?.APP_ORIGIN || '*', 'Cache-Control': 'no-store' });
const ok = (body, env, status = 200) => new Response(JSON.stringify(body), { status, headers: headers(env) });
const fail = (message, status, env, code) => new Response(JSON.stringify({ error: message, ...(code ? { code } : {}) }), { status, headers: headers(env) });

const progressPath = (uid, courseId) => 'learna_progress/' + uid + '_' + courseId;
const slotPath = (uid, n) => 'learna_slots/' + uid + '_' + n;

function planInfo(account) {
  const plan = getPlan(account.planId);
  const limit = plan.limits.learnaCourses;
  return { planId: account.planId, planName: plan.name, courseLimit: limit >= UNLIMITED ? null : limit, canTake: limit > 0 };
}

function accessFor(course, account) {
  const info = planInfo(account);
  if (!info.canTake || !planSatisfies(account.planId, course.access)) return { allowed: false, reason: 'PLAN_REQUIRED', requiredPlan: course.access };
  return { allowed: true };
}

async function listProgress(env, uid) {
  const rows = await fsQuery('learna_progress', 'uid', uid, null, 50, env);
  return rows.filter((r) => E.COURSE_MAP[r.courseId]);
}

async function loadProgress(env, uid, course) {
  const p = await fsGet(progressPath(uid, course.id), env);
  if (!p) return null;
  p.lessons = p.lessons || {};
  const r = E.reconcileVersion(p, course);
  if (r.changed) await fsSet(progressPath(uid, course.id), p, env);
  p._notice = r.notice;
  return p;
}

async function saveProgress(env, uid, course, p) {
  p.lastActivityAt = new Date().toISOString();
  const { _notice, ...clean } = p;
  await fsSet(progressPath(uid, course.id), clean, env);
}

// ── Slots ───────────────────────────────────────────────────────────────
async function takeSlot(env, uid, courseId, limit) {
  for (let n = 1; n <= limit; n++) {
    const doc = { uid, courseId, createdAt: new Date().toISOString() };
    if (await fsCreate(slotPath(uid, n), doc, env)) return n;
    const held = await fsGet(slotPath(uid, n), env);
    if (held && held.courseId === courseId) return n;
    // Reclaim a slot whose course no longer has an active record (an earlier failed enrol).
    if (held) {
      const hp = await fsGet(progressPath(uid, held.courseId), env);
      if (!hp || hp.status !== 'active') { await fsSet(slotPath(uid, n), doc, env); return n; }
    }
  }
  return 0;
}

async function freeSlot(env, uid, courseId, limit) {
  for (let n = 1; n <= Math.min(Math.max(limit, 1), MAX_SLOT_SCAN); n++) {
    const held = await fsGet(slotPath(uid, n), env);
    if (held && held.courseId === courseId) await fsDelete(slotPath(uid, n), env);
  }
}

// ── Handlers ────────────────────────────────────────────────────────────
async function catalogue(env, uid, account) {
  const rows = await listProgress(env, uid);
  const mine = {};
  for (const r of rows) {
    const c = E.COURSE_MAP[r.courseId];
    r.lessons = r.lessons || {};
    E.reconcileVersion(r, c);
    mine[r.courseId] = { percent: E.percentComplete(c, r), status: r.status, lastActivityAt: r.lastActivityAt };
  }
  const info = planInfo(account);
  const active = rows.filter((r) => r.status === 'active').length;
  return {
    categories: E.CATEGORIES,
    courses: E.COURSES.map((c) => ({ ...E.courseSummary(c), access_state: accessFor(c, account) })),
    mine, viewer: { ...info, activeCourses: active, atLimit: info.courseLimit !== null && active >= info.courseLimit },
  };
}

async function courseDetailRes(env, uid, account, course) {
  const p = await loadProgress(env, uid, course);
  const rows = await listProgress(env, uid);
  const info = planInfo(account);
  const active = rows.filter((r) => r.status === 'active').length;
  return {
    course: E.courseDetail(course),
    access: accessFor(course, account),
    viewer: { ...info, activeCourses: active, atLimit: info.courseLimit !== null && active >= info.courseLimit },
    progress: p ? E.progressView(course, p) : null,
    notice: p ? p._notice : null,
  };
}

async function enroll(env, uid, account, course) {
  const acc = accessFor(course, account);
  if (!acc.allowed) return fail('Starting a course needs ' + getPlan(course.access).name + ' or higher.', 403, env, 'PLAN_REQUIRED');
  if (course.status !== 'available') return fail('This course is not open yet.', 409, env, 'COURSE_UNAVAILABLE');

  const existing = await loadProgress(env, uid, course);
  if (existing) return ok({ enrolled: true, already: true, progress: E.progressView(course, existing) }, env);

  const limit = getPlan(account.planId).limits.learnaCourses;
  let slot = null;
  if (limit < UNLIMITED) {
    slot = await takeSlot(env, uid, course.id, limit);
    if (!slot) return fail('You can take ' + limit + ' courses at the same time on ' + getPlan(account.planId).name + '. Finish a course or upgrade to start another.', 403, env, 'COURSE_LIMIT');
  }
  const p = E.newProgress(uid, course);
  try {
    const created = await fsCreate(progressPath(uid, course.id), p, env);
    if (!created) {
      const again = await loadProgress(env, uid, course);
      return ok({ enrolled: true, already: true, progress: E.progressView(course, again || p) }, env);
    }
  } catch (e) {
    if (slot) await fsDelete(slotPath(uid, slot), env).catch(() => {});
    throw e;
  }
  return ok({ enrolled: true, already: false, progress: E.progressView(course, p) }, env, 201);
}

function lessonResponse(course, p, key) {
  const lesson = E.publicLesson(course, key);
  const raw = E.flatLessons(course).find((f) => f.key === key).lesson;
  const ls = p.lessons[key] || { acts: {}, status: 'open' };
  const acts = {};
  for (const s of raw.steps) if (s.kind === 'activity') acts[s.id] = E.actView(ls.acts[s.id]);
  const isCurrent = p.current.lesson === key;
  return {
    lesson, acts, status: ls.status || 'open', mastery: ls.mastery || null,
    step: isCurrent ? p.current.step : (ls.status === 'done' ? raw.steps.length - 1 : 0), isCurrent,
    progress: E.progressView(course, p),
  };
}

function revealAfter(st, a) { return a && (a.revealed) ? E.revealFor(st) : null; }

async function submit(env, uid, account, course, p, body) {
  const f = E.flatLessons(course).find((x) => x.key === p.current.lesson);
  const st = f.lesson.steps[p.current.step];
  if (!st || st.kind !== 'activity' || st.id !== body.activity || body.lesson !== f.key) return fail('That activity is not the current step. Reload the lesson.', 409, env, 'OUT_OF_SYNC');
  const ls = E.lessonState(p, f.key, f.lesson.rev);
  const prev = ls.acts[st.id];
  if (prev && (prev.passed || prev.revealed)) return fail('This activity is already finished.', 409, env, 'ALREADY_DONE');

  let outcome;
  let checklist = null;
  let usageTaken = false;
  if (st.type === 'open') {
    const text = String(body.answer ?? '').trim();
    if (E.countWords(text) < (st.minWords || 1)) return ok({ result: { correct: false, invalid: true, feedback: 'Write a little more. This task needs at least ' + st.minWords + ' words.' } }, env);
    const limit = getPlan(account.planId).limits.learnaTutorPerDay;
    if (limit < UNLIMITED) {
      const q = await checkAndIncrement(uid, TUTOR_USAGE, limit, env);
      if (!q.allowed) return fail('You have used all ' + q.limit + ' tutor checks for today. They reset at midnight UTC.', 429, env, 'DAILY_LIMIT');
      usageTaken = true;
    }
    let marked = null;
    try {
      const tier = MODEL_TIERS[resolveChatTier(account.planId, 'advanced') === 'v0' ? 'advanced' : resolveChatTier(account.planId, 'advanced')];
      const res = await callWithFallback(tier, E.markerPrompt(course, st, text), env, { maxTokens: 500, jsonMode: true, feature: 'learna-mark', sessionId: await makeSessionId('learna', uid) });
      marked = E.parseMarker(res.text, st);
    } catch (e) { console.error('[learna] marking failed:', e.message); }
    if (!marked) {
      if (usageTaken) await refundUsage(uid, TUTOR_USAGE, env).catch(() => {});
      return fail('The tutor could not check your answer right now. This try was not counted. Please try again.', 503, env, 'ASSESSMENT_UNAVAILABLE');
    }
    const d = E.decideOpen(st, marked.met);
    outcome = { correct: d.correct, feedback: marked.feedback };
    checklist = st.rubric.map((r) => ({ label: r.label, met: marked.met[r.id] === true }));
  } else if (st.type === 'code') {
    outcome = E.checkCodeResults(st, body.results);
    if (outcome.invalid) return ok({ result: { correct: false, invalid: true, feedback: outcome.feedback } }, env);
    checklist = st.tests.map((t, i) => ({ label: t.name, met: !(outcome.failed || []).some((x) => x.name === t.name) }));
  } else {
    outcome = E.checkDeterministic(st, body.answer);
    if (outcome.invalid) return ok({ result: { correct: false, invalid: true, feedback: outcome.feedback } }, env);
  }

  const a = E.recordAttempt(ls, st, { correct: outcome.correct, feedback: outcome.feedback, answerText: typeof body.answer === 'string' ? body.answer : JSON.stringify(body.answer ?? body.code ?? '') });
  await saveProgress(env, uid, course, p);
  return ok({
    result: { correct: outcome.correct, feedback: outcome.feedback, checklist, attemptsLeft: Math.max(0, st.maxAttempts - a.attempts), revealed: revealAfter(st, a) },
    act: E.actView(a), canAdvance: E.canAdvance(st, ls),
  }, env);
}

async function hint(env, course, uid, p, body) {
  const f = E.flatLessons(course).find((x) => x.key === p.current.lesson);
  const st = f.lesson.steps[p.current.step];
  if (!st || st.kind !== 'activity' || st.id !== body.activity || body.lesson !== f.key) return fail('That activity is not the current step. Reload the lesson.', 409, env, 'OUT_OF_SYNC');
  const ls = E.lessonState(p, f.key, f.lesson.rev);
  const a = ls.acts[st.id] || (ls.acts[st.id] = { attempts: 0, hintsUsed: 0, passed: false, revealed: false, mistakes: [], lastFeedback: null });
  if (a.passed || a.revealed) return fail('This activity is already finished.', 409, env, 'ALREADY_DONE');
  const hints = st.hints || [];
  if (a.hintsUsed >= hints.length) return ok({ hint: null, message: 'There are no more hints for this activity.', act: E.actView(a) }, env);
  const text = hints[a.hintsUsed];
  a.hintsUsed += 1;
  await saveProgress(env, uid, course, p);
  return ok({ hint: text, hintsLeft: hints.length - a.hintsUsed, act: E.actView(a) }, env);
}

async function advanceStep(env, account, uid, course, p, body) {
  if (body.lesson !== p.current.lesson || body.step !== p.current.step) return fail('Your place changed. Reload the lesson.', 409, env, 'OUT_OF_SYNC');
  const r = E.advance(course, p);
  if (!r.ok) return fail(r.message, 409, env, r.code);
  if (r.event === 'course_complete') await freeSlot(env, uid, course.id, getPlan(account.planId).limits.learnaCourses).catch((e) => console.error('[learna] slot free failed:', e.message));
  await saveProgress(env, uid, course, p);
  return ok({ event: r.event, mastery: r.mastery || null, progress: E.progressView(course, p), next: r.next || null }, env);
}

async function tutor(env, account, uid, course, p, body) {
  const message = String(body.message ?? '').trim();
  if (message.length < 2) return fail('Type a question first.', 400, env);
  if (message.length > 600) return fail('Keep the question under 600 characters.', 400, env);
  const limit = getPlan(account.planId).limits.learnaTutorPerDay;
  let taken = false;
  if (limit < UNLIMITED) {
    const q = await checkAndIncrement(uid, TUTOR_USAGE, limit, env);
    if (!q.allowed) return fail('You have used all ' + q.limit + ' tutor replies for today. They reset at midnight UTC.', 429, env, 'DAILY_LIMIT');
    taken = true;
  }
  const ctx = E.buildTutorContext(course, p);
  try {
    const key = resolveChatTier(account.planId, 'advanced');
    const tier = MODEL_TIERS[key === 'v0' ? 'advanced' : key];
    const res = await callWithFallback(tier, [{ role: 'system', content: E.tutorSystemPrompt(ctx) }, { role: 'user', content: E.tutorUserPrompt(ctx, message) }], env, { maxTokens: 450, feature: 'learna-tutor', sessionId: await makeSessionId('learna', uid) });
    const reply = String(res.text || '').replace(/\u2014/g, ',').trim().slice(0, 1200);
    if (!reply) throw new Error('empty');
    return ok({ reply }, env);
  } catch (e) {
    console.error('[learna] tutor failed:', e.message);
    if (taken) await refundUsage(uid, TUTOR_USAGE, env).catch(() => {});
    return fail('Your tutor is not available right now. This question was not counted. Please try again.', 503, env, 'TUTOR_UNAVAILABLE');
  }
}

// ── Router ──────────────────────────────────────────────────────────────
export async function handleLearnaRequest(request, env) {
  let identity;
  try { identity = await requireAuth(request, env); } catch (e) { const { status, message } = describeAuthError(e); return fail(message, status, env); }
  const uid = identity.uid;

  const url = new URL(request.url);
  const parts = url.pathname.replace(/^\/api\/learna\/?/, '').split('/').filter(Boolean);
  const method = request.method;

  try {
    const account = await resolveAccountWithRole(uid, env);

    if (parts[0] === 'catalogue' && parts.length === 1 && method === 'GET') return ok(await catalogue(env, uid, account), env);
    if (parts[0] !== 'courses' || !parts[1]) return fail('Not found.', 404, env);

    const course = E.COURSE_MAP[parts[1]];
    if (!course) return fail('This course does not exist.', 404, env, 'COURSE_UNAVAILABLE');
    const action = parts[2];

    if (!action && method === 'GET') return ok(await courseDetailRes(env, uid, account, course), env);
    if (action === 'enroll' && method === 'POST') return await enroll(env, uid, account, course);

    // Everything below needs an enrolment and a plan that can take courses.
    if (!planInfo(account).canTake) return fail('Starting a course needs Cognita Plus or higher.', 403, env, 'PLAN_REQUIRED');
    const p = await loadProgress(env, uid, course);
    if (!p) return fail('You have not started this course.', 403, env, 'NOT_ENROLLED');

    if (action === 'progress' && method === 'GET') return ok({ progress: E.progressView(course, p), notice: p._notice }, env);
    if (action === 'lessons' && parts[3] && method === 'GET') {
      if (!E.isUnlocked(course, p, parts[3])) return fail('Finish the earlier lessons first.', 403, env, 'LESSON_LOCKED');
      return ok({ ...lessonResponse(course, p, parts[3]), notice: p._notice }, env);
    }

    if (method !== 'POST') return fail('Not found.', 404, env);
    const body = await request.json().catch(() => ({}));
    if (p.status === 'completed' && action !== 'tutor') return fail('You have finished this course.', 409, env, 'COURSE_COMPLETED');

    if (action === 'advance') return await advanceStep(env, account, uid, course, p, body);
    if (action === 'submit') return await submit(env, uid, account, course, p, body);
    if (action === 'hint') return await hint(env, course, uid, p, body);
    if (action === 'restart') {
      if (body.lesson !== p.current.lesson) return fail('Your place changed. Reload the lesson.', 409, env, 'OUT_OF_SYNC');
      const ls = p.lessons[p.current.lesson];
      if (!ls || ls.status !== 'review') return fail('This lesson does not need to be repeated.', 409, env);
      E.restartLesson(course, p);
      await saveProgress(env, uid, course, p);
      return ok({ progress: E.progressView(course, p) }, env);
    }
    if (action === 'tutor') return await tutor(env, account, uid, course, p, body);
    return fail('Not found.', 404, env);
  } catch (e) {
    console.error('[learna] request failed:', e.message);
    return fail('Something went wrong on our side. Please try again.', 500, env);
  }
}
