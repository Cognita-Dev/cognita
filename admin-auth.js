// admin-auth.js
// Server-side authorization for curation staff. A person's role lives at
// admins/{uid} in Firestore as { uid, role: 'admin' | 'moderator',
// grantedBy, createdAt }. Never trust a client-sent role — this always
// re-checks Firestore on every request.
//
// 'admin'     — full curation access, plus can grant/revoke roles.
// 'moderator' — full curation access (create/edit/publish resources and
//               collections), but cannot touch anyone's role.

import { requireAuth } from './auth-middleware.js';
import { fsGet } from './firestore-rest.js';

/**
 * Verifies the request is from a signed-in user who holds ANY curation
 * role (admin or moderator). Use this for resource/collection curation
 * endpoints. Throws on failure — caller must catch and respond 401/403.
 *
 * @returns {Promise<{uid, email, emailVerified, claims, role}>}
 */
export async function requireAdmin(request, env) {
  const identity = await requireAuth(request, env);

  let roleDoc;
  try {
    roleDoc = await fsGet('admins/' + identity.uid, env);
  } catch (e) {
    throw new Error('Could not verify admin status: ' + e.message);
  }

  if (!roleDoc || !['admin', 'moderator'].includes(roleDoc.role)) {
    const e = new Error('Not authorized as admin or moderator.');
    e.isForbidden = true;
    throw e;
  }

  return { ...identity, role: roleDoc.role };
}

/**
 * Verifies the request is from a signed-in user whose role is
 * specifically 'admin' — not 'moderator'. Use this for role management
 * (granting/revoking access to other people) and anything else that
 * shouldn't be delegable to a moderator.
 *
 * @returns {Promise<{uid, email, emailVerified, claims, role}>}
 */
export async function requireSuperAdmin(request, env) {
  const identity = await requireAdmin(request, env);

  if (identity.role !== 'admin') {
    const e = new Error('This action requires the admin role, not moderator.');
    e.isForbidden = true;
    throw e;
  }

  return identity;
}
