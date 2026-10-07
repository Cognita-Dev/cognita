// learna-admin-endpoint.js
// Admin tools for Learna, routed from worker.js for /api/admin/learna/*.
//
// Who may do what (checked on the server with the same admins/{uid} documents the resource admin uses):
//   admin only      create, edit, publish, unpublish, revert and delete courses; revoke certificates
//   admin or mod    read the review queue, watch recordings, approve or send back tasks, read code-audit data
//
// Course editing never touches source code. Edits go to a draft copy; learners see nothing until the course is published,
// and publishing validates the whole course first (learna/validate.js).
import { requireAdmin, requireSuperAdmin, describeAuthError } from './admin-auth.js';
import { fsGet, fsSet, fsQuery } from './firestore-rest.js';
import * as store from './learna/course-store.js';
import { validateCourse, emptyCourse } from './learna/validate.js';
import { COURSES as BUILT_IN } from './learna/courses.js';
import * as E from './learna/engine.js';
import { evaluateEligibility } from './learna/certificates.js';
import { CERT } from './learna/certificates-endpoint.js';
import { publicSubmission } from './learna/assignments.js';
import { notifyReview, notifyCertificateReady } from './learna/nudges.js';
import { ok, fail, progressPath, saveProgress } from './learna/http.js';

const SUB = 'learna_submissions/';
const jsonBody = (r) => r.json().catch(() => ({}));

async function loadProgressFor(env, uid, courseId) {
  const e = await store.getEntry(env, courseId);
  const course = e && (e.course || e.draft);
  if (!course) return { course: null, p: null };
  const p = await fsGet(progressPath(uid, courseId), env);
  if (p) { p.lessons = p.lessons || {}; E.reconcileVersion(p, course); }
  return { course, p };
}

async function reviewQueue(env, url) {
  const status = ['pending', 'auto_passed', 'approved', 'changes'].includes(url.searchParams.get('status')) ? url.searchParams.get('status') : 'pending';
  const rows = (await fsQuery('learna_submissions', 'status', status, null, 100, env)).filter((r) => r.kind === 'submission');
  rows.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  return { status, submissions: rows.map((r) => publicSubmission(r, { admin: true })) };
}

async function decide(env, reviewer, id, body) {
  const sub = await fsGet(SUB + id, env);
  if (!sub || sub.kind !== 'submission') return fail('That submission does not exist.', 404, env);
  if (sub.status !== 'pending') return fail('This submission was already reviewed.', 409, env, 'ALREADY_REVIEWED');
  const decision = body.decision === 'approve' ? 'approve' : body.decision === 'changes' ? 'changes' : null;
  if (!decision) return fail('Choose approve or changes.', 400, env);
  const note = String(body.note || '').trim().slice(0, 1500);
  if (decision === 'changes' && note.length < 5) return fail('Say what the learner should change. A short note is enough.', 400, env);
  const { course, p } = await loadProgressFor(env, sub.uid, sub.courseId);
  if (!course || !p) return fail('The learner or the course no longer exists.', 409, env);
  const found = E.flatLessons(course).find((f) => f.key === sub.lesson);
  const st = found && found.lesson.steps.find((s) => s.id === sub.activity);
  const ls = p.lessons[sub.lesson];
  const a = ls && ls.acts[sub.activity];
  if (!st || !a || a.submissionId !== sub.id) return fail('This submission is out of date: the learner has sent a newer one or the course changed.', 409, env, 'STALE');
  const now = new Date().toISOString();
  await fsSet(SUB + id, { ...sub, status: decision === 'approve' ? 'approved' : 'changes', reviewDecision: decision, reviewNote: note, reviewedAt: now, reviewedBy: reviewer.uid }, env);
  a.review = decision === 'approve' ? 'approved' : 'changes';
  a.reviewNote = note || null;
  if (decision === 'changes') { a.passed = false; a.revealed = false; a.attempts = Math.min(a.attempts, Math.max(0, st.maxAttempts - 1)); a.lastFeedback = note.slice(0, 500); }
  await saveProgress(env, sub.uid, course, p);
  let notify = { sent: false };
  try {
    notify = await notifyReview(env, sub.uid, course, st.title, decision);
    if (decision === 'approve' && E.hasCertificate(course) && evaluateEligibility(course, p).eligible) await notifyCertificateReady(env, sub.uid, course);
  } catch (e) { console.error('[learna-admin] notify failed:', e.message); }
  return ok({ ok: true, decision, notified: !!notify.sent }, env);
}

