// js/home.js
// Behaviour for the public homepage (index.html) only.
//
// This is an external file on purpose: the site's Content-Security-Policy
// (vercel.json) allows inline scripts only by hash, so inline code here
// would be blocked the moment its text changed.
//
// What lives here, and why each piece exists:
//   1. Header + mobile menu ........ chrome
//   2. Workspace preview ........... hero demo: tabs, plus a one-time scripted chat
//   3. Journey line ................ draws once when the sequence comes into view
//   4. Showcase .................... pinned, scroll-driven card stack (all sizes;
//                                    under Reduce Motion it becomes a crossfade). This file
//                                    computes ONE number (--p) per frame and
//                                    writes it to the section. CSS does the rest.
//   5. Learna sample question ...... a real interaction, not a video
//   6. Note Taker tabs, export formats, step highlights
//   7. Chapter rail
// Everything degrades to a complete static page if this file never runs.

(function () {
  'use strict';

  var doc = document;
  var $ = function (s, r) { return (r || doc).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || doc).querySelectorAll(s)); };
  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var hasIO = 'IntersectionObserver' in window;

  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
  function wait(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }

  /* ─────────────────────────────────────────────
     1 · Header, mobile menu, small footer bits
  ───────────────────────────────────────────── */
  var menuBtn = $('#navMenuBtn');
  var overlay = $('#navOverlay');
  function setMenu(open) {
    doc.body.classList.toggle('nav-open', open);
    if (menuBtn) {
      menuBtn.setAttribute('aria-expanded', String(open));
      menuBtn.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    }
  }
  if (menuBtn && overlay) {
    menuBtn.addEventListener('click', function () { setMenu(!doc.body.classList.contains('nav-open')); });
    $$('a', overlay).forEach(function (a) { a.addEventListener('click', function () { setMenu(false); }); });
    doc.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && doc.body.classList.contains('nav-open')) { setMenu(false); menuBtn.focus(); }
    });
  }

  var yearEl = $('#year');
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  var header = $('.site-header');
  var rail = $('#rail');
  var scrollTick = false;
  function onScrollChrome() {
    scrollTick = false;
    var y = window.scrollY;
    if (header) header.classList.toggle('is-scrolled', y > 8);
    if (rail) rail.classList.toggle('is-visible', y > window.innerHeight * 0.6);
  }
  window.addEventListener('scroll', function () {
    if (!scrollTick) { scrollTick = true; requestAnimationFrame(onScrollChrome); }
  }, { passive: true });
  onScrollChrome();

  /* ─────────────────────────────────────────────
     Shared: accessible tabs (roving tabindex + arrow keys)
  ───────────────────────────────────────────── */
  function makeTabs(tablist, onSelect) {
    var tabs = $$('[role="tab"]', tablist);
    function select(tab, focus) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
        var panel = doc.getElementById(t.getAttribute('aria-controls'));
        if (panel) panel.hidden = !on;
      });
      if (focus) tab.focus();
      if (onSelect) onSelect(tab);
    }
    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { select(t, false); });
      t.addEventListener('keydown', function (e) {
        var next = null;
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = tabs[(i + 1) % tabs.length];
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = tabs[(i - 1 + tabs.length) % tabs.length];
        else if (e.key === 'Home') next = tabs[0];
        else if (e.key === 'End') next = tabs[tabs.length - 1];
        if (next) { e.preventDefault(); select(next, true); }
      });
    });
    return { select: select, tabs: tabs };
  }

  /* ─────────────────────────────────────────────
     2 · Workspace preview (hero)
  ───────────────────────────────────────────── */
  (function workspace() {
    var ws = $('#workspace');
    if (!ws) return;

    var chat = $('#demoChat');
    var composer = $('#demoComposer');
    var sendBtn = $('#demoSend');
    var replyEl = $('#demoReply');
    var statusEl = $('#demoStatus');
    var userMsg = $('[data-step="user"]', chat);
    var aiMsg = $('[data-step="ai"]', chat);
    var replyBox = $('[data-step="reply"]', chat);
    var docChip = $('[data-step="doc"]', chat);
    var emptyEl = $('#demoEmpty');

    var PROMPT = 'Pull this into a client-ready retention brief';
    var PLACEHOLDER = '<span class="composer-placeholder">Message Cognita</span>';
    var fullReply = replyEl ? replyEl.textContent.trim() : '';
    var fullStatus = statusEl ? statusEl.textContent : '';
    var runId = 0;
    var started = false;

    function finalState() {
      runId += 1; // cancels any run in progress
      chat.classList.remove('is-playing');
      [userMsg, aiMsg, replyBox, docChip].forEach(function (el) { if (el) el.classList.remove('is-in'); });
      if (replyEl) replyEl.textContent = fullReply;
      if (statusEl) statusEl.textContent = fullStatus;
      composer.innerHTML = PLACEHOLDER;
      sendBtn.classList.remove('is-ready', 'is-pressed');
      if (emptyEl) emptyEl.classList.add('is-gone');
    }

    async function play() {
      var id = ++runId;
      var alive = function () { return id === runId; };

      chat.classList.add('is-playing');
      [userMsg, aiMsg, replyBox, docChip].forEach(function (el) { el.classList.remove('is-in'); });
      replyEl.textContent = '';
      composer.innerHTML = PLACEHOLDER;
      if (emptyEl) emptyEl.classList.remove('is-gone');

      await wait(1500); if (!alive()) return;

      // Type the request into the composer.
      composer.innerHTML = '<span id="demoTyped"></span><span class="caret"></span>';
      var typed = $('#demoTyped');
      for (var i = 1; i <= PROMPT.length; i += 1) {
        typed.textContent = PROMPT.slice(0, i);
        if (i === 1) sendBtn.classList.add('is-ready');
        await wait(34 + Math.random() * 26); if (!alive()) return;
      }
      await wait(420); if (!alive()) return;

      // Send.
      sendBtn.classList.add('is-pressed');
      await wait(160); if (!alive()) return;
      sendBtn.classList.remove('is-pressed', 'is-ready');
      composer.innerHTML = PLACEHOLDER;
      if (emptyEl) emptyEl.classList.add('is-gone');
      userMsg.classList.add('is-in');
      await wait(650); if (!alive()) return;

      // Thinking.
      var t0 = performance.now();
      aiMsg.classList.add('is-in');
      var labels = ['Planning…', 'Rounding up…', 'Presenting response…'];
      for (var k = 0; k < labels.length; k += 1) {
        statusEl.textContent = labels[k];
        await wait(640); if (!alive()) return;
      }
      statusEl.textContent = 'Thought for ' + ((performance.now() - t0) / 1000).toFixed(1) + 's';
      await wait(380); if (!alive()) return;

      // Reply, a few words at a time.
      replyBox.classList.add('is-in');
      var words = fullReply.split(' ');
      for (var w = 1; w <= words.length; w += 1) {
        replyEl.textContent = words.slice(0, w).join(' ');
        await wait(46); if (!alive()) return;
      }
      await wait(420); if (!alive()) return;
      docChip.classList.add('is-in');
    }

    makeTabs($('.ws-nav', ws), function (tab) {
      // Leaving the chat, or returning to it, always shows the finished conversation.
      if (started) finalState();
    });

    if (reduceMotion) return;
    started = true;
    play();
  })();

  /* ─────────────────────────────────────────────
     3 · Journey: the line draws once
  ───────────────────────────────────────────── */
  (function journey() {
    var list = $('#journey');
    if (!list) return;
    $$('li', list).forEach(function (li, i) { li.querySelector('.j-n').style.setProperty('--k', i); });
    if (reduceMotion || !hasIO) { list.classList.add('is-in'); return; }
    var io = new IntersectionObserver(function (entries) {
      if (entries[0].isIntersecting) { list.classList.add('is-in'); io.disconnect(); }
    }, { threshold: 0.5 });
    io.observe(list);
  })();

  /* ─────────────────────────────────────────────
     4 · Showcase: pinned, scroll-driven card stack
     Raw scroll progress is mapped so every stage HOLDS for roughly half of
     its scroll distance, then transitions to the next. Integer values of
     --p are settled stages; fractions are the card stacking over.
  ───────────────────────────────────────────── */
  (function showcase() {
    var sec = $('#product');
    var track = $('#showcaseTrack');
    if (!sec || !track) return;

    var N = $$('.stage', sec).length;
    if (N < 2) return;
    var frame = $('#showcaseFrame');
    var mq = window.matchMedia('(min-height: 600px)');
    var pinned = false;
    var visible = false;
    var tick = false;
    var io = null;

    function range() { return track.offsetHeight - (frame ? frame.offsetHeight : window.innerHeight); }

    function update() {
      tick = false;
      var r = range();
      if (r <= 0) return;
      var raw = clamp(-track.getBoundingClientRect().top / r, 0, 1) * (N - 1);
      var i = Math.floor(raw);
      var t = clamp((raw - i - 0.45) / 0.55, 0, 1);
      var p = i + t * t * (3 - 2 * t);
      sec.style.setProperty('--p', p.toFixed(3));
    }
    function request() {
      if (visible && !tick) { tick = true; requestAnimationFrame(update); }
    }

    function enable() {
      if (pinned) return;
      pinned = true;
      sec.classList.add('is-pinned');
      window.addEventListener('scroll', request, { passive: true });
      window.addEventListener('resize', request);
      if (hasIO) {
        io = new IntersectionObserver(function (entries) {
          visible = entries[0].isIntersecting;
          request();
        }, { rootMargin: '120px 0px 120px 0px' });
        io.observe(track);
      } else {
        visible = true;
      }
      visible = visible || !hasIO;
      tick = false;
      requestAnimationFrame(function () { visible = true; update(); });
    }
    function disable() {
      if (!pinned) return;
      pinned = false;
      sec.classList.remove('is-pinned');
      sec.style.removeProperty('--p');
      window.removeEventListener('scroll', request);
      window.removeEventListener('resize', request);
      if (io) { io.disconnect(); io = null; }
    }
    function sync() { if (mq.matches) enable(); else disable(); }
    sync();
    if (mq.addEventListener) mq.addEventListener('change', sync);
    else if (mq.addListener) mq.addListener(sync);

    // Jump to a stage from the index.
    $$('[data-go]', sec).forEach(function (btn) {
      btn.addEventListener('click', function () {
        var i = Number(btn.getAttribute('data-go'));
        var top = track.getBoundingClientRect().top + window.scrollY + (i / (N - 1)) * range();
        window.scrollTo({ top: Math.round(top) + 1, behavior: 'smooth' });
      });
    });
  })();

  /* ─────────────────────────────────────────────
     5 · Learna sample question
  ───────────────────────────────────────────── */
  (function learna() {
    var form = $('#lq');
    if (!form) return;
    var fb = $('#lqFeedback');
    var hintBtn = $('#lqHint');
    var WHY = {
      a: 'f(1) is 2, but f is then called again with that result.',
      c: 'That would take three calls. There are only two.'
    };

    function say(kind, lead, text) {
      fb.className = 'lw-feedback' + (kind ? ' is-' + kind : '');
      fb.textContent = '';
      var strong = doc.createElement('strong');
      strong.textContent = lead;
      fb.appendChild(strong);
      fb.appendChild(doc.createTextNode(' ' + text));
    }
    function clearMarks() { $$('.choice', form).forEach(function (c) { c.classList.remove('is-right', 'is-wrong'); }); }

    form.addEventListener('change', function () { clearMarks(); fb.textContent = ''; fb.className = 'lw-feedback'; });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      clearMarks();
      var sel = $('input:checked', form);
      if (!sel) { say('', 'Choose an answer first.', ''); return; }
      var label = sel.closest('.choice');
      if (sel.value === 'b') {
        label.classList.add('is-right');
        say('ok', 'That\u2019s right.', 'f(1) returns 2, then f(2) returns 3.');
      } else {
        label.classList.add('is-wrong');
        say('no', 'Not quite.', WHY[sel.value] + ' Try again.');
      }
    });
    hintBtn.addEventListener('click', function () {
      clearMarks();
      say('', 'Hint.', 'Work from the inside out. What does f(1) give you?');
    });
  })();

  /* ─────────────────────────────────────────────
     6a · Note Taker tabs
  ───────────────────────────────────────────── */
  (function notes() {
    var list = $('#noteDemo .nw-tabs');
    if (list) makeTabs(list);
  })();

  /* ─────────────────────────────────────────────
     6b · Export formats
  ───────────────────────────────────────────── */
  (function exportFormats() {
    var group = $('.fmt');
    if (!group) return;
    var FORMATS = {
      docx: { icon: 'ph-file-doc', name: 'Q3-retention-brief.docx', note: 'Opens in Word and other document editors.' },
      pdf: { icon: 'ph-file-pdf', name: 'Q3-retention-brief.pdf', note: 'A fixed layout that looks the same everywhere.' },
      pptx: { icon: 'ph-file-ppt', name: 'Q3-retention-brief.pptx', note: 'The same content, laid out as slides.' }
    };
    var icon = $('#expIcon');
    var name = $('#expName');
    var note = $('#expNote');
    var buttons = $$('button', group);
    buttons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        var f = FORMATS[btn.getAttribute('data-fmt')];
        if (!f) return;
        buttons.forEach(function (b) {
          var on = b === btn;
          b.classList.toggle('is-on', on);
          b.setAttribute('aria-pressed', String(on));
        });
        icon.className = 'ph ' + f.icon;
        name.textContent = f.name;
        note.textContent = f.note;
      });
    });
  })();

  /* ─────────────────────────────────────────────
     6c · Step highlights (Create pipeline, Investigate run)
  ───────────────────────────────────────────── */
  (function steps() {
    var pipe = $('#pipe');
    if (pipe) {
      var items = $$('li', pipe);
      var lightAll = function () { items.forEach(function (li) { li.classList.add('is-lit'); }); };
      if (reduceMotion || !hasIO) lightAll();
      else {
        var io1 = new IntersectionObserver(async function (entries) {
          if (!entries[0].isIntersecting) return;
          io1.disconnect();
          for (var i = 0; i < items.length; i += 1) {
            items[i].classList.add('is-lit');
            await wait(420);
          }
        }, { threshold: 0.45 });
        io1.observe(pipe);
      }
    }

    var run = $('#run');
    if (run) {
      $$('.run-steps li', run).forEach(function (li, i) { li.style.setProperty('--k', i); });
      if (reduceMotion || !hasIO) run.classList.add('is-in');
      else {
        var io2 = new IntersectionObserver(function (entries) {
          if (entries[0].isIntersecting) { run.classList.add('is-in'); io2.disconnect(); }
        }, { threshold: 0.4 });
        io2.observe(run);
      }
    }
  })();

  /* ─────────────────────────────────────────────
     6d · Reveals and gentle parallax
     Classes are added here (not in the HTML) so that nothing is ever hidden
     unless this script is running.
  ───────────────────────────────────────────── */
  (function motion() {
    var groups = [
      '.facts > div', '.learna-win', '.flow li', '.note-win', '.pipe li', '.sheet#sheet', '.export',
      '.create-more > div', '.run', '.ticks li', '.ledger li', '.trust-list > div', '.trust-links',
      '.home-pricing .pricing-card', '.faq-item', '.final-title', '.final p', '.final .btn-primary'
    ];
    var seen = [];
    function tag(sel) {
      $$(sel).forEach(function (el, i) {
        if (seen.indexOf(el) !== -1) return;
        seen.push(el);
        el.classList.add('rv');
        el.style.setProperty('--rv', String(Math.min(i, 6)));
      });
    }
    groups.forEach(tag);
    var items = $$('.rv');
    if (!hasIO) { items.forEach(function (el) { el.classList.add('in'); }); }
    else {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
      }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
      items.forEach(function (el) { io.observe(el); });
    }
    // Pricing cards are rendered after load by pricing-cards.js.
    var grid = $('#pricingGrid');
    if (grid && 'MutationObserver' in window) {
      new MutationObserver(function () { tag('.home-pricing .pricing-card'); $$('.home-pricing .pricing-card:not(.in)').forEach(function (el) { if (hasIO) io.observe(el); else el.classList.add('in'); }); }).observe(grid, { childList: true });
    }

    if (reduceMotion) return;
    var par = [
      ['.learna-win', -26], ['.note-win', -22], ['.doc-stage', -34], ['.pipe', 14], ['.run', -26], ['.ledger', 12]
    ].map(function (pair) {
      var el = $(pair[0]);
      if (el) { el.setAttribute('data-par', ''); el.style.setProperty('--amp', String(pair[1])); }
      return el;
    }).filter(Boolean);
    var tick = false;
    function updatePar() {
      tick = false;
      var vh = window.innerHeight;
      par.forEach(function (el) {
        var r = el.getBoundingClientRect();
        if (r.bottom < -200 || r.top > vh + 200) return;
        var c = (r.top + r.height / 2 - vh / 2) / (vh / 2 + r.height / 2);
        el.style.setProperty('--par', clamp(c, -1, 1).toFixed(3));
      });
    }
    window.addEventListener('scroll', function () { if (!tick) { tick = true; requestAnimationFrame(updatePar); } }, { passive: true });
    window.addEventListener('resize', updatePar);
    updatePar();
  })();

  /* ─────────────────────────────────────────────
     7 · Chapter rail
  ───────────────────────────────────────────── */
  (function chapterRail() {
    if (!rail || !hasIO) return;
    var links = $$('a[data-rail]', rail);
    var map = {};
    links.forEach(function (a) { map[a.getAttribute('data-rail')] = a; });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        links.forEach(function (a) { a.classList.remove('is-active'); a.removeAttribute('aria-current'); });
        var a = map[entry.target.id];
        if (a) { a.classList.add('is-active'); a.setAttribute('aria-current', 'true'); }
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    Object.keys(map).forEach(function (id) {
      var el = doc.getElementById(id);
      if (el) io.observe(el);
    });
  })();
})();
