// learna/certificates.js
// Certificate rules. A certificate is never granted by a button. The server works out eligibility from stored progress,
// stored task results and reviewer decisions, and only then issues one. Nothing in this file trusts the browser.
import { flatLessons, assignmentsOf, hasCertificate } from './engine.js';

// Review states stored on a task's act record (acts[id].review):
//   'auto'      marked at once by the rubric and measurements (auto tasks only)
//   'pending'   waiting for a reviewer
//   'approved'  a reviewer approved it
//   'changes'   a reviewer asked for changes
export function taskSatisfied(step, act) {
  if (!act) return false;
  if (step.review === 'auto') return !!act.passed && act.review === 'auto';
  return act.review === 'approved';
}

/**
 * Works out whether the learner has met every requirement. Returns { eligible, requirements: [{ id, label, met, detail }] }.
 * `progress` is the stored progress document.
 */
export function evaluateEligibility(course, progress) {
  const reqs = [];
  if (!hasCertificate(course)) return { eligible: false, requirements: [{ id: 'none', label: 'This course does not issue a certificate.', met: false }] };
  const flat = flatLessons(course);
  const notDone = flat.filter((f) => !(progress.lessons[f.key] && progress.lessons[f.key].status === 'done'));
  reqs.push({ id: 'lessons', label: 'Finish every lesson', met: !notDone.length, detail: notDone.length ? notDone.length + ' lesson' + (notDone.length === 1 ? '' : 's') + ' left' : 'All ' + flat.length + ' done' });

  for (const f of flat.filter((x) => x.lesson.exam)) {
    const ls = progress.lessons[f.key];
    const need = f.lesson.threshold || course.masteryThreshold || 0.7;
    const ok = !!(ls && ls.status === 'done' && ls.mastery && ls.mastery.ratio >= need);
    reqs.push({ id: 'exam:' + f.key, label: 'Pass the assessment: ' + f.lesson.title, met: ok, detail: ls && ls.mastery ? Math.round(ls.mastery.ratio * 100) + '% (need ' + Math.round(need * 100) + '%)' : 'Not taken yet' });
  }

  for (const a of assignmentsOf(course).filter((x) => x.step.certRequired)) {
    const act = ((progress.lessons[a.lessonKey] || {}).acts || {})[a.step.id];
    const met = taskSatisfied(a.step, act);
    let detail = 'Not submitted';
    if (act && act.review === 'pending') detail = 'Waiting for a reviewer';
    else if (act && act.review === 'changes') detail = 'The reviewer asked for changes';
    else if (act && act.review === 'approved') detail = 'Approved';
    else if (act && act.review === 'auto') detail = act.passed ? 'Passed' : 'Not passed yet';
    reqs.push({ id: 'task:' + a.step.id, label: a.step.title, met, detail, lesson: a.lessonKey });
  }

  // Code tasks whose source looked like it contained the answers, or that an independent re-run did not confirm, must be cleared.
  const unresolved = [];
  for (const f of flat) for (const st of f.lesson.steps) {
    if (st.kind !== 'activity' || !(st.type === 'code')) continue;
    const act = ((progress.lessons[f.key] || {}).acts || {})[st.id];
    if (act && (act.codeVerdict === 'mismatch' || (act.flagged && act.codeVerdict !== 'verified' && act.codeVerdict !== 'cleared'))) unresolved.push(st.title);
  }
  reqs.push({ id: 'code', label: 'No coding task is under question', met: !unresolved.length, detail: unresolved.length ? 'Run again: ' + unresolved.slice(0, 3).join(', ') : 'Clear' });

  return { eligible: reqs.every((r) => r.met), requirements: reqs };
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newCertificateId() {
  const b = new Uint8Array(12);
  globalThis.crypto.getRandomValues(b);
  let s = ''; for (const x of b) s += ALPHABET[x % ALPHABET.length];
  return 'CGN-' + s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8, 12);
}

export const CERT_ID = /^CGN-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/;

/** The only fields a stranger may see when checking a certificate. */
export function publicCertificate(doc) {
  if (!doc) return null;
  return { id: doc.id, name: doc.name, courseTitle: doc.courseTitle, certificateTitle: doc.certificateTitle, issuedAt: doc.issuedAt, courseVersion: doc.courseVersion, revoked: !!doc.revoked, revokedAt: doc.revoked ? doc.revokedAt : null };
}

export function cleanName(raw) {
  const n = String(raw || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim();
  return n.length >= 2 && n.length <= 80 ? n : null;
}
