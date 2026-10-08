// learna/course-store.js
// Where courses come from. Built-in courses live in learna/courses-*.js. Courses made or edited in the admin editor are
// stored in Firestore as learna_courses/{id}. A stored course with the same id as a built-in one replaces it, so an admin can
// improve a built-in course without touching source code. Learners never read these documents directly: only the Worker does.
//
//   learna_courses/{id} = { kind:'course', id, status:'draft'|'published'|'unpublished', course, publishedCourse, lessonHashes,
//                           updatedAt, updatedBy, publishedAt, publishedBy }
//
// `course` is the working copy the editor changes. `publishedCourse` is what learners see. Editing never changes what learners
// see until the admin publishes, and publishing validates first.

import { fsGet, fsSet, fsDelete, fsQuery } from '../firestore-rest.js';
import { COURSES as BUILT_IN } from './courses.js';
import { validateCourse } from './validate.js';

export const COURSE_COLLECTION = 'learna_courses';
const TTL_MS = 15000;
let cache = null; // { at, map }

export function invalidateCourseCache() { cache = null; }

const clone = (o) => JSON.parse(JSON.stringify(o));

// A short stable hash of a lesson's content, used to decide when its rev must go up.
export function hashLesson(l) {
  const { rev, ...rest } = l;
  const s = JSON.stringify(rest);
  let h1 = 5381, h2 = 52711;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = ((h1 * 33) ^ c) >>> 0; h2 = ((h2 * 33) ^ c) >>> 0; }
  return h1.toString(36) + h2.toString(36);
}

export function bumpPatch(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v || '');
  return m ? m[1] + '.' + m[2] + '.' + (+m[3] + 1) : '1.0.0';
}

/**
 * Sets lesson revs from content: a lesson whose content changed since the last publish gets rev + 1, so learners who already
 * did it are asked to repeat it, while untouched lessons keep their progress. Returns { course, changed, bumped }.
 */
export function stampRevisions(next, published) {
  const out = clone(next);
  const prev = {};
  if (published) for (const s of published.sections) for (const l of s.lessons) prev[s.id + '_' + l.id] = { rev: l.rev, hash: hashLesson(l) };
  let changed = 0;
  for (const s of out.sections) for (const l of s.lessons) {
    const p = prev[s.id + '_' + l.id];
    if (!p) { l.rev = Math.max(1, l.rev || 1); continue; }
    if (hashLesson(l) !== p.hash) { l.rev = p.rev + 1; changed++; } else l.rev = p.rev;
  }
  // Anything that differs from what was published (ignoring version numbers and revisions) is a new version.
  const sig = (c) => JSON.stringify(c, (k, v) => (k === 'rev' || k === 'version' ? undefined : v));
  if (published && (changed || sig(out) !== sig(published))) out.version = bumpPatch(published.version);
  return { course: out, changed };
}

async function readAll(env) {
  const rows = await fsQuery(COURSE_COLLECTION, 'kind', 'course', null, 200, env).catch(() => []);
  return rows.filter((r) => r && r.id && r.course);
}

/** id -> { course (what learners see, or null), draft (working copy), status, builtIn, doc } */
export async function loadCourseMap(env, { fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < TTL_MS) return cache.map;
  const map = new Map();
  for (const c of BUILT_IN) map.set(c.id, { id: c.id, course: c, draft: c, status: 'published', builtIn: true, doc: null });
  for (const r of await readAll(env)) {
    const live = r.status === 'published' || r.status === 'unpublished' ? r.publishedCourse || null : null;
    map.set(r.id, { id: r.id, course: live, draft: r.course, status: r.status, builtIn: BUILT_IN.some((b) => b.id === r.id), doc: r });
  }
  cache = { at: Date.now(), map };
  return map;
}

/**
 * The course a learner may use. A published course is open to everyone. An unpublished one stays open to people who already
 * enrolled (so nobody loses their place) but is hidden from the catalogue and cannot be started. Drafts are for admins only.
 */
export async function getLearnerCourse(env, id, { enrolled = false } = {}) {
  const e = (await loadCourseMap(env)).get(id);
  if (!e || !e.course) return null;
  if (e.status === 'published') return { course: e.course, listed: true };
  if (e.status === 'unpublished' && enrolled) return { course: e.course, listed: false };
  return null;
}

export async function listPublished(env) {
  const out = [];
  for (const e of (await loadCourseMap(env)).values()) if (e.status === 'published' && e.course) out.push(e.course);
  return out;
}

export async function getEntry(env, id) { return (await loadCourseMap(env, { fresh: true })).get(id) || null; }

export async function listForAdmin(env) {
  return [...(await loadCourseMap(env, { fresh: true })).values()].map((e) => ({
    id: e.id, title: (e.draft || e.course).title, status: e.status, builtIn: e.builtIn, edited: !!e.doc, category: (e.draft || e.course).category, version: e.course ? e.course.version : null,
    lessons: (e.draft || e.course).sections.reduce((n, s) => n + s.lessons.length, 0), updatedAt: e.doc ? e.doc.updatedAt : null, updatedBy: e.doc ? e.doc.updatedBy : null, hasUnpublishedChanges: !!(e.doc && e.doc.dirty),
  })).sort((a, b) => a.title.localeCompare(b.title));
}

