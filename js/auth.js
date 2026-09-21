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

// Account emails (verify email, reset password) are sent by our own Worker
// from our own domain, not by Firebase. See emails/auth-email-endpoint.js.
const AUTH_MAIL_API = 'https://api.cognita.com.ng';

async function _requestAuthEmail(path, body, user) {
  const headers = { 'Content-Type': 'application/json' };
  if (user) headers.Authorization = 'Bearer ' + (await user.getIdToken());
  const res = await fetch(AUTH_MAIL_API + path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body || {}),
  });
  if (!res.ok) {
    let message = 'Could not send the email. Please try again.';
    try {
      const data = await res.json();
      if (data && data.error) message = data.error;
    } catch (_) { /* keep default message */ }
    const err = new Error(message);
    if (res.status === 429) err.code = 'auth/too-many-requests';
    throw err;
  }
}

// ── Session state ──────────────────────────────────────────────────────
//
// We deliberately use Firebase's DEFAULT persistence chain here (IndexedDB
// → localStorage → sessionStorage → in-memory). It already probes each
// storage type and falls back safely. The old code re-implemented that with
// hard 1.5s timeouts around setPersistence(); on a slow phone or network
// those timeouts fired even though nothing was wrong, which silently moved
// the login from long-lived storage into per-tab storage — the login then
// disappeared when the tab closed or opened in a second tab.
let _currentUser = null;
let _isReady = false;
let _readyResolvers = [];

let _protectedPage = false;      // set once a page calls requireAuthOrRedirect()
let _knownUid = null;            // uid this page has been running as
let _intentionalSignOut = false; // true once WE called signOut()
let _redirecting = false;

const LAST_UID_KEY = 'cognita:lastUid';
// Browser-side copies of one person's data. Must never be shown to (or
// synced into the account of) a different person on the same browser.
const USER_SCOPED_LOCAL_KEYS = ['cognita:conversations', 'cognita:pendingDeletes'];

function _clearUserScopedLocalData() {
  try {
    USER_SCOPED_LOCAL_KEYS.forEach((k) => localStorage.removeItem(k));
  } catch (_) { /* storage unavailable — nothing to clear */ }
}

// If a different account signs in on this browser, wipe the previous
// person's locally cached chats first. Without this, chat history was
// stored under one shared key: person B would see person A's chats, and
// the app's background sync would upload them into B's cloud account.
function _guardAgainstAccountSwitch(uid) {
  try {
    const last = localStorage.getItem(LAST_UID_KEY);
    if (last && last !== uid) _clearUserScopedLocalData();
    if (last !== uid) localStorage.setItem(LAST_UID_KEY, uid);
  } catch (_) { /* storage unavailable — non-fatal */ }
}

function _settleReady(user) {
  if (_isReady) return;
  _isReady = true;
  _readyResolvers.forEach((resolve) => resolve(user));
  _readyResolvers = [];
}

onAuthStateChanged(
  auth,
  (user) => {
    const previousUid = _knownUid;
    _currentUser = user;

    if (user) _guardAgainstAccountSwitch(user.uid);
    _settleReady(user);

    if (user) {
      _knownUid = user.uid;
      // Another tab signed into a DIFFERENT account. Reload so this tab
      // starts cleanly as that account instead of mixing the two.
      if (_protectedPage && previousUid && previousUid !== user.uid) {
        window.location.reload();
      }
    } else if (previousUid && _protectedPage && !_intentionalSignOut) {
      // We WERE signed in on this page and now aren't — signed out in
      // another tab, or the account was disabled / password changed.
      _knownUid = null;
      _redirectToLogin('signed_out');
    }
  },
  (error) => {
    console.error('[Auth] onAuthStateChanged error:', error.message);
    _settleReady(auth.currentUser || null);
  }
);

// NOTE: there is intentionally NO "give up after N seconds and treat the
// person as signed out" timer any more. On a slow connection Firebase
// needs a moment to restore the saved login (it may contact Google to
// refresh it). Treating "not answered yet" as "signed out" is what bounced
// people to the login page while they were logged in.
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
    // The account already exists and the person is already signed in at
    // this point. If saving the display name hiccups (flaky network) we
    // must NOT surface that as "sign-up failed" — retrying would only say
    // "email already in use". Carry on; the name can be set later.
    try {
      await updateProfile(result.user, { displayName: trimmedName });
      await result.user.getIdToken(true);
    } catch (e) {
      console.warn('[Auth] Could not save display name (non-fatal):', e.message);
    }
  }
  // Anyone could type in someone else's email address at sign-up; sending
  // a verification link is what actually confirms they own it. Non-fatal:
  // a flaky network here must not turn into "sign-up failed" either. The
  // person still gets reminded on their next visit — see the "unverified
  // email" banner wired up in requireAuthOrRedirect() below.
  try {
    await _requestAuthEmail('/api/auth/send-verification', {}, result.user);
  } catch (e) {
    console.warn('[Auth] Could not send verification email (non-fatal):', e.message);
  }
  return result.user;
}

