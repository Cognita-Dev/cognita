// js/learna.js
// Learna view. Exports mount(), activate() and deactivate(), called by js/router.js.
// Routes inside the view use the query string so refresh, back and forward work:
//   ?view=learna                          catalogue
//   ?view=learna&course=<id>              course page
//   ?view=learna&course=<id>&lesson=<key> learning workspace
//
// The browser never decides progress or grades. It shows what the server returns
// and sends answers. Code tests run in the existing Cognita sandbox; the server
// compares the values they produce against expectations the browser never sees,
// and adds hidden cases for every run (see learna-endpoint.js).
// Speech (listening, dictation, recording) lives in learna-speech.js and is only
// offered where it has a learning purpose.

import { escapeHtml as esc, ensureSidebarAccount } from './shell.js';
import { SandboxClient } from './sandbox-client.js';
import * as Speech from './learna-speech.js';

const WORKER_URL = 'https://api.cognita.com.ng';
const root = () => document.getElementById('learnaRoot');
const scroller = () => document.getElementById('learnaScroll');

const S = {
  route: { course: null, lesson: null },
  cat: null, catState: 'idle',
  filters: { q: '', category: 'all', level: 'all' },
  detail: null, detailState: 'idle', detailFor: null,
  lessonData: null, lessonState: 'idle', lessonFor: null,
  busy: new Set(),
  tutor: { open: false, log: [], sending: false, forStep: null },
  drawer: false, token: 0, lastFocus: null,
  draft: {},                 // unsent answers, keyed by activity id
  result: {},                // latest server result per activity id
  codeOut: {},               // latest test run per activity id
  notice: null,
  hot: {},                   // selected hotspot per step id
  voices: null,              // speech status from the server
  speech: { playing: null, note: null },
  rec: {},                   // recorder state per activity id
  cert: { name: '', busy: false, error: null, done: null },
  prefs: null, prefsOpen: false,
};
let liveRec = null, liveDict = null;   // the one active recorder and dictation session
let sandbox = null;
let mounted = false;

// ── Helpers ──────────────────────────────────────────────────────────────
class ApiError extends Error { constructor(message, status, code) { super(message); this.status = status; this.code = code; } }

