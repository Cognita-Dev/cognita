// js/page-chrome.js
// Small, dependency-free polish shared by the marketing, legal, pricing,
// auth and payment pages. (The signed-in app has its own loading states.)
//
//  1. Route progress bar: a thin accent line at the top edge. It starts
//     when the page begins loading and when an internal link is clicked,
//     and completes when the next page is ready. It never blocks anything.
//  2. Generic scroll reveal: any element with [data-reveal] fades up when
//     it enters the viewport. Siblings stagger automatically.
//
// Both do nothing visible under prefers-reduced-motion. If this script
// fails to load, content is simply visible (see the .js flag in shared.css).

(function () {
  'use strict';

  var reduceMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ── 1. Route progress bar ── */
  var bar = document.createElement('div');
  bar.className = 'page-progress';
  bar.setAttribute('aria-hidden', 'true');
  document.body.appendChild(bar);

  var doneTimer = null;

  function startProgress() {
    if (reduceMotion) return;
    clearTimeout(doneTimer);
    bar.classList.remove('is-done');
    bar.style.transition = 'none';
    bar.classList.remove('is-active');
    void bar.offsetWidth; // restart from zero
    bar.style.transition = '';
    bar.classList.add('is-active');
  }

  function finishProgress() {
    if (!bar.classList.contains('is-active')) return;
    bar.classList.remove('is-active');
    bar.classList.add('is-done');
    doneTimer = setTimeout(function () {
      bar.classList.remove('is-done');
    }, 600);
  }

  // Initial load: the bar is already running by the time this deferred
  // script executes, so just finish it once everything has loaded.
  if (document.readyState === 'complete') {
    finishProgress();
  } else {
    startProgress();
    window.addEventListener('load', finishProgress, { once: true });
  }

  // Back/forward cache restores the page without a load event.
  window.addEventListener('pageshow', function (e) {
    if (e.persisted) finishProgress();
  });

  // Same-origin link click → start the bar while the next page loads.
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a || a.target === '_blank' || a.hasAttribute('download')) return;
    var url;
    try { url = new URL(a.href, location.href); } catch (_) { return; }
    if (url.origin !== location.origin) return;
    if (url.pathname === location.pathname && url.search === location.search) return; // in-page anchor
    startProgress();
  });

  /* ── 2. Scroll reveal for [data-reveal] ── */
  var items = Array.prototype.slice.call(document.querySelectorAll('[data-reveal]'));
  if (!items.length) return;

  // Stagger siblings that share a parent, capped so long lists don't drag.
  var seen = new Map();
  items.forEach(function (el) {
    if (el.style.getPropertyValue('--reveal-delay')) return;
    var n = seen.get(el.parentNode) || 0;
    seen.set(el.parentNode, n + 1);
    el.style.setProperty('--reveal-delay', Math.min(n, 6) * 70 + 'ms');
  });

  if (reduceMotion || !('IntersectionObserver' in window)) {
    items.forEach(function (el) { el.classList.add('is-revealed'); });
    return;
  }

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('is-revealed');
      io.unobserve(entry.target);
    });
  }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });

  items.forEach(function (el) { io.observe(el); });
})();