/** A draft only has to be well formed to be saved. Completeness is checked when it is published. */
export function structureProblems(c) {
  if (!c || typeof c !== 'object') return ['The course is empty.'];
  if (!/^[a-z0-9][a-z0-9-]{1,60}$/.test(c.id || '')) return ['The course id must be lowercase letters, numbers and dashes.'];
  let size = 0; try { size = JSON.stringify(c).length; } catch (_) { return ['The course contains data that cannot be saved.']; }
  if (size > 700 * 1024) return ['The course is too large. Split it into two courses.'];
  if (!Array.isArray(c.sections)) return ['The course needs a list of sections.'];
  for (const s of c.sections) {
    if (!s || typeof s !== 'object' || !Array.isArray(s.lessons)) return ['Every section needs a list of lessons.'];
    for (const l of s.lessons) {
      if (!l || typeof l !== 'object' || !Array.isArray(l.steps)) return ['Every lesson needs a list of steps.'];
      for (const st of l.steps) if (!st || typeof st !== 'object' || typeof st.kind !== 'string') return ['Every step needs a kind (teach or activity).'];
    }
  }
  return [];
}

/**
 * Saves the working copy. Work in progress is allowed to be incomplete: it is stored together with a list of what still has to be
 * fixed ("problems"). Nothing reaches learners until publish() finds no problems.
 */
export async function saveDraft(env, uid, course) {
  const bad = structureProblems(course);
  if (bad.length) return { ok: false, errors: bad, warnings: [] };
  const v = validateCourse(course);
  const prev = await fsGet(COURSE_COLLECTION + '/' + course.id, env);
  const builtIn = BUILT_IN.find((b) => b.id === course.id);
  if (builtIn && prev == null && !v.ok) return { ok: false, errors: v.errors, warnings: v.warnings };   // never start a built-in's draft from broken content
  const status = prev ? prev.status : (builtIn ? 'published' : 'draft');
  const doc = {
    kind: 'course', id: course.id, status, course: clone(course), publishedCourse: prev ? prev.publishedCourse || null : (builtIn ? clone(builtIn) : null),
    dirty: true, problems: v.errors.slice(0, 20), updatedAt: new Date().toISOString(), updatedBy: uid, publishedAt: prev ? prev.publishedAt || null : null, publishedBy: prev ? prev.publishedBy || null : null,
  };
  await fsSet(COURSE_COLLECTION + '/' + course.id, doc, env);
  invalidateCourseCache();
  return { ok: true, problems: v.errors, warnings: v.warnings };
}

export async function publish(env, uid, id) {
  const doc = await fsGet(COURSE_COLLECTION + '/' + id, env);
  const builtIn = BUILT_IN.find((b) => b.id === id);
  if (!doc) {
    if (builtIn) return { ok: false, errors: ['This built-in course has not been edited. There is nothing new to publish.'] };
    return { ok: false, errors: ['Save the course first.'] };
  }
  const v = validateCourse(doc.course);
  if (!v.ok) return { ok: false, errors: v.errors, warnings: v.warnings };
  const { course, changed } = stampRevisions({ ...doc.course, status: 'available' }, doc.publishedCourse || null);
  const now = new Date().toISOString();
  await fsSet(COURSE_COLLECTION + '/' + id, { ...doc, status: 'published', course: clone(course), publishedCourse: clone(course), dirty: false, publishedAt: now, publishedBy: uid, updatedAt: now }, env);
  invalidateCourseCache();
  return { ok: true, version: course.version, lessonsChanged: changed, warnings: v.warnings };
}

export async function unpublish(env, uid, id) {
  const doc = await fsGet(COURSE_COLLECTION + '/' + id, env);
  if (!doc) {
    const builtIn = BUILT_IN.find((b) => b.id === id);
    if (!builtIn) return { ok: false, errors: ['That course does not exist.'] };
    await fsSet(COURSE_COLLECTION + '/' + id, { kind: 'course', id, status: 'unpublished', course: clone(builtIn), publishedCourse: clone(builtIn), dirty: false, updatedAt: new Date().toISOString(), updatedBy: uid, publishedAt: null, publishedBy: null }, env);
  } else await fsSet(COURSE_COLLECTION + '/' + id, { ...doc, status: 'unpublished', updatedAt: new Date().toISOString(), updatedBy: uid }, env);
  invalidateCourseCache();
  return { ok: true };
}

/** Throws away admin edits of a built-in course and goes back to the version in the source code. */
export async function revertToBuiltIn(env, id) {
  if (!BUILT_IN.some((b) => b.id === id)) return { ok: false, errors: ['Only built-in courses can be reverted.'] };
  await fsDelete(COURSE_COLLECTION + '/' + id, env);
  invalidateCourseCache();
  return { ok: true };
}

export async function deleteDraft(env, id) {
  if (BUILT_IN.some((b) => b.id === id)) return { ok: false, errors: ['Built-in courses cannot be deleted. Unpublish it instead.'] };
  const doc = await fsGet(COURSE_COLLECTION + '/' + id, env);
  if (!doc) return { ok: false, errors: ['That course does not exist.'] };
  if (doc.status === 'published') return { ok: false, errors: ['Unpublish the course before deleting it.'] };
  if (doc.publishedCourse) return { ok: false, errors: ['This course was published before, so learners may have progress in it. Keep it unpublished instead of deleting it.'] };
  await fsDelete(COURSE_COLLECTION + '/' + id, env);
  invalidateCourseCache();
  return { ok: true };
}
