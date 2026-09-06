// js/auth.js
// Wraps Firebase Authentication (Google sign-in + email/password).
// This is the ONLY frontend file that talks to Firebase Auth directly.
// Every other page gets the current user's ID token through
// Auth.getIdToken() and sends it as a Bearer token to the Worker — the
// Worker independently re-verifies it, so nothing here is a security
// boundary on its own. This module exists for UX, not enforcement.
//
// Google sign-in uses Google Identity Services (GIS) directly, NOT
// Firebase's signInWithPopup/signInWithRedirect. Both of those rely on
// a hidden cross-origin iframe that relays auth state through
// *.firebaseapp.com using third-party storage access. Safari 16.1+
// blocks that access by default (unconditionally, not tied to any
// special privacy setting), so the iframe handshake silently fails and
// the flow gets stuck blank at __/auth/handler before ever reaching
// Google's consent screen. This is documented directly by Firebase:
// https://firebase.google.com/docs/auth/web/redirect-best-practices
// GIS renders its own popup/prompt against accounts.google.com and
// hands back a Google ID token directly to our own callback — no
// firebaseapp.com iframe involved. We then exchange that ID token for
// a Firebase credential with signInWithCredential(). This works
// regardless of Firebase Hosting, third-party storage settings, or
// browser (desktop and mobile Safari included).

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

/**
 * Waits for the Google Identity Services script (loaded via <script> tag
 * in the page's <head>) to be ready. Resolves once window.google.accounts.id
 * exists, or rejects after a timeout if the script failed to load (e.g.
 * blocked by a network issue).
 */
function _waitForGis(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function check() {
      if (window.google?.accounts?.id) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('Could not load Google sign-in. Please refresh and try again.'));
        return;
      }
      setTimeout(check, 100);
    })();
  });
}

/**
 * Starts Google sign-in using Google Identity Services (GIS), NOT
 * Firebase's popup/redirect. GIS shows Google's own sign-in prompt
 * directly, then hands us an ID token via a callback, which we exchange
 * for a Firebase credential. Returns the signed-in Firebase user.
 */
async function signInWithGoogle() {
  await _waitForGis();

  const idToken = await new Promise((resolve, reject) => {
    window.google.accounts.id.initialize({
      client_id: GOOGLE_WEB_CLIENT_ID,
      callback: (response) => {
        if (response?.credential) {
          resolve(response.credential);
        } else {
          reject(new Error('Google sign-in did not return a credential.'));
        }
      },
    });

    window.google.accounts.id.prompt((notification) => {
      if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
        reject(
          new Error(
            'Google sign-in prompt was blocked or dismissed. Please try again, or use email/password.'
          )
        );
      }
    });
  });

  const credential = GoogleAuthProvider.credential(idToken);
  const result = await signInWithCredential(auth, credential);
  return result.user;
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

function friendlyAuthError(error) {
  const code = error?.code || '';
  const message = error?.message || '';
  const map = {
    'auth/invalid-email': "That email address doesn't look right.",
    'auth/user-not-found': 'No account found with that email.',
    'auth/wrong-password': 'Incorrect password.',
    'auth/invalid-credential': 'Incorrect email or password.',
    'auth/email-already-in-use': 'An account already exists with that email.',
    'auth/weak-password': 'Please choose a password with at least 6 characters.',
    'auth/popup-closed-by-user': 'Sign-in was cancelled.',
    'auth/popup-blocked':
      'Sign-in was blocked by your browser. Please allow popups for this site.',
    'auth/network-request-failed':
      'Network error. Please check your connection.',
    'auth/too-many-requests':
      'Too many attempts. Please wait a moment and try again.',
    'auth/account-exists-with-different-credential':
      'An account already exists with this email using a different sign-in method.',
  };
  return map[code] || message || 'Something went wrong. Please try again.';
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
  friendlyAuthError,
};

// Keep the global for any legacy code, but pages should import directly.
window.Auth = Auth;
export { Auth };