async function codeAudit(env, url) {
  const rows = (await fsQuery('learna_code_attempts', 'status', 'unverified', null, 100, env)).filter((r) => r.kind === 'code_attempt');
  const items = [];
  const map = await store.loadCourseMap(env);
  for (const r of rows) {
    const e = map.get(r.courseId); const course = e && (e.course || e.draft);
    if (!course) continue;
    const f = E.flatLessons(course).find((x) => x.key === r.lesson);
    const st = f && f.lesson.steps.find((s) => s.id === r.activity);
    if (!st) continue;
    items.push({ id: r.uid + '_' + r.courseId + '_' + r.lesson + '_' + r.activity, uid: r.uid, courseId: r.courseId, lesson: r.lesson, activity: r.activity, source: r.source, flags: r.flags || [], tests: [...st.tests, ...(st.hidden || [])].map((t) => ({ expr: t.expr, expect: t.expect })), mustDefine: st.mustDefine || [], passedAt: r.passedAt });
  }
  void url;
  return { items };
}

async function codeAuditResult(env, body) {
  const id = String(body.id || '');
  const m = /^(.+?)_([a-z0-9-]+)_(s\d+_l\d+)_([A-Za-z0-9_-]+)$/.exec(id);
  if (!m || !['verified', 'mismatch'].includes(body.verdict)) return fail('Send an id and a verdict of verified or mismatch.', 400, env);
  const [, uid, courseId, lessonKey, activity] = m;
  const doc = await fsGet('learna_code_attempts/' + id, env);
  if (!doc) return fail('No such code attempt.', 404, env);
  await fsSet('learna_code_attempts/' + id, { ...doc, status: body.verdict, verifiedAt: new Date().toISOString(), detail: String(body.detail || '').slice(0, 500) }, env);
  const { course, p } = await loadProgressFor(env, uid, courseId);
  if (course && p) {
    const ls = p.lessons[lessonKey]; const a = ls && ls.acts[activity];
    if (a) {
      a.codeVerdict = body.verdict;
      if (body.verdict === 'mismatch') { a.passed = false; a.revealed = false; a.attempts = 0; a.lastFeedback = 'An independent re-run of your code did not give the expected results. Run the task again.'; }
      await saveProgress(env, uid, course, p);
    }
  }
  return ok({ ok: true }, env);
}

