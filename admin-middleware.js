// admin-middleware.js
// Server-side admin authorization.
//
// Admin access is controlled by COGNITA_ADMIN_UIDS in the Worker environment.
// Example:
// COGNITA_ADMIN_UIDS="firebaseUidOne,firebaseUidTwo"
//
// Never trust an admin flag, email, or role supplied by the browser.

import { requireAuth } from './auth-middleware.js';

function _getAdminUids(env) {
  return String(env.COGNITA_ADMIN_UIDS || '')
    .split(',')
    .map((uid) => uid.trim())
    .filter(Boolean);
}

export async function requireAdmin(request, env) {
  const identity = await requireAuth(request, env);
  const adminUids = _getAdminUids(env);

  if (!adminUids.includes(identity.uid)) {
    const error = new Error('Admin access required.');
    error.status = 403;
    throw error;
  }

  return identity;
}

export function isAdminUid(uid, env) {
  if (!uid) return false;
  return _getAdminUids(env).includes(uid);
}
