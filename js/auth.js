// js/auth.js

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithCredential,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';

// Firebase web config is NOT a secret — it's meant to be public and is
// safe to commit. It only identifies which Firebase project to talk to;
// it grants no access on its own. Actual security comes from Firestore
// rules (server-side) and the Worker's independent token verification
// (see auth-middleware.js) — never from hiding this.
const firebaseConfig = {
  apiKey: 'AIzaSyB2K_ST2Crl-u-DoWsN8QoIN2rpBOA2XOs',
  authDomain: 'cognita-b94eb.firebaseapp.com',
  projectId: 'cognita-b94eb',
  storageBucket: 'cognita-b94eb.firebasestorage.app',
  messagingSenderId: '994240602309',
  appId: '1:994240602309:web:b21738d56b47f215f9d0ac',
};

// Web client ID from Firebase Console → Authentication → Sign-in method
// → Google → Web SDK configuration. This is what GIS uses to identify
// our app to Google — it is also not a secret.
const GOOGLE_WEB_CLIENT_ID =
  '994240602309-4qh07lo5ugu2p07n4tmkvamotovqkspk.apps.googleusercontent.com';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

let _currentUser = null;
let _readyResolvers = [];
let _isReady = false;

onAuthStateChanged(auth, (user) => {
  _currentUser = user;
  _isReady = true;
  _readyResolvers.forEach((resolve) => resolve(user));
  _readyResolvers = [];
});

/** Resolves once Firebase has determined the initial auth state. */
function ready() {
  if (_isReady) return Promise.resolve(_currentUser);
  return new Promise((resolve) => _readyResolvers.push(resolve));
}

function getCurrentUser() {
  return _currentUser;
}

/** Returns a fresh ID token for the current user, or null if signed out. */
async function getIdToken(forceRefresh = false) {
  if (!_currentUser) return null;
  try {
    return await _currentUser.getIdToken(forceRefresh);
  } catch (e) {
    console.error('[Auth] Could not get ID token:', e.message);
    return null;
  }
}

function _waitForGis(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function check() {
      if (window.google?.accounts?.oauth2) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        const e = new Error('Could not load Google sign-in. Please refresh and try again.');
        e.authField = 'google';
        reject(e);
        return;
      }
      setTimeout(check, 100);
    })();
  });
}

/**
 * Starts Google sign-in using Google Identity Services' OAuth2 token
 * popup, NOT One Tap and NOT Firebase's popup/redirect. Unlike One Tap,
 * this opens a real, reliable popup directly to accounts.google.com in
 * response to the user's click, so it isn't subject to One Tap's
 * display/cooldown restrictions or FedCM quirks on Safari. It still
 * never touches firebaseapp.com's iframe. We get back an access token,
 * which Firebase accepts directly to build a credential.
 *
 * Every error thrown from this function is tagged with authField='google'
 * so the caller always knows to render it under the Google button —
 * these errors never carry a Firebase auth/... code of their own.
 */
async function signInWithGoogle() {
  await _waitForGis();

  const accessToken = await new Promise((resolve, reject) => {
    const tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_WEB_CLIENT_ID,
      scope: 'openid email profile',
      callback: (response) => {
        if (response?.access_token) {
          resolve(response.access_token);
        } else {
          const e = new Error('Google sign-in did not return an access token.');
          e.authField = 'google';
          reject(e);
        }
      },
      error_callback: (err) => {
        let e;
        if (err?.type === 'popup_closed') {
          e = new Error('Sign-in was cancelled.');
        } else if (err?.type === 'popup_failed_to_open') {
          e = new Error('Popup blocked. Please allow popups for this site.');
        } else {
          e = new Error('Google sign-in failed. Please try again.');
        }
        e.authField = 'google';
        reject(e);
      },
    });
    tokenClient.requestAccessToken();
  });

  const credential = GoogleAuthProvider.credential(null, accessToken);
  try {
    const result = await signInWithCredential(auth, credential);
    return result.user;
  } catch (err) {
    // Firebase-side failure of an otherwise successful Google auth
    // (e.g. account-exists-with-different-credential) still belongs
    // under the Google button, not the email/password fields.
    if (!err.authField) err.authField = 'google';
    throw err;
  }
}

async function signInWithEmail(email, password) {
  const result = await signInWithEmailAndPassword(auth, email, password);
  return result.user;
}

async function signUpWithEmail(email, password) {
  const result = await createUserWithEmailAndPassword(auth, email, password);
  return result.user;
}

async function resetPassword(email) {
  await sendPasswordResetEmail(auth, email);
}

async function logOut() {
  await signOut(auth);
}

/**
 * Fetches from the Worker with the current user's ID token attached.
 * Use this instead of raw fetch() for any /api/* call that requires auth.
 * Automatically retries once with a forced token refresh on a 401, since
 * that's the common case of a token having just expired.
 */
