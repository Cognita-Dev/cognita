// js/admin.js
// Admin console for Learna courses, task reviews and people (roles). If a
// signed-in user isn't an admin or moderator, every request here comes
// back 401/403 from the server (requireAdmin); the server check is the
// only one that matters.
//
// The People (roles) section is additionally gated to only show for
// people whose role is 'admin'.

const WORKER_URL = 'https://api.cognita.com.ng';

let isSuperAdmin = false;
let currentUid = null;

(async function init() {
  const user = await window.Auth.requireAuthOrRedirect();
  if (!user) return;

  document.getElementById('accountEmail').textContent = user.email || 'Signed in';
  document.getElementById('accountAvatar').textContent = (user.email || 'A').charAt(0).toUpperCase();

  currentUid = user.uid;
  wireAccountMenu();
  loadAccountBadge();
  wireSectionNav();
  wireMobileNav();
  wireRolesPanel();

  const initial = (window.location.hash || '').slice(1);
  switchSection(initial && initial !== 'roles' && document.getElementById('section-' + initial) ? initial : 'courses');

  await tryLoadRolesPanel();
  if (initial === 'roles' && isSuperAdmin) switchSection('roles');
})();

/* ── Account menu (sign out, settings, back to chat) ── */

function wireAccountMenu() {
  const btn = document.getElementById('accountBtn');
  const menu = document.getElementById('accountMenu');

  const setOpen = (open) => {
    menu.classList.toggle('is-open', open);
    btn.setAttribute('aria-expanded', String(open));
  };
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(!menu.classList.contains('is-open'));
  });
  document.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu.classList.contains('is-open')) { setOpen(false); btn.focus(); }
  });

  document.getElementById('logOutBtn').addEventListener('click', async () => {
    await window.Auth.logOut();
    window.location.href = '/login.html';
  });
}

// Reads /api/account purely to show the role/plan badge and the
// "Unlimited AI access" pill next to the AI Chat nav item — this page's
// actual access is still gated entirely server-side (requireAdmin on
// every /api/admin/* call), this is cosmetic only.
async function loadAccountBadge() {
  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/account');
    if (!res.ok) return;
    const data = await res.json();

    const roleLabel = data.role === 'admin' ? 'Admin' : (data.role === 'moderator' ? 'Moderator' : 'Signed in');
    document.getElementById('accountRoleBadge').textContent = roleLabel;

    const isAdmin = data.role === 'admin' || (data.models && Array.isArray(data.models.chat) && data.models.chat.includes('v0'));
    const pill = document.getElementById('aiChatPill');
    if (pill) pill.hidden = !isAdmin;
  } catch (e) {
    console.error('[admin] Could not load account badge:', e.message);
  }
}

/* ── Section navigation ── */

function wireSectionNav() {
  document.querySelectorAll('.admin-nav-item[data-section]').forEach((btn) => {
    btn.addEventListener('click', () => switchSection(btn.dataset.section));
  });
}

const SECTION_META = {
  courses: { title: 'Courses', subtitle: 'Create, edit, publish and unpublish Learna courses without touching code.' },
  reviews: { title: 'Task reviews', subtitle: 'Watch recordings, read written work and approve or send tasks back.' },
  roles: { title: 'People', subtitle: 'Manage who can curate content as an admin or moderator.' },
};

