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

  document.getElementById('sidebarCollapseBtn').addEventListener('click', () => {
    sidebar.classList.toggle('is-collapsed');
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
}

function wireAccountMenu() {
  const btn = document.getElementById('accountBtn');
  const menu = document.getElementById('accountMenu');

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('is-open');
  });

  document.addEventListener('click', () => { menu.classList.remove('is-open'); });

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

// Called once, on first load, before any view mounts.
export function initShell() {
  wireSidebarChrome();
  wireAccountMenu();
}
