// learna-endpoint.js
// Learna: course-aware learning inside Cognita. One entry point, handleLearnaRequest,
// routed from worker.js for every /api/learna/* path.
//
// Trust model: the browser sends only "which course", "which lesson/activity" and
// the learner's answer. The uid comes from the verified token, the plan from
// resolveAccountWithRole, and every grade, position and progress change is
// decided here from the course data in learna/ (or the admin-edited copy stored
// in Firestore, see learna/course-store.js). The browser never receives
// answer keys, rubric exemplars or test expectations.
//
// Code tasks: the browser runs the learner's code in the Cognita sandbox and reports values. A Worker cannot run learner JavaScript,
// so the server cannot prove the code ran. It therefore (1) ties every run to a one-time server challenge that adds randomly
// chosen hidden cases, (2) never exposes expected values, (3) keeps and scans the source, and (4) offers an independent re-run
// (scripts/verify-code-submissions.mjs). See learna/README.md, "Code grading trust".
//
// Course limit (Plus = 2): a course is "taken" while its progress record is
// active. Each active course on a limited plan holds a slot document,
// learna_slots/{uid}_{n}, created with fsCreate (atomic, create-only), so two
// parallel enrol requests can never both take the last slot. Finishing a
// course frees its slot. Studio and Admin have no slot documents.
//
// Data:  learna_progress/{uid}_{courseId}     enrolment + position + activity results
//        learna_slots/{uid}_{n}               Plus course slots
//        learna_courses/{id}                  admin-edited courses
//        learna_submissions/{id}              task submissions
//        learna_certificates/{id}             issued certificates
//        learna_code_attempts/{key}           latest passing code source per task (for independent re-runs)
//        learna_prefs/{uid}                   notification choices

import { requireAuth, describeAuthError } from './auth-middleware.js';
import { resolveAccountWithRole } from './subscription.js';
import { getPlan, planSatisfies, MODEL_TIERS, UNLIMITED, resolveChatTier } from './entitlements.js';
import { fsGet, fsSet, fsCreate, fsDelete, fsQuery } from './firestore-rest.js';
import { checkAndIncrement, refundUsage, reserveUsage, adjustUsage } from './usage.js';
import { callWithFallback, makeSessionId } from './providers.js';
import * as E from './learna/engine.js';
import { loadCourseMap, getLearnerCourse } from './learna/course-store.js';
import { ok, fail, progressPath, slotPath, planInfo, loadProgress, saveProgress } from './learna/http.js';
import { submitAssignment, listMine, getMedia } from './learna/assignments.js';
import { handleCertificate, verifyCertificate } from './learna/certificates-endpoint.js';
import { evaluateEligibility } from './learna/certificates.js';
import { VOICES, pickVoice, defaultLangFor, textForPart, synthesize, premiumAvailable, monthlyUsed, monthlyCap } from './learna/speech.js';
import { noteActivity, getPrefs, savePrefs } from './learna/nudges.js';

const TUTOR_USAGE = 'learnaTutor';
const TTS_USAGE = 'learnaTts';
const MAX_SLOT_SCAN = 10;
const SPEAK_PASS = 0.6;

function accessFor(course, account) {
  const info = planInfo(account);
  if (!info.canTake || !planSatisfies(account.planId, course.access)) return { allowed: false, reason: 'PLAN_REQUIRED', requiredPlan: course.access };
  return { allowed: true };
}

const isAdminAccount = (account) => account.planId === 'admin';

/** The course this person may see: published ones for everyone, unpublished ones for people already enrolled, drafts for admins. */
async function courseFor(env, id, uid, account) {
  const enrolled = !!(await fsGet(progressPath(uid, id), env));
  const got = await getLearnerCourse(env, id, { enrolled });
  if (got) return got;
  if (isAdminAccount(account)) { const e = (await loadCourseMap(env)).get(id); if (e && (e.course || e.draft)) return { course: e.course || e.draft, listed: false, draft: !e.course }; }
  return null;
}