function switchSection(section) {
  if (!document.getElementById('section-' + section)) section = 'courses';
  document.querySelectorAll('.admin-section').forEach((el) => el.classList.remove('is-active'));
  document.getElementById('section-' + section).classList.add('is-active');

  document.querySelectorAll('.admin-nav-item[data-section]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.section === section);
  });

  document.querySelectorAll('.admin-nav-item[data-section]').forEach((btn) => {
    if (btn.dataset.section === section) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
  // Remember the section across reloads / allow deep links (#courses).
  if (window.location.hash !== '#' + section) history.replaceState(null, '', '#' + section);
  const scroller = document.querySelector('.admin-scroll');
  if (scroller) scroller.scrollTop = 0;


  const meta = SECTION_META[section] || SECTION_META.courses;
  document.getElementById('sectionTitle').textContent = meta.title;
  document.getElementById('sectionSubtitle').textContent = meta.subtitle;

  document.dispatchEvent(new CustomEvent('admin:section', { detail: section }));
  closeMobileNav();
}

function wireMobileNav() {
  const sidebar = document.getElementById('adminSidebar');
  const scrim = document.getElementById('adminNavScrim');

  document.getElementById('adminNavOpen').addEventListener('click', () => {
    sidebar.classList.add('is-open');
    scrim.classList.add('is-visible');
  });
  document.getElementById('adminNavClose').addEventListener('click', closeMobileNav);
  scrim.addEventListener('click', closeMobileNav);
}

function closeMobileNav() {
  document.getElementById('adminSidebar').classList.remove('is-open');
  document.getElementById('adminNavScrim').classList.remove('is-visible');
}


/* ── Roles ──────────────────────────────────────────────────────────── */

async function tryLoadRolesPanel() {
  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/admin/roles');

    if (res.status === 403) {
      document.getElementById('rolesNavItem').hidden = true;
      document.getElementById('peopleNavLabel').hidden = true;
      return;
    }

    if (!res.ok) return;

    isSuperAdmin = true;
    document.getElementById('rolesNavItem').hidden = false;
    document.getElementById('peopleNavLabel').hidden = false;
    const data = await res.json();
    renderRolesList(data.people || []);
  } catch (e) {
    console.error('[admin] roles panel load failed:', e.message);
  }
}

function renderRolesList(people) {
  const list = document.getElementById('rolesList');

  if (people.length === 0) {
    list.innerHTML = '<div class="admin-empty">No admins or moderators yet.</div>';
    return;
  }

  list.innerHTML = people.map((p) =>
    '<div class="admin-person-row">' +
    '<span class="admin-person-avatar">' + escapeHtml((p.uid || '?').charAt(0).toUpperCase()) + '</span>' +
    '<div class="admin-person-info">' +
    '<div class="admin-person-uid" title="' + escapeHtml(p.uid) + '">' + escapeHtml(p.uid) + (p.uid === currentUid ? '<span class="admin-person-you">(you)</span>' : '') + '</div>' +
    '</div>' +
    '<span class="admin-role-badge admin-role-badge--' + p.role + '">' + escapeHtml(p.role) + '</span>' +
    '<button data-uid="' + escapeHtml(p.uid) + '" class="admin-btn admin-btn--danger revoke-role-btn">Revoke</button>' +
    '</div>'
  ).join('');

  list.querySelectorAll('.revoke-role-btn').forEach((btn) => {
    btn.addEventListener('click', () => revokeRole(btn.dataset.uid));
  });
}

async function revokeRole(uid) {
  const isSelf = uid === currentUid;
  const ok = await confirmDialog({
    title: isSelf ? 'Revoke your own role?' : 'Revoke this role?',
    body: isSelf
      ? 'You\u2019ll lose access to this admin panel as soon as it\u2019s revoked.'
      : 'This person will immediately lose access to manage content.',
    confirmLabel: 'Revoke role',
  });
  if (!ok) return;

  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/admin/roles/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uid }),
    });
    const data = await res.json();

    if (!res.ok) {
      showToast(data.error || 'Could not revoke.');
      return;
    }

    showToast('Revoked.');
    await tryLoadRolesPanel();
  } catch (e) {
    showToast('Could not reach the server.');
    console.error('[admin] revoke failed:', e.message);
  }
}

