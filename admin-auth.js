// admin-auth.js
// Server-side admin authorization. An admin is anyone with a document at
// admins/{uid} in Firestore. Never trust a client-sent "isAdmin" field —
// this always re-checks Firestore on every request.

import { requireAuth } from './auth-middleware.js';
import { fsGet } from './firestore-rest.js';

/**
 * Verifies the request is from a signed-in AND admin user.
 * Throws on any failure — caller must catch and respond 401/403.
 *
 * @returns {Promise<{uid: string, email: string|null, emailVerified: boolean, claims: object}>}
 */
export async function requireAdmin(request, env) {
  const identity = await requireAuth(request, env);

  let adminDoc;
  try {
    adminDoc = await fsGet('admins/' + identity.uid, env);
  } catch (e) {
    throw new Error('Could not verify admin status: ' + e.message);
  }

  if (!adminDoc) {
    const e = new Error('Not authorized as admin.');
    e.isForbidden = true;
    throw e;
  }

  return identity;
}
