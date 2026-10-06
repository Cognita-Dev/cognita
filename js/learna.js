// js/learna.js
// Learna view. Exports mount(), activate() and deactivate(), called by js/router.js.
// Routes inside the view use the query string so refresh, back and forward work:
//   ?view=learna                          catalogue
//   ?view=learna&course=<id>              course page
//   ?view=learna&course=<id>&lesson=<key> learning workspace
//
// The browser never decides progress or grades. It shows what the server returns
// and sends answers. Code tests run in the existing Cognita sandbox; the server
// compares the values they produce against expectations the browser never sees.

import { escapeHtml as esc, ensureSidebarAccount } from './shell.js';
import { SandboxClient } from './sandbox-client.js';

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
};
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

const say = (text) => { const el = document.getElementById('learnaStatus'); if (el) { el.textContent = ''; setTimeout(() => { el.textContent = text; }, 30); } };
const paras = (arr) => arr.map((t) => '<p>' + esc(t) + '</p>').join('');
const catName = (id) => ((S.cat && S.cat.categories.find((c) => c.id === id)) || {}).name || '';
const planName = (p) => ({ free: 'Starter', plus: 'Plus', studio: 'Studio', admin: 'Admin' }[p] || p);
const minutes = (n) => (n >= 60 ? (Math.floor(n / 60) + ' h' + (n % 60 ? ' ' + (n % 60) + ' min' : '')) : n + ' min');
const plural = (n, w) => n + ' ' + w + (n === 1 ? '' : 's');
const isAuthErr = (e) => e && (e.code === 'AUTH' || e.status === 401);

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
}