async function authedFetch(url, options = {}) {
  let token = await getIdToken(false);
  if (!token) throw new Error('Not signed in.');

  const doFetch = (t) =>
    fetch(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: 'Bearer ' + t,
      },
    });

  let res = await doFetch(token);
  if (res.status === 401) {
    token = await getIdToken(true);
    if (token) res = await doFetch(token);
  }
  return res;
}

/**
 * Redirects to login.html if no user is signed in once auth state settles.
 * Call this at the top of any protected page (app.html, account.html, etc).
 */
async function requireAuthOrRedirect() {
  const user = await ready();
  if (!user) {
    window.location.href = '/login.html';
    return null;
  }
  return user;
}

/**
 * Turns ANY auth error — Firebase-coded or our own — into a
 * { field, message } pair that's always safe to show a user directly.
 * field is one of: 'email', 'password', 'google', 'general'.
 * There is no path through here that can surface a raw Firebase code
 * or error.message unless we've explicitly decided it's already
 * human-readable (i.e. it came from our own code with authField set).
 */
function classifyAuthError(error) {
  const code = error?.code || '';

  const codeMap = {
    'auth/invalid-email': { field: 'email', message: 'Enter a valid email address.' },
    'auth/missing-email': { field: 'email', message: 'Enter your email.' },
    'auth/user-not-found': { field: 'email', message: 'No account found with that email.' },
    'auth/user-disabled': { field: 'email', message: 'This account has been disabled.' },
    'auth/wrong-password': { field: 'password', message: 'Incorrect password.' },
    'auth/missing-password': { field: 'password', message: 'Enter your password.' },
    'auth/invalid-credential': { field: 'password', message: 'Incorrect email or password.' },
    'auth/invalid-login-credentials': { field: 'password', message: 'Incorrect email or password.' },
    'auth/email-already-in-use': { field: 'email', message: 'An account already exists with that email.' },
    'auth/weak-password': { field: 'password', message: 'Please choose a stronger password.' },
    'auth/popup-closed-by-user': { field: 'google', message: 'Sign-in was cancelled.' },
    'auth/popup-blocked': { field: 'google', message: 'Popup blocked. Please allow popups for this site.' },
    'auth/cancelled-popup-request': { field: 'google', message: 'Sign-in was cancelled.' },
    'auth/network-request-failed': { field: 'general', message: 'Network error. Check your connection and try again.' },
    'auth/too-many-requests': { field: 'general', message: 'Too many attempts. Please wait a moment and try again.' },
    'auth/account-exists-with-different-credential': {
      field: 'google',
      message: 'An account already exists with this email using a different sign-in method.',
    },
  };

  if (codeMap[code]) return codeMap[code];

  // Our own thrown errors (Google flow, "Not signed in.", forgot-password
  // guard, etc.) already carry a safe message and, where relevant, a
  // pre-set field.
  if (error?.authField) {
    return { field: error.authField, message: error.message || 'Something went wrong. Please try again.' };
  }

  // Unknown/unmapped — never leak the raw code or message.
  return { field: 'general', message: 'Something went wrong. Please try again.' };
}

// ── Client-side input validation ──
// This is UX help, not a security boundary: it just gives people instant
// feedback instead of a round trip to Firebase. The real enforcement is
// server-side — Firebase Auth's own account rules, plus auth-middleware.js
// independently re-verifying every token on every request.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(email) {
  return EMAIL_RE.test(String(email || '').trim());
}

/**
 * Evaluates password strength against fixed requirements:
 * 6+ characters, at least one lowercase letter, one uppercase letter,
 * one number. Special characters are optional but count toward score.
 * Returns { score (0-5), percent, level ('weak'|'fair'|'strong'),
 * checks: { length, lower, upper, number, special }, valid (bool) }.
 */
function evaluatePasswordStrength(password) {
  const pwd = String(password || '');
  const checks = {
    length: pwd.length >= 6,
    lower: /[a-z]/.test(pwd),
    upper: /[A-Z]/.test(pwd),
    number: /[0-9]/.test(pwd),
    special: /[^A-Za-z0-9]/.test(pwd),
  };

  const requiredMet = checks.length && checks.lower && checks.upper && checks.number;
  const score = Object.values(checks).filter(Boolean).length; // 0-5
  const percent = Math.min(100, (score / 5) * 100);

  let level = 'weak';
  if (requiredMet && checks.special) level = 'strong';
  else if (requiredMet) level = 'fair';

  return { score, percent, level, checks, valid: requiredMet };
}

const Auth = {
  ready,
  getCurrentUser,
  getIdToken,
  signInWithGoogle,
  signInWithEmail,
  signUpWithEmail,
  resetPassword,
  logOut,
  authedFetch,
  requireAuthOrRedirect,
  classifyAuthError,
  isValidEmail,
  evaluatePasswordStrength,
};

// Keep the global for any legacy code, but pages should import directly.
window.Auth = Auth;
export { Auth };