function wireRolesPanel() {
  document.querySelectorAll('input[name="grantLookupMode"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      const byUid = document.querySelector('input[name="grantLookupMode"]:checked').value === 'uid';
      document.getElementById('grantEmailWrap').hidden = byUid;
      document.getElementById('grantUidWrap').hidden = !byUid;
      document.querySelectorAll('#grantLookupSegmented .admin-segmented-option').forEach((opt) => {
        opt.classList.toggle('is-active', opt.querySelector('input').checked);
      });
    });
  });

  ['grantEmailInput', 'grantUidInput'].forEach((id) => {
    document.getElementById(id).addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); document.getElementById('grantRoleBtn').click(); }
    });
  });

  document.getElementById('grantRoleBtn').addEventListener('click', async () => {
    const grantBtn = document.getElementById('grantRoleBtn');
    if (grantBtn.disabled) return;
    grantBtn.disabled = true;
    try { await grantRole(); } finally { grantBtn.disabled = false; }
  });

  async function grantRole() {
    const lookupMode = document.querySelector('input[name="grantLookupMode"]:checked').value;
    const role = document.getElementById('grantRoleSelect').value;
    const resultLine = document.getElementById('grantResultLine');

    let uid = null;

    if (lookupMode === 'uid') {
      uid = document.getElementById('grantUidInput').value.trim();
      if (!uid) {
        resultLine.textContent = 'Enter a uid.';
        resultLine.style.color = 'var(--danger)';
        return;
      }
    } else {
      const email = document.getElementById('grantEmailInput').value.trim();
      if (!email) {
        resultLine.textContent = 'Enter an email.';
        resultLine.style.color = 'var(--danger)';
        return;
      }

      resultLine.textContent = 'Looking up ' + email + '...';
      resultLine.style.color = '';

      try {
        const lookupRes = await window.Auth.authedFetch(WORKER_URL + '/api/admin/roles/lookup-email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email }),
        });
        const lookupData = await lookupRes.json();

        if (!lookupRes.ok) {
          resultLine.textContent = lookupData.error || 'Could not find that user.';
          resultLine.style.color = 'var(--danger)';
          return;
        }

        uid = lookupData.uid;
      } catch (e) {
        resultLine.textContent = 'Could not reach the server for lookup.';
        resultLine.style.color = 'var(--danger)';
        console.error('[admin] email lookup failed:', e.message);
        return;
      }
    }

    try {
      const res = await window.Auth.authedFetch(WORKER_URL + '/api/admin/roles/grant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid, role }),
      });
      const data = await res.json();

      if (!res.ok) {
        resultLine.textContent = data.error || 'Could not grant role.';
        resultLine.style.color = 'var(--danger)';
        return;
      }

      resultLine.textContent = 'Granted ' + role + ' to ' + uid + '.';
      resultLine.style.color = 'var(--success)';
      document.getElementById('grantEmailInput').value = '';
      document.getElementById('grantUidInput').value = '';
      await tryLoadRolesPanel();
    } catch (e) {
      resultLine.textContent = 'Could not reach the server.';
      resultLine.style.color = 'var(--danger)';
      console.error('[admin] grant failed:', e.message);
    }
  }
}

/* ── Helpers ── */

// In-app replacement for window.confirm(): resolves true/false. Focus goes
// to Cancel by default (the safe choice), Escape cancels, and focus returns
// to whatever opened it.
function confirmDialog({ title, body, confirmLabel = 'Confirm', danger = true }) {
  return new Promise((resolve) => {
    const scrim = document.getElementById('confirmScrim');
    const okBtn = document.getElementById('confirmOkBtn');
    const cancelBtn = document.getElementById('confirmCancelBtn');
    const opener = document.activeElement;

    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmBody').textContent = body;
    okBtn.textContent = confirmLabel;
    okBtn.className = 'admin-btn ' + (danger ? 'admin-btn--danger-solid' : 'admin-btn--primary');
    scrim.hidden = false;
    cancelBtn.focus();

    function finish(result) {
      scrim.hidden = true;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      scrim.removeEventListener('click', onScrim);
      document.removeEventListener('keydown', onKey, true);
      if (opener && opener.focus) opener.focus();
      resolve(result);
    }
    const onOk = () => finish(true);
    const onCancel = () => finish(false);
    const onScrim = (e) => { if (e.target === scrim) finish(false); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
      // keep Tab inside the two buttons
      if (e.key === 'Tab') {
        e.preventDefault();
        (document.activeElement === okBtn ? cancelBtn : okBtn).focus();
      }
    };
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    scrim.addEventListener('click', onScrim);
    document.addEventListener('keydown', onKey, true);
  });
}

function setBtnLoading(btn, isLoading) {
  btn.disabled = isLoading;
  const label = btn.querySelector('.btn-label');
  const spinner = btn.querySelector('.btn-spinner');
  if (label) label.hidden = isLoading;
  if (spinner) spinner.hidden = !isLoading;
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showToast(message) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}