async function loadLesson(courseId, key, force) {
  if (S.lessonFor === courseId + '/' + key && S.lessonData && !force) return;
  const t = ++S.token; S.lessonData = null; S.lessonFor = courseId + '/' + key; S.lessonState = 'loading';
  S.tutor = { open: window.matchMedia('(min-width: 900px)').matches, log: [], sending: false }; S.result = {}; S.codeOut = {}; S.draft = {};
  if (!S.detail || S.detailFor !== courseId) { try { S.detail = await api('/courses/' + encodeURIComponent(courseId)); S.detailFor = courseId; } catch (e) { if (t !== S.token) return; S.lessonState = 'error'; S.lessonError = e; render(); return; } if (t !== S.token) return; }
  if (!S.detail.progress) { go(courseId, null, { replace: true }); return; }
  render();
  try {
    const d = await api('/courses/' + encodeURIComponent(courseId) + '/lessons/' + encodeURIComponent(key));
    if (t !== S.token) return;
    S.lessonData = d; S.lessonState = 'ready'; S.notice = d.notice || null;
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
  const status = m ? (m.status === 'completed' ? '<span class="lrn-tag lrn-tag--done">Completed</span>' : `<span class="lrn-tag lrn-tag--live">${m.percent}% done</span>`) : (c.status !== 'available' ? '<span class="lrn-tag">Coming soon</span>' : (c.access_state.allowed ? '' : `<span class="lrn-tag">${planName(c.access)} to start</span>`));
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
        <section aria-labelledby="lrnCur"><h3 id="lrnCur" class="lrn-h">Curriculum</h3>
          ${c.curriculum.map((s, i) => `<details class="lrn-sec" ${i === 0 ? 'open' : ''}><summary><span>Section ${i + 1}: ${esc(s.title)}</span><span class="lrn-sec-n">${plural(s.lessons.length, 'lesson')}</span></summary><p class="lrn-sec-sum">${esc(s.summary)}</p><ol class="lrn-lessons">${s.lessons.map((l) => { const st = prog && prog.lessons[l.key]; const done = st && st.status === 'done'; return `<li class="${done ? 'is-done' : ''}"><span class="lrn-tick" aria-hidden="true">${done ? '<i class="ph ph-check"></i>' : ''}</span><span><span class="lrn-ltitle">${esc(l.title)}${done ? '<span class="lrn-sr"> (completed)</span>' : ''}</span><span class="lrn-lobj">${esc(l.objective)}</span><span class="lrn-lmeta">${l.minutes} min · ${plural(l.activityCount, 'activity')}</span></span></li>`; }).join('')}</ol></details>`).join('')}
        </section>
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
      <div class="lrn-step" id="lrnStep">${viewingOld ? reviewOld(L, ld) : (doneCourse ? courseDone(d) : stepBody(st, ld, L))}</div>
      ${tutorHtml(d, ld, L, st)}
    </section>
    <div class="lrn-drawer ${S.drawer ? 'is-open' : ''}" id="lrnDrawer" ${S.drawer ? '' : 'hidden'}>
      <div class="lrn-scrim" data-act="drawer-close"></div>
      <div class="lrn-sheet" role="dialog" aria-modal="true" aria-label="Lessons"><button type="button" class="lrn-btn lrn-btn--small lrn-sheet-close" data-act="drawer-close" id="lrnDrawerClose">Close</button>${navPanel(d, ld)}</div>
    </div>
  </div>`;
}

function reviewOld(L, ld) {
  return `<div class="lrn-card"><h3 class="lrn-h">You have finished this lesson</h3><p class="lrn-body">${ld.mastery ? `You passed ${ld.mastery.passedClean} of ${ld.mastery.total} activities without seeing the answer.` : ''} Pick any lesson in the list, or carry on where you stopped.</p><button class="lrn-btn lrn-btn--primary" type="button" data-act="open-lesson" data-lesson="${esc(ld.progress.current.lesson)}">Go to my current lesson</button></div>`;
}
function courseDone(d) {
  return `<div class="lrn-card lrn-card--done"><h3 class="lrn-h">You finished ${esc(d.course.title)}</h3><p class="lrn-body">Every lesson is complete. Your course place is free again, so you can start another course. You can reopen any lesson from the list.</p><a class="lrn-btn lrn-btn--primary" href="/app.html?view=learna" data-act="home">Choose your next course</a></div>`;
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

function teachBody(st, ld, L) {
  const last = ld.step >= L.steps.length - 1;
  return `<article class="lrn-card"><h3 class="lrn-h">${esc(st.title)}</h3><div class="lrn-prose">${paras(st.text)}</div>
    ${st.example ? `<figure class="lrn-example"><figcaption>${esc(st.example.label)}</figcaption><pre>${esc(st.example.text)}</pre></figure>` : ''}
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
  else if (st.type === 'open') {
    const text = draft || '';
    const wc = (text.match(/\S+/g) || []).length;
    input = `<div class="lrn-prompt">${prompt(st.prompt)}</div>
      <div class="lrn-criteria"><p class="lrn-objective-h">Your answer should</p>${r && r.checklist ? `<ul class="lrn-check">${r.checklist.map((c) => `<li class="${c.met ? 'is-met' : 'is-miss'}"><i class="ph ${c.met ? 'ph-check-circle' : 'ph-circle'}" aria-hidden="true"></i><span>${esc(c.label)}<span class="lrn-sr">${c.met ? ' (done)' : ' (missing)'}</span></span></li>`).join('')}</ul>` : `<ul class="lrn-bullets">${st.criteria.map((c) => `<li>${esc(c)}</li>`).join('')}</ul>`}</div>
      <label class="lrn-field"><span class="lrn-sr">Your answer</span><textarea id="lrnAns" rows="5" ${dis} placeholder="Write your answer here">${esc(text)}</textarea></label>
      <p class="lrn-wc" id="lrnWc">${wc} of at least ${st.minWords} words</p>`;
  } else if (st.type === 'code') {
    const code = draft != null ? draft : st.starter;
    const out = S.codeOut[st.id];
    input = `<div class="lrn-prompt">${prompt(st.prompt)}</div>
      <label class="lrn-field"><span class="lrn-sr">Your code</span><textarea id="lrnCode" class="lrn-code" rows="9" spellcheck="false" autocapitalize="off" autocomplete="off" ${dis}>${esc(code)}</textarea></label>
      <div class="lrn-tests"><p class="lrn-objective-h">Tests that must pass</p>${r && r.checklist ? `<ul class="lrn-check">${r.checklist.map((c) => `<li class="${c.met ? 'is-met' : 'is-miss'}"><i class="ph ${c.met ? 'ph-check-circle' : 'ph-x-circle'}" aria-hidden="true"></i><code>${esc(c.label)}</code><span class="lrn-sr">${c.met ? ' passed' : ' failed'}</span></li>`).join('')}</ul>` : `<ul class="lrn-check">${st.tests.map((t) => `<li><i class="ph ph-circle" aria-hidden="true"></i><code>${esc(t.name)}</code></li>`).join('')}</ul>`}</div>
      ${out ? `<pre class="lrn-out" tabindex="0" aria-label="Run output">${esc(out)}</pre>` : ''}`;
  }

  const feedback = r && r.feedback ? `<div class="lrn-feedback ${r.correct ? 'is-right' : r.invalid ? 'is-note' : 'is-wrong'}" role="status"><p class="lrn-fb-h">${r.correct ? 'Correct' : r.invalid ? 'Check your answer' : 'Not yet'}</p><p>${esc(r.feedback)}</p></div>` : (a.lastFeedback && !r ? `<div class="lrn-feedback ${a.passed ? 'is-right' : 'is-wrong'}" role="status"><p>${esc(a.lastFeedback)}</p></div>` : '');
  const reveal = r && r.revealed ? `<div class="lrn-reveal"><p class="lrn-objective-h">The answer</p>${st.type === 'code' || st.type === 'open' ? `<pre>${esc(r.revealed.answer)}</pre>` : `<p>${esc(r.revealed.answer)}</p>`}<p>${esc(r.revealed.explanation)}</p></div>` : '';
  const hintBox = S.hint && S.hint.id === st.id ? `<div class="lrn-hint" role="status"><p class="lrn-objective-h">Hint ${S.hint.n}</p><p>${esc(S.hint.text)}</p></div>` : '';
  const canHint = !finished && st.hintCount > a.hintsUsed;
  const last = ld.step >= S.lessonData.lesson.steps.length - 1;

  return `<article class="lrn-card" aria-labelledby="lrnActH">
    <p class="lrn-eyebrow">${activityLabel(st)}</p><h3 class="lrn-h" id="lrnActH">${esc(st.title)}</h3>
    <form id="lrnForm" novalidate>${input}
      ${feedback}${reveal}${hintBox}
      <div class="lrn-actions">
        ${finished ? `<button class="lrn-btn lrn-btn--primary" type="button" data-act="advance" ${S.busy.has('advance') ? 'disabled' : ''}>${last ? 'Finish lesson' : 'Continue'}</button>` :
          st.type === 'code' ? `<button class="lrn-btn lrn-btn--primary" type="submit" ${busyCheck ? 'disabled' : ''}>${busyCheck ? 'Running tests' : 'Run tests'}</button>` :
          `<button class="lrn-btn lrn-btn--primary" type="submit" ${busyCheck || st.unsupported ? 'disabled' : ''}>${busyCheck ? 'Checking' : 'Check answer'}</button>`}
        ${canHint ? `<button class="lrn-btn" type="button" data-act="hint" ${S.busy.has('hint') ? 'disabled' : ''}>Show a hint</button>` : ''}
        ${!finished ? `<span class="lrn-tries">${left === 1 ? '1 try left' : left + ' tries left'}</span>` : ''}
      </div></form>
    <p class="lrn-error" id="lrnErr" role="alert" hidden></p>
  </article>`;
}
function prompt(t) { return String(t).split('\n').map((l) => l ? `<span class="lrn-pl">${esc(l)}</span>` : '<span class="lrn-pl">&nbsp;</span>').join(''); }
function activityLabel(st) { return ({ choice: 'Question', fill: 'Fill in the blank', order: 'Put in order', match: 'Match', open: 'Writing task', code: 'Coding task' }[st.type]) || 'Activity'; }

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
  const thunks = st.tests.map((t) => 'function(){return (' + t.expr + ');}').join(',');
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
  try { return { results: JSON.parse(m[1]) }; } catch (_) { return { text: 'The test results could not be read. Run your code again.' }; }
}