export async function handleLearnaAdminRequest(request, env) {
  const url = new URL(request.url);
  const parts = url.pathname.replace(/^\/api\/admin\/learna\/?/, '').split('/').filter(Boolean);
  const method = request.method;
  const needsSuper = parts[0] === 'courses' && (method !== 'GET') || parts[0] === 'certificates';
  let who;
  try { who = needsSuper ? await requireSuperAdmin(request, env) : await requireAdmin(request, env); } catch (e) { const { status, message } = describeAuthError(e); return fail(message, status, env); }
  try {
    if (parts[0] === 'courses') {
      if (!parts[1] && method === 'GET') return ok({ courses: await store.listForAdmin(env) }, env);
      if (!parts[1] && method === 'POST') {
        const b = await jsonBody(request);
        if (b.cloneFrom) {
          const e = await store.getEntry(env, String(b.cloneFrom));
          const src = e && (e.draft || e.course);
          if (!src) return fail('That course does not exist.', 404, env);
          const id = String(b.id || '').trim();
          const c = JSON.parse(JSON.stringify(src)); c.id = id; c.title = String(b.title || src.title + ' (copy)'); c.version = '0.1.0'; c.featured = false;
          const r = await store.saveDraft(env, who.uid, c);
          return r.ok ? ok({ ok: true, id, problems: r.problems }, env, 201) : fail('The copy is not valid: ' + r.errors[0], 400, env, 'INVALID', { errors: r.errors });
        }
        const id = String(b.id || '').trim();
        if (await store.getEntry(env, id)) return fail('A course with that id already exists.', 409, env, 'EXISTS');
        const r = await store.saveDraft(env, who.uid, emptyCourse(id, String(b.title || 'New course').slice(0, 120)));
        return r.ok ? ok({ ok: true, id, problems: r.problems }, env, 201) : fail(r.errors[0], 400, env, 'INVALID', { errors: r.errors });
      }
      if (parts[1] === 'validate' && method === 'POST') { const b = await jsonBody(request); return ok(validateCourse(b.course), env); }
      const id = parts[1];
      const entry = await store.getEntry(env, id);
      if (!parts[2] && method === 'GET') return entry ? ok({ id, status: entry.status, builtIn: entry.builtIn, dirty: !!(entry.doc && entry.doc.dirty), course: entry.draft, problems: (entry.doc && entry.doc.problems) || [], published: entry.course ? { version: entry.course.version } : null }, env) : fail('That course does not exist.', 404, env);
      if (!parts[2] && method === 'PUT') {
        const b = await jsonBody(request);
        if (!b.course || b.course.id !== id) return fail('The course id in the body must match the address.', 400, env);
        const r = await store.saveDraft(env, who.uid, b.course);
        return r.ok ? ok({ ok: true, problems: r.problems, warnings: r.warnings }, env) : fail('Not saved: ' + r.errors[0], 400, env, 'INVALID', { errors: r.errors, warnings: r.warnings });
      }
      if (parts[2] === 'publish' && method === 'POST') { const r = await store.publish(env, who.uid, id); return r.ok ? ok(r, env) : fail('Not published: ' + r.errors[0], 400, env, 'INVALID', { errors: r.errors }); }
      if (parts[2] === 'unpublish' && method === 'POST') { const r = await store.unpublish(env, who.uid, id); return r.ok ? ok(r, env) : fail(r.errors[0], 400, env); }
      if (parts[2] === 'revert' && method === 'POST') { const r = await store.revertToBuiltIn(env, id); return r.ok ? ok(r, env) : fail(r.errors[0], 400, env); }
      if (!parts[2] && method === 'DELETE') { const r = await store.deleteDraft(env, id); return r.ok ? ok(r, env) : fail(r.errors[0], 409, env); }
    }
    if (parts[0] === 'submissions') {
      if (!parts[1] && method === 'GET') return ok(await reviewQueue(env, url), env);
      if (parts[1] && !parts[2] && method === 'GET') { const s = await fsGet(SUB + parts[1], env); return s ? ok({ submission: publicSubmission(s, { admin: true }) }, env) : fail('Not found.', 404, env); }
      if (parts[1] && parts[2] === 'review' && method === 'POST') return await decide(env, who, parts[1], await jsonBody(request));
    }
    if (parts[0] === 'code-audit') {
      if (!parts[1] && method === 'GET') return ok(await codeAudit(env, url), env);
      if (parts[1] === 'result' && method === 'POST') return await codeAuditResult(env, await jsonBody(request));
    }
    if (parts[0] === 'certificates' && parts[1] && parts[2] === 'revoke' && method === 'POST') {
      const doc = await fsGet(CERT + String(parts[1]).toUpperCase(), env);
      if (!doc) return fail('No such certificate.', 404, env);
      const b = await jsonBody(request);
      await fsSet(CERT + doc.id, { ...doc, revoked: true, revokedAt: new Date().toISOString(), revokedBy: who.uid, revokeReason: String(b.reason || '').slice(0, 300) }, env);
      return ok({ ok: true }, env);
    }
    void BUILT_IN;
    return fail('Not found.', 404, env);
  } catch (e) {
    console.error('[learna-admin] failed:', e.message);
    return fail('Something went wrong on our side. Please try again.', 500, env);
  }
}