async function api(path, { method = 'GET', body } = {}) {
  let res;
  try {
    res = await window.Auth.authedFetch(WORKER_URL + '/api/learna' + path, {
      method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
    });
  } catch (_) { throw new ApiError('Could not reach Cognita. Check your connection and try again.', 0, 'NETWORK'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || 'Something went wrong. Please try again.', res.status, data.code || (res.status === 401 ? 'AUTH' : null));
  return data;
}

// Binary helpers: premium voice audio comes back as audio, and recordings go up as raw bytes.
async function apiBlob(path, body) {
  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/learna' + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) { const j = await res.json().catch(() => ({})); return { ok: false, code: j.code || null, status: res.status }; }
    return { ok: true, blob: await res.blob() };
  } catch (_) { return { ok: false, code: 'NETWORK' }; }
}
async function apiUpload(path, blob, headers) {
  let res;
  try { res = await window.Auth.authedFetch(WORKER_URL + '/api/learna' + path, { method: 'POST', headers, body: blob }); }
  catch (_) { throw new ApiError('Could not reach Cognita. Check your connection and try again.', 0, 'NETWORK'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(data.error || 'The upload did not work. Please try again.', res.status, data.code || (res.status === 401 ? 'AUTH' : null));
  return data;
}

const say = (text) => { const el = document.getElementById('learnaStatus'); if (el) { el.textContent = ''; setTimeout(() => { el.textContent = text; }, 30); } };
const paras = (arr) => arr.map((t) => '<p>' + esc(t) + '</p>').join('');
const catName = (id) => ((S.cat && S.cat.categories.find((c) => c.id === id)) || {}).name || '';
const planName = (p) => ({ free: 'Starter', plus: 'Plus', studio: 'Studio', admin: 'Admin' }[p] || p);
const minutes = (n) => (n >= 60 ? (Math.floor(n / 60) + ' h' + (n % 60 ? ' ' + (n % 60) + ' min' : '')) : n + ' min');
const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
const isAuthErr = (e) => e && (e.code === 'AUTH' || e.status === 401);
const courseLang = () => (S.detail && S.detail.course.language && S.detail.course.language.tts) || 'en-NG';
const isLangCourse = () => !!(S.detail && S.detail.course.language);
const clock = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');

// [[word]] in course text shows the word with a small speaker button that says only that word.
function rich(text) {
  return esc(text).replace(/\[\[(.+?)\]\]/g, (_, w) => `<span class="lrn-w">${w}<button type="button" class="lrn-spk" data-act="speak-word" data-word="${w}" aria-label="Hear ${w}"><i class="ph ph-speaker-high" aria-hidden="true"></i></button></span>`);
}
const plainText = (t) => String(t).replace(/\[\[|\]\]/g, '');

function visualHtml(v, id) {
  if (!v) return '';
  const sel = S.hot[id];
  const spots = (v.hotspots || []).map((h, i) => `<button type="button" class="lrn-hot ${sel === i ? 'is-on' : ''}" style="left:${h.x}%;top:${h.y}%" data-act="hot" data-step="${esc(id)}" data-i="${i}" aria-label="${esc(h.label)}: point ${i + 1} of ${v.hotspots.length}" aria-pressed="${sel === i}"><span aria-hidden="true">${i + 1}</span></button>`).join('');
  const panel = v.hotspots && v.hotspots.length ? `<div class="lrn-hot-panel" role="status">${sel != null && v.hotspots[sel] ? `<p class="lrn-hot-h">${sel + 1}. ${esc(v.hotspots[sel].label)}</p><p>${esc(v.hotspots[sel].text)}</p>` : '<p class="lrn-hot-hint">Tap a numbered point on the picture to learn more.</p>'}</div>
    <details class="lrn-hot-list"><summary>Read the numbered points as a list</summary><ol>${v.hotspots.map((h) => `<li><strong>${esc(h.label)}.</strong> ${esc(h.text)}</li>`).join('')}</ol></details>` : '';
  return `<figure class="lrn-visual"><div class="lrn-visual-img"><img src="${esc(v.src)}" alt="${esc(v.alt)}" loading="lazy" decoding="async" width="1200" height="675">${spots}</div>${v.caption ? `<figcaption>${esc(v.caption)}</figcaption>` : ''}</figure>${panel}`;
}

function routeFromUrl() {
  const p = new URLSearchParams(window.location.search);
  return { course: p.get('course'), lesson: p.get('lesson') };
}
function go(course, lesson, { replace = false } = {}) {
  const url = new URL(window.location.href);
  url.searchParams.set('view', 'learna');
  url.searchParams.delete('course'); url.searchParams.delete('lesson');
  if (course) url.searchParams.set('course', course);
  if (course && lesson) url.searchParams.set('lesson', lesson);
  window.history[replace ? 'replaceState' : 'pushState']({ view: 'learna' }, '', url);
  onRouteChange();
}

function errorBlock(e, retryAttr) {
  if (isAuthErr(e)) return `<div class="lrn-state" role="alert"><h3>You have been signed out</h3><p>Your session ended. Sign in again to carry on. Your progress is saved.</p><a class="lrn-btn lrn-btn--primary" href="/login.html">Sign in</a></div>`;
  return `<div class="lrn-state" role="alert"><h3>${e.code === 'NETWORK' ? 'You seem to be offline' : 'This did not load'}</h3><p>${esc(e.message)}</p><button class="lrn-btn" type="button" ${retryAttr}>Try again</button></div>`;
}
const skeletonList = () => `<div class="lrn-skel" aria-hidden="true">${'<div class="lrn-skel-row"><span class="skeleton"></span><span class="skeleton"></span><span class="skeleton"></span></div>'.repeat(4)}</div>`;

// ── Loading ──────────────────────────────────────────────────────────────
async function loadCatalogue(force) {
  if (S.catState === 'loading') return;
  if (S.cat && !force) return;
  S.catState = 'loading'; if (!S.cat) render();
  try { S.cat = await api('/catalogue'); S.catState = 'ready'; }
  catch (e) { S.catState = 'error'; S.catError = e; }
  render();
}

async function loadDetail(id, force) {
  if (S.detailFor === id && S.detail && !force) return;
  const t = ++S.token; S.detail = null; S.detailFor = id; S.detailState = 'loading'; render();
  try { const d = await api('/courses/' + encodeURIComponent(id)); if (t !== S.token) return; S.detail = d; S.detailState = 'ready'; }
  catch (e) { if (t !== S.token) return; S.detailState = e.status === 404 ? 'missing' : 'error'; S.detailError = e; }
  render();
  if (S.detailState === 'ready') { S.cert = { name: S.cert.name, busy: false, error: null, done: null }; loadCertificate(); }
}

async function loadLesson(courseId, key, force) {
  if (S.lessonFor === courseId + '/' + key && S.lessonData && !force) return;
  cleanupMedia();
  const t = ++S.token; S.lessonData = null; S.lessonFor = courseId + '/' + key; S.lessonState = 'loading'; S.hot = {}; S.rec = {};
  S.tutor = { open: window.matchMedia('(min-width: 900px)').matches, log: [], sending: false }; S.result = {}; S.codeOut = {}; S.draft = {};
  if (!S.detail || S.detailFor !== courseId) { try { S.detail = await api('/courses/' + encodeURIComponent(courseId)); S.detailFor = courseId; } catch (e) { if (t !== S.token) return; S.lessonState = 'error'; S.lessonError = e; render(); return; } if (t !== S.token) return; }
  if (!S.detail.progress) { go(courseId, null, { replace: true }); return; }
  render();
  try {
    const d = await api('/courses/' + encodeURIComponent(courseId) + '/lessons/' + encodeURIComponent(key));
    if (t !== S.token) return;
    S.lessonData = d; S.lessonState = 'ready'; S.notice = d.notice || null; ensureVoices();
    if (S.openTask && !d.lesson.steps.some((x) => x.id === S.openTask)) S.openTask = null;
    S.detail.progress = d.progress;
  } catch (e) {
    if (t !== S.token) return;
    if (e.code === 'NOT_ENROLLED' || e.code === 'LESSON_LOCKED' || e.code === 'PLAN_REQUIRED') { go(courseId, null, { replace: true }); return; }
    S.lessonState = e.status === 404 ? 'missing' : 'error'; S.lessonError = e;
  }
  render();
}

// ── Render dispatcher ────────────────────────────────────────────────────
let lastKey = null;
function render() {
  const el = root(); if (!el) return;
  const { course, lesson } = S.route;
  const key = course ? (lesson ? 'l:' + course + '/' + lesson : 'c:' + course) : 'cat';
  const active = document.activeElement;
  const keepFocusId = active && el.contains(active) && active.id ? active.id : null;
  const keepSel = keepFocusId && active.selectionStart != null ? [active.selectionStart, active.selectionEnd] : null;

  if (!course) el.innerHTML = viewCatalogue();
  else if (!lesson) el.innerHTML = viewCourse();
  else el.innerHTML = viewWorkspace();

  if (key !== lastKey) {
    lastKey = key;
    const h = el.querySelector('[data-focus-heading]');
    if (h) { h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
    scroller().scrollTop = 0;
  } else if (keepFocusId) {
    const n = document.getElementById(keepFocusId);
    if (n) { n.focus({ preventScroll: true }); if (keepSel && n.setSelectionRange) try { n.setSelectionRange(keepSel[0], keepSel[1]); } catch (_) {} }
  }
  syncTitle();
}

function syncTitle() {
  const t = document.querySelector('#view-learna .conversation-title');
  if (!t) return;
  t.textContent = S.route.course && S.detail && S.detailFor === S.route.course ? S.detail.course.title : 'Learna';
}

// ── Catalogue ────────────────────────────────────────────────────────────
function accessLine(v) {
  if (v.planId === 'free') return '<p class="lrn-plan"><strong>Browsing is free.</strong> Starting a course needs <a href="/pricing.html">Plus or Studio</a>.</p>';
  if (v.courseLimit === null) return `<p class="lrn-plan"><strong>${planName(v.planId)}.</strong> You can take any course, with no limit.</p>`;
  return `<p class="lrn-plan"><strong>${planName(v.planId)}.</strong> ${v.activeCourses} of ${v.courseLimit} courses in use. ${v.atLimit ? 'Finish a course to free a place, or <a href="/pricing.html">upgrade</a>.' : ''}</p>`;
}

function courseRow(c, mine) {
  const m = mine[c.id];
  const status = m ? (m.status === 'completed' ? '<span class="lrn-tag lrn-tag--done">Completed</span>' : `<span class="lrn-tag lrn-tag--live">${m.percent}% done</span>`) : (c.adminState ? `<span class="lrn-tag lrn-tag--warn">${c.adminState === 'draft' ? 'Draft: only admins see this' : 'Unpublished'}</span>` : c.status !== 'available' ? '<span class="lrn-tag">Coming soon</span>' : (c.access_state.allowed ? '' : `<span class="lrn-tag">${planName(c.access)} to start</span>`));
  return `<li><a class="lrn-row" href="/app.html?view=learna&course=${encodeURIComponent(c.id)}" data-course="${esc(c.id)}">
    <span class="lrn-row-main">
      <span class="lrn-eyebrow">${esc(catName(c.category))}</span>
      <span class="lrn-row-title">${esc(c.title)}</span>
      <span class="lrn-row-desc">${esc(c.shortDescription)}</span>
      <span class="lrn-meta"><span>${esc(c.level)}</span><span>${esc(c.estimatedDuration)}</span><span>${plural(c.lessonCount, 'lesson')}</span><span>Practical work</span></span>
    </span>
    <span class="lrn-row-side">${status}<i class="ph ph-arrow-right" aria-hidden="true"></i></span>
  </a></li>`;
}

function filtered() {
  const f = S.filters, q = f.q.trim().toLowerCase();
  return S.cat.courses.filter((c) => (f.category === 'all' || c.category === f.category) && (f.level === 'all' || (f.level === 'A1-C2' ? /^[ABC][12]$/.test(c.level) : c.level === f.level)) &&
    (!q || (c.title + ' ' + c.shortDescription + ' ' + c.skills.join(' ') + ' ' + catName(c.category)).toLowerCase().includes(q)));
}

function viewCatalogue() {
  const head = `<header class="lrn-hero">
      <p class="lrn-kicker">Learna</p>
      <h2 class="lrn-display" data-focus-heading>Learn something useful. Build the skill. Put it into practice.</h2>
      <p class="lrn-lede">Short courses with real tasks. Your tutor knows exactly where you are, teaches one step at a time, and checks your work.</p>
    </header>`;
  if (S.catState === 'error' && !S.cat) return `<div class="lrn-page">${head}${errorBlock(S.catError, 'data-act="reload-cat"')}</div>`;
  if (!S.cat) return `<div class="lrn-page">${head}<div aria-busy="true" aria-label="Loading courses">${skeletonList()}</div></div>`;

  const mine = S.cat.mine, v = S.cat.viewer;
  const going = S.cat.courses.filter((c) => mine[c.id] && mine[c.id].status === 'active').sort((a, b) => (mine[b.id].lastActivityAt || '').localeCompare(mine[a.id].lastActivityAt || ''));
  const done = S.cat.courses.filter((c) => mine[c.id] && mine[c.id].status === 'completed');
  const list = filtered();
  const searching = S.filters.q || S.filters.category !== 'all' || S.filters.level !== 'all';
  const feat = S.cat.courses.filter((c) => c.featured && c.status === 'available');

  const yours = going.length ? `<section class="lrn-section" aria-labelledby="lrnYours"><h3 id="lrnYours" class="lrn-h">Continue learning</h3><ul class="lrn-continue">${going.map((c) => `<li class="lrn-cont"><div><p class="lrn-cont-title">${esc(c.title)}</p><div class="lrn-bar" role="progressbar" aria-label="${esc(c.title)} progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${mine[c.id].percent}"><span style="width:${mine[c.id].percent}%"></span></div><p class="lrn-cont-sub">${mine[c.id].percent}% complete</p></div><button type="button" class="lrn-btn lrn-btn--primary" data-act="resume" data-course="${esc(c.id)}">Continue</button></li>`).join('')}</ul></section>` :
    (v.canTake ? `<section class="lrn-section"><h3 class="lrn-h">Your courses</h3><p class="lrn-empty-inline">You have not started a course yet. Pick one below.</p></section>` : '');

  const featured = !searching && feat.length ? `<section class="lrn-section" aria-labelledby="lrnFeat"><h3 id="lrnFeat" class="lrn-h">Start here</h3><div class="lrn-feat">${feat.slice(0, 2).map((c) => `<a class="lrn-feat-item" href="/app.html?view=learna&course=${encodeURIComponent(c.id)}" data-course="${esc(c.id)}"><span class="lrn-eyebrow">${esc(catName(c.category))}</span><span class="lrn-feat-title">${esc(c.title)}</span><span class="lrn-row-desc">${esc(c.shortDescription)}</span><span class="lrn-meta"><span>${esc(c.level)}</span><span>${esc(c.estimatedDuration)}</span><span>${plural(c.lessonCount, 'lesson')}</span></span></a>`).join('')}</div></section>` : '';

  const cats = [{ id: 'all', name: 'All' }, ...S.cat.categories];
  const hasLang = S.cat.courses.some((c) => /^[ABC][12]$/.test(c.level));
  const levels = ['all', 'Beginner', 'Intermediate', 'Advanced', ...(hasLang ? ['A1-C2'] : [])];
  const levelName = (l) => ({ all: 'All levels', 'A1-C2': 'Language levels (A1 to C2)' }[l] || l);

  return `<div class="lrn-page">${head}
    <div class="lrn-plan-wrap">${accessLine(v)}</div>
    ${S.catState === 'error' ? `<div class="lrn-banner" role="alert">Could not refresh the list. <button class="lrn-link" type="button" data-act="reload-cat">Try again</button></div>` : ''}
    ${yours}${featured}
    ${v.isAdmin ? '<p class="lrn-plan"><a href="/admin.html#courses">Manage courses</a> (admins only): create, edit, publish and review tasks.</p>' : ''}
    <section class="lrn-section" aria-labelledby="lrnAll">
      <h3 id="lrnAll" class="lrn-h">All courses</h3>
      <div class="lrn-tools">
        <label class="lrn-search"><span class="lrn-sr">Search courses</span><i class="ph ph-magnifying-glass" aria-hidden="true"></i><input id="lrnSearch" type="search" placeholder="Search by topic or skill" value="${esc(S.filters.q)}" autocomplete="off"></label>
        <label class="lrn-select"><span class="lrn-sr">Level</span><select id="lrnLevel">${levels.map((l) => `<option value="${esc(l)}" ${S.filters.level === l ? 'selected' : ''}>${esc(levelName(l))}</option>`).join('')}</select></label>
      </div>
      <div class="lrn-cats" role="group" aria-label="Categories">${cats.map((c) => `<button type="button" class="lrn-chip" data-act="cat" data-cat="${esc(c.id)}" aria-pressed="${S.filters.category === c.id}">${esc(c.name)}</button>`).join('')}</div>
      <p class="lrn-count" id="lrnCount">${plural(list.length, 'course')}</p>
      ${list.length ? `<ul class="lrn-list">${list.map((c) => courseRow(c, mine)).join('')}</ul>` : `<div class="lrn-state"><h3>No courses match</h3><p>Try a different word, or clear the filters.</p><button class="lrn-btn" type="button" data-act="clear">Clear filters</button></div>`}
    </section>
    ${done.length ? `<p class="lrn-foot">You have completed ${plural(done.length, 'course')}.</p>` : ''}
    ${v.canTake ? prefsPanel() : ''}
  </div>`;
}

// ── Course page ──────────────────────────────────────────────────────────
function ctaFor(d) {
  const { course, access, viewer, progress } = d;
  if (course.status !== 'available') return { html: '<button class="lrn-btn lrn-btn--primary lrn-btn--block" type="button" disabled>Coming soon</button>', note: 'This course is not open yet.' };
  if (progress) {
    if (progress.status === 'completed') return { html: `<button class="lrn-btn lrn-btn--block" type="button" data-act="resume" data-course="${esc(course.id)}">Review the course</button>`, note: 'You have finished this course.' };
    return { html: `<button class="lrn-btn lrn-btn--primary lrn-btn--block" type="button" data-act="resume" data-course="${esc(course.id)}">Continue</button>`, note: progress.percent + '% complete' };
  }
  if (!access.allowed) return { html: '<a class="lrn-btn lrn-btn--primary lrn-btn--block" href="/pricing.html">Upgrade to start</a>', note: 'Starting this course needs ' + planName(access.requiredPlan) + ' or higher. You can read everything here for free.' };
  if (viewer.atLimit) return { html: '<button class="lrn-btn lrn-btn--block" type="button" disabled>Course limit reached</button>', note: `${planName(viewer.planId)} allows ${viewer.courseLimit} courses at once. Finish one to free a place, or <a href="/pricing.html">upgrade to Studio</a>.` };
  const busy = S.busy.has('enroll');
  return { html: `<button class="lrn-btn lrn-btn--primary lrn-btn--block" type="button" data-act="enroll" ${busy ? 'disabled' : ''}>${busy ? 'Starting' : 'Start course'}</button>`, note: viewer.courseLimit === null ? '' : `Uses 1 of your ${viewer.courseLimit} course places. It is freed when you finish the course.` };
}

function viewCourse() {
  const back = `<a class="lrn-back" href="/app.html?view=learna" data-act="home"><i class="ph ph-arrow-left" aria-hidden="true"></i> All courses</a>`;
  if (S.detailState === 'loading' || (S.detailFor !== S.route.course && S.detailState !== 'error')) return `<div class="lrn-page">${back}<h2 class="lrn-sr" data-focus-heading>Loading course</h2><div aria-busy="true">${skeletonList()}</div></div>`;
  if (S.detailState === 'missing') return `<div class="lrn-page">${back}<div class="lrn-state"><h2 data-focus-heading>This course is not available</h2><p>It may have been removed or the link is wrong.</p><a class="lrn-btn" href="/app.html?view=learna" data-act="home">See all courses</a></div></div>`;
  if (S.detailState === 'error') return `<div class="lrn-page">${back}${errorBlock(S.detailError, 'data-act="reload-detail"')}</div>`;

  const d = S.detail, c = d.course, prog = d.progress;
  const cta = ctaFor(d);
  const li = (a) => '<ul class="lrn-bullets">' + a.map((x) => '<li>' + esc(x) + '</li>').join('') + '</ul>';
  return `<div class="lrn-page lrn-page--course">${back}
    ${S.notice ? `<div class="lrn-banner" role="status">${esc(S.notice)}</div>` : ''}
    ${d.notice ? `<div class="lrn-banner" role="status">${esc(d.notice)}</div>` : ''}
    <div class="lrn-course">
      <div class="lrn-course-main">
        <p class="lrn-eyebrow">${esc(catName(c.category))}</p>
        <h2 class="lrn-title" data-focus-heading>${esc(c.title)}</h2>
        <p class="lrn-lede">${esc(c.shortDescription)}</p>
        <dl class="lrn-facts">
          <div><dt>Level</dt><dd>${esc(c.level)}</dd></div><div><dt>Time</dt><dd>${esc(c.estimatedDuration)}</dd></div>
          <div><dt>Sections</dt><dd>${c.sectionCount}</dd></div><div><dt>Lessons</dt><dd>${c.lessonCount}</dd></div>
        </dl>
        <p class="lrn-body">${esc(c.fullDescription)}</p>
        <section aria-labelledby="lrnOut"><h3 id="lrnOut" class="lrn-h">What you will be able to do</h3>${li(c.learningOutcomes)}</section>
        <section aria-labelledby="lrnFor"><h3 id="lrnFor" class="lrn-h">Who it is for</h3><p class="lrn-body">${esc(c.whoFor)}</p></section>
        <section aria-labelledby="lrnPre"><h3 id="lrnPre" class="lrn-h">Before you start</h3>${li(c.prerequisites)}</section>
        <section aria-labelledby="lrnSk"><h3 id="lrnSk" class="lrn-h">Skills you will practise</h3><p class="lrn-skills">${c.skills.map((s) => `<span>${esc(s)}</span>`).join('')}</p></section>
        <section aria-labelledby="lrnPr"><h3 id="lrnPr" class="lrn-h">Practical work</h3><p class="lrn-body">${esc(c.practical)}</p></section>
        <section aria-labelledby="lrnAs"><h3 id="lrnAs" class="lrn-h">How you are assessed</h3><p class="lrn-body">${esc(c.assessment)}</p></section>
        ${c.language ? `<section aria-labelledby="lrnLg"><h3 id="lrnLg" class="lrn-h">Language</h3><p class="lrn-body">Explanations in ${esc(c.language.explanation)}. You learn ${esc(c.language.target)}. ${esc(c.language.framework)}. Cognita is not accredited by the Council of Europe and this course does not lead to an official certificate.</p></section>` : ''}
        ${c.certificate && !prog ? '' : ''}
        <section aria-labelledby="lrnCur"><h3 id="lrnCur" class="lrn-h">Curriculum</h3>
          ${c.curriculum.map((s, i) => `<details class="lrn-sec" ${i === 0 ? 'open' : ''}><summary><span>Section ${i + 1}: ${esc(s.title)}</span><span class="lrn-sec-n">${plural(s.lessons.length, 'lesson')}</span></summary><p class="lrn-sec-sum">${esc(s.summary)}</p><ol class="lrn-lessons">${s.lessons.map((l) => { const st = prog && prog.lessons[l.key]; const done = st && st.status === 'done'; return `<li class="${done ? 'is-done' : ''}"><span class="lrn-tick" aria-hidden="true">${done ? '<i class="ph ph-check"></i>' : ''}</span><span><span class="lrn-ltitle">${esc(l.title)}${done ? '<span class="lrn-sr"> (completed)</span>' : ''}</span><span class="lrn-lobj">${esc(l.objective)}</span><span class="lrn-lmeta">${l.minutes} min · ${plural(l.activityCount, 'activity')}</span></span></li>`; }).join('')}</ol></details>`).join('')}
        </section>
        ${tasksPanel(d)}${certPanel(d)}
        ${c.references && c.references.length ? `<section aria-labelledby="lrnRef"><h3 id="lrnRef" class="lrn-h">Reference material</h3><ul class="lrn-bullets">${c.references.map((r) => `<li><a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.label)}</a></li>`).join('')}</ul></section>` : ''}
        <p class="lrn-foot">Version ${esc(c.version)}</p>
      </div>
      <aside class="lrn-aside" aria-label="Start this course">
        <div class="lrn-cta">
          ${prog ? `<div class="lrn-bar" role="progressbar" aria-label="Course progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${prog.percent}"><span style="width:${prog.percent}%"></span></div>` : ''}
          ${cta.html}
          ${cta.note ? `<p class="lrn-cta-note">${cta.note}</p>` : ''}
          <p class="lrn-cta-err" id="lrnEnrollErr" role="alert" hidden></p>
        </div>
      </aside>
    </div>
  </div>`;
}

// ── Workspace ────────────────────────────────────────────────────────────
function navPanel(d, ld) {
  const prog = ld.progress, cur = prog.current;
  return `<nav class="lrn-nav" aria-label="Course lessons">
    <p class="lrn-nav-title">${esc(d.course.title)}</p>
    <div class="lrn-bar" role="progressbar" aria-label="Course progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${prog.percent}"><span style="width:${prog.percent}%"></span></div>
    <p class="lrn-cont-sub">${prog.percent}% complete</p>
    ${d.course.curriculum.map((s, i) => `<div class="lrn-nav-sec"><p class="lrn-nav-h">Section ${i + 1}: ${esc(s.title)}</p><ol>${s.lessons.map((l) => {
      const st = prog.lessons[l.key] || { status: 'open' };
      const reach = Object.keys(prog.lessons).indexOf(l.key) <= Object.keys(prog.lessons).indexOf(cur.lesson);
      const isCur = l.key === S.route.lesson;
      const label = st.status === 'done' ? 'Completed' : l.key === cur.lesson ? (st.status === 'review' ? 'Needs review' : 'In progress') : reach ? '' : 'Locked';
      return `<li><button type="button" class="lrn-nav-item ${isCur ? 'is-current' : ''}" data-act="open-lesson" data-lesson="${esc(l.key)}" ${isCur ? 'aria-current="step"' : ''} ${reach ? '' : 'disabled'}><span class="lrn-tick ${st.status === 'done' ? 'is-done' : ''}" aria-hidden="true">${st.status === 'done' ? '<i class="ph ph-check"></i>' : (reach ? '' : '<i class="ph ph-lock-simple"></i>')}</span><span>${esc(l.title)}${label ? `<span class="lrn-nav-state">${label}</span>` : ''}</span></button></li>`;
    }).join('')}</ol></div>`).join('')}
  </nav>`;
}

function viewWorkspace() {
  const back = `<a class="lrn-back" href="/app.html?view=learna&course=${encodeURIComponent(S.route.course)}" data-act="to-course"><i class="ph ph-arrow-left" aria-hidden="true"></i> Course overview</a>`;
  if (S.lessonState === 'loading' || (S.lessonState === 'idle')) return `<div class="lrn-page">${back}<h2 class="lrn-sr" data-focus-heading>Loading lesson</h2><div aria-busy="true">${skeletonList()}</div></div>`;
  if (S.lessonState === 'missing') return `<div class="lrn-page">${back}<div class="lrn-state"><h2 data-focus-heading>This lesson is not available</h2><p>It may have been removed in a course update.</p><a class="lrn-btn" href="/app.html?view=learna&course=${encodeURIComponent(S.route.course)}" data-act="to-course">Back to the course</a></div></div>`;
  if (S.lessonState === 'error') return `<div class="lrn-page">${back}${errorBlock(S.lessonError, 'data-act="reload-lesson"')}</div>`;

  const d = S.detail, ld = S.lessonData, L = ld.lesson;
  const flat = d.course.curriculum.flatMap((s) => s.lessons);
  const idx = flat.findIndex((l) => l.key === S.route.lesson);
  const prog = ld.progress;
  const doneCourse = prog.status === 'completed';
  const viewingOld = !ld.isCurrent;
  const step = ld.step;
  const st = L.steps[Math.min(step, L.steps.length - 1)];
  const stepLabel = ld.status === 'done' && viewingOld ? 'Completed lesson' : 'Step ' + (step + 1) + ' of ' + L.steps.length;

  return `<div class="lrn-work">
    <aside class="lrn-side" aria-label="Lesson navigation">${navPanel(d, ld)}</aside>
    <section class="lrn-stage" aria-labelledby="lrnLesson">
      <div class="lrn-stage-bar">
        ${back}
        <button type="button" class="lrn-btn lrn-btn--small lrn-only-mobile" data-act="drawer"><i class="ph ph-list-bullets" aria-hidden="true"></i> Lessons</button>
      </div>
      ${S.notice ? `<div class="lrn-banner" role="status">${esc(S.notice)}</div>` : ''}
      <header class="lrn-lh">
        <p class="lrn-eyebrow">${esc(L.sectionTitle)} · Lesson ${idx + 1} of ${flat.length}</p>
        <h2 class="lrn-title lrn-title--lesson" id="lrnLesson" data-focus-heading>${esc(L.title)}</h2>
        <div class="lrn-objective"><p class="lrn-objective-h">Objective</p><p>${esc(L.objective)}</p></div>
        <div class="lrn-steps" aria-hidden="true">${L.steps.map((s, i) => `<span class="${i < step || (ld.status === 'done' && viewingOld) ? 'is-done' : i === step ? 'is-now' : ''}"></span>`).join('')}</div>
        <p class="lrn-stepline">${stepLabel}${S.busy.has('save') ? ' · Saving' : ''}</p>
      </header>
      <div class="lrn-step" id="lrnStep">${viewingOld ? reviewOld(L, ld) : (doneCourse ? courseDone(d) + lessonTasks(L, ld) : stepBody(st, ld, L))}</div>
      ${tutorHtml(d, ld, L, st)}
    </section>
    <div class="lrn-drawer ${S.drawer ? 'is-open' : ''}" id="lrnDrawer" ${S.drawer ? '' : 'hidden'}>
      <div class="lrn-scrim" data-act="drawer-close"></div>
      <div class="lrn-sheet" role="dialog" aria-modal="true" aria-label="Lessons"><button type="button" class="lrn-btn lrn-btn--small lrn-sheet-close" data-act="drawer-close" id="lrnDrawerClose">Close</button>${navPanel(d, ld)}</div>
    </div>
  </div>`;
}

function reviewOld(L, ld) {
  return `<div class="lrn-card"><h3 class="lrn-h">You have finished this lesson</h3><p class="lrn-body">${ld.mastery ? `You passed ${ld.mastery.passedClean} of ${ld.mastery.total} activities without seeing the answer.` : ''} Pick any lesson in the list, or carry on where you stopped.</p><button class="lrn-btn lrn-btn--primary" type="button" data-act="open-lesson" data-lesson="${esc(ld.progress.current.lesson)}">Go to my current lesson</button></div>${lessonTasks(L, ld)}`;
}
function courseDone(d) {
  return `<div class="lrn-card lrn-card--done"><h3 class="lrn-h">You finished ${esc(d.course.title)}</h3><p class="lrn-body">Every lesson is complete. Your course place is free again, so you can start another course. You can reopen any lesson from the list.</p><div class="lrn-actions"><a class="lrn-btn lrn-btn--primary" href="/app.html?view=learna" data-act="home">Choose your next course</a>${d.course.certificate ? `<a class="lrn-btn" href="/app.html?view=learna&course=${encodeURIComponent(d.course.id)}" data-act="to-course">Check my certificate</a>` : ''}</div></div>`;
}

function stepBody(st, ld, L) {
  const status = ld.status;
  if (status === 'review' && ld.step >= L.steps.length - 1) {
    const m = ld.mastery || {};
    return `<div class="lrn-card"><h3 class="lrn-h">Let us go over this lesson again</h3><p class="lrn-body">You passed ${m.passedClean} of ${m.total} activities without seeing the answer. You need ${Math.round((S.detail.course.masteryThreshold || 0.7) * 100)}% to move on. Repeating the lesson takes a few minutes and makes the next one easier.</p><button class="lrn-btn lrn-btn--primary" type="button" data-act="restart" ${S.busy.has('restart') ? 'disabled' : ''}>Repeat this lesson</button><p class="lrn-error" id="lrnErr" role="alert" hidden></p></div>`;
  }
  if (st.kind === 'teach') return teachBody(st, ld, L);
  return activityBody(st, ld);
}

function listenBtn(stepId, part, label) {
  const on = S.speech.playing === stepId + ':' + part;
  return `<button type="button" class="lrn-listen ${on ? 'is-on' : ''}" data-act="listen" data-step="${esc(stepId)}" data-part="${esc(part)}" aria-label="${on ? 'Stop' : 'Listen to'} ${esc(label)}" aria-pressed="${on}"><i class="ph ${on ? 'ph-stop-circle' : 'ph-speaker-high'}" aria-hidden="true"></i><span>${on ? 'Stop' : 'Listen'}</span></button>`;
}
function speechNote() { return S.speech.note ? `<p class="lrn-speech-note" role="status">${esc(S.speech.note)}</p>` : ''; }

function voiceControls() {
  const p = Speech.prefs.get(); const v = S.voices;
  const lang = courseLang();
  const list = v ? v.voices.filter((x) => x.lang === lang) : [];
  const two = list.length >= 2;
  return `<div class="lrn-voice" role="group" aria-label="Voice settings">
    ${two ? `<label class="lrn-select lrn-select--small"><span>Voice</span><select data-pref="voice">${[['default', list.find((x) => x.default) || list[0]], ['alt', list.find((x) => !x.default) || list[1]]].map(([id, x]) => `<option value="${id}" ${p.voice === id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>` : ''}
    <label class="lrn-select lrn-select--small"><span>Speed</span><select data-pref="rate">${[[0.75, 'Slow'], [1, 'Normal'], [1.1, 'Fast']].map(([r, n]) => `<option value="${r}" ${Number(p.rate) === r ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
  </div>`;
}

function teachBody(st, ld, L) {
  const last = ld.step >= L.steps.length - 1;
  const canListen = st.listen || isLangCourse();
  const lines = st.example ? st.example.text.split('\n') : [];
  const exampleHtml = st.example ? `<figure class="lrn-example"><figcaption>${esc(st.example.label)}</figcaption>${isLangCourse() ? `<ul class="lrn-lines">${lines.map((l, i) => l.trim() ? `<li><span>${esc(l)}</span><button type="button" class="lrn-spk lrn-spk--line" data-act="listen" data-step="${esc(st.id)}" data-part="example:${i}" aria-label="Hear this line"><i class="ph ph-speaker-high" aria-hidden="true"></i></button></li>` : '').join('')}</ul>` : `<pre>${esc(st.example.text)}</pre>`}</figure>` : '';
  return `<article class="lrn-card"><div class="lrn-card-top"><h3 class="lrn-h">${esc(st.title)}</h3>${canListen ? listenBtn(st.id, 'all', 'this explanation') : ''}</div>
    ${canListen ? voiceControls() : ''}${speechNote()}
    ${visualHtml(st.visual, st.id)}
    <div class="lrn-prose">${st.text.map((t) => '<p>' + rich(t) + '</p>').join('')}</div>
    ${exampleHtml}
    <div class="lrn-actions"><button class="lrn-btn lrn-btn--primary" type="button" data-act="advance" ${S.busy.has('advance') ? 'disabled' : ''}>${last ? 'Finish lesson' : 'Continue'}</button></div>
    <p class="lrn-error" id="lrnErr" role="alert" hidden></p></article>`;
}

function activityBody(st, ld) {
  const a = ld.acts[st.id] || { attempts: 0, hintsUsed: 0, passed: false, revealed: false };
  const r = S.result[st.id];
  const finished = a.passed || a.revealed;
  const busyCheck = S.busy.has('submit');
  const left = st.maxAttempts - a.attempts;
  let input = '';
  const dis = finished || busyCheck ? 'disabled' : '';
  const draft = S.draft[st.id];

  if (st.unsupported) input = `<div class="lrn-state"><h3>This activity cannot run here</h3><p>This kind of activity is not supported by your version of the app. Refresh the page, or contact support if it continues.</p></div>`;
  else if (st.type === 'choice') input = `<fieldset class="lrn-opts" ${dis}><legend class="lrn-prompt">${prompt(st.prompt)}</legend>${st.options.map((o) => `<label class="lrn-opt"><input type="radio" name="ans" value="${esc(o.id)}" ${draft === o.id ? 'checked' : ''}><span>${esc(o.text)}</span></label>`).join('')}</fieldset>`;
  else if (st.type === 'fill') input = `<div class="lrn-prompt">${prompt(st.prompt)}</div><label class="lrn-field"><span class="lrn-sr">Your answer</span><input id="lrnAns" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" value="${esc(draft || '')}" ${dis}></label>`;
  else if (st.type === 'order') { const cur = Array.isArray(draft) ? draft : st.items; input = `<div class="lrn-prompt">${prompt(st.prompt)}</div><ol class="lrn-order">${cur.map((t, i) => `<li><span class="lrn-order-t">${esc(t)}</span><span class="lrn-order-b"><button type="button" class="lrn-icon" data-act="move" data-i="${i}" data-d="-1" aria-label="Move ${esc(t)} up" ${dis || i === 0 ? 'disabled' : ''}><i class="ph ph-arrow-up" aria-hidden="true"></i></button><button type="button" class="lrn-icon" data-act="move" data-i="${i}" data-d="1" aria-label="Move ${esc(t)} down" ${dis || i === cur.length - 1 ? 'disabled' : ''}><i class="ph ph-arrow-down" aria-hidden="true"></i></button></span></li>`).join('')}</ol>`; }
  else if (st.type === 'match') { const m = draft || {}; input = `<div class="lrn-prompt">${prompt(st.prompt)}</div><div class="lrn-match">${st.left.map((l, i) => `<div class="lrn-match-row"><label for="lrnM${i}">${esc(l)}</label><select id="lrnM${i}" data-left="${esc(l)}" ${dis}><option value="">Choose</option>${st.right.map((x) => `<option value="${esc(x)}" ${m[l] === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></div>`).join('')}</div>`; }
  else if (st.type === 'speak') input = speakInput(st, ld, a, r);
  else if (st.type === 'assignment') input = assignmentInput(st, ld, a, r);
  else if (st.type === 'open') {
    const text = draft || '';
    const wc = (text.match(/\S+/g) || []).length;
    input = `<div class="lrn-prompt">${prompt(st.prompt)}</div>
      <div class="lrn-criteria"><p class="lrn-objective-h">Your answer should</p>${r && r.checklist ? `<ul class="lrn-check">${r.checklist.map((c) => `<li class="${c.met ? 'is-met' : 'is-miss'}"><i class="ph ${c.met ? 'ph-check-circle' : 'ph-circle'}" aria-hidden="true"></i><span>${esc(c.label)}<span class="lrn-sr">${c.met ? ' (done)' : ' (missing)'}</span></span></li>`).join('')}</ul>` : `<ul class="lrn-bullets">${st.criteria.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>`}</div>
      <label class="lrn-field"><span class="lrn-sr">Your answer</span><textarea id="lrnAns" rows="5" ${dis} placeholder="Write your answer here">${esc(text)}</textarea></label>
      <p class="lrn-wc" id="lrnWc">${wc} of at least ${st.minWords} words</p>${st.voice ? dictateBar(st.id, courseLang() === 'fr-FR' ? 'fr-FR' : 'en-NG', 'lrnAns') : ''}`;
  } else if (st.type === 'code') {
    const code = draft != null ? draft : st.starter;
    const out = S.codeOut[st.id];
    input = `${st.visual ? visualHtml(st.visual, st.id) : ''}<div class="lrn-prompt">${prompt(st.prompt)}</div>
      <label class="lrn-field"><span class="lrn-sr">Your code</span><textarea id="lrnCode" class="lrn-code" rows="9" spellcheck="false" autocapitalize="off" autocomplete="off" ${dis}>${esc(code)}</textarea></label>
      <div class="lrn-tests"><p class="lrn-objective-h">Tests that must pass</p>${r && r.checklist ? `<ul class="lrn-check">${r.checklist.map((c) => `<li class="${c.met ? 'is-met' : 'is-miss'}"><i class="ph ${c.met ? 'ph-check-circle' : 'ph-x-circle'}" aria-hidden="true"></i><code>${esc(c.label)}</code><span class="lrn-sr">${c.met ? ' passed' : ' failed'}</span></li>`).join('')}</ul>` : `<ul class="lrn-check">${st.tests.map((t) => `<li><i class="ph ph-circle" aria-hidden="true"></i><code>${esc(t.name)}</code></li>`).join('')}${st.hiddenCount ? `<li><i class="ph ph-circle" aria-hidden="true"></i><span>${st.hiddenCount} extra cases you cannot see. They change every time you run your code.</span></li>` : ''}</ul>`}</div>
      ${out ? `<pre class="lrn-out" tabindex="0" aria-label="Run output">${esc(out)}</pre>` : ''}`;
  }

  const metricsHtml = r && r.metrics ? `<dl class="lrn-metrics"><div><dt>Words</dt><dd>${r.metrics.words}</dd></div><div><dt>Pace</dt><dd>${r.metrics.wpm} per min</dd></div><div><dt>Fillers</dt><dd>${r.metrics.fillerTotal}</dd></div><div><dt>Length</dt><dd>${clock(r.metrics.seconds)}</dd></div></dl>` : '';
  const checklistHtml = r && r.checklist && st.type === 'assignment' && st.format !== 'code' ? `<ul class="lrn-check">${r.checklist.map((c) => `<li class="${c.met ? 'is-met' : 'is-miss'}"><i class="ph ${c.met ? 'ph-check-circle' : 'ph-circle'}" aria-hidden="true"></i><span>${esc(c.label)}<span class="lrn-sr">${c.met ? ' (done)' : ' (missing)'}</span></span></li>`).join('')}</ul>` : '';
  const feedback = r && r.feedback ? `<div class="lrn-feedback ${r.correct ? 'is-right' : r.invalid ? 'is-note' : 'is-wrong'}" role="status"><p class="lrn-fb-h">${r.correct ? (st.type === 'assignment' ? (r.pendingReview ? 'Submitted' : 'Passed') : 'Correct') : r.invalid ? 'Check your answer' : 'Not yet'}</p><p>${esc(r.feedback)}</p>${checklistHtml}${metricsHtml}</div>` : (a.lastFeedback && !r ? `<div class="lrn-feedback ${a.passed ? 'is-right' : 'is-wrong'}" role="status"><p>${esc(a.lastFeedback)}</p></div>` : '');
  const reveal = r && r.revealed ? `<div class="lrn-reveal"><p class="lrn-objective-h">The answer</p>${st.type === 'code' || st.type === 'open' ? `<pre>${esc(r.revealed.answer)}</pre>` : `<p>${esc(r.revealed.answer)}</p>`}<p>${esc(r.revealed.explanation)}</p></div>` : '';
  const hintBox = S.hint && S.hint.id === st.id ? `<div class="lrn-hint" role="status"><p class="lrn-objective-h">Hint ${S.hint.n}</p><p>${esc(S.hint.text)}</p></div>` : '';
  const canHint = !finished && st.hintCount > a.hintsUsed;
  const last = ld.step >= S.lessonData.lesson.steps.length - 1;

  const ownSubmit = st.type === 'assignment' && st.format !== 'code';
  return `<article class="lrn-card" aria-labelledby="lrnActH">
    <p class="lrn-eyebrow">${activityLabel(st)}${st.graded === false ? ' · practice' : ''}</p><h3 class="lrn-h" id="lrnActH">${esc(st.title)}</h3>
    <form id="lrnForm" novalidate>${input}
      ${feedback}${reveal}${hintBox}
      <div class="lrn-actions">
        ${finished ? `<button class="lrn-btn lrn-btn--primary" type="button" data-act="advance" ${S.busy.has('advance') ? 'disabled' : ''}>${last ? 'Finish lesson' : 'Continue'}</button>` :
          ownSubmit || st.type === 'speak' ? '' :
          st.type === 'code' || (st.type === 'assignment' && st.format === 'code') ? `<button class="lrn-btn lrn-btn--primary" type="submit" ${busyCheck ? 'disabled' : ''}>${busyCheck ? 'Running tests' : 'Run tests'}</button>` :
          `<button class="lrn-btn lrn-btn--primary" type="submit" ${busyCheck || st.unsupported ? 'disabled' : ''}>${busyCheck ? 'Checking' : 'Check answer'}</button>`}
        ${canHint && st.type !== 'assignment' ? `<button class="lrn-btn" type="button" data-act="hint" ${S.busy.has('hint') ? 'disabled' : ''}>Show a hint</button>` : ''}
        ${!finished && st.type !== 'speak' ? `<span class="lrn-tries">${left === 1 ? '1 try left' : left + ' tries left'}</span>` : ''}
      </div></form>
    <p class="lrn-error" id="lrnErr" role="alert" hidden></p>
  </article>`;
}
function prompt(t) { return String(t).split('\n').map((l) => l ? `<span class="lrn-pl">${esc(l)}</span>` : '<span class="lrn-pl">&nbsp;</span>').join(''); }
function activityLabel(st) { return ({ choice: 'Question', fill: 'Fill in the blank', order: 'Put in order', match: 'Match', open: 'Writing task', code: 'Coding task', speak: 'Say it aloud', assignment: ({ audio: 'Speaking task', video: 'Video task', text: 'Written task', code: 'Project task', file: 'Task' }[st.format]) || 'Task' }[st.type]) || 'Activity'; }

function tutorHtml(d, ld, L, st) {
  const t = S.tutor;
  if (ld.progress.status === 'completed' || !ld.isCurrent) return '';
  return `<section class="lrn-tutor ${t.open ? 'is-open' : ''}" aria-labelledby="lrnTutorH">
    <button type="button" class="lrn-tutor-head" data-act="tutor-toggle" aria-expanded="${t.open}" aria-controls="lrnTutorBody"><span><span class="lrn-tutor-h" id="lrnTutorH">Your tutor</span><span class="lrn-tutor-ctx">${esc(L.title)}</span></span><i class="ph ${t.open ? 'ph-caret-down' : 'ph-caret-up'}" aria-hidden="true"></i></button>
    <div class="lrn-tutor-body" id="lrnTutorBody" ${t.open ? '' : 'hidden'}>
      <p class="lrn-tutor-intro">Ask about this step. Your tutor only uses this course's material, and will not give away the answer to a task.</p>
      <div class="lrn-log" id="lrnLog" role="log" aria-live="polite">${t.log.map((m) => `<div class="lrn-msg lrn-msg--${m.role}"><p class="lrn-msg-who">${m.role === 'me' ? 'You' : 'Tutor'}</p><div>${m.text.split(/\n+/).map((p) => '<p>' + esc(p) + '</p>').join('')}</div></div>`).join('')}${t.sending ? '<div class="lrn-msg lrn-msg--tutor" aria-busy="true"><p class="lrn-msg-who">Tutor</p><p class="lrn-typing">Thinking</p></div>' : ''}${t.error ? `<p class="lrn-error" role="alert">${esc(t.error)}</p>` : ''}</div>
      <div class="lrn-quick">${['Explain this another way', 'Give me an example'].map((q) => `<button type="button" class="lrn-chip" data-act="quick" data-q="${esc(q)}" ${t.sending ? 'disabled' : ''}>${q}</button>`).join('')}</div>
      <form id="lrnTutorForm"><label class="lrn-sr" for="lrnTutorIn">Your question</label><textarea id="lrnTutorIn" rows="2" maxlength="600" placeholder="Type your question" ${t.sending ? 'disabled' : ''}></textarea><button class="lrn-btn lrn-btn--primary" type="submit" ${t.sending ? 'disabled' : ''}>Send</button></form>
    </div></section>`;
}

// ── Actions ──────────────────────────────────────────────────────────────
function showErr(msg) { const e = document.getElementById('lrnErr') || document.getElementById('lrnEnrollErr'); if (e) { e.textContent = msg; e.hidden = false; } else say(msg); }

async function doEnroll() {
  if (S.busy.has('enroll')) return; S.busy.add('enroll'); render();
  try {
    await api('/courses/' + encodeURIComponent(S.route.course) + '/enroll', { method: 'POST' });
    S.cat = null; S.busy.delete('enroll');
    await loadDetail(S.route.course, true);
    const p = S.detail && S.detail.progress; say('Course started.');
    if (p) go(S.route.course, p.current.lesson);
  } catch (e) {
    S.busy.delete('enroll');
    if (e.code === 'COURSE_LIMIT' || e.code === 'PLAN_REQUIRED') await loadDetail(S.route.course, true);
    render(); showErr(isAuthErr(e) ? 'You were signed out. Sign in again to continue.' : e.message);
  }
}

function resume(courseId) {
  const go2 = async () => { try { const p = await api('/courses/' + encodeURIComponent(courseId) + '/progress'); go(courseId, p.progress.current.lesson); } catch (e) { say(e.message); go(courseId, null); } };
  go2();
}

async function post(action, body, busyKey) {
  const base = '/courses/' + encodeURIComponent(S.route.course) + '/';
  if (S.busy.has(busyKey)) return null;
  S.busy.add(busyKey); render();
  try { return await api(base + action, { method: 'POST', body }); }
  catch (e) { if (e.code === 'OUT_OF_SYNC') { S.busy.delete(busyKey); await loadLesson(S.route.course, S.route.lesson, true); say('Your place changed. The lesson was reloaded.'); return null; } throw e; }
  finally { S.busy.delete(busyKey); }
}

async function doAdvance() {
  const ld = S.lessonData; const key = S.route.lesson, course = S.route.course; const t = S.token;
  try {
    const r = await post('advance', { lesson: key, step: ld.step }, 'advance');
    if (!r || t !== S.token) return;
    S.hint = null;
    if (r.event === 'step') { S.lessonData.step += 1; S.lessonData.progress = r.progress; }
    else if (r.event === 'review') { S.lessonData.status = 'review'; S.lessonData.mastery = r.mastery; S.lessonData.progress = r.progress; }
    else if (r.event === 'lesson_done') { S.cat = null; say('Lesson complete.'); S.detail.progress = r.progress; go(course, r.next); return; }
    else if (r.event === 'course_complete') { S.cat = null; S.detail.progress = r.progress; S.lessonData.progress = r.progress; S.lessonData.status = 'done'; say('Course complete.'); }
    render();
  } catch (e) { render(); showErr(isAuthErr(e) ? 'You were signed out. Sign in again to continue.' : e.message); }
}

function currentStep() { const ld = S.lessonData; return ld.lesson.steps[ld.step]; }
function activeStep() { const ld = S.lessonData; if (S.openTask) { const t = ld.lesson.steps.find((x) => x.id === S.openTask); if (t) return t; } return currentStep(); }

function gather(st) {
  const f = document.getElementById('lrnForm');
  if (st.type === 'choice') { const c = f.querySelector('input[name="ans"]:checked'); return c ? c.value : null; }
  if (st.type === 'fill' || st.type === 'open') return document.getElementById('lrnAns').value;
  if (st.type === 'order') return Array.isArray(S.draft[st.id]) ? S.draft[st.id] : st.items;
  if (st.type === 'match') { const m = {}; f.querySelectorAll('select[data-left]').forEach((s) => { if (s.value) m[s.dataset.left] = s.value; }); return m; }
  return null;
}

async function runTests(st) {
  const src = document.getElementById('lrnCode').value;
  S.draft[st.id] = src;
  // A fresh challenge adds extra hidden cases to this run. The expected values stay on the server.
  let ch = { nonce: null, expr: [] };
  try { ch = await api('/courses/' + encodeURIComponent(S.route.course) + '/code/challenge', { method: 'POST', body: { lesson: S.route.lesson, activity: st.id } }); }
  catch (e) { if (e.code === 'OUT_OF_SYNC') throw e; throw e; }
  const exprs = [...st.tests.map((t) => t.expr), ...ch.expr];
  const thunks = exprs.map((x) => 'function(){return (' + x + ');}').join(',');
  const code = src + '\n;(function(){var T=[' + thunks + '],o=[];for(var i=0;i<T.length;i++){try{var v=T[i]();o.push({value:v===undefined?null:v});}catch(e){o.push({error:String(e&&e.message||e)});}}console.log("@@LEARNA@@"+JSON.stringify(o));})();';
  if (!sandbox) sandbox = new SandboxClient();
  const call = { id: 'learna_' + Math.random().toString(36).slice(2, 9), name: 'sandbox_run_javascript', args: { code }, limits: { timeoutMs: 8000, maxFileBytes: 1048576, maxWorkspaceBytes: 5242880, maxOutputChars: 12000, maxProcesses: 1, network: false } };
  const { result } = await sandbox.run(call, 'learna-' + S.route.course, {});
  if (!result) return { unavailable: true, text: 'The code sandbox did not respond.' };
  const out = String(result.stdout || '');
  const m = out.match(/@@LEARNA@@(.*)/);
  if (!m) {
    const err = String(result.stderr || '').trim();
    if (/could not start|did not start|not running|stopped responding/i.test(err)) return { unavailable: true, text: err };
    if (result.exitCode === 124) return { text: 'Your code ran for too long and was stopped. Check for a loop that never ends.' };
    return { text: err ? 'Your code has an error:\n' + err.slice(0, 600) : 'The tests did not finish. Check your code and run it again.' };
  }
  try { return { results: JSON.parse(m[1]), nonce: ch.nonce, source: src }; } catch (_) { return { text: 'The test results could not be read. Run your code again.' }; }
}

async function doSubmit() {
  if (S.busy.has('submit')) return;
  const ld = S.lessonData, st = currentStep(), key = S.route.lesson, t = S.token;
  const body = { lesson: key, activity: st.id };
  if (st.type === 'code') {
    S.busy.add('submit'); render();
    let run; try { run = await runTests(st); } catch (e) { run = e && e.code === 'OUT_OF_SYNC' ? null : { unavailable: true, text: e && e.status ? e.message : 'The code sandbox could not start in this browser.' }; if (!run) { S.busy.delete('submit'); await loadLesson(S.route.course, S.route.lesson, true); return; } }
    S.busy.delete('submit');
    if (t !== S.token) return;
    if (run.unavailable) { S.codeOut[st.id] = ''; S.result[st.id] = { invalid: true, feedback: 'The coding sandbox is not available right now. ' + run.text + ' Try again in a moment, or reload the page.' }; render(); return; }
    if (!run.results) { S.codeOut[st.id] = run.text; S.result[st.id] = { invalid: true, feedback: 'Fix the problem below, then run the tests again.' }; render(); return; }
    S.codeOut[st.id] = ''; body.results = run.results; body.nonce = run.nonce; body.source = run.source;
  } else {
    const ans = gather(st); S.draft[st.id] = ans;
    if (ans === null || (typeof ans === 'string' && !ans.trim()) || (st.type === 'match' && Object.keys(ans).length < st.left.length)) { S.result[st.id] = { invalid: true, feedback: st.type === 'choice' ? 'Choose one of the options.' : st.type === 'match' ? 'Match every item.' : 'Write your answer first.' }; render(); return; }
    body.answer = ans;
  }
  try {
    const r = await post('submit', body, 'submit');
    if (!r || t !== S.token) return;
    S.result[st.id] = r.result;
    if (r.act) ld.acts[st.id] = r.act;
    S.hint = null; render();
    if (r.result && r.result.needChallenge) say('Run your code again.');
    else if (r.result && !r.result.invalid) say(r.result.correct ? 'Correct.' : 'Not yet. ' + r.result.feedback);
  } catch (e) {
    if (t !== S.token) return;
    const msg = e.code === 'ASSESSMENT_UNAVAILABLE' ? e.message : e.code === 'DAILY_LIMIT' ? e.message : isAuthErr(e) ? 'You were signed out. Sign in again to continue.' : e.message;
    S.result[st.id] = { invalid: true, feedback: msg }; render();
  }
}

async function doHint() {
  const st = currentStep(), t = S.token;
  try {
    const r = await post('hint', { lesson: S.route.lesson, activity: st.id }, 'hint');
    if (!r || t !== S.token) return;
    S.lessonData.acts[st.id] = r.act;
    S.hint = r.hint ? { id: st.id, text: r.hint, n: r.act.hintsUsed } : { id: st.id, text: r.message, n: '' };
    render(); say('Hint: ' + (r.hint || r.message));
  } catch (e) { render(); showErr(e.message); }
}

async function doRestart() {
  try {
    const r = await post('restart', { lesson: S.route.lesson }, 'restart');
    if (!r) return;
    await loadLesson(S.route.course, S.route.lesson, true); say('Lesson restarted.');
  } catch (e) { render(); showErr(e.message); }
}

async function sendTutor(text) {
  const t = S.tutor; text = String(text || '').trim();
  if (!text || t.sending) return;
  t.log.push({ role: 'me', text }); t.sending = true; t.error = null; render();
  const token = S.token;
  try {
    const r = await api('/courses/' + encodeURIComponent(S.route.course) + '/tutor', { method: 'POST', body: { message: text } });
    if (token !== S.token) return;
    t.log.push({ role: 'tutor', text: r.reply });
  } catch (e) { if (token !== S.token) return; t.error = isAuthErr(e) ? 'You were signed out. Sign in again to continue.' : e.message; }
  t.sending = false; render();
  const log = document.getElementById('lrnLog'); if (log) log.scrollTop = log.scrollHeight;
  const inp = document.getElementById('lrnTutorIn'); if (inp && !t.error) inp.focus({ preventScroll: true });
}

function openLesson(key) {
  S.drawer = false;
  if (key === S.route.lesson) { render(); return; }
  go(S.route.course, key);
}

// ── Speech, recording and tasks ──────────────────────────────────────────
function stepById(id) { return S.lessonData && S.lessonData.lesson.steps.find((x) => x.id === id); }

function cleanupMedia() {
  Speech.stopSpeaking(); Speech.paceGuide(false);
  if (liveRec) { liveRec.cancel(); liveRec = null; }
  if (liveDict) { liveDict.stop(); liveDict = null; }
  for (const r of Object.values(S.rec)) if (r && r.url) URL.revokeObjectURL(r.url);
  S.rec = {}; S.speech = { playing: null, note: null };
}

function ensureVoices() {
  if (S.voices) return;
  S.voices = { voices: [], premium: false };
  api('/speech/voices').then((v) => { S.voices = v; if (S.lessonData && !document.activeElement.closest('form')) render(); }).catch(() => {});
}

async function doListen(stepId, part, word) {
  const key = stepId + ':' + (word ? 'w:' + word : part);
  if (S.speech.playing === key) { Speech.stopSpeaking(); S.speech.playing = null; render(); return; }
  const st = stepById(stepId); if (!st) return;
  let text = '';
  if (word) text = word;
  else if (part === 'all') text = (st.text || []).map(plainText).join(' ') + (st.example && !isLangCourse() ? '' : '');
  else if (part === 'target') text = st.target;
  else if (part === 'prompt') text = st.prompt;
  else if (/^example:\d+$/.test(part)) text = plainText((st.example.text.split('\n')[+part.split(':')[1]]) || '');
  if (!text.trim()) return;
  S.speech.note = null; S.speech.playing = key; render();
  const ref = { course: S.route.course, lesson: S.route.lesson, step: stepId, part: word ? 'word' : part === 'all' ? 'text:0' : part, word: word || undefined, lang: courseLang() };
  let r;
  if (part === 'all' && !word) {
    // Read every paragraph in turn so the premium voice stays within what the server will fetch.
    for (let i = 0; i < st.text.length; i++) {
      if (S.speech.playing !== key) return;
      r = await Speech.speak({ ...ref, part: 'text:' + i }, plainText(st.text[i]), { blob: apiBlob }, {});
      if (!r.ok) break;
    }
  } else r = await Speech.speak(ref, text, { blob: apiBlob }, {});
  if (S.speech.playing !== key && r && r.cancelled) return;
  S.speech.playing = null; S.speech.note = r && r.note ? r.note : (r && !r.ok && !r.cancelled ? 'Could not play speech on this device.' : null);
  render();
}

// Dictation: say it instead of typing. Fills the text box. A recognition aid, not a pronunciation score.
function dictateBar(id, lang, targetId) {
  const on = S.rec['dict:' + id] && S.rec['dict:' + id].on;
  const msg = S.rec['dict:' + id] && S.rec['dict:' + id].msg;
  if (!Speech.dictationSupported()) return `<p class="lrn-speech-note">Dictation is not available in this browser, so type your answer. Chrome, Edge and Safari support it.</p>`;
  return `<div class="lrn-dict"><button type="button" class="lrn-btn lrn-btn--small ${on ? 'is-rec' : ''}" data-act="dictate" data-id="${esc(id)}" data-lang="${esc(lang)}" data-target="${esc(targetId)}" aria-pressed="${!!on}"><i class="ph ${on ? 'ph-stop-circle' : 'ph-microphone'}" aria-hidden="true"></i> ${on ? 'Stop dictating' : 'Say your answer'}</button><span class="lrn-dict-hint">${on ? 'Listening. Speak, then press stop. You can edit the text afterwards.' : 'Optional. Your words appear in the box.'}</span>${msg ? `<span class="lrn-error" role="alert">${esc(msg)}</span>` : ''}</div>`;
}
function startDictation(id, lang, targetId) {
  const key = 'dict:' + id;
  if (liveDict) { liveDict.stop(); liveDict = null; S.rec[key] = { on: false }; render(); return; }
  const box = document.getElementById(targetId); if (!box) return;
  const base = box.value ? box.value.replace(/\s+$/, '') + ' ' : '';
  S.rec[key] = { on: true };
  liveDict = Speech.dictate(lang, {
    onUpdate: (fin, interim) => { const b = document.getElementById(targetId); if (b) { b.value = base + fin + (interim ? ' ' + interim : ''); S.draft[id] = b.value; b.dispatchEvent(new Event('input', { bubbles: true })); } },
    onEnd: (reason, text) => { liveDict = null; S.rec[key] = { on: false, msg: reason === 'denied' ? 'Cognita was not allowed to use the microphone. Allow it in your browser settings, or type your answer.' : reason === 'no-speech' ? 'No speech was heard. Try again, or type your answer.' : reason === 'error' ? 'Dictation stopped unexpectedly. You can type instead.' : null }; if (text) S.draft[id] = (base + text).trim(); render(); },
  });
  render();
}

// Say-it-aloud practice. The server compares what the speech recogniser heard with the target text.
function speakInput(st, ld, a, r) {
  const s = S.rec['speak:' + st.id] || {};
  const supported = Speech.dictationSupported();
  return `<div class="lrn-prompt">${prompt(st.prompt)}</div>
    <div class="lrn-target"><p class="lrn-target-t" lang="${esc(st.lang)}">${esc(plainText(st.target))}</p>
      <div class="lrn-target-b">${listenBtn(st.id, 'target', 'the target')}<button type="button" class="lrn-listen" data-act="listen-slow" data-step="${esc(st.id)}" aria-label="Listen slowly"><i class="ph ph-person-simple-walk" aria-hidden="true"></i><span>Slowly</span></button></div></div>
    ${voiceControls()}${speechNote()}
    ${supported ? `<div class="lrn-dict"><button type="button" class="lrn-btn ${s.on ? 'is-rec' : 'lrn-btn--primary'}" data-act="speak-record" data-id="${esc(st.id)}" data-lang="${esc(st.lang)}" aria-pressed="${!!s.on}" ${a.passed ? 'disabled' : ''}><i class="ph ${s.on ? 'ph-stop-circle' : 'ph-microphone'}" aria-hidden="true"></i> ${s.on ? 'Stop and check' : 'Say it'}</button><span class="lrn-dict-hint">${s.on ? 'Listening. Say the text, then press stop.' : 'Say the text out loud. The recogniser shows what it heard.'}</span></div>
      <p class="lrn-heard" id="lrnHeard" aria-live="polite">${s.text ? 'Heard: <q>' + esc(s.text) + '</q>' : ''}</p>` : '<p class="lrn-speech-note">Speech recognition is not available in this browser, so this practice is optional. Use Chrome, Edge or Safari to try it. You can skip it.</p>'}
    ${s.msg ? `<p class="lrn-error" role="alert">${esc(s.msg)}</p>` : ''}
    <p class="lrn-speech-note">This checks that a speech recogniser understood your words. It cannot judge your accent or how close your sounds are to a native speaker, so do not read it as a pronunciation score.</p>
    <div class="lrn-actions">${a.passed ? '' : `<button class="lrn-btn" type="button" data-act="speak-skip" ${S.busy.has('submit') ? 'disabled' : ''}>Skip this practice</button>`}</div>`;
}
function toggleSpeakRecord(id, lang) {
  const key = 'speak:' + id;
  if (liveDict) { liveDict.stop(); return; }
  S.rec[key] = { on: true, text: '' }; render();
  let heard = '';
  liveDict = Speech.dictate(lang, {
    continuous: false,
    onUpdate: (fin, interim) => { heard = fin || interim; const el = document.getElementById('lrnHeard'); if (el) el.innerHTML = 'Heard: <q>' + esc(heard) + '</q>'; },
    onEnd: (reason, text) => {
      liveDict = null; const t = text || heard;
      S.rec[key] = { on: false, text: t, msg: reason === 'denied' ? 'Cognita was not allowed to use the microphone. Allow it in your browser settings, or skip this practice.' : (!t && reason === 'no-speech' ? 'No speech was heard. Try again, or skip.' : null) };
      render();
      if (t) submitSpeak(id, t);
    },
  });
}
async function submitSpeak(id, transcript, skip) {
  const st = currentStep(), t = S.token;
  try {
    const r = await post('submit', { lesson: S.route.lesson, activity: id, ...(skip ? { skip: true } : { transcript }) }, 'submit');
    if (!r || t !== S.token) return;
    S.result[id] = r.result; if (r.act) S.lessonData.acts[id] = r.act; render();
    if (r.result) say(r.result.feedback);
  } catch (e) { S.result[id] = { invalid: true, feedback: e.message }; render(); } void st;
}

// Tasks: written, spoken, video, or code.
const REVIEW_TEXT = { pending: 'A reviewer will look at this. You can carry on with the course. Your certificate waits for the approval.', changes: 'Your reviewer asked for changes. Read the note, then send a new version.', approved: 'Approved by your reviewer.', auto: 'Passed.' };
function taskStatus(a) { return a.review ? `<div class="lrn-review lrn-review--${esc(a.review)}" role="status"><p><strong>${a.review === 'pending' ? 'Waiting for a reviewer' : a.review === 'changes' ? 'Changes requested' : a.review === 'approved' ? 'Approved' : 'Passed'}.</strong> ${esc(REVIEW_TEXT[a.review] || '')}</p>${a.reviewNote ? `<blockquote>${esc(a.reviewNote)}</blockquote>` : ''}</div>` : ''; }

function assignmentInput(st, ld, a, r) {
  const draft = S.draft[st.id];
  const locked = a.review === 'pending' || a.review === 'approved' || (a.review === 'auto' && a.passed);
  const crit = st.criteria && st.criteria.length ? `<div class="lrn-criteria"><p class="lrn-objective-h">${st.format === 'audio' || st.format === 'video' ? 'What is checked' : 'Your answer should'}</p><ul class="lrn-bullets">${st.criteria.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>` : '';
  const tips = st.checklist && st.checklist.length ? `<div class="lrn-tips"><p class="lrn-objective-h">Before you start</p><ul class="lrn-bullets">${st.checklist.map((c) => `<li>${esc(c)}</li>`).join('')}</ul></div>` : '';
  const head = `${st.visual ? visualHtml(st.visual, st.id) : ''}<div class="lrn-prompt">${prompt(st.prompt)}</div>${taskStatus(a)}${st.certRequired ? '<p class="lrn-pill">Needed for your certificate</p>' : ''}`;
  if (st.format === 'text') {
    const text = draft || ''; const wc = (text.match(/\S+/g) || []).length;
    return `${head}${crit}<label class="lrn-field"><span class="lrn-sr">Your answer</span><textarea id="lrnAns" rows="7" ${locked || S.busy.has('submit') ? 'disabled' : ''} placeholder="Write here">${esc(text)}</textarea></label><p class="lrn-wc" id="lrnWc">${wc} of at least ${st.minWords} words</p>${locked ? '' : dictateBar(st.id, 'en-NG', 'lrnAns')}
      <div class="lrn-actions">${locked ? '' : `<button class="lrn-btn lrn-btn--primary" type="submit" ${S.busy.has('submit') ? 'disabled' : ''}>${S.busy.has('submit') ? 'Sending' : st.review === 'admin' ? 'Submit for review' : 'Submit'}</button>`}</div>`;
  }
  if (st.format === 'code') {
    const code = draft != null ? draft : st.starter; const out = S.codeOut[st.id];
    return `${head}<label class="lrn-field"><span class="lrn-sr">Your code</span><textarea id="lrnCode" class="lrn-code" rows="14" spellcheck="false" autocapitalize="off" autocomplete="off" ${locked ? 'disabled' : ''}>${esc(code)}</textarea></label>
      <div class="lrn-tests"><p class="lrn-objective-h">Tests that must pass</p>${r && r.checklist ? `<ul class="lrn-check">${r.checklist.map((c) => `<li class="${c.met ? 'is-met' : 'is-miss'}"><i class="ph ${c.met ? 'ph-check-circle' : 'ph-x-circle'}" aria-hidden="true"></i><code>${esc(c.label.length > 90 ? c.label.slice(0, 90) + '...' : c.label)}</code></li>`).join('')}</ul>` : `<ul class="lrn-check">${st.tests.map((t) => `<li><i class="ph ph-circle" aria-hidden="true"></i><code>${esc(t.name.length > 90 ? t.name.slice(0, 90) + '...' : t.name)}</code></li>`).join('')}${st.hiddenCount ? `<li><i class="ph ph-circle" aria-hidden="true"></i><span>${st.hiddenCount} extra cases you cannot see.</span></li>` : ''}</ul>`}</div>${out ? `<pre class="lrn-out" tabindex="0">${esc(out)}</pre>` : ''}
      <p class="lrn-speech-note">Your code runs in a sandbox in your browser. Cognita checks the results again with extra cases, keeps your code, and a reviewer reads it before it counts towards a certificate.</p>`;
  }
  return recorderUi(st, a, head, crit, tips, locked);
}

function recorderUi(st, a, head, crit, tips, locked) {
  const kind = st.format === 'video' ? 'video' : 'audio';
  const rs = S.rec['rec:' + st.id] || { phase: 'idle' };
  const sup = Speech.recorderSupport(kind);
  const limit = st.maxSeconds || 120;
  let body = '';
  if (!sup.ok) body = `<div class="lrn-state"><h3>Recording is not available here</h3><p>${esc(sup.why)}</p></div>`;
  else if (locked) body = '';
  else if (rs.phase === 'idle') body = `${kind === 'video' ? '<div class="lrn-cam lrn-cam--off"><i class="ph ph-video-camera" aria-hidden="true"></i><p>Your camera is off. Press the button to start.</p></div>' : ''}${rs.error ? `<p class="lrn-error" role="alert">${esc(rs.error)}</p>` : ''}
    <p class="lrn-speech-note">${st.minSeconds ? 'Record at least ' + st.minSeconds + ' seconds. ' : ''}You can record up to ${clock(limit)}. Your recording stays private to you and your reviewers.</p>
    <div class="lrn-actions"><button class="lrn-btn lrn-btn--primary" type="button" data-act="rec-start" data-id="${esc(st.id)}"><i class="ph ph-record" aria-hidden="true"></i> Start recording</button>${kind === 'audio' && st.format === 'audio' ? `<button class="lrn-btn" type="button" data-act="pace" aria-pressed="${Speech.paceGuideOn()}"><i class="ph ph-metronome" aria-hidden="true"></i> Pace guide ${Speech.paceGuideOn() ? 'on' : 'off'}</button>` : ''}</div>`;
  else if (rs.phase === 'recording') body = `${kind === 'video' ? '<video id="lrnCam" class="lrn-cam" playsinline muted></video>' : ''}
    <div class="lrn-recbar" role="status"><span class="lrn-recdot" aria-hidden="true"></span><strong id="lrnRecTime">0:00</strong> <span>of ${clock(limit)}</span><span class="lrn-meter" aria-hidden="true"><span id="lrnMeter"></span></span></div>
    ${Speech.dictationSupported() && kind === 'audio' ? '<p class="lrn-live" id="lrnLive" aria-live="off"></p>' : ''}
    <div class="lrn-actions"><button class="lrn-btn lrn-btn--primary" type="button" data-act="rec-stop" data-id="${esc(st.id)}"><i class="ph ph-stop-circle" aria-hidden="true"></i> Stop</button></div>`;
  else if (rs.phase === 'review') body = `${kind === 'video' ? `<video class="lrn-cam" controls playsinline src="${esc(rs.url)}"></video>` : `<audio class="lrn-audio" controls src="${esc(rs.url)}"></audio>`}
    <p class="lrn-speech-note">Length ${clock(rs.ms / 1000)}. Listen first. If you are happy, send it. Otherwise record again.</p>${rs.error ? `<p class="lrn-error" role="alert">${esc(rs.error)}</p>` : ''}
    <div class="lrn-actions"><button class="lrn-btn lrn-btn--primary" type="button" data-act="rec-send" data-id="${esc(st.id)}" ${S.busy.has('submit') ? 'disabled' : ''}>${S.busy.has('submit') ? (kind === 'audio' && st.format === 'audio' && st.review !== 'admin' ? 'Checking your speech' : 'Uploading') : st.review === 'admin' ? 'Submit for review' : 'Send for checking'}</button><button class="lrn-btn" type="button" data-act="rec-redo" data-id="${esc(st.id)}" ${S.busy.has('submit') ? 'disabled' : ''}>Record again</button></div>`;
  return `${head}${crit}${tips}${body}`;
}

async function startRec(id) {
  const st = currentStepFor(id); if (!st) return;
  const kind = st.format === 'video' ? 'video' : 'audio';
  const key = 'rec:' + id;
  Speech.stopSpeaking();
  if (S.rec[key] && S.rec[key].url) URL.revokeObjectURL(S.rec[key].url);
  S.rec[key] = { phase: 'recording' }; render();
  const meter = (v) => { const m = document.getElementById('lrnMeter'); if (m) m.style.width = Math.round(v * 100) + '%'; };
  const tick = (s) => { const t = document.getElementById('lrnRecTime'); if (t) t.textContent = clock(s); };
  liveRec = new Speech.Recorder(kind, { maxSeconds: st.maxSeconds || 120, onTick: tick, onLevel: meter, onAutoStop: () => stopRec(id) });
  try { await liveRec.start(document.getElementById('lrnCam')); }
  catch (e) { liveRec = null; S.rec[key] = { phase: 'idle', error: Speech.micError(e) }; render(); return; }
  Speech.cue.start();
  if (kind === 'audio' && Speech.dictationSupported()) {
    const t0 = Date.now();
    liveDict = Speech.dictate('en-NG', { onUpdate: (fin, interim) => { const el = document.getElementById('lrnLive'); if (!el) return; const words = ((fin + ' ' + interim).match(/\S+/g) || []).length; const mins = Math.max((Date.now() - t0) / 60000, 0.05); el.textContent = 'Live estimate: about ' + Math.round(words / mins) + ' words per minute. The official check happens after you send.'; }, onEnd: () => { liveDict = null; } });
  }
}
async function stopRec(id) {
  const key = 'rec:' + id;
  if (!liveRec) return;
  const r = await liveRec.stop(); liveRec = null;
  if (liveDict) { liveDict.stop(); liveDict = null; }
  Speech.cue.stop();
  if (!r || !r.blob.size) { S.rec[key] = { phase: 'idle', error: 'Nothing was recorded. Check your microphone and try again.' }; render(); return; }
  S.rec[key] = { phase: 'review', blob: r.blob, mime: r.mime, ms: r.durationMs, url: URL.createObjectURL(r.blob) }; render();
}
function currentStepFor(id) { return S.lessonData && S.lessonData.lesson.steps.find((s) => s.id === id); }

async function sendRec(id) {
  const st = currentStepFor(id), key = 'rec:' + id, rs = S.rec[key];
  if (!st || !rs || S.busy.has('submit')) return;
  const t = S.token; S.busy.add('submit'); render();
  try {
    const r = await apiUpload('/courses/' + encodeURIComponent(S.route.course) + '/assignments/submit', rs.blob, { 'Content-Type': rs.mime, 'X-Learna-Lesson': S.route.lesson, 'X-Learna-Activity': id, 'X-Duration-Ms': String(Math.round(rs.ms)) });
    S.busy.delete('submit'); if (t !== S.token) return;
    afterTask(st, r, key);
  } catch (e) {
    S.busy.delete('submit'); if (t !== S.token) return;
    S.rec[key].error = isAuthErr(e) ? 'You were signed out. Sign in again, then send your recording again.' : e.message; render();
  }
}
function afterTask(st, r, key) {
  S.result[st.id] = r.result;
  if (r.act) S.lessonData.acts[st.id] = r.act;
  if (r.result && (r.result.invalid || !r.result.correct)) { if (key && S.rec[key]) S.rec[key] = { phase: 'idle' }; }
  else if (key && S.rec[key]) { if (S.rec[key].url) URL.revokeObjectURL(S.rec[key].url); S.rec[key] = { phase: 'idle' }; }
  S.detail && (S.detail.tasks = null);
  render(); if (r.result) say(r.result.feedback);
}

async function sendTextTask(st) {
  const t = S.token; const box = document.getElementById('lrnAns'); const text = box ? box.value : '';
  S.draft[st.id] = text; S.busy.add('submit'); render();
  try { const r = await api('/courses/' + encodeURIComponent(S.route.course) + '/assignments/submit', { method: 'POST', body: { lesson: S.route.lesson, activity: st.id, text } }); S.busy.delete('submit'); if (t !== S.token) return; afterTask(st, r); }
  catch (e) { S.busy.delete('submit'); if (t !== S.token) return; S.result[st.id] = { invalid: true, feedback: isAuthErr(e) ? 'You were signed out. Sign in again to continue.' : e.message }; render(); }
}
async function sendCodeTask(st) {
  const t = S.token; S.busy.add('submit'); render();
  let run; try { run = await runTests(st); } catch (e) { run = { unavailable: true, text: e.message && e.code ? e.message : 'The code sandbox could not start in this browser.' }; }
  if (run.unavailable || !run.results) { S.busy.delete('submit'); if (t !== S.token) return; S.codeOut[st.id] = run.unavailable ? '' : run.text; S.result[st.id] = { invalid: true, feedback: run.unavailable ? 'The coding sandbox is not available right now. ' + run.text + ' Try again in a moment, or reload the page.' : 'Fix the problem below, then run the tests again.' }; render(); return; }
  S.codeOut[st.id] = '';
  try { const r = await api('/courses/' + encodeURIComponent(S.route.course) + '/assignments/submit', { method: 'POST', body: { lesson: S.route.lesson, activity: st.id, source: run.source, results: run.results, nonce: run.nonce } }); S.busy.delete('submit'); if (t !== S.token) return; afterTask(st, r); }
  catch (e) { S.busy.delete('submit'); if (t !== S.token) return; S.result[st.id] = { invalid: true, feedback: e.message }; render(); }
}

// Tasks from earlier lessons (a reviewer asked for changes, or a task is still open) can be done from their lesson page.
function lessonTasks(L, ld) {
  const tasks = L.steps.filter((s) => s.kind === 'activity' && s.type === 'assignment');
  if (!tasks.length) return '';
  return `<div class="lrn-tasks"><h3 class="lrn-h">Practical tasks in this lesson</h3>${tasks.map((st) => { const a = ld.acts[st.id] || {}; const open = S.openTask === st.id; return `<div class="lrn-task"><div class="lrn-task-h"><span><strong>${esc(st.title)}</strong> ${taskTag(a, st)}</span><button type="button" class="lrn-btn lrn-btn--small" data-act="task-toggle" data-id="${esc(st.id)}" aria-expanded="${open}">${open ? 'Close' : (a.review === 'changes' ? 'Fix it' : a.review ? 'View' : 'Open')}</button></div>${open ? `<form id="lrnForm" novalidate>${assignmentInput(st, ld, a, S.result[st.id])}${S.result[st.id] && S.result[st.id].feedback ? `<div class="lrn-feedback ${S.result[st.id].correct ? 'is-right' : 'is-note'}" role="status"><p>${esc(S.result[st.id].feedback)}</p></div>` : (a.lastFeedback ? `<div class="lrn-feedback is-note"><p>${esc(a.lastFeedback)}</p></div>` : '')}</form>` : ''}</div>`; }).join('')}</div>`;
}
function taskTag(a, st) {
  const t = a.review === 'pending' ? ['Waiting for a reviewer', ''] : a.review === 'changes' ? ['Changes requested', 'warn'] : a.review === 'approved' ? ['Approved', 'done'] : a.review === 'auto' ? ['Passed', 'done'] : a.passed ? ['Done', 'done'] : ['Not done', ''];
  return `<span class="lrn-tag ${t[1] === 'done' ? 'lrn-tag--done' : t[1] === 'warn' ? 'lrn-tag--warn' : ''}">${t[0]}</span>${st.certRequired ? ' <span class="lrn-tag">Certificate</span>' : ''}`;
}

// Course page: tasks, certificate, reminders.
function tasksPanel(d) {
  if (!d.tasks || !d.tasks.length) return '';
  const tag = (t) => t.state === 'pending' ? 'Waiting for a reviewer' : t.state === 'changes' ? 'Changes requested' : t.state === 'approved' ? 'Approved' : (t.state === 'done' || t.state === 'auto') ? 'Done' : 'To do';
  return `<section class="lrn-section" aria-labelledby="lrnTasks"><h3 id="lrnTasks" class="lrn-h">Your practical tasks</h3><ul class="lrn-tasklist">${d.tasks.map((t) => `<li class="lrn-taskrow lrn-taskrow--${esc(t.state)}"><span><strong>${esc(t.title)}</strong><span class="lrn-lmeta">${esc({ audio: 'Recording', video: 'Video', text: 'Written', code: 'Project', file: 'File' }[t.format] || t.format)}${t.certRequired ? ' · needed for the certificate' : ''}</span>${t.note ? `<span class="lrn-tasknote">${esc(t.note)}</span>` : ''}</span><span class="lrn-tag ${t.state === 'approved' || t.state === 'done' || t.state === 'auto' ? 'lrn-tag--done' : t.state === 'changes' ? 'lrn-tag--warn' : ''}">${tag(t)}</span><button type="button" class="lrn-btn lrn-btn--small" data-act="open-task" data-lesson="${esc(t.lesson)}" data-id="${esc(t.id)}">${t.state === 'changes' ? 'Fix it' : t.state === 'todo' ? 'Open' : 'View'}</button></li>`).join('')}</ul></section>`;
}

function certPanel(d) {
  const c = d.course;
  if (!c.certificate) return '';
  const done = S.cert.done;
  const cert = d.certificate;
  const body = done ? certCard(done) : !d.progress ? `<p class="lrn-body">To earn the certificate you must:</p><ul class="lrn-bullets">${c.certificate.requirements.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` :
    cert ? `<ul class="lrn-reqs">${cert.requirements.map((r) => `<li class="${r.met ? 'is-met' : ''}"><i class="ph ${r.met ? 'ph-check-circle' : 'ph-circle'}" aria-hidden="true"></i><span>${esc(r.label)}<span class="lrn-lmeta">${esc(r.detail || '')}</span></span></li>`).join('')}</ul>
      ${cert.eligible ? `<form id="lrnCertForm"><p class="lrn-body">Every requirement is met. Enter your full name as it should appear. You cannot change it after it is issued.</p><label class="lrn-field"><span class="lrn-sr">Full name</span><input id="lrnCertName" type="text" maxlength="80" autocomplete="name" placeholder="Your full name" value="${esc(S.cert.name)}"></label><button class="lrn-btn lrn-btn--primary" type="submit" ${S.cert.busy ? 'disabled' : ''}>${S.cert.busy ? 'Issuing' : 'Get my certificate'}</button>${S.cert.error ? `<p class="lrn-error" role="alert">${esc(S.cert.error)}</p>` : ''}</form>` : '<p class="lrn-lmeta">The certificate is issued only when every item above is done.</p>'}` : '';
  return `<section class="lrn-section" aria-labelledby="lrnCert"><h3 id="lrnCert" class="lrn-h">${esc(c.certificate.title)}</h3>${body}</section>`;
}
function certCard(cert) {
  return `<div class="lrn-certcard"><p class="lrn-eyebrow">Issued</p><p class="lrn-body"><strong>${esc(cert.name)}</strong><br>${esc(cert.courseTitle)}<br>Number: <code>${esc(cert.id)}</code></p><a class="lrn-btn lrn-btn--primary" href="/certificate.html?id=${encodeURIComponent(cert.id)}" target="_blank" rel="noopener">View and print</a></div>`;
}
async function loadCertificate() {
  const d = S.detail; if (!d || !d.progress || !d.course.certificate) return;
  try { const r = await api('/courses/' + encodeURIComponent(d.course.id) + '/certificate'); if (r.certificate) S.cert.done = r.certificate; if (!S.cert.name && r.suggestedName) S.cert.name = r.suggestedName; render(); } catch (_) { /* the panel still shows requirements */ }
}
async function claimCertificate() {
  const inp = document.getElementById('lrnCertName'); S.cert.name = inp ? inp.value : S.cert.name; S.cert.busy = true; S.cert.error = null; render();
  try { const r = await api('/courses/' + encodeURIComponent(S.route.course) + '/certificate', { method: 'POST', body: { name: S.cert.name } }); S.cert.done = r.certificate; say('Certificate issued.'); }
  catch (e) { S.cert.error = e.code === 'NOT_ELIGIBLE' ? 'Not every requirement is met yet. Reload the page and check the list.' : isAuthErr(e) ? 'You were signed out. Sign in again.' : e.message; }
  S.cert.busy = false; render();
}

function prefsPanel() {
  const p = S.prefs;
  const perm = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
  const permText = perm === 'granted' ? 'Notifications are allowed in this browser.' : perm === 'denied' ? 'Notifications are blocked in this browser. Allow them in your browser settings to receive reminders.' : perm === 'default' ? 'Notifications are not switched on yet. You can switch them on in <a href="/app.html?view=reminders">Reminders</a>.' : 'This browser cannot show notifications.';
  return `<details class="lrn-prefs" ${S.prefsOpen ? 'open' : ''}><summary data-act="prefs-toggle">Reminders and notifications</summary>${!p ? '<p class="lrn-lmeta">Loading</p>' : `<p class="lrn-body">Cognita only sends a notification when it is useful: when a reviewer has looked at your work, when your certificate is ready, and, if you stop part way through a course, one nudge after about 3 days and one after about 10 days. Never daily. Nothing is sent at night.</p>
    <label class="lrn-switch"><input type="checkbox" data-pref-n="reviewAlerts" ${p.reviewAlerts ? 'checked' : ''}><span>Tell me when work is reviewed or a certificate is ready</span></label>
    <label class="lrn-switch"><input type="checkbox" data-pref-n="nudges" ${p.nudges ? 'checked' : ''}><span>Remind me if I stop part way through a course</span></label>
    <p class="lrn-lmeta">${permText}</p>`}</details>`;
}
async function loadPrefs() { if (S.prefs) return; try { S.prefs = await api('/prefs'); S.prefs.tz = S.prefs.tz; render(); } catch (_) { /* the panel stays in its loading state */ } }
async function savePref(key, val) {
  S.prefs = { ...S.prefs, [key]: val };
  try { S.prefs = await api('/prefs', { method: 'POST', body: { [key]: val, tz: Intl.DateTimeFormat().resolvedOptions().timeZone } }); say('Saved.'); } catch (e) { say(e.message); }
  render();
}

// ── Events (bound once) ──────────────────────────────────────────────────
function onClick(e) {
  const link = e.target.closest('a[data-course]');
  if (link && root().contains(link) && !link.dataset.act) { if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return; e.preventDefault(); go(link.dataset.course, null); return; }
  const a = e.target.closest('[data-act]'); if (!a || !root().contains(a)) return;
  const act = a.dataset.act;
  if (act === 'home' || act === 'to-course') { if (e.metaKey || e.ctrlKey || e.shiftKey) return; e.preventDefault(); S.drawer = false; go(act === 'home' ? null : S.route.course, null); return; }
  if (act === 'reload-cat') { S.catState = 'idle'; loadCatalogue(true); return; }
  if (act === 'reload-detail') { loadDetail(S.route.course, true); return; }
  if (act === 'reload-lesson') { loadLesson(S.route.course, S.route.lesson, true); return; }
  if (act === 'cat') { S.filters.category = a.dataset.cat; render(); return; }
  if (act === 'clear') { S.filters = { q: '', category: 'all', level: 'all' }; render(); return; }
  if (act === 'resume') { resume(a.dataset.course); return; }
  if (act === 'enroll') { doEnroll(); return; }
  if (act === 'advance') { doAdvance(); return; }
  if (act === 'hint') { doHint(); return; }
  if (act === 'restart') { doRestart(); return; }
  if (act === 'open-lesson') { openLesson(a.dataset.lesson); return; }
  if (act === 'drawer') { S.lastFocus = a; S.drawer = true; render(); const c = document.getElementById('lrnDrawerClose'); if (c) c.focus(); return; }
  if (act === 'drawer-close') { S.drawer = false; render(); if (S.lastFocus && document.body.contains(S.lastFocus)) S.lastFocus.focus(); else { const b = root().querySelector('[data-act="drawer"]'); if (b) b.focus(); } return; }
  if (act === 'tutor-toggle') { S.tutor.open = !S.tutor.open; render(); if (S.tutor.open) { const i = document.getElementById('lrnTutorIn'); if (i) i.focus({ preventScroll: true }); } return; }
  if (act === 'quick') { sendTutor(a.dataset.q); return; }
  if (act === 'listen') { doListen(a.dataset.step, a.dataset.part); return; }
  if (act === 'listen-slow') { const st = stepById(a.dataset.step); Speech.prefs.set({}); Speech.speak({ course: S.route.course, lesson: S.route.lesson, step: a.dataset.step, part: 'target', lang: st.lang, rate: 0.75 }, plainText(st.target), { blob: apiBlob }, {}).then((r) => { S.speech.note = r.note || null; render(); }); return; }
  if (act === 'speak-word') { doListen(a.closest('[data-step]') ? a.closest('[data-step]').dataset.step : (S.lessonData && S.lessonData.lesson.steps[S.lessonData.step] || {}).id, 'word', a.dataset.word); return; }
  if (act === 'hot') { S.hot[a.dataset.step] = S.hot[a.dataset.step] === +a.dataset.i ? null : +a.dataset.i; render(); const b = root().querySelector('.lrn-hot[data-i="' + a.dataset.i + '"]'); if (b) b.focus({ preventScroll: true }); return; }
  if (act === 'dictate') { startDictation(a.dataset.id, a.dataset.lang, a.dataset.target); return; }
  if (act === 'speak-record') { toggleSpeakRecord(a.dataset.id, a.dataset.lang); return; }
  if (act === 'speak-skip') { const st = currentStep(); submitSpeak(st.id, '', true); return; }
  if (act === 'rec-start') { startRec(a.dataset.id); return; }
  if (act === 'rec-stop') { stopRec(a.dataset.id); return; }
  if (act === 'rec-redo') { const k = 'rec:' + a.dataset.id; if (S.rec[k] && S.rec[k].url) URL.revokeObjectURL(S.rec[k].url); S.rec[k] = { phase: 'idle' }; render(); return; }
  if (act === 'rec-send') { sendRec(a.dataset.id); return; }
  if (act === 'pace') { Speech.paceGuide(!Speech.paceGuideOn(), 130); render(); return; }
  if (act === 'task-toggle') { S.openTask = S.openTask === a.dataset.id ? null : a.dataset.id; render(); return; }
  if (act === 'open-task') { S.openTask = a.dataset.id; const l = a.dataset.lesson; if (S.detail && S.detail.progress && S.detail.progress.current.lesson === l) { go(S.route.course, l); } else go(S.route.course, l); return; }
  if (act === 'prefs-toggle') { S.prefsOpen = !S.prefsOpen; if (S.prefsOpen) loadPrefs(); return; }
  if (act === 'move') {
    const st = currentStep(); const cur = (Array.isArray(S.draft[st.id]) ? S.draft[st.id] : st.items).slice();
    const i = +a.dataset.i, j = i + +a.dataset.d; if (j < 0 || j >= cur.length) return;
    [cur[i], cur[j]] = [cur[j], cur[i]]; S.draft[st.id] = cur; render();
    const nb = root().querySelectorAll('.lrn-order li')[j]; const btn = nb && nb.querySelector('[data-act="move"][data-d="' + a.dataset.d + '"]:not([disabled])') || (nb && nb.querySelector('[data-act="move"]:not([disabled])')); if (btn) btn.focus();
  }
}
function onSubmit(e) {
  if (e.target.id === 'lrnCertForm') { e.preventDefault(); claimCertificate(); return; }
  if (e.target.id === 'lrnForm') {
    e.preventDefault();
    const st = S.lessonData ? activeStep() : null;
    if (st && st.type === 'assignment') { if (st.format === 'text') sendTextTask(st); else if (st.format === 'code') sendCodeTask(st); return; }
    doSubmit();
  }
  else if (e.target.id === 'lrnTutorForm') { e.preventDefault(); const i = document.getElementById('lrnTutorIn'); const v = i.value; i.value = ''; sendTutor(v); }
}
function onInput(e) {
  const t = e.target;
  if (t.id === 'lrnSearch') { S.filters.q = t.value; const list = S.cat ? filtered() : []; const el = root(); el.innerHTML = viewCatalogue(); const n = document.getElementById('lrnSearch'); n.focus(); n.setSelectionRange(t.value.length, t.value.length); say(plural(list.length, 'course') + ' found'); }
  else if (t.id === 'lrnAns' && S.lessonData) { const st = activeStep(); S.draft[st.id] = t.value; const wc = document.getElementById('lrnWc'); if (wc) wc.textContent = (t.value.match(/\S+/g) || []).length + ' of at least ' + st.minWords + ' words'; }
  else if (t.id === 'lrnCode' && S.lessonData) S.draft[activeStep().id] = t.value;
}
function onChange(e) {
  const t = e.target;
  if (t.id === 'lrnLevel') { S.filters.level = t.value; render(); }
  else if (t.name === 'ans' && S.lessonData) S.draft[currentStep().id] = t.value;
  else if (t.dataset && t.dataset.pref) { Speech.prefs.set({ [t.dataset.pref]: t.dataset.pref === 'rate' ? Number(t.value) : t.value }); }
  else if (t.dataset && t.dataset.prefN) savePref(t.dataset.prefN, t.checked);
}
function onKey(e) {
  if (e.key === 'Escape' && S.drawer) { S.drawer = false; render(); const b = root().querySelector('[data-act="drawer"]'); if (b) b.focus(); return; }
  if (S.drawer && e.key === 'Tab') {
    const sheet = root().querySelector('.lrn-sheet'); if (!sheet) return;
    const f = [...sheet.querySelectorAll('button:not([disabled])')]; if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  }
}

function onRouteChange() {
  const next = routeFromUrl();
  if (!(next.lesson && next.lesson === S.route.lesson && next.course === S.route.course)) cleanupMedia();
  S.route = next; S.drawer = false; S.hint = null; if (!next.lesson) S.openTask = null;
  if (!next.course) { render(); loadCatalogue(!S.cat); return; }
  if (!next.lesson) { S.lessonFor = null; loadDetail(next.course, true); return; }
  loadLesson(next.course, next.lesson, false);
}

function onLearnaNavClick() {
  // Clicking Learna in the sidebar while already inside a course returns to the catalogue.
  if (S.route.course) go(null, null);
}

// ── Router hooks ─────────────────────────────────────────────────────────
export async function mount() {
  if (mounted) return;
  window.addEventListener('pagehide', cleanupMedia);
  const user = await window.Auth.requireAuthOrRedirect();
  if (!user) return;
  mounted = true;
  const el = root();
  el.addEventListener('click', onClick); el.addEventListener('submit', onSubmit);
  el.addEventListener('input', onInput); el.addEventListener('change', onChange);
  el.addEventListener('keydown', onKey);
  window.addEventListener('popstate', () => { if (document.getElementById('view-learna') && !document.getElementById('view-learna').hidden) onRouteChange(); });
  document.querySelectorAll('[data-view="learna"]').forEach((n) => n.addEventListener('click', onLearnaNavClick));
  ensureSidebarAccount();
  onRouteChange();
}
export function activate() { S.cat = null; onRouteChange(); }
export function deactivate() { S.drawer = false; cleanupMedia(); }
