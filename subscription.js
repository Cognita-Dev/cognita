// subscription.js
// Resolves a Firebase-verified uid to their actual subscription state.
// This is the SINGLE authoritative source for "what plan is this user on."
// It is only ever called with a uid that came out of auth-middleware.js —
// never with a client-supplied uid.

import { fsGet, fsUpdate, fsCreate } from './firestore-rest.js';
import { getPlan, planSatisfies } from './entitlements.js';

// Role lives at admins/{uid} in Firestore — the exact same doc shape
// admin-auth.js's requireAdmin/requireSuperAdmin read for the curation
// endpoints. This is the ONLY other place in the codebase that reads
// it, and it never trusts anything client-sent, only the verified uid.

// Possible subscription.status values:
//   'active'    — paid plan, in good standing
//   'none'      — never subscribed (implicitly free)
//   'past_due'  — payment failed, in grace period
//   'cancelled' — user cancelled, access continues until periodEnd
//   'expired'   — grace period or cancellation period has passed

const GRACE_PERIOD_DAYS = 3;
// Safety net: if an 'active' account is this many days past its period end
// and no renewal has been recorded, something went wrong (missed webhook).
// Access stops rather than continuing for free indefinitely.
const ACTIVE_STALE_DAYS = 7;

/**
 * Reads (and lazily initializes) a user's account document.
 * Returns { uid, planId, status, periodEnd, createdAt }.
 */
export async function getAccount(uid, env) {
  let doc = await fsGet('accounts/' + uid, env);

  if (!doc) {
    const fresh = {
      uid,
      planId: 'free',
      status: 'none',
      periodEnd: null,
      createdAt: new Date().toISOString(),
    };
    // Create-only: if a payment webhook wrote this account in the meantime,
    // we must NOT overwrite it with a free record.
    const created = await fsCreate('accounts/' + uid, fresh, env);
    if (created) return fresh;
    doc = await fsGet('accounts/' + uid, env);
    if (!doc) return fresh;
  }

  return _resolveEffectivePlan(doc);
}

// Applies grace-period / expiry logic without mutating Firestore on every
// read — expiry is only written back when it actually changes (see
// reconcileExpiry, called from a cron or on-access check below).
function _resolveEffectivePlan(doc) {
  const now = Date.now();

  if (doc.status === 'active') {
    if (doc.periodEnd) {
      const staleAt = new Date(doc.periodEnd).getTime() + ACTIVE_STALE_DAYS * 86400000;
      if (!isNaN(staleAt) && now > staleAt) {
        return { ...doc, planId: 'free', status: 'expired' };
      }
    }
    return doc;
  }

  if (doc.status === 'past_due' && doc.periodEnd) {
    const graceEnd = new Date(doc.periodEnd).getTime() + GRACE_PERIOD_DAYS * 86400000;
    if (now <= graceEnd) {
      return doc; // still within grace, treat as active plan-wise
    }
    return { ...doc, planId: 'free', status: 'expired' };
  }

  if (doc.status === 'cancelled' && doc.periodEnd) {
    if (now <= new Date(doc.periodEnd).getTime()) {
      return doc; // cancelled but period not over, still has access
    }
    return { ...doc, planId: 'free', status: 'expired' };
  }

  if (doc.status === 'expired' || doc.status === 'none') {
    return { ...doc, planId: 'free' };
  }

  // past_due / cancelled with no period end, or any unknown status: fail closed.
  return { ...doc, planId: 'free', status: 'expired' };
}

/**
 * Writes back the actually-expired state if we computed one that differs
 * from Firestore. Call this after getAccount() when you're about to act on
 * the result, so stale 'active'/'past_due' records self-heal over time
 * without needing a cron sweep for correctness (a cron sweep is still used
 * for cleanliness/reporting — see scheduled-tasks.js).
 */
export async function reconcileIfExpired(uid, freshDoc, env) {
  const stored = await fsGet('accounts/' + uid, env);
  if (!stored) return;
  if (stored.status !== freshDoc.status || stored.planId !== freshDoc.planId) {
    // Partial update of just these two fields. A full overwrite from a stale
    // read could wipe a payment that landed a moment ago.
    await fsUpdate('accounts/' + uid, { planId: freshDoc.planId, status: freshDoc.status, updatedAt: new Date().toISOString() }, env);
  }
}

/**
 * Full account resolution: verified uid in, effective plan + a guarantee
 * that Firestore reflects reality, in one call. This is what protected
 * endpoints should use.
 */
export async function resolveAccount(uid, env) {
  const raw = await getAccount(uid, env);
  const effective = _resolveEffectivePlan(raw);
  if (effective.status !== raw.status || effective.planId !== raw.planId) {
    await reconcileIfExpired(uid, effective, env);
  }
  return effective;
}

/**
 * Same as resolveAccount(), plus the person's curation role (if any) and,
 * critically, the 'admin' plan override: a Firestore admins/{uid} doc
 * with role EXACTLY 'admin' (never 'moderator') gets its planId swapped
 * to the unlimited, v0-enabled 'admin' pseudo-plan from entitlements.js,
 * regardless of whatever they're actually subscribed to. Moderators and
 * plain users always fall through to their real, unmodified plan.
 *
 * This is the single choke point that decides who gets unlimited/v0
 * access — every endpoint that should honor it (chat, account, usage)
 * calls this instead of resolveAccount() directly.
 *
 * @returns {Promise<object>} the account doc, plus { role: 'admin'|'moderator'|null }
 */
export async function resolveAccountWithRole(uid, env) {
  const account = await resolveAccount(uid, env);

  let roleDoc = null;
  try {
    roleDoc = await fsGet('admins/' + uid, env);
  } catch (e) {
    // Role lookup failing (e.g. Firestore hiccup) should never break
    // ordinary chat/account access — just treat as "no elevated role"
    // for this request rather than failing it outright.
    console.error('[subscription] role lookup failed for', uid, ':', e.message);
  }

  const role = (roleDoc && (roleDoc.role === 'admin' || roleDoc.role === 'moderator')) ? roleDoc.role : null;

  if (role === 'admin') {
    return { ...account, planId: 'admin', status: 'active', role };
  }
  return { ...account, role };
}

/**
 * Throws if the account's plan does not satisfy requiredPlan.
 * Use inside protected endpoints after resolveAccount().
 */
export function assertPlan(account, requiredPlan) {
  if (!planSatisfies(account.planId, requiredPlan)) {
    const err = new Error('This feature requires the ' + getPlan(requiredPlan).name + ' plan or higher.');
    err.code = 'PLAN_REQUIRED';
    err.requiredPlan = requiredPlan;
    err.currentPlan = account.planId;
    throw err;
  }
}
