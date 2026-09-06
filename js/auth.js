// js/auth.js
// Wraps Firebase Authentication (Google sign-in + email/password).
// This is the ONLY frontend file that talks to Firebase Auth directly.
// Every other page gets the current user's ID token through
// Auth.getIdToken() and sends it as a Bearer token to the Worker — the
// Worker independently re-verifies it, so nothing here is a security
// boundary on its own. This module exists for UX, not enforcement.
//
// Google sign-in uses REDIRECT (not popup) because signInWithPopup is
// unreliable on mobile browsers — popups often render blank or get
// blocked. Redirect-based sign-in navigates the whole page to Google and
// back, which works reliably everywhere.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithRedirect,
  getRedirectResult,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';

// Firebase web config is NOT a secret — it's meant to be public and is
// safe to commit. It only identifies which Firebase project to talk to;
// it grants no access on its own. Actual security comes from Firestore
// rules (server-side, see firestore.rules) and the Worker's independent
// token verification (see auth-middleware.js) — never from hiding this.
const firebaseConfig = {
  apiKey: 'AIzaSyB2K_ST2Crl-u-DoWsN8QoIN2rpBOA2XOs',
  authDomain: 'cognita-b94eb.firebaseapp.com',
  projectId: 'cognita-b94eb',
  storageBucket: 'cognita-b94eb.firebasestorage.app',
  messagingSenderId: '994240602309',
  appId: '1:994240602309:web:b21738d56b47f215f9d0ac',
};

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

/**
 * Starts Google sign-in via full-page redirect. Execution does not
 * continue past this call in any meaningful way — the browser navigates
 * to Google, then back to this same page. The signed-in user is picked
 * up by handleRedirectResult() below, which must be called on page load.
 */
async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  await signInWithRedirect(auth, provider);
}

/**
 * Call this once, on every page that offers Google sign-in, right after
 * Auth.ready(). Catches the user coming back from Google after a
 * redirect. Returns the user if a redirect sign-in just completed, or
 * null if this page load wasn't the result of one (e.g. a normal visit).
 * Throws if the redirect sign-in itself failed.
 */
async function handleRedirectResult() {
  const result = await getRedirectResult(auth);
  return result?.user || null;
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

  const doFetch = (t) => fetch(url, {
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

function friendlyAuthError(error) {
  const code = error?.code || '';
  const map = {
    'auth/invalid-email': 'That email address doesn\'t look right.',
    'auth/user-not-found': 'No account found with that email.',
    'auth/wrong-password': 'Incorrect password.',
    'auth/invalid-credential': 'Incorrect email or password.',
    'auth/email-already-in-use': 'An account already exists with that email.',
    'auth/weak-password': 'Please choose a password with at least 6 characters.',
    'auth/popup-closed-by-user': 'Sign-in was cancelled.',
    'auth/network-request-failed': 'Network error. Please check your connection.',
    'auth/too-many-requests': 'Too many attempts. Please wait a moment and try again.',
    'auth/account-exists-with-different-credential': 'An account already exists with this email using a different sign-in method.',
  };
  return map[code] || 'Something went wrong. Please try again.';
}

window.Auth = {
  ready,
  getCurrentUser,
  getIdToken,
  signInWithGoogle,
  handleRedirectResult,
  signInWithEmail,
  signUpWithEmail,
  resetPassword,
  logOut,
  authedFetch,
  requireAuthOrRedirect,
  friendlyAuthError,
};