async function resetPassword(email) {
  await _requestAuthEmail('/api/auth/send-password-reset', { email });
}

/**
 * Re-sends the verification link to the signed-in person's own email.
 * Used by the "unverified email" banner. Firebase itself rate-limits
 * this, so a rapid double-click just surfaces auth/too-many-requests
 * rather than spamming the inbox.
 */
async function resendVerificationEmail() {
  const user = auth.currentUser;
  if (!user) throw new Error('Not signed in.');
  await _requestAuthEmail('/api/auth/send-verification', {}, user);
}

/**
 * True only for accounts that could plausibly be sitting on an
 * unverified, possibly-not-owned email address: email/password sign-ups
 * that haven't clicked the link yet. Google sign-in already verifies the
 * address as a condition of the OAuth flow, so those are left alone.
 */
function needsEmailVerification(user) {
  if (!user || user.emailVerified) return false;
  return (user.providerData || []).some((p) => p.providerId === 'password');
}

/**
 * Re-fetches the signed-in person's own profile from Firebase (does
 * nothing if nobody is signed in) and returns the refreshed user. This is
 * what makes `user.emailVerified` flip to true in THIS tab after the
 * person clicks the verification link somewhere else — Firebase never
 * pushes that change to us on its own, we have to ask. Used by the
 * verify-email page's polling and by requireAuthOrRedirect(). Also forces
 * a fresh ID token so the very next authedFetch() call carries the
 * up-to-date email_verified claim rather than a stale, cached one.
 */
async function reloadCurrentUser() {
  const user = auth.currentUser;
  if (!user) return null;
  await user.reload();
  try { await user.getIdToken(true); } catch (_) { /* non-fatal */ }
  return auth.currentUser;
}

async function logOut() {
  _intentionalSignOut = true;
  try {
    await signOut(auth);
  } catch (e) {
    _intentionalSignOut = false;
    throw e;
  }
  _knownUid = null;
  // Shared-computer privacy: don't leave this person's chats behind.
  // (They're mirrored to the cloud and come back on next sign-in.)
  _clearUserScopedLocalData();
}

async function authedFetch(url, options = {}) {
  // Never run before the saved login has been restored.
  await ready();

  const user = auth.currentUser || _currentUser;
  if (!user) throw new Error('Not signed in.');

  const doFetch = (t) =>
    fetch(url, {
      ...options,
      headers: {
        ...(options.headers || {}),
        Authorization: 'Bearer ' + t,
      },
    });

  // If the token can't be fetched (e.g. offline) this throws Firebase's
  // real error (auth/network-request-failed) instead of pretending the
  // person is signed out. The session itself is untouched.
  const token = await user.getIdToken(false);
  let res = await doFetch(token);

  if (res.status === 401) {
    // Token may have expired or been rejected — get a brand-new one and
    // try exactly once more. We do NOT sign the person out on a repeated
    // 401: Firebase itself ends the session when it is genuinely invalid
    // (disabled account, password changed), which the auth-state listener
    // above handles. A 401 from our own server should never log anyone out.
    try {
      const fresh = await user.getIdToken(true);
      res = await doFetch(fresh);
    } catch (e) {
      console.warn('[Auth] Token refresh after 401 failed:', e.message);
    }
  }
  return res;
}

// ── Safe "where to go next" handling ──────────────────────────────────
// Accepts only a same-site path. Rejects absolute URLs, protocol-relative
// URLs ("//evil.com"), backslash tricks ("/\evil.com"), and never sends
// the person back to the login/signup page itself.
function getSafeNextPath(raw) {
  if (typeof raw !== 'string' || !raw.startsWith('/')) return null;
  if (raw.startsWith('//') || raw.includes('\\')) return null;
  try {
    const url = new URL(raw, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    if (/^\/(login|signup)(\.html)?\/?$/.test(url.pathname)) return null;
    return url.pathname + url.search + url.hash;
  } catch (_) {
    return null;
  }
}

// ── Redirect-loop guard ───────────────────────────────────────────────
// If something is badly wrong (e.g. the browser blocks all site storage)
// the app and login page could send the person back and forth forever.
// After 4 bounces in 30 seconds we stop and explain instead.
const BOUNCE_KEY = 'cognita:authBounces';
const BOUNCE_WINDOW_MS = 30000;
const BOUNCE_LIMIT = 4;

function _recordBounce() {
  try {
    const now = Date.now();
    const recent = JSON.parse(sessionStorage.getItem(BOUNCE_KEY) || '[]')
      .filter((t) => now - t < BOUNCE_WINDOW_MS);
    recent.push(now);
    sessionStorage.setItem(BOUNCE_KEY, JSON.stringify(recent));
    return recent.length;
  } catch (_) {
    return 1;
  }
}

function _clearBounces() {
  try { sessionStorage.removeItem(BOUNCE_KEY); } catch (_) {}
}

function _showBanner(id, html) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    el.setAttribute('role', 'status');
    el.style.cssText =
      'position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:99999;' +
      'max-width:min(92vw,440px);padding:14px 16px;border-radius:12px;' +
      'background:#fff;color:#1a1a1a;box-shadow:0 8px 30px rgba(0,0,0,.18);' +
      'font:14px/1.45 Inter,system-ui,sans-serif;text-align:center;';
    document.body.appendChild(el);
  }
  el.innerHTML = html;
  return el;
}

