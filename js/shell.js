// js/shell.js
// Single owner of the chrome shared by every workspace view (chat,
// resources, library): sidebar collapse/mobile-open, the account menu,
// sign-out, toasts and HTML-escaping. Wired exactly once by the shell
// itself, before any view module mounts, so it never gets bound twice.

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function showToast(message) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

export function closeMobileSidebar() {
  document.getElementById('appSidebar').classList.remove('is-open');
  document.getElementById('sidebarScrim').classList.remove('is-visible');
}

// ── Shared modal open/close ──
// Every .modal-overlay (visual/document/connectors/reminder generation)
// used to be shown and hidden by flipping its `hidden` attribute directly,
// which is instant — display:none can't be transitioned, so the modal
// just appeared and disappeared with no sense of arriving or leaving.
// These two give every modal the same real motion from one place, rather
// than each view reimplementing its own timing:
//   openModal  — unhides it, then (after a forced reflow so the browser
//                registers the "closed" starting state first) adds
//                .is-open, which app.css transitions from.
//   closeModal — removes .is-open to start the close transition, and
//                only re-hides the element once that transition has had
//                time to actually finish, so it's still visible while
//                it's animating away instead of vanishing mid-motion.
// MODAL_CLOSE_MS must stay >= the CSS transition duration those rules
// use (currently --duration-base, 200ms) or the modal will be yanked
// from the layout before its exit motion completes.
const MODAL_CLOSE_MS = 200;

export function openModal(modal) {
  modal.hidden = false;
  void modal.offsetWidth; // force layout so the transition has a "before" state to animate from
  modal.classList.add('is-open');
}

export function closeModal(modal) {
  modal.classList.remove('is-open');
  window.setTimeout(() => {
    // Guards against a rapid reopen during the close animation: only
    // actually hide if it's still meant to be closed.
    if (!modal.classList.contains('is-open')) modal.hidden = true;
  }, MODAL_CLOSE_MS);
}

function wireSidebarChrome() {
  const sidebar = document.getElementById('appSidebar');
  const scrim = document.getElementById('sidebarScrim');

  const collapseBtn = document.getElementById('sidebarCollapseBtn');
  const shell = document.querySelector('.app-shell');
  collapseBtn.addEventListener('click', () => {
    const collapsed = sidebar.classList.toggle('is-collapsed');
    // The grid track must shrink with the rail (see .is-sidebar-collapsed in app.css).
    shell.classList.toggle('is-sidebar-collapsed', collapsed);
    collapseBtn.setAttribute('aria-expanded', String(!collapsed));
    collapseBtn.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  });

  document.getElementById('sidebarCloseBtn').addEventListener('click', () => {
    closeMobileSidebar();
  });

  document.querySelectorAll('.mobile-sidebar-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      sidebar.classList.add('is-open');
      scrim.classList.add('is-visible');
    });
  });

  scrim.addEventListener('click', closeMobileSidebar);

  // Escape closes the mobile drawer, like every other overlay in the app.
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sidebar.classList.contains('is-open')) closeMobileSidebar();
  });
}

function wireAccountMenu() {
  const btn = document.getElementById('accountBtn');
  const menu = document.getElementById('accountMenu');

  function setMenuOpen(open) {
    menu.classList.toggle('is-open', open);
    btn.setAttribute('aria-expanded', String(open));
  }

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setMenuOpen(!menu.classList.contains('is-open'));
  });

  document.addEventListener('click', () => setMenuOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu.classList.contains('is-open')) {
      setMenuOpen(false);
      btn.focus();
    }
  });

  document.getElementById('logOutBtn').addEventListener('click', async () => {
    await window.Auth.logOut();
    window.location.href = '/login.html';
  });
}

export function renderAccountInfo(user) {
  const displayName = (user.displayName || '').trim();
  const label = displayName || user.email || 'Signed in';
  document.getElementById('accountEmail').textContent = label;
  document.getElementById('accountAvatar').textContent = label.charAt(0).toUpperCase();
}

// Fills the sidebar's plan label (and the admin / upgrade shortcuts) from an
// /api/account response. Views that already fetch /api/account pass their
// data straight in; views that don't call ensureSidebarAccount().
const ADMIN_ROLES = ['admin', 'moderator'];

export function applySidebarAccount(data) {
  if (!data) return;
  const plan = document.getElementById('accountPlan');
  if (plan && data.planName) {
    plan.textContent = data.planName;
    plan.classList.remove('skeleton');
  }
  const email = document.getElementById('accountEmail');
  if (email) email.classList.remove('skeleton');

  const adminLink = document.getElementById('adminPanelLink');
  if (adminLink) adminLink.hidden = !ADMIN_ROLES.includes(data.role);

  const upgradeLink = document.getElementById('upgradeLink');
  if (upgradeLink && data.planId !== 'studio' && data.planId !== 'admin') {
    upgradeLink.hidden = false;
  }
}

// One /api/account fetch per page load, shared by every view that needs the
// sidebar filled in. Failures are swallowed: the sidebar just stays as-is.
const SHELL_WORKER_URL = 'https://api.cognita.com.ng';
let sidebarAccountPromise = null;

export function ensureSidebarAccount() {
  if (!sidebarAccountPromise) {
    sidebarAccountPromise = window.Auth.authedFetch(SHELL_WORKER_URL + '/api/account')
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => { applySidebarAccount(data); return data; })
      .catch(() => { sidebarAccountPromise = null; return null; });
  }
  return sidebarAccountPromise;
}

// Called once, on first load, before any view mounts.
export function initShell() {
  wireSidebarChrome();
  wireAccountMenu();
}