async function doSubmit() {
  if (S.busy.has('submit')) return;
  const ld = S.lessonData, st = currentStep(), key = S.route.lesson, t = S.token;
  const body = { lesson: key, activity: st.id };
  if (st.type === 'code') {
    S.busy.add('submit'); render();
    let run; try { run = await runTests(st); } catch (e) { run = { unavailable: true, text: 'The code sandbox could not start in this browser.' }; }
    S.busy.delete('submit');
    if (t !== S.token) return;
    if (run.unavailable) { S.codeOut[st.id] = ''; S.result[st.id] = { invalid: true, feedback: 'The coding sandbox is not available right now. ' + run.text + ' Try again in a moment, or reload the page.' }; render(); return; }
    if (!run.results) { S.codeOut[st.id] = run.text; S.result[st.id] = { invalid: true, feedback: 'Fix the problem below, then run the tests again.' }; render(); return; }
    S.codeOut[st.id] = ''; body.results = run.results;
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
    if (r.result && !r.result.invalid) say(r.result.correct ? 'Correct.' : 'Not yet. ' + r.result.feedback);
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
  if (act === 'move') {
    const st = currentStep(); const cur = (Array.isArray(S.draft[st.id]) ? S.draft[st.id] : st.items).slice();
    const i = +a.dataset.i, j = i + +a.dataset.d; if (j < 0 || j >= cur.length) return;
    [cur[i], cur[j]] = [cur[j], cur[i]]; S.draft[st.id] = cur; render();
    const nb = root().querySelectorAll('.lrn-order li')[j]; const btn = nb && nb.querySelector('[data-act="move"][data-d="' + a.dataset.d + '"]:not([disabled])') || (nb && nb.querySelector('[data-act="move"]:not([disabled])')); if (btn) btn.focus();
  }
}
function onSubmit(e) {
  if (e.target.id === 'lrnForm') { e.preventDefault(); doSubmit(); }
  else if (e.target.id === 'lrnTutorForm') { e.preventDefault(); const i = document.getElementById('lrnTutorIn'); const v = i.value; i.value = ''; sendTutor(v); }
}
function onInput(e) {
  const t = e.target;
  if (t.id === 'lrnSearch') { S.filters.q = t.value; const list = S.cat ? filtered() : []; const el = root(); el.innerHTML = viewCatalogue(); const n = document.getElementById('lrnSearch'); n.focus(); n.setSelectionRange(t.value.length, t.value.length); say(plural(list.length, 'course') + ' found'); }
  else if (t.id === 'lrnAns' && S.lessonData) { const st = currentStep(); S.draft[st.id] = t.value; const wc = document.getElementById('lrnWc'); if (wc) wc.textContent = (t.value.match(/\S+/g) || []).length + ' of at least ' + st.minWords + ' words'; }
  else if (t.id === 'lrnCode' && S.lessonData) S.draft[currentStep().id] = t.value;
}
function onChange(e) {
  const t = e.target;
  if (t.id === 'lrnLevel') { S.filters.level = t.value; render(); }
  else if (t.name === 'ans' && S.lessonData) S.draft[currentStep().id] = t.value;
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
  S.route = next; S.drawer = false; S.hint = null;
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
export function deactivate() { S.drawer = false; }