function _hideBanner(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

function _showLoopError() {
  const el = _showBanner(
    'authLoopNotice',
    '<strong>We can\u2019t keep you signed in on this browser.</strong><br>' +
    'Make sure cookies / site data aren\u2019t blocked and you\u2019re not in a ' +
    'private window, then try again.<br>' +
    '<button id="authLoopBtn" style="margin-top:10px;padding:8px 14px;border:0;' +
    'border-radius:8px;background:#1a1a1a;color:#fff;cursor:pointer;">Go to sign in</button>'
  );
  el.querySelector('#authLoopBtn').addEventListener('click', () => {
    _clearBounces();
    window.location.replace('/login.html');
  });
}

function _redirectToLogin(reason) {
  if (_redirecting) return;
  _redirecting = true;

  if (_recordBounce() >= BOUNCE_LIMIT) {
    _showLoopError();
    return;
  }

  // Remember where the person was headed (page + query, e.g.
  // /payment.html?plan=plus or /app.html?view=library) so that signing in
  // brings them straight back instead of dropping them on the default page.
  const params = new URLSearchParams();
  const next = getSafeNextPath(window.location.pathname + window.location.search);
  if (next) params.set('next', next);
  if (reason) params.set('reason', reason);
  const qs = params.toString();

  // replace(), not href = : keeps the protected page out of the Back-button
  // history so Back doesn't bounce the person straight into another redirect.
  window.location.replace('/login.html' + (qs ? '?' + qs : ''));
}

// Sends an unverified email/password account to the dedicated
// verify-email page instead of the page it originally asked for. Shares
// the same bounce-loop guard as _redirectToLogin — if something keeps
// bouncing the person back here (e.g. a token that can never resolve to
// verified) we stop and explain rather than looping forever.
function _redirectToVerifyEmail() {
  if (_redirecting) return;
  _redirecting = true;

  if (_recordBounce() >= BOUNCE_LIMIT) {
    _showLoopError();
    return;
  }

  const params = new URLSearchParams();
  const next = getSafeNextPath(window.location.pathname + window.location.search);
  if (next) params.set('next', next);
  const qs = params.toString();

  window.location.replace('/verify-email.html' + (qs ? '?' + qs : ''));
}

/**
 * Call at the start of any page that needs a signed-in person. Waits for
 * the saved login to be restored (however long that takes), and only
 * redirects to the login page when Firebase has DEFINITELY said "nobody is
 * signed in". Also keeps watching for the rest of the page's life so that
 * signing out in another tab, or an account being disabled, sends this tab
 * to login cleanly instead of leaving it half-broken.
 */
async function requireAuthOrRedirect() {
  _protectedPage = true;

  // If restoring the login is slow, say so rather than guess.
  const slowTimer = setTimeout(() => {
    _showBanner(
      'authSlowNotice',
      'Still connecting\u2026 this is taking longer than usual.<br>' +
      '<button id="authSlowBtn" style="margin-top:8px;padding:6px 12px;border:0;' +
      'border-radius:8px;background:#1a1a1a;color:#fff;cursor:pointer;">Reload</button>'
    ).querySelector('#authSlowBtn').addEventListener('click', () => window.location.reload());
  }, 8000);

  let user;
  try {
    user = await ready();
  } finally {
    clearTimeout(slowTimer);
    _hideBanner('authSlowNotice');
  }

  if (!user) {
    _redirectToLogin();
    return null;
  }
  _knownUid = user.uid;

  if (needsEmailVerification(user)) {
    // The signed-in snapshot Firebase restored from local storage can be
    // stale — the person may already have clicked the verification link
    // on another tab or device since this browser last talked to
    // Firebase. Reload from the server once before deciding to bounce
    // them, so a person who's actually verified is never sent back to
    // the verify-email page.
    try {
      await user.reload();
    } catch (_) { /* offline / transient — fall through with what we have */ }

    if (needsEmailVerification(auth.currentUser || user)) {
      _redirectToVerifyEmail();
      return null;
    }
  }

  return user;
}

// Back/forward cache: after signing out, pressing Back can restore the
// old signed-in page from memory without running any code. Re-check.
window.addEventListener('pageshow', (event) => {
  if (!event.persisted) return;
  _redirecting = false;
  if (_protectedPage && !auth.currentUser) _redirectToLogin('signed_out');
});

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
    length: pwd.length >= 8,
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
  resendVerificationEmail,
  needsEmailVerification,
  reloadCurrentUser,
  logOut,
  authedFetch,
  requireAuthOrRedirect,
  getSafeNextPath,
  classifyAuthError,
  isValidEmail,
  evaluatePasswordStrength,
};

window.Auth = Auth;
export { Auth };
