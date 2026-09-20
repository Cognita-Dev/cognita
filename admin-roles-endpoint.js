// admin-roles-endpoint.js
// First-admin bootstrap, and admin/moderator role management.
//
// Bootstrap: a one-time-only endpoint that creates the very first admin.
// Gated by a hardcoded allow-list of emails (FIRST_ADMIN_EMAILS below) —
// no secret, no environment variable, no dashboard access needed. Edit
// the list in this file and push to GitHub to change who's eligible
// before bootstrap runs. It can only ever succeed once: a singleton
// system/bootstrapStatus document is checked first, and set immediately
// after the first admin is created, so replaying the request (or anyone
// else eligible on the list, after the fact) gets a 409, not a second
// bootstrap.
//
// After bootstrap, all further role changes go through grant/revoke,
// which require an existing 'admin' (requireSuperAdmin) — moderators
// cannot use these endpoints.

import { requireAuth, describeAuthError } from './auth-middleware.js';
import { requireAdmin, requireSuperAdmin } from './admin-auth.js';
import { fsGet, fsSet, fsQuery, fsDelete, getGoogleAccessToken } from './firestore-rest.js';

const VALID_ROLES = ['admin', 'moderator'];
const BOOTSTRAP_DOC_PATH = 'system/bootstrapStatus';

// Whoever signs in with one of these emails is eligible to run bootstrap
// ONCE. Lowercase, trimmed comparison — edit this list and redeploy to
// change who's eligible before bootstrap has run. After bootstrap
// succeeds, this list is never consulted again for anything.
const FIRST_ADMIN_EMAILS = [
  'oluwagbemiga5884@gmail.com',
];

function _corsJsonHeaders(env) {
  return { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': env?.APP_ORIGIN || '*' };
}

function _jsonError(message, status, env) {
  return new Response(JSON.stringify({ error: message }), { status, headers: _corsJsonHeaders(env) });
}

function _jsonOk(body, status, env) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: _corsJsonHeaders(env) });
}

// ── Bootstrap the first admin ─────────────────────────────────────────
// POST /api/admin/bootstrap
// No body needed — eligibility is based on the signed-in user's email
// matching FIRST_ADMIN_EMAILS, not anything the client sends.
export async function handleAdminBootstrap(request, env) {
  let identity;
  try {
    identity = await requireAuth(request, env);
  } catch (e) {
    const _authErr = describeAuthError(e);
    return _jsonError(_authErr.message, _authErr.status, env);
  }

  const email = (identity.email || '').trim().toLowerCase();
  const allowList = FIRST_ADMIN_EMAILS.map((e) => e.trim().toLowerCase());

  if (!email || !allowList.includes(email)) {
    return _jsonError('This account is not eligible to bootstrap the first admin.', 403, env);
  }

  let bootstrapDoc;
  try {
    bootstrapDoc = await fsGet(BOOTSTRAP_DOC_PATH, env);
  } catch (e) {
    return _jsonError('Could not check bootstrap status.', 500, env);
  }

  if (bootstrapDoc && bootstrapDoc.completed) {
    return _jsonError('Bootstrap has already been completed. Use role grant/revoke instead.', 409, env);
  }

  const now = new Date().toISOString();

  try {
    // Mark completed FIRST. If the admin-doc write below fails partway,
    // it's safer to require a manual Firestore fix for one stuck bootstrap
    // than to leave the door open for a second concurrent bootstrap
    // request to also succeed and create two "first" admins.
    await fsSet(BOOTSTRAP_DOC_PATH, {
      completed: true,
      completedAt: now,
      firstAdminUid: identity.uid,
      firstAdminEmail: email,
    }, env);

    await fsSet('admins/' + identity.uid, {
      uid: identity.uid,
      role: 'admin',
      grantedBy: 'bootstrap',
      createdAt: now,
    }, env);
  } catch (e) {
    console.error('[admin-roles] bootstrap failed:', e.message);
    return _jsonError('Bootstrap failed partway. Check Firestore at ' + BOOTSTRAP_DOC_PATH + ' and admins/' + identity.uid + ' before retrying.', 500, env);
  }

  return _jsonOk({ uid: identity.uid, role: 'admin' }, 201, env);
}

// ── Who am I (staff check) ────────────────────────────────────────────
// GET /api/admin/whoami
// Lightweight check used right after sign-in to decide whether to route
// someone to /admin.html instead of /app.html. Accepts either role
// (admin or moderator) — unlike role management, deciding where to land
// after login isn't a superadmin-only concern.
export async function handleAdminWhoAmI(request, env) {
  try {
    const identity = await requireAdmin(request, env);
    return _jsonOk({ role: identity.role }, 200, env);
  } catch (e) {
    const _authErr = describeAuthError(e);
    return _jsonError(_authErr.message, _authErr.status, env);
  }
}

// ── List current admins/moderators ────────────────────────────────────
// GET /api/admin/roles
export async function handleAdminRoleList(request, env) {
  try {
    await requireSuperAdmin(request, env);
  } catch (e) {
    const _authErr = describeAuthError(e);
    return _jsonError(_authErr.message, _authErr.status, env);
  }

  try {
    const [admins, moderators] = await Promise.all([
      fsQuery('admins', 'role', 'admin', 'createdAt', 200, env),
      fsQuery('admins', 'role', 'moderator', 'createdAt', 200, env),
    ]);
    return _jsonOk({ people: [...admins, ...moderators] }, 200, env);
  } catch (e) {
    console.error('[admin-roles] list failed:', e.message);
    return _jsonError('Could not load roles.', 500, env);
  }
}