async function listProgress(env, uid, map) {
  const rows = await fsQuery('learna_progress', 'uid', uid, null, 50, env);
  return rows.filter((r) => map.get(r.courseId) && (map.get(r.courseId).course || map.get(r.courseId).draft));
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
function reviewNotes(course, p) {
  const pending = [], changes = [];
  for (const a of E.assignmentsOf(course)) {
    const act = ((p.lessons[a.lessonKey] || {}).acts || {})[a.step.id];
    if (act && act.review === 'pending') pending.push(a.step.title);
    if (act && act.review === 'changes') changes.push(a.step.title);
  }
  return { pending, changes };
}

async function catalogue(env, uid, account) {
  const map = await loadCourseMap(env);
  const admin = isAdminAccount(account);
  const rows = await listProgress(env, uid, map);
  const mine = {};
  for (const r of rows) {
    const e = map.get(r.courseId); const c = e.course || e.draft;
    r.lessons = r.lessons || {};
    E.reconcileVersion(r, c);
    mine[r.courseId] = { percent: E.percentComplete(c, r), status: r.status, lastActivityAt: r.lastActivityAt };
  }
  const info = planInfo(account);
  const active = rows.filter((r) => r.status === 'active').length;
  const visible = [...map.values()].filter((e) => (e.status === 'published' && e.course) || admin || (e.course && mine[e.id]));
  return {
    categories: E.CATEGORIES,
    courses: visible.flatMap((e) => {
      const c = e.course || e.draft; let s;
      try { s = E.courseSummary(c); } catch (_) { return []; }   // a half-finished draft must never break the catalogue
      const hidden = e.status !== 'published';
      return [{ ...s, status: hidden ? 'unavailable' : s.status, adminState: hidden ? (e.status === 'unpublished' ? 'unpublished' : 'draft') : null, access_state: hidden && !admin ? { allowed: false, reason: 'UNPUBLISHED' } : accessFor(c, account) }];
    }),
    mine, viewer: { ...info, activeCourses: active, atLimit: info.courseLimit !== null && active >= info.courseLimit, isAdmin: admin },
  };
}

async function courseDetailRes(env, uid, account, got) {
  const course = got.course;
  const p = await loadProgress(env, uid, course);
  const map = await loadCourseMap(env);
  const rows = await listProgress(env, uid, map);
  const info = planInfo(account);
  const active = rows.filter((r) => r.status === 'active').length;
  const detail = E.courseDetail(course);
  if (!got.listed && !got.draft && !p) detail.status = 'unavailable';
  if (got.draft || (!got.listed && isAdminAccount(account))) detail.adminState = got.draft ? 'draft' : 'unpublished';
  let tasks = null, cert = null;
  if (p) {
    tasks = E.assignmentsOf(course).map((a) => { const act = E.actView(((p.lessons[a.lessonKey] || {}).acts || {})[a.step.id]); return { id: a.step.id, lesson: a.lessonKey, title: a.step.title, format: a.step.format, review: a.step.review, certRequired: !!a.step.certRequired, state: act.review || (act.passed ? 'done' : 'todo'), note: act.reviewNote }; });
    if (E.hasCertificate(course)) cert = evaluateEligibility(course, p);
  }
  return {
    course: detail, access: accessFor(course, account), viewer: { ...info, activeCourses: active, atLimit: info.courseLimit !== null && active >= info.courseLimit },
    progress: p ? E.progressView(course, p) : null, notice: p ? p._notice : null, tasks, certificate: cert ? { eligible: cert.eligible, requirements: cert.requirements } : null,
  };
}

async function enroll(env, uid, account, got) {
  const course = got.course;
  const acc = accessFor(course, account);
  if (!acc.allowed) return fail('Starting a course needs ' + getPlan(course.access).name + ' or higher.', 403, env, 'PLAN_REQUIRED');
  if (course.status !== 'available' || (!got.listed && !isAdminAccount(account))) return fail('This course is not open yet.', 409, env, 'COURSE_UNAVAILABLE');

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
    await noteActivity(env, p);
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

const revealAfter = (st, a) => (a && a.revealed ? E.revealFor(st) : null);

/** Finds an activity by lesson and id in an unlocked lesson. */
function findActivity(course, p, lessonKey, activityId) {
  const f = E.flatLessons(course).find((x) => x.key === lessonKey);
  if (!f || !E.isUnlocked(course, p, f.key)) return null;
  const st = f.lesson.steps.find((s) => s.id === activityId);
  return st && st.kind === 'activity' ? { f, st } : null;
}

/** May this activity be answered now? The current step, or a task or code check that was sent back for another go. */
function answerable(p, f, st, a) {
  const cur = p.current.lesson === f.key && f.lesson.steps[p.current.step] && f.lesson.steps[p.current.step].id === st.id;
  if (cur) return true;
  if (st.type === 'code' && a && a.codeVerdict === 'mismatch') return true;
  return false;
}

async function codeChallenge(env, uid, course, p, body) {
  const found = findActivity(course, p, body.lesson, body.activity);
  if (!found) return fail('That activity is not available. Reload the lesson.', 409, env, 'OUT_OF_SYNC');
  const { f, st } = found;
  const isCode = st.type === 'code' || (st.type === 'assignment' && st.format === 'code');
  if (!isCode) return fail('This activity has no code tests.', 400, env);
  const ls = E.lessonState(p, f.key, f.lesson.rev);
  const a = ls.acts[st.id] || (ls.acts[st.id] = { attempts: 0, hintsUsed: 0, passed: false, revealed: false, mistakes: [], lastFeedback: null });
  if (st.type === 'code' && !answerable(p, f, st, a)) return fail('That activity is not the current step. Reload the lesson.', 409, env, 'OUT_OF_SYNC');
  if (!(st.hidden || []).length) return ok({ nonce: null, expr: [] }, env);
  const ch = E.makeCodeChallenge(st);
  a.challenge = ch;
  await saveProgress(env, uid, course, p);
  return ok(E.publicChallenge(st, ch), env);
}

async function submit(env, uid, account, course, p, body) {
  const found = findActivity(course, p, body.lesson, body.activity);
  if (!found || found.st.type === 'assignment') return fail('That activity is not the current step. Reload the lesson.', 409, env, 'OUT_OF_SYNC');
  const { f, st } = found;
  const ls = E.lessonState(p, f.key, f.lesson.rev);
  const prev = ls.acts[st.id];
  if (!answerable(p, f, st, prev)) return fail('That activity is not the current step. Reload the lesson.', 409, env, 'OUT_OF_SYNC');
  const retry = !!(prev && prev.codeVerdict === 'mismatch');
  if (prev && (prev.passed || prev.revealed) && !retry) return fail('This activity is already finished.', 409, env, 'ALREADY_DONE');

  let outcome;
  let checklist = null;
  let usageTaken = false;
  let sourceToKeep = null;
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
    const a0 = ls.acts[st.id] || (ls.acts[st.id] = { attempts: 0, hintsUsed: 0, passed: false, revealed: false, mistakes: [], lastFeedback: null });
    const ch = a0.challenge && a0.challenge.nonce === body.nonce ? a0.challenge : null;
    outcome = E.checkCodeResults(st, body.results, ch);
    delete a0.challenge;                                   // a challenge works once
    if (outcome.invalid) { await saveProgress(env, uid, course, p); return ok({ result: { correct: false, invalid: true, needChallenge: !!outcome.needChallenge, feedback: outcome.feedback } }, env); }
    checklist = outcome.checklist;
    if (outcome.correct) {
      const source = String(body.source || '').slice(0, 12000);
      const flags = E.scanCodeSource(st, source);
      if (flags.length) a0.flagged = flags; else delete a0.flagged;
      sourceToKeep = { source, flags };
    }
  } else if (st.type === 'speak') {
    if (body.skip === true) outcome = { correct: true, skipped: true, feedback: 'Skipped. Speaking practice never blocks your progress.' };
    else {
      const m = E.speechMatch(st.target, body.transcript);
      if (!m.total || !String(body.transcript || '').trim()) return ok({ result: { correct: false, invalid: true, feedback: 'No speech was heard. Check your microphone and try again, or skip this practice.' } }, env);
      const pct = Math.round(m.score * 100);
      outcome = { correct: m.score >= SPEAK_PASS, match: m, feedback: 'The speech recogniser understood ' + m.matched + ' of ' + m.total + ' words (' + pct + '%).' + (m.missed.length ? ' It did not catch: ' + m.missed.slice(0, 6).join(', ') + '.' : '') + ' This shows the words were clear enough for a machine to recognise. It is not a score for accent or pronunciation.' };
    }
  } else {
    outcome = E.checkDeterministic(st, body.answer);
    if (outcome.invalid) return ok({ result: { correct: false, invalid: true, feedback: outcome.feedback } }, env);
  }

  const a = E.recordAttempt(ls, st, { correct: outcome.correct, feedback: outcome.feedback, answerText: typeof body.answer === 'string' ? body.answer : JSON.stringify(body.answer ?? body.source ?? body.transcript ?? '') });
  if (outcome.skipped) { a.skipped = true; a.passed = true; }
  if (st.type === 'speak' && outcome.match) a.score = outcome.match.score;
  if (retry && outcome.correct) { a.codeVerdict = 'pending'; a.revealed = false; }
  if (retry && !outcome.correct && a.attempts >= st.maxAttempts) a.revealed = false;
  if (sourceToKeep) {
    await fsSet('learna_code_attempts/' + uid + '_' + course.id + '_' + f.key + '_' + st.id, {
      kind: 'code_attempt', status: 'unverified', uid, courseId: course.id, courseVersion: course.version, lesson: f.key, activity: st.id, source: sourceToKeep.source, flags: sourceToKeep.flags, passedAt: new Date().toISOString(),
    }, env).catch((e) => console.error('[learna] code attempt not kept:', e.message));
    if (!retry) a.codeVerdict = 'pending';
  }
  await saveProgress(env, uid, course, p);
  return ok({
    result: { correct: outcome.correct, feedback: outcome.feedback, checklist, attemptsLeft: Math.max(0, st.maxAttempts - a.attempts), revealed: revealAfter(st, a), match: outcome.match || null, skipped: !!outcome.skipped },
    act: E.actView(a), canAdvance: E.canAdvance(st, ls),
  }, env);
}

async function hint(env, course, uid, p, body) {
  const f = E.flatLessons(course).find((x) => x.key === p.current.lesson);
  const st = f.lesson.steps[p.current.step];
  if (!st || st.kind !== 'activity' || st.id !== body.activity || body.lesson !== f.key) return fail('That activity is not the current step. Reload the lesson.', 409, env, 'OUT_OF_SYNC');
  if (f.lesson.exam) return fail('Hints are not available in an assessment.', 409, env, 'EXAM');
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
  if (r.event === 'lesson_done' || r.event === 'course_complete') await noteActivity(env, p);
  await saveProgress(env, uid, course, p);
  const out = { event: r.event, mastery: r.mastery || null, progress: E.progressView(course, p), next: r.next || null };
  if (r.event === 'course_complete' && E.hasCertificate(course)) out.certificate = evaluateEligibility(course, p);
  return ok(out, env);
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
  const rn = reviewNotes(course, p);
  const ctx = E.buildTutorContext(course, p, { pendingReviews: rn.pending, changesRequested: rn.changes });
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

// ── Speech: premium text to speech ──────────────────────────────────────
async function ttsRoute(env, uid, account, body) {
  const plan = getPlan(account.planId);
  const dayLimit = plan.limits.learnaTtsCharsPerDay;
  if (!(dayLimit > 0)) return fail('Listening with a premium voice is part of the paid plans. Your browser voice is used instead.', 403, env, 'PLAN_REQUIRED');
  const got = await courseFor(env, String(body.course || ''), uid, account);
  if (!got) return fail('That course is not available.', 404, env, 'COURSE_UNAVAILABLE');
  const p = await fsGet(progressPath(uid, got.course.id), env);
  if (!p && !isAdminAccount(account)) return fail('Start the course to hear its lessons.', 403, env, 'NOT_ENROLLED');
  const text = textForPart(got.course, String(body.lesson || ''), String(body.step || ''), String(body.part || ''), body.word);
  if (!text) return fail('That text is not part of this lesson.', 400, env, 'BAD_TEXT');
  const lang = String(body.lang || defaultLangFor(got.course));
  const voice = pickVoice(lang, String(body.voice || 'default'));
  if (!voice) return fail('No voice for that language.', 400, env, 'NO_VOICE');
  const rate = [0.75, 1, 1.1].includes(Number(body.rate)) ? Number(body.rate) : 1;
  let reservation = null;
  const charge = async (n) => {
    if (dayLimit >= UNLIMITED) return true;
    reservation = await reserveUsage(uid, TTS_USAGE, n, dayLimit, env);
    return reservation.allowed;
  };
  const r = await synthesize(env, voice, rate, text, charge);
  if (!r.ok) {
    if (reservation && r.refund) await adjustUsage(uid, TTS_USAGE, -r.refund, reservation.day, env).catch(() => {});
    const msg = { TTS_NOT_CONFIGURED: 'Premium voices are not switched on. Your browser voice is used instead.', TTS_BUDGET: 'The premium voice allowance for this month is used up. Your browser voice is used instead.', DAILY_LIMIT: 'You have used today\u2019s premium listening. Your browser voice is used instead.', TTS_FAILED: 'The premium voice is not available right now. Your browser voice is used instead.' }[r.code] || 'Premium voice unavailable.';
    return fail(msg, r.code === 'DAILY_LIMIT' ? 429 : 503, env, r.code);
  }
  return new Response(r.bytes, { status: 200, headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'private, max-age=86400', 'Access-Control-Allow-Origin': env?.APP_ORIGIN || '*', 'X-Learna-Voice': voice.name, 'X-Learna-Cache': r.cached ? 'hit' : 'miss', 'Access-Control-Expose-Headers': 'X-Learna-Voice,X-Learna-Cache' } });
}

async function speechStatus(env) {
  const used = await monthlyUsed(env).catch(() => 0);
  return { premium: premiumAvailable(env) && used < monthlyCap(env), voices: VOICES.map((v) => ({ id: v.id, name: v.name, gender: v.gender, lang: v.lang, default: !!v.default })) };
}

// ── Router ──────────────────────────────────────────────────────────────
export async function handleLearnaRequest(request, env) {
  const url = new URL(request.url);
  const parts = url.pathname.replace(/^\/api\/learna\/?/, '').split('/').filter(Boolean);
  const method = request.method;

  // Anyone may check a certificate. It returns only the name, course and date.
  if (parts[0] === 'certificates' && parts[1] === 'verify' && method === 'GET') return verifyCertificate(request, env);

  let identity;
  try { identity = await requireAuth(request, env); } catch (e) { const { status, message } = describeAuthError(e); return fail(message, status, env); }
  const uid = identity.uid;

  try {
    const account = await resolveAccountWithRole(uid, env);

    if (parts[0] === 'catalogue' && parts.length === 1 && method === 'GET') return ok(await catalogue(env, uid, account), env);
    if (parts[0] === 'prefs' && parts.length === 1) {
      if (method === 'GET') { const { nudges, reviewAlerts, tz } = await getPrefs(env, uid); return ok({ nudges, reviewAlerts, tz }, env); }
      if (method === 'POST') { const b = await request.json().catch(() => ({})); const { nudges, reviewAlerts, tz } = await savePrefs(env, uid, b); return ok({ nudges, reviewAlerts, tz }, env); }
    }
    if (parts[0] === 'speech') {
      if (parts[1] === 'voices' && method === 'GET') return ok(await speechStatus(env), env);
      if (parts[1] === 'tts' && method === 'POST') return await ttsRoute(env, uid, account, await request.json().catch(() => ({})));
    }
    if (parts[0] === 'submissions' && parts[1] && parts[2] === 'media' && method === 'GET') {
      let reviewer = false;
      try { const r = await fsGet('admins/' + uid, env); reviewer = !!(r && ['admin', 'moderator'].includes(r.role)); } catch (_) { reviewer = false; }
      return await getMedia(env, uid, reviewer, parts[1]);
    }
    if (parts[0] !== 'courses' || !parts[1]) return fail('Not found.', 404, env);

    const got = await courseFor(env, parts[1], uid, account);
    if (!got) return fail('This course does not exist.', 404, env, 'COURSE_UNAVAILABLE');
    const course = got.course;
    const action = parts[2];

    if (!action && method === 'GET') return ok(await courseDetailRes(env, uid, account, got), env);
    if (action === 'enroll' && method === 'POST') return await enroll(env, uid, account, got);

    // Everything below needs an enrolment and a plan that can take courses.
    if (!planInfo(account).canTake) return fail('Starting a course needs Cognita Plus or higher.', 403, env, 'PLAN_REQUIRED');
    const p = await loadProgress(env, uid, course);
    if (!p) return fail('You have not started this course.', 403, env, 'NOT_ENROLLED');

    if (action === 'progress' && method === 'GET') return ok({ progress: E.progressView(course, p), notice: p._notice }, env);
    if (action === 'lessons' && parts[3] && method === 'GET') {
      if (!E.isUnlocked(course, p, parts[3])) return fail('Finish the earlier lessons first.', 403, env, 'LESSON_LOCKED');
      return ok({ ...lessonResponse(course, p, parts[3]), notice: p._notice }, env);
    }
    if (action === 'submissions' && method === 'GET') return ok({ submissions: await listMine(env, uid, course.id) }, env);
    if (action === 'certificate') return await handleCertificate({ env, request, uid, account, course, p, identity });

    if (action === 'assignments' && parts[3] === 'submit' && method === 'POST') return await submitAssignment({ env, request, uid, account, course, p });

    if (method !== 'POST') return fail('Not found.', 404, env);
    const body = await request.json().catch(() => ({}));
    // A finished course still allows the tutor, resubmitting a task a reviewer sent back, and re-running a code check.
    const allowedWhenDone = ['tutor', 'code', 'submit'];
    if (p.status === 'completed' && !allowedWhenDone.includes(action)) return fail('You have finished this course.', 409, env, 'COURSE_COMPLETED');

    if (action === 'code' && parts[3] === 'challenge') return await codeChallenge(env, uid, course, p, body);
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
