// learna/http.js
// Small helpers shared by the Learna endpoint files.
import { fsGet, fsSet } from '../firestore-rest.js';
import { getPlan, UNLIMITED } from '../entitlements.js';
import * as E from './engine.js';

export const headers = (env) => ({ 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': env?.APP_ORIGIN || '*', 'Cache-Control': 'no-store' });
export const ok = (body, env, status = 200) => new Response(JSON.stringify(body), { status, headers: headers(env) });
export const fail = (message, status, env, code, extra) => new Response(JSON.stringify({ error: message, ...(code ? { code } : {}), ...(extra || {}) }), { status, headers: headers(env) });

export const progressPath = (uid, courseId) => 'learna_progress/' + uid + '_' + courseId;
export const slotPath = (uid, n) => 'learna_slots/' + uid + '_' + n;

export function planInfo(account) {
  const plan = getPlan(account.planId);
  const limit = plan.limits.learnaCourses;
  return { planId: account.planId, planName: plan.name, courseLimit: limit >= UNLIMITED ? null : limit, canTake: limit > 0 };
}

/** Loads a learner's progress for a course and brings it in line with the course version. */
export async function loadProgress(env, uid, course) {
  const p = await fsGet(progressPath(uid, course.id), env);
  if (!p) return null;
  p.lessons = p.lessons || {};
  const r = E.reconcileVersion(p, course);
  if (r.changed) await fsSet(progressPath(uid, course.id), p, env);
  p._notice = r.notice;
  return p;
}

export async function saveProgress(env, uid, course, p) {
  p.lastActivityAt = new Date().toISOString();
  const { _notice, ...clean } = p;
  await fsSet(progressPath(uid, course.id), clean, env);
}

export const randomId = (bytes = 10) => { const b = new Uint8Array(bytes); crypto.getRandomValues(b); return [...b].map((x) => x.toString(16).padStart(2, '0')).join(''); };
export const clean = (v, max) => String(v ?? '').trim().slice(0, max);
