// user-skills-endpoint.js
// The person's own skills (Settings > Skills).
//   GET    /api/skills            -> { skills, limits }
//   PUT    /api/skills            -> save one skill { name, description, instructions, triggers, enabled, originalName? }
//   DELETE /api/skills?name=...   -> remove one
// Stored in one Firestore document per person: userSkills/{uid} { items: [...] }.
// Everything is cleaned by skills.js (sanitizeCustomSkill) on the way in AND on the way out, so a bad row
// can never reach a prompt. The chat reads this through loadUserSkills(), which never throws.
import { requireAuth, describeAuthError } from './auth-middleware.js';
import { fsGet, fsSet } from './firestore-rest.js';
import { sanitizeCustomSkill, cleanCustomList, CUSTOM_LIMITS } from './skills.js';

const _headers = (env) => ({ 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': env?.APP_ORIGIN || '*' });
const _json = (data, status, env) => new Response(JSON.stringify(data), { status, headers: _headers(env) });
const _err = (message, status, env) => _json({ error: message }, status, env);

/** Reads the person's skills for the chat. Returns [] on any problem or after `timeoutMs` (chat must never wait on this). */
export async function loadUserSkills(uid, env, timeoutMs = 1500) {
  if (!uid || !env || !env.FIREBASE_PROJECT_ID) return [];
  try {
    const doc = await Promise.race([
      fsGet('userSkills/' + encodeURIComponent(uid), env),
      new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    return cleanCustomList(doc && doc.items).filter((k) => k.enabled);
  } catch (e) {
    console.warn('[skills] could not read saved skills:', e && e.message);
    return [];
  }
}

async function _readAll(uid, env) {
  const doc = await fsGet('userSkills/' + encodeURIComponent(uid), env);
  return cleanCustomList(doc && doc.items);
}

export async function handleUserSkillsRequest(request, env) {
  let identity;
  try { identity = await requireAuth(request, env); } catch (e) { const a = describeAuthError(e); return _err(a.message, a.status, env); }
  const uid = identity.uid;
  const url = new URL(request.url);
  try {
    if (request.method === 'GET') return _json({ skills: await _readAll(uid, env), limits: CUSTOM_LIMITS }, 200, env);

    if (request.method === 'PUT') {
      let body;
      try { body = await request.json(); } catch (_) { return _err('Send the skill as JSON.', 400, env); }
      const r = sanitizeCustomSkill(body);
      if (!r.ok) return _err(r.error, 400, env);
      const originalName = body && typeof body.originalName === 'string' ? sanitizeCustomSkill({ ...body, name: body.originalName }).skill?.name : null;
      const all = await _readAll(uid, env);
      const rest = all.filter((k) => k.name !== r.skill.name && k.name !== originalName);
      if (rest.length >= CUSTOM_LIMITS.maxSkills) return _err('You can save up to ' + CUSTOM_LIMITS.maxSkills + ' skills. Delete one first.', 409, env);
      const exists = all.some((k) => k.name === r.skill.name);
      if (exists && originalName && originalName !== r.skill.name) return _err('You already have a skill with that name.', 409, env);
      const next = rest.concat([r.skill]);
      await fsSet('userSkills/' + encodeURIComponent(uid), { items: next, updatedAt: new Date().toISOString() }, env);
      return _json({ skill: r.skill, skills: next }, 200, env);
    }

    if (request.method === 'DELETE') {
      const name = (url.searchParams.get('name') || '').toLowerCase().slice(0, 80);
      if (!name) return _err('Say which skill to delete.', 400, env);
      const all = await _readAll(uid, env);
      const next = all.filter((k) => k.name !== name);
      if (next.length !== all.length) await fsSet('userSkills/' + encodeURIComponent(uid), { items: next, updatedAt: new Date().toISOString() }, env);
      return _json({ skills: next }, 200, env); // deleting something that is not there is fine
    }
    return _err('Method not allowed.', 405, env);
  } catch (e) {
    console.error('[skills] request failed:', e && e.message);
    return _err('Could not save your skills. Please try again.', 500, env);
  }
}