// ── Grant a role (create or change) ──────────────────────────────────
// POST /api/admin/roles/grant
// Body: { uid, role: 'admin' | 'moderator' }
// Idempotent: granting the same role again just re-saves it, no error.
// Changing an existing person's role (moderator -> admin or vice versa)
// overwrites it in place.
export async function handleAdminRoleGrant(request, env) {
  let identity;
  try {
    identity = await requireSuperAdmin(request, env);
  } catch (e) {
    const _authErr = describeAuthError(e);
    return _jsonError(_authErr.message, _authErr.status, env);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return _jsonError('Invalid JSON body.', 400, env);
  }

  const uid = String(body.uid || '').trim();
  const role = body.role;

  if (!uid) return _jsonError('uid is required.', 400, env);
  if (!VALID_ROLES.includes(role)) {
    return _jsonError('role must be "admin" or "moderator".', 400, env);
  }

  let existing;
  try {
    existing = await fsGet('admins/' + uid, env);
  } catch (e) {
    return _jsonError('Could not check existing role.', 500, env);
  }

  const now = new Date().toISOString();
  const doc = {
    uid,
    role,
    grantedBy: identity.uid,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };

  try {
    await fsSet('admins/' + uid, doc, env);
  } catch (e) {
    console.error('[admin-roles] grant failed:', e.message);
    return _jsonError('Could not grant the role.', 500, env);
  }

  return _jsonOk({ person: doc }, 200, env);
}

// ── Revoke a role ──────────────────────────────────────────────────────
// POST /api/admin/roles/revoke
// Body: { uid }
// Refuses to remove the last remaining 'admin' — the system must always
// have at least one person who can manage roles.
export async function handleAdminRoleRevoke(request, env) {
  try {
    await requireSuperAdmin(request, env);
  } catch (e) {
    const _authErr = describeAuthError(e);
    return _jsonError(_authErr.message, _authErr.status, env);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return _jsonError('Invalid JSON body.', 400, env);
  }

  const uid = String(body.uid || '').trim();
  if (!uid) return _jsonError('uid is required.', 400, env);

  let target;
  try {
    target = await fsGet('admins/' + uid, env);
  } catch (e) {
    return _jsonError('Could not load that person.', 500, env);
  }

  if (!target) {
    return _jsonOk({ revoked: true }, 200, env); // already not a role-holder — idempotent
  }

  if (target.role === 'admin') {
    try {
      const remainingAdmins = await fsQuery('admins', 'role', 'admin', 'createdAt', 200, env);
      if (remainingAdmins.length <= 1) {
        return _jsonError('Cannot revoke the last remaining admin. Grant someone else the admin role first.', 409, env);
      }
    } catch (e) {
      return _jsonError('Could not verify remaining admin count.', 500, env);
    }
  }

  try {
    await fsDelete('admins/' + uid, env);
  } catch (e) {
    console.error('[admin-roles] revoke failed:', e.message);
    return _jsonError('Could not revoke the role.', 500, env);
  }

  return _jsonOk({ revoked: true }, 200, env);
}

// ── Look up a user's uid by email (convenience for "select from
//    existing users") ─────────────────────────────────────────────────
// POST /api/admin/roles/lookup-email
// Body: { email }
// Uses the Identity Toolkit REST API with a scoped OAuth token from the
// same service account already used for Firestore — no Admin SDK needed.
// Best-effort: if the lookup call itself fails (network, API not
// enabled, etc.), this returns a clear error rather than crashing, and an
// admin can still grant a role by uid directly if they already have it.
export async function handleAdminRoleLookupEmail(request, env) {
  try {
    await requireSuperAdmin(request, env);
  } catch (e) {
    const _authErr = describeAuthError(e);
    return _jsonError(_authErr.message, _authErr.status, env);
  }

  let body;
  try {
    body = await request.json();
  } catch (e) {
    return _jsonError('Invalid JSON body.', 400, env);
  }

  const email = String(body.email || '').trim();
  if (!email) return _jsonError('email is required.', 400, env);

  try {
    const token = await getGoogleAccessToken(env, 'https://www.googleapis.com/auth/identitytoolkit');

    const res = await fetch(
      'https://identitytoolkit.googleapis.com/v1/projects/' + env.FIREBASE_PROJECT_ID + '/accounts:lookup',
      {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: [email] }),
      }
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error('Identity Toolkit lookup failed (' + res.status + '): ' + text.slice(0, 200));
    }

    const data = await res.json();
    const users = data.users || [];

    if (users.length === 0) {
      return _jsonError('No user found with that email.', 404, env);
    }

    return _jsonOk({
      uid: users[0].localId,
      email: users[0].email,
      displayName: users[0].displayName || null,
    }, 200, env);
  } catch (e) {
    console.error('[admin-roles] email lookup failed:', e.message);
    return _jsonError('Could not look up that email. You can grant a role by uid instead.', 502, env);
  }
}
