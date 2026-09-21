// emails/firebase-users.js
// Looks up an account's details straight from Firebase (server to server),
// so emails never depend on what a browser claims. Uses the same service
// account the rest of the Worker already uses.

import { getGoogleAccessToken } from '../firestore-rest.js';

const IDENTITY_SCOPE = 'https://www.googleapis.com/auth/identitytoolkit';

/**
 * Find one account by { uid } or by { email }. Returns null if there is
 * no such account. Throws if Firebase cannot be reached.
 */
export async function lookupUser(env, { uid, email }) {
  const token = await getGoogleAccessToken(env, IDENTITY_SCOPE);
  const res = await fetch(
    'https://identitytoolkit.googleapis.com/v1/projects/' + env.FIREBASE_PROJECT_ID + '/accounts:lookup',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify(uid ? { localId: [uid] } : { email: [email] }),
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error('Identity Toolkit lookup failed (' + res.status + '): ' + text.slice(0, 200));
  }

  const data = await res.json();
  const u = (data.users || [])[0];
  if (!u) return null;

  // Time the password last changed, in milliseconds. Older records may only
  // carry validSince (in seconds), which also moves when a password changes.
  let passwordUpdatedAt = Number(u.passwordUpdatedAt) || 0;
  if (!passwordUpdatedAt && Number(u.validSince)) passwordUpdatedAt = Number(u.validSince) * 1000;

  return {
    uid: u.localId,
    email: u.email || null,
    displayName: u.displayName || '',
    emailVerified: !!u.emailVerified,
    createdAt: Number(u.createdAt) || 0,
    passwordUpdatedAt,
  };
}

/** "Oluwagbemiga Akinde" becomes "Oluwagbemiga". */
export function firstName(displayName) {
  return String(displayName || '').trim().split(/\s+/)[0] || '';
}
