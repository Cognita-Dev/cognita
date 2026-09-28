// emails/email-prefs.js
// Remembers which optional emails a person has turned off.
// Stored in Firestore at emailPrefs/{uid}.
//
// Only the *optional* emails can be switched off (reminder emails).
// Account and billing emails (verify, password reset, receipts, payment
// failed, and so on) are required for the account to work safely, so they
// are never affected by this.
//
// Performance digests are NOT stored here. They already have their own
// on/off switch (deliverEmail on insightsSchedules/{uid}), so that switch
// stays the single source of truth and the Insights page always agrees
// with what the unsubscribe link did.

import { fsGet, fsSet } from '../firestore-rest.js';

const PATH = (uid) => 'emailPrefs/' + uid;

/** True unless this person has unsubscribed from reminder emails. */
export async function isReminderEmailAllowed(env, uid) {
  try {
    const prefs = await fsGet(PATH(uid), env);
    return !(prefs && prefs.remindersEmail === false);
  } catch (_) {
    // If we cannot check, deliver: a missed reminder is worse than one extra email.
    return true;
  }
}

export async function setReminderEmailAllowed(env, uid, allowed) {
  const existing = (await fsGet(PATH(uid), env).catch(() => null)) || {};
  await fsSet(
    PATH(uid),
    { ...existing, remindersEmail: !!allowed, updatedAt: new Date().toISOString() },
    env
  );
}
