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
    menu.hidden = !menu.hidden;
  });

  document.addEventListener('click', () => { menu.hidden = true; });

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
