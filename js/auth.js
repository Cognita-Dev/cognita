// js/auth.js

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithCredential,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  updateProfile,
  signOut,
  onAuthStateChanged,
  sendPasswordResetEmail,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  inMemoryPersistence,
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

// ── Persistence, with a fallback chain for private/incognito browsing ──
function _withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

async function _initPersistence() {
  const attempts = [
    { mode: browserLocalPersistence, timeoutMs: 1500 },
    { mode: browserSessionPersistence, timeoutMs: 1500 },
    { mode: inMemoryPersistence, timeoutMs: 1500 },
  ];
  for (const { mode, timeoutMs } of attempts) {
    try {
      await _withTimeout(setPersistence(auth, mode), timeoutMs);
      return;
    } catch (e) {
      console.warn('[Auth] Persistence mode failed or timed out, trying next:', e.message);
    }
  }
  console.error('[Auth] All persistence modes failed or timed out — continuing without persistence.');
}

const _authReadyPromise = _initPersistence().finally(() => {
  onAuthStateChanged(
    auth,
    (user) => {
      _currentUser = user;
      _isReady = true;
      _readyResolvers.forEach((resolve) => resolve(user));
      _readyResolvers = [];
    },
    (error) => {
      console.error('[Auth] onAuthStateChanged error:', error.message);
      _currentUser = null;
      _isReady = true;
      _readyResolvers.forEach((resolve) => resolve(null));
      _readyResolvers = [];
    }
  );
});

const _READY_TIMEOUT_MS = 5000;
let _timeoutFired = false;
setTimeout(() => {
  if (!_isReady) {
    _timeoutFired = true;
    _isReady = true;
    console.error('[Auth] Auth state did not settle within timeout — treating as signed out.');
    _readyResolvers.forEach((resolve) => resolve(null));
    _readyResolvers = [];
  }
}, _READY_TIMEOUT_MS);

function ready() {
  if (_isReady) return Promise.resolve(_currentUser);
  return new Promise((resolve) => _readyResolvers.push(resolve));
}

function getCurrentUser() {
  return _currentUser;
}

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
 * popup. Google's own profile info (name, photo, email) rides along
 * automatically and Firebase copies it onto the resulting user record —
 * no separate name entry is needed for Google sign-in.
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
    // Force a fresh ID token so the "name" claim (copied from the Google
    // profile onto the Firebase user record) is guaranteed to be present
    // on the very first request the app makes right after this resolves.
    try { await result.user.getIdToken(true); } catch (_) { /* non-fatal */ }
    return result.user;
  } catch (err) {
    if (!err.authField) err.authField = 'google';
    throw err;
  }
}

async function signInWithEmail(email, password) {
  const result = await signInWithEmailAndPassword(auth, email, password);
  return result.user;
}

/**
 * Creates an email/password account and attaches the person's chosen
 * name to their Firebase profile as displayName. The ID token is then
 * force-refreshed so the "name" claim is available immediately on the
 * very next authenticated request (the Worker reads it from there —
 * see auth-middleware.js / chat-endpoint.js).
 */
async function signUpWithEmail(email, password, name) {
  const result = await createUserWithEmailAndPassword(auth, email, password);
  const trimmedName = String(name || '').trim();
  if (trimmedName) {
    await updateProfile(result.user, { displayName: trimmedName });
    try { await result.user.getIdToken(true); } catch (_) { /* non-fatal */ }
  }
  return result.user;
}

async function resetPassword(email) {
  await sendPasswordResetEmail(auth, email);
}

async function logOut() {
  await signOut(auth);
}

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

async function requireAuthOrRedirect() {
  const user = await ready();
  if (!user) {
    window.location.href = '/login.html';
    return null;
  }
  return user;
}

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

  if (error?.authField) {
    return { field: error.authField, message: error.message || 'Something went wrong. Please try again.' };
  }

  return { field: 'general', message: 'Something went wrong. Please try again.' };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(email) {
  return EMAIL_RE.test(String(email || '').trim());
}

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
  const score = Object.values(checks).filter(Boolean).length;
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

window.Auth = Auth;
export { Auth };
