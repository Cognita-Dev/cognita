// js/admin.js
// Admin curation UI. Talks to the same Worker as resources.js. If a
// signed-in user isn't an admin or moderator, every request here comes
// back 401/403 from the server (requireAdmin) — this page has no
// client-side gate of its own beyond that, since the server check is the
// only one that actually matters.
//
// The People (roles) section is additionally gated to only show for
// people whose role is 'admin' — moderators can use everything else on
// this page but the server will reject role-management calls from them,
// so the nav item + section are hidden for them rather than
// shown-then-erroring.

const WORKER_URL = 'https://cognita.cognitai.workers.dev';

const RESOURCE_TYPES = [
  'lesson_plan', 'lesson_note', 'worksheet', 'exam', 'scheme_of_work', 'quiz', 'study_guide',
  'teaching_guide', 'classroom_activity', 'assignment', 'marking_scheme',
  'rubric', 'flashcards', 'student_handout', 'presentation', 'project', 'test',
];

const STATUSES = ['draft', 'in_review', 'validated', 'published', 'archived'];

const STATUS_LABELS = {
  draft: 'Draft',
  in_review: 'In review',
  validated: 'Validated',
  published: 'Published',
  archived: 'Archived',
};

// The single obvious "next step" action per status, shown as the primary
// button in the detail panel. Anything else available from that status
// stays in the secondary row.
const PRIMARY_ACTION_BY_STATUS = {
  draft: { action: 'submit_review', label: 'Submit for review' },
  in_review: { action: 'validate', label: 'Validate' },
  validated: { action: 'publish', label: 'Publish' },
  published: { action: 'archive', label: 'Archive' },
  archived: { action: 'restore', label: 'Restore to draft' },
};

// Skeleton JSON per resource type, matching each recipe's required
// structure (recipes/*.js on the backend). Placeholder values are meant
// to be overwritten — they exist so an admin writing content by hand
// doesn't have to guess field names or the exact shape. Types not listed
// here fall back to a generic { title, sections } skeleton, which the
// generic docx/pdf exporter in admin-resources-endpoint.js can still
// render even if it doesn't exactly match that type's AI-mode recipe
// structure — flag it to the dev if a specific type needs its own exact
// template added here.
const RESOURCE_TEMPLATES = {
  lesson_plan: {
    title: '',
    duration: '',
    lessonStyle: '',
    learningObjectives: [''],
    previousKnowledge: '',
    materials: [''],
    introduction: '',
    teacherActivities: [''],
    studentActivities: [''],
    assessment: [''],
    conclusion: '',
    homework: '',
    teacherNotes: '',
  },
  lesson_note: {
    title: '',
    introduction: '',
    sections: [
      { heading: '', type: 'paragraph', content: '' },
      { heading: '', type: 'bullets', content: [''] },
      { heading: '', type: 'definition', content: [{ term: '', explanation: '' }] },
    ],
    summary: '',
  },
  flashcards: {
    title: '',
    cards: [
      { number: 1, front: '', back: '', difficulty: 'medium' },
    ],
  },
  presentation: {
    title: '',
    slides: [
      { heading: '', bulletPoints: [''] },
    ],
  },
};

const GENERIC_TEMPLATE = {
  title: '',
  sections: [
    { heading: '', type: 'paragraph', content: '' },
    { heading: '', type: 'bullets', content: [''] },
  ],
};

let currentStatusFilter = 'draft';
let currentResources = [];       // resources for the active status filter, unfiltered by search/type
let currentDetailResource = null;
let isSuperAdmin = false;
let activeDetailEditorHandle = null;

(async function init() {
  const user = await window.Auth.requireAuthOrRedirect();
  if (!user) return;

  document.getElementById('accountEmail').textContent = user.email || 'Signed in';
  document.getElementById('accountAvatar').textContent = (user.email || 'A').charAt(0).toUpperCase();

  wireAccountMenu();
  loadAccountBadge();

  populateResourceTypeSelect();
  populateResourceTypeFilter();
  renderStatusTabs();
  wireSectionNav();
  wireMobileNav();
  wireCreateForm();
  wireDetailPanel();
  wireCollections();
  wireRolesPanel();
  wireResourceToolbar();

  await loadResourceList();
  await loadCollections();
  await tryLoadRolesPanel();
  await loadOverview();
})();

/* ── Account menu (sign out, settings, back to chat) ── */

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
    const unlimitedBadge = document.getElementById('unlimitedBadge');
    if (unlimitedBadge) unlimitedBadge.hidden = !isAdmin;
  } catch (e) {
    console.error('[admin] Could not load account badge:', e.message);
  }
}

/* ── Section navigation ── */

function wireSectionNav() {
  document.querySelectorAll('.admin-nav-item[data-section]').forEach((btn) => {
    btn.addEventListener('click', () => switchSection(btn.dataset.section));
  });

  document.getElementById('topbarNewResourceBtn').addEventListener('click', () => switchSection('create'));

  document.querySelectorAll('.admin-stat-card[data-status]').forEach((card) => {
    card.addEventListener('click', () => {
      switchSection('resources');
      currentStatusFilter = card.dataset.status;
      syncStatusTabsUI();
      loadResourceList();
    });
  });
}

const SECTION_META = {
  overview: { title: 'Overview', subtitle: "A quick look at your content pipeline." },
  resources: { title: 'Resources', subtitle: 'Browse, filter and manage every learning resource.' },
  create: { title: 'Create', subtitle: 'Generate a new resource with AI, or write one by hand.' },
  collections: { title: 'Collections', subtitle: 'Group published resources for learners to browse.' },
  roles: { title: 'People', subtitle: 'Manage who can curate content as an admin or moderator.' },
};

function switchSection(section) {
  document.querySelectorAll('.admin-section').forEach((el) => el.classList.remove('is-active'));
  document.getElementById('section-' + section).classList.add('is-active');

  document.querySelectorAll('.admin-nav-item[data-section]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.section === section);
  });

  const meta = SECTION_META[section] || SECTION_META.overview;
  document.getElementById('sectionTitle').textContent = meta.title;
  document.getElementById('sectionSubtitle').textContent = meta.subtitle;
  document.getElementById('topbarActions').hidden = section === 'create';

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

/* ── Overview ── */

async function loadOverview() {
  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/admin/resources');
    if (!res.ok) return;
    const data = await res.json();
    const all = data.resources || [];

    const counts = {};
    STATUSES.forEach((s) => { counts[s] = 0; });
    all.forEach((r) => { if (counts[r.status] !== undefined) counts[r.status]++; });

    const grid = document.getElementById('overviewStatGrid');
    grid.innerHTML = STATUSES.map((s) =>
      '<div class="admin-stat-card" data-status="' + s + '">' +
      '<div class="admin-stat-card-label">' + escapeHtml(STATUS_LABELS[s]) + '</div>' +
      '<div class="admin-stat-card-value">' + counts[s] + '</div>' +
      '</div>'
    ).join('');
    grid.querySelectorAll('.admin-stat-card[data-status]').forEach((card) => {
      card.addEventListener('click', () => {
        switchSection('resources');
        currentStatusFilter = card.dataset.status;
        syncStatusTabsUI();
        loadResourceList();
      });
    });

    const inReview = all.filter((r) => r.status === 'in_review').slice(0, 6);
    document.getElementById('overviewReviewList').innerHTML = inReview.length === 0
      ? '<div class="admin-empty">Nothing waiting on review right now.</div>'
      : inReview.map(renderOverviewRow).join('');
    document.getElementById('overviewReviewList').querySelectorAll('[data-open-id]').forEach((row) => {
      row.addEventListener('click', () => openDetail(row.dataset.openId));
    });

    const recent = [...all].sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || '')).slice(0, 6);
    document.getElementById('overviewRecentList').innerHTML = recent.length === 0
      ? '<div class="admin-empty">No resources yet.</div>'
      : recent.map(renderOverviewRow).join('');
    document.getElementById('overviewRecentList').querySelectorAll('[data-open-id]').forEach((row) => {
      row.addEventListener('click', () => openDetail(row.dataset.openId));
    });
  } catch (e) {
    console.error('[admin] overview load failed:', e.message);
  }
}

function renderOverviewRow(r) {
  return '<button class="admin-row" data-open-id="' + r.id + '">' +
    '<span class="admin-row-icon"><i class="ph ph-file-text"></i></span>' +
    '<div class="admin-row-info">' +
    '<div class="admin-row-title">' + escapeHtml(r.structuredContent?.title || r.id) + '</div>' +
    '<div class="admin-row-meta">' + escapeHtml(r.resourceType) + '<span class="dot"></span>' + relativeTime(r.updatedAt) + '</div>' +
    '</div>' +
    '<span class="admin-badge admin-badge--' + r.status + '">' + escapeHtml(STATUS_LABELS[r.status] || r.status) + '</span>' +
    '</button>';
}

/* ── Resource type selects ── */

function populateResourceTypeSelect() {
  const select = document.getElementById('fieldResourceType');
  select.innerHTML = RESOURCE_TYPES.map((t) => '<option value="' + t + '">' + t + '</option>').join('');
}

function populateResourceTypeFilter() {
  const select = document.getElementById('resourceTypeFilter');
  select.insertAdjacentHTML('beforeend', RESOURCE_TYPES.map((t) => '<option value="' + t + '">' + t + '</option>').join(''));
}

/* ── Status tabs ── */

function renderStatusTabs() {
  const wrap = document.getElementById('statusTabs');
  wrap.innerHTML = STATUSES.map((s) =>
    '<button type="button" class="admin-status-tab' + (s === currentStatusFilter ? ' is-active' : '') + '" data-status="' + s + '">' +
    '<span>' + escapeHtml(STATUS_LABELS[s]) + '</span>' +
    '</button>'
  ).join('');

  wrap.querySelectorAll('[data-status]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      currentStatusFilter = btn.dataset.status;
      syncStatusTabsUI();
      await loadResourceList();
    });
  });
}

function syncStatusTabsUI() {
  document.querySelectorAll('.admin-status-tab').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.status === currentStatusFilter);
  });
  document.getElementById('resourceListHeading').textContent = STATUS_LABELS[currentStatusFilter] || currentStatusFilter;
}

/* ── Toolbar: search + type filter (client-side over the loaded status page) ── */

function wireResourceToolbar() {
  document.getElementById('resourceSearchInput').addEventListener('input', renderResourceRows);
  document.getElementById('resourceTypeFilter').addEventListener('change', renderResourceRows);
}

/* ── Create ── */

function wireCreateForm() {
  document.querySelectorAll('input[name="createMode"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      const isBatch = document.querySelector('input[name="createMode"]:checked').value === 'batch';
      document.getElementById('singleCreateForm').hidden = isBatch;
      document.getElementById('batchCreateForm').hidden = !isBatch;
      document.querySelectorAll('#createModeSegmented .admin-segmented-option').forEach((opt) => {
        opt.classList.toggle('is-active', opt.querySelector('input').checked);
      });
    });
  });

  document.querySelectorAll('#creationModeToggle .admin-mode-card').forEach((card) => {
    card.addEventListener('click', () => {
      const mode = card.dataset.mode;
      document.getElementById('fieldCreationMode').value = mode;
      document.querySelectorAll('#creationModeToggle .admin-mode-card').forEach((c) => c.classList.toggle('is-active', c === card));
      const isManual = mode === 'manual';
      document.getElementById('aiFieldsWrap').hidden = isManual;
      document.getElementById('manualContentWrap').hidden = !isManual;
    });
  });

  document.getElementById('loadTemplateBtn').addEventListener('click', () => {
    const resourceType = document.getElementById('fieldResourceType').value;
    const template = RESOURCE_TEMPLATES[resourceType] || GENERIC_TEMPLATE;
    document.getElementById('fieldManualContent').value = JSON.stringify(template, null, 2);

    if (!RESOURCE_TEMPLATES[resourceType]) {
      showToast('No exact template for "' + resourceType + '" yet — loaded a generic structure instead.');
    }
  });

  document.getElementById('createSingleBtn').addEventListener('click', async () => {
    const resourceType = document.getElementById('fieldResourceType').value;
    const mode = document.getElementById('fieldCreationMode').value;

    const body = { resourceType, mode, clientRequestId: 'ui-' + Date.now() + '-' + Math.random().toString(36).slice(2) };

    if (mode === 'ai') {
      body.fields = {
        subject: document.getElementById('fieldSubject').value.trim(),
        classLevel: document.getElementById('fieldClassLevel').value.trim(),
        topic: document.getElementById('fieldTopic').value.trim(),
      };
    } else {
      try {
        body.manualContent = JSON.parse(document.getElementById('fieldManualContent').value);
      } catch (e) {
        showToast('Manual content is not valid JSON.');
        return;
      }
    }

    const btn = document.getElementById('createSingleBtn');
    setBtnLoading(btn, true);

    try {
      const res = await window.Auth.authedFetch(WORKER_URL + '/api/admin/resources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      setBtnLoading(btn, false);

      if (!res.ok) {
        showToast(data.error || 'Could not create resource.');
        return;
      }

      showToast('Draft created.');
      currentStatusFilter = 'draft';
      syncStatusTabsUI();
      await loadResourceList();
      await loadOverview();
      switchSection('resources');
    } catch (e) {
      setBtnLoading(btn, false);
      showToast('Could not reach the server.');
      console.error('[admin] create failed:', e.message);
    }
  });

  document.getElementById('createBatchBtn').addEventListener('click', async () => {
    let items;
    try {
      items = JSON.parse(document.getElementById('fieldBatchItems').value);
    } catch (e) {
      showToast('Batch items must be valid JSON.');
      return;
    }

    if (!Array.isArray(items)) {
      showToast('Batch items must be a JSON array.');
      return;
    }

    const btn = document.getElementById('createBatchBtn');
    setBtnLoading(btn, true);

    try {
      const res = await window.Auth.authedFetch(WORKER_URL + '/api/admin/resources/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
      });
      const data = await res.json();
      setBtnLoading(btn, false);

      if (!res.ok) {
        showToast(data.error || 'Batch failed.');
        return;
      }

      renderBatchResults(data.results);
      await loadResourceList();
      await loadOverview();
    } catch (e) {
      setBtnLoading(btn, false);
      showToast('Could not reach the server.');
      console.error('[admin] batch create failed:', e.message);
    }
  });
}

function renderBatchResults(results) {
  const wrap = document.getElementById('batchResults');
  wrap.innerHTML = results.map((r) => {
    if (r.ok) {
      return '<div style="color:var(--success);">#' + r.index + ' ok — ' +
        escapeHtml(r.resource?.structuredContent?.title || r.resource?.id || '') +
        (r.wasExisting ? ' (already existed — idempotent replay)' : '') + '</div>';
    }
    return '<div style="color:var(--danger);">#' + r.index + ' failed — ' + escapeHtml(r.error) + '</div>';
  }).join('');
}

/* ── List ── */

async function loadResourceList() {
  const list = document.getElementById('adminResourceList');

  try {
    const res = await window.Auth.authedFetch(
      WORKER_URL + '/api/admin/resources?status=' + encodeURIComponent(currentStatusFilter)
    );
    if (!res.ok) return;

    const data = await res.json();
    currentResources = data.resources || [];
    syncStatusTabsUI();
    renderResourceRows();
  } catch (e) {
    console.error('[admin] list load failed:', e.message);
    list.innerHTML = '<div class="admin-empty">Could not load resources. Please try again.</div>';
  }
}

function renderResourceRows() {
  const list = document.getElementById('adminResourceList');
  const query = (document.getElementById('resourceSearchInput').value || '').trim().toLowerCase();
  const typeFilter = document.getElementById('resourceTypeFilter').value;

  const filtered = currentResources.filter((r) => {
    if (typeFilter && r.resourceType !== typeFilter) return false;
    if (!query) return true;
    const title = (r.structuredContent?.title || r.id || '').toLowerCase();
    return title.includes(query);
  });

  document.getElementById('resourceListCount').textContent = filtered.length;

  if (filtered.length === 0) {
    list.innerHTML = '<div class="admin-empty">' +
      (currentResources.length === 0 ? 'No resources in this status.' : 'No resources match your search.') +
      '</div>';
    return;
  }

  list.innerHTML = filtered.map((r) =>
    '<button class="admin-row" data-id="' + r.id + '">' +
    '<span class="admin-row-icon"><i class="ph ph-file-text"></i></span>' +
    '<div class="admin-row-info">' +
    '<div class="admin-row-title">' + escapeHtml(r.structuredContent?.title || r.id) + '</div>' +
    '<div class="admin-row-meta">' +
    escapeHtml(r.resourceType) + '<span class="dot"></span>' +
    (r.createdMode === 'ai' ? 'Generated with AI' : 'Written by hand') + '<span class="dot"></span>' +
    'Updated ' + relativeTime(r.updatedAt) +
    '</div>' +
    '</div>' +
    '<span class="admin-badge admin-badge--' + r.status + '">' + escapeHtml(STATUS_LABELS[r.status] || r.status) + '</span>' +
    '</button>'
  ).join('');

  list.querySelectorAll('.admin-row[data-id]').forEach((row) => {
    row.addEventListener('click', () => openDetail(row.dataset.id));
  });
}

/* ── Detail / edit / transitions ── */

async function openDetail(resourceId) {
  let data;
  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/admin/resources/' + resourceId);
    if (!res.ok) {
      showToast('Could not load resource.');
      return;
    }
    data = await res.json();
  } catch (e) {
    showToast('Could not reach the server.');
    console.error('[admin] detail load failed:', e.message);
    return;
  }

  currentDetailResource = data.resource;
  document.getElementById('detailScrim').hidden = false;
  document.getElementById('detailPanel').hidden = false;

  // Rendering/mounting the editor is a separate step from the network
  // call above. If it throws (e.g. content shaped in a way the editor
  // doesn't expect), that must never look identical to a dead network
  // request — it needs its own toast, and the Edit/Preview toggle must
  // stay usable instead of being left pointed at a half-built editor.
  try {
    renderDetailChrome();
  } catch (e) {
    showToast('Could not load the editor for this resource: ' + e.message);
    console.error('[admin] renderDetailChrome failed:', e);
  }

  try {
    await loadVersionHistory(resourceId);
  } catch (e) {
    console.error('[admin] version history load failed:', e.message);
  }
}

function renderDetailChrome() {
  const r = currentDetailResource;
  document.getElementById('detailTitle').textContent = r.structuredContent?.title || r.id;
  document.getElementById('detailTypeBadge').textContent = r.resourceType;
  const statusBadge = document.getElementById('detailStatusBadge');
  statusBadge.textContent = STATUS_LABELS[r.status] || r.status;
  statusBadge.className = 'admin-badge admin-badge--' + r.status;

  const saveBtn = document.getElementById('saveEditBtn');
  saveBtn.disabled = true;
  if (activeDetailEditorHandle) {
    activeDetailEditorHandle.destroy();
    activeDetailEditorHandle = null;
  }

  // If mount() throws on this particular resource's content shape, fall
  // back to a plain JSON textarea rather than leaving
  // activeDetailEditorHandle null — a null handle is what made Preview
  // silently show "Nothing to preview yet" with no indication anything
  // had gone wrong.
  try {
    activeDetailEditorHandle = window.ResourceEditor.mount(
      document.getElementById('detailContentEditor'),
      r.resourceType,
      r.structuredContent,
      {
        onDirty: () => {
          saveBtn.disabled = false;
          if (!document.getElementById('detailContentPreview').hidden) renderDetailPreview();
        },
      }
    );
  } catch (e) {
    console.error('[admin] editor mount failed, falling back to raw JSON:', e);
    activeDetailEditorHandle = mountFallbackJsonEditor(
      document.getElementById('detailContentEditor'),
      r.structuredContent,
      saveBtn
    );
    showToast('This resource\u2019s content could not be loaded into the normal editor, so raw JSON is shown instead.');
  }
  setDetailView('edit');

  const primary = PRIMARY_ACTION_BY_STATUS[r.status];
  const primaryBtn = document.getElementById('detailPrimaryActionBtn');
  if (primary) {
    primaryBtn.hidden = false;
    primaryBtn.textContent = primary.label;
    primaryBtn.dataset.action = primary.action;
  } else {
    primaryBtn.hidden = true;
  }

  // Secondary row shows every other transition still legal from this
  // status, so nothing is hidden — it just isn't the visually dominant
  // action.
  const secondaryMap = {
    requestChangesBtn: 'request_changes',
    validateBtn: 'validate',
    archiveBtn: 'archive',
    restoreBtn: 'restore',
  };
  Object.entries(secondaryMap).forEach(([btnId, action]) => {
    const btn = document.getElementById(btnId);
    const isPrimary = primary && primary.action === action;
    const legalFrom = ACTION_LEGAL_FROM[action] || [];
    btn.hidden = isPrimary || !legalFrom.includes(r.status);
  });
}

// Minimal handle-shaped fallback used only when ResourceEditor.mount()
// throws. Keeps the Edit/Preview toggle and Save button functional
// instead of leaving activeDetailEditorHandle null.
function mountFallbackJsonEditor(container, structuredContent, saveBtn) {
  container.innerHTML = '';
  const textarea = document.createElement('textarea');
  textarea.className = 'admin-code-textarea';
  textarea.style.minHeight = '320px';
  textarea.value = JSON.stringify(structuredContent, null, 2);
  textarea.addEventListener('input', () => { saveBtn.disabled = false; });
  container.appendChild(textarea);

  return {
    getValue() {
      try {
        return JSON.parse(textarea.value);
      } catch (e) {
        showToast('That JSON is not valid, so it was not applied.');
        return structuredContent;
      }
    },
    isDirty() {
      return textarea.value !== JSON.stringify(structuredContent, null, 2);
    },
    scrollToQuestion() {},
    destroy() {
      container.innerHTML = '';
    },
  };
}

// Shows the content exactly the way a real user would see it (same
// renderer resources.js/library.js use), built from whatever is
// currently in the editor — including unsaved edits — so an admin can
// check their change looks right before saving, not just after.
function renderDetailPreview() {
  const previewEl = document.getElementById('detailContentPreview');
  if (!currentDetailResource || !activeDetailEditorHandle) {
    previewEl.innerHTML = '<p class="admin-hint">Nothing to preview yet.</p>';
    return;
  }

  const content = activeDetailEditorHandle.getValue();
  const resourceType = currentDetailResource.resourceType;

  let html = '';
  if (window.ResourceRenderers && typeof window.ResourceRenderers.render === 'function') {
    html = window.ResourceRenderers.render(resourceType, content) || '';
  }

  if (!html) {
    html = '<p class="admin-hint">No preview is available for this resource type yet — it will still export normally.</p>';
  }

  previewEl.innerHTML = html;

  if (window.ResourceRenderers && typeof window.ResourceRenderers.mount === 'function') {
    window.ResourceRenderers.mount(resourceType, previewEl, content);
  }
}

function setDetailView(view) {
  const editEl = document.getElementById('detailContentEditor');
  const previewEl = document.getElementById('detailContentPreview');
  const editBtn = document.getElementById('detailViewEditBtn');
  const previewBtn = document.getElementById('detailViewPreviewBtn');

  const showPreview = view === 'preview';
  editEl.hidden = showPreview;
  previewEl.hidden = !showPreview;
  editBtn.classList.toggle('is-active', !showPreview);
  previewBtn.classList.toggle('is-active', showPreview);

  if (showPreview) renderDetailPreview();
}

// Mirrors ACTION_MAP.from on the backend, so the UI only ever offers an
// action the server will actually accept.
const ACTION_LEGAL_FROM = {
  submit_review: ['draft'],
  request_changes: ['in_review', 'validated'],
  validate: ['in_review'],
  publish: ['validated'],
  archive: ['published'],
  restore: ['archived'],
};

async function loadVersionHistory(resourceId) {
  const wrap = document.getElementById('versionHistory');
  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/admin/resources/' + resourceId + '/versions');
    if (!res.ok) return;
    const data = await res.json();
    const versions = data.versions || [];

    wrap.innerHTML = versions.length === 0
      ? '<p class="admin-hint">No previous versions yet.</p>'
      : versions.slice().reverse().map((v) =>
          '<div class="admin-timeline-item">' +
          '<div class="admin-timeline-version">Version ' + v.version + '</div>' +
          '<div class="admin-timeline-reason">' + escapeHtml(formatSnapshotReason(v.snapshotReason)) + '</div>' +
          '<div class="admin-timeline-date">' + new Date(v.createdAt).toLocaleString() + '</div>' +
          '</div>'
        ).join('');
  } catch (e) {
    console.error('[admin] version history load failed:', e.message);
  }
}

function formatSnapshotReason(reason) {
  if (!reason) return '';
  return String(reason).replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function wireDetailPanel() {
  const close = () => {
    if (activeDetailEditorHandle && activeDetailEditorHandle.isDirty()) {
      if (!window.confirm('You have unsaved changes. Discard them?')) return;
    }
    document.getElementById('detailPanel').hidden = true;
    document.getElementById('detailScrim').hidden = true;
    currentDetailResource = null;
    if (activeDetailEditorHandle) {
      activeDetailEditorHandle.destroy();
      activeDetailEditorHandle = null;
    }
  };
  document.getElementById('detailClose').addEventListener('click', close);
  document.getElementById('detailScrim').addEventListener('click', close);

  document.getElementById('detailViewEditBtn').addEventListener('click', () => setDetailView('edit'));
  document.getElementById('detailViewPreviewBtn').addEventListener('click', () => setDetailView('preview'));

  document.getElementById('detailPrimaryActionBtn').addEventListener('click', (e) => {
    const action = e.currentTarget.dataset.action;
    if (action) runTransition(action);
  });

  document.getElementById('saveEditBtn').addEventListener('click', async () => {
    await saveCurrentEdit();
  });

  const transitionButtons = {
    submitReviewBtn: 'submit_review',
    requestChangesBtn: 'request_changes',
    validateBtn: 'validate',
    publishBtn: 'publish',
    archiveBtn: 'archive',
    restoreBtn: 'restore',
  };

  Object.entries(transitionButtons).forEach(([btnId, action]) => {
    document.getElementById(btnId).addEventListener('click', () => runTransition(action));
  });

  document.getElementById('deleteBtn').addEventListener('click', async () => {
    if (!currentDetailResource) return;
    if (!confirm('Delete this resource? This cannot be undone.')) return;

    try {
      const res = await window.Auth.authedFetch(
        WORKER_URL + '/api/admin/resources/' + currentDetailResource.id,
        { method: 'DELETE' }
      );
      const data = await res.json();

      if (!res.ok) {
        showToast(data.error || 'Could not delete.');
        return;
      }

      showToast('Deleted.');
      document.getElementById('detailPanel').hidden = true;
      document.getElementById('detailScrim').hidden = true;
      currentDetailResource = null;
      await loadResourceList();
      await loadOverview();
    } catch (e) {
      showToast('Could not reach the server.');
      console.error('[admin] delete failed:', e.message);
    }
  });
}

// Saves whatever is currently in the editor. Returns true on success,
// false on failure (a toast is already shown either way, so callers
// just need to know whether it's safe to proceed).
async function saveCurrentEdit() {
  if (!currentDetailResource || !activeDetailEditorHandle) return true;

  const structuredContent = activeDetailEditorHandle.getValue();

  try {
    const res = await window.Auth.authedFetch(
      WORKER_URL + '/api/admin/resources/' + currentDetailResource.id,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ structuredContent }),
      }
    );
    const data = await res.json();

    if (!res.ok) {
      showToast(data.error || 'Could not save edit.');
      return false;
    }

    showToast('Saved.' + (data.resource.status === 'draft' ? ' Sent back to draft for re-review.' : ''));
    currentDetailResource = data.resource;
    renderDetailChrome();
    await loadResourceList();
    await loadVersionHistory(currentDetailResource.id);
    return true;
  } catch (e) {
    showToast('Could not reach the server.');
    console.error('[admin] edit failed:', e.message);
    return false;
  }
}

// A validation error names the affected question as "question N" or
// "Question N" — pulling that number out lets the failure jump straight
// to the offending card instead of leaving the admin to hunt for it.
function _extractQuestionNumber(message) {
  const match = /question\s+(\d+)/i.exec(message || '');
  return match ? Number(match[1]) : null;
}

async function runTransition(action) {
  if (!currentDetailResource) return;

  // Validating (or any other transition) against whatever was last
  // saved is wrong if the admin just fixed something in the editor and
  // clicked the action directly — the server would re-check the old
  // content and report the exact same failure again, with nothing
  // telling the admin that their fix was never actually sent. Save
  // first so the transition always checks the content on screen.
  if (activeDetailEditorHandle && activeDetailEditorHandle.isDirty()) {
    const saved = await saveCurrentEdit();
    if (!saved) return;
  }

  try {
    const res = await window.Auth.authedFetch(
      WORKER_URL + '/api/admin/resources/' + currentDetailResource.id + '/transition',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      }
    );
    const data = await res.json();

    if (!res.ok) {
      showToast(data.error || 'Transition failed.');
      const questionNumber = _extractQuestionNumber(data.error);
      if (questionNumber && activeDetailEditorHandle && typeof activeDetailEditorHandle.scrollToQuestion === 'function') {
        activeDetailEditorHandle.scrollToQuestion(questionNumber);
      }
      return;
    }

    currentDetailResource = data.resource;
    renderDetailChrome();
    showToast('Now: ' + (STATUS_LABELS[currentDetailResource.status] || currentDetailResource.status));
    await loadResourceList();
    await loadVersionHistory(currentDetailResource.id);
    await loadOverview();
  } catch (e) {
    showToast('Could not reach the server.');
    console.error('[admin] transition failed:', e.message);
  }
}

/* ── Collections ── */

// Cache of published resources, used to populate the "add resource"
// pickers inside each collection card. Fetched lazily the first time
// any collection's manage panel is opened, then reused — a manage
// click never needs to re-fetch unless the admin asks it to refresh.
let _publishedResourcesCache = null;

// Which collection's manage panel (if any) is currently expanded, kept
// so a re-render from loadCollections() (e.g. after add/remove) can
// restore it open instead of collapsing everything back down.
let _openManageCollectionId = null;

function wireCollections() {
  document.getElementById('createCollectionBtn').addEventListener('click', async () => {
    const name = document.getElementById('newCollectionName').value.trim();
    if (!name) {
      showToast('Enter a collection name.');
      return;
    }

    try {
      const res = await window.Auth.authedFetch(WORKER_URL + '/api/admin/collections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json();

      if (!res.ok) {
        showToast(data.error || 'Could not create collection.');
        return;
      }

      document.getElementById('newCollectionName').value = '';
      showToast('Collection created.');
      await loadCollections();
    } catch (e) {
      showToast('Could not reach the server.');
      console.error('[admin] collection create failed:', e.message);
    }
  });
}

async function loadCollections() {
  const list = document.getElementById('collectionsList');

  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/admin/collections');
    if (!res.ok) return;
    const data = await res.json();
    const collections = data.collections || [];

    if (collections.length === 0) {
      list.innerHTML = '<div class="admin-empty">No collections yet. Create one above.</div>';
      return;
    }

    list.innerHTML = collections.map((c) => _renderCollectionCard(c)).join('');

    list.querySelectorAll('.toggle-vis-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const nextVis = btn.dataset.vis === 'published' ? 'draft' : 'published';
        try {
          const res = await window.Auth.authedFetch(
            WORKER_URL + '/api/admin/collections/' + btn.dataset.cid,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ visibility: nextVis }),
            }
          );
          const data = await res.json();
          if (!res.ok) {
            showToast(data.error || 'Could not update collection.');
            return;
          }
          await loadCollections();
        } catch (e) {
          showToast('Could not reach the server.');
          console.error('[admin] collection visibility toggle failed:', e.message);
        }
      });
    });

    list.querySelectorAll('.manage-resources-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const cid = btn.dataset.cid;
        _openManageCollectionId = _openManageCollectionId === cid ? null : cid;
        await loadCollections();
      });
    });

    // Only the currently-open card needs its manage panel wired up.
    if (_openManageCollectionId) {
      const openCollection = collections.find((c) => c.id === _openManageCollectionId);
      if (openCollection) await _wireCollectionManagePanel(openCollection);
    }
  } catch (e) {
    console.error('[admin] collections load failed:', e.message);
  }
}

function _renderCollectionCard(c) {
  const isOpen = _openManageCollectionId === c.id;
  return (
    '<div class="admin-collection-card" data-cid="' + c.id + '">' +
    '<div class="admin-collection-card-head">' +
    '<div>' +
    '<div class="admin-collection-card-title">' + escapeHtml(c.name) + '</div>' +
    '<div class="admin-collection-card-meta">' + (c.resourceIds || []).length + ' resource(s) &middot; ' +
    (c.visibility === 'published' ? 'Published' : 'Draft') + '</div>' +
    '</div>' +
    '<div class="admin-collection-card-actions">' +
    '<button data-cid="' + c.id + '" class="admin-btn admin-btn--ghost admin-btn--sm manage-resources-btn">' +
    '<i class="ph ph-stack"></i><span>' + (isOpen ? 'Close' : 'Manage resources') + '</span>' +
    '</button>' +
    '<button data-cid="' + c.id + '" data-vis="' + c.visibility + '" class="admin-btn admin-btn--ghost admin-btn--sm toggle-vis-btn">' +
    (c.visibility === 'published'
      ? '<i class="ph ph-eye-slash"></i><span>Unpublish</span>'
      : '<i class="ph ph-globe"></i><span>Publish</span>') +
    '</button>' +
    '</div>' +
    '</div>' +
    (isOpen ? '<div class="admin-collection-manage" id="manage-' + c.id + '">' +
      '<div class="admin-collection-resource-list">Loading…</div>' +
      '</div>' : '') +
    '</div>'
  );
}

// Populates and wires the manage panel for a single (already-open)
// collection card: the list of resources currently in it (each
// removable), plus a picker to add any published resource not
// already in it.
async function _wireCollectionManagePanel(collection) {
  const panel = document.getElementById('manage-' + collection.id);
  if (!panel) return;

  if (!_publishedResourcesCache) {
    try {
      const res = await window.Auth.authedFetch(WORKER_URL + '/api/admin/resources?status=published');
      const data = await res.json();
      if (!res.ok) {
        panel.innerHTML = '<div class="admin-collection-manage-empty">' +
          escapeHtml(data.error || 'Could not load published resources.') + '</div>';
        return;
      }
      _publishedResourcesCache = data.resources || [];
    } catch (e) {
      panel.innerHTML = '<div class="admin-collection-manage-empty">Could not reach the server.</div>';
      console.error('[admin] published resources load failed:', e.message);
      return;
    }
  }

  const currentIds = Array.isArray(collection.resourceIds) ? collection.resourceIds : [];
  const byId = new Map(_publishedResourcesCache.map((r) => [r.id, r]));
  const currentResources = currentIds.map((id) => byId.get(id)).filter(Boolean);
  const availableResources = _publishedResourcesCache.filter((r) => !currentIds.includes(r.id));

  const listHtml = currentResources.length
    ? '<div class="admin-collection-resource-list">' + currentResources.map((r) =>
        '<div class="admin-collection-resource-row">' +
        '<div class="admin-collection-resource-info">' +
        '<div class="admin-collection-resource-title">' + escapeHtml(r.structuredContent?.title || r.id) + '</div>' +
        '<div class="admin-collection-resource-type">' + escapeHtml(r.resourceType) + '</div>' +
        '</div>' +
        '<button class="admin-btn admin-btn--ghost admin-btn--sm remove-resource-btn" data-rid="' + r.id + '">' +
        '<i class="ph ph-x"></i><span>Remove</span>' +
        '</button>' +
        '</div>'
      ).join('') + '</div>'
    : '<div class="admin-collection-manage-empty">No resources in this collection yet.</div>';

  const addHtml = availableResources.length
    ? '<div class="admin-collection-add-row">' +
      '<select class="admin-select add-resource-select">' +
      availableResources.map((r) =>
        '<option value="' + r.id + '">' + escapeHtml(r.structuredContent?.title || r.id) +
        ' (' + escapeHtml(r.resourceType) + ')</option>'
      ).join('') +
      '</select>' +
      '<button class="admin-btn admin-btn--primary admin-btn--sm add-resource-btn">' +
      '<i class="ph ph-plus"></i><span>Add</span></button>' +
      '</div>'
    : '<div class="admin-collection-manage-empty">Every published resource is already in this collection.</div>';

  panel.innerHTML = listHtml + addHtml;

  panel.querySelectorAll('.remove-resource-btn').forEach((btn) => {
    btn.addEventListener('click', () => _editCollectionResource(collection.id, 'remove', btn.dataset.rid));
  });

  const addBtn = panel.querySelector('.add-resource-btn');
  const addSelect = panel.querySelector('.add-resource-select');
  if (addBtn && addSelect) {
    addBtn.addEventListener('click', () => _editCollectionResource(collection.id, 'add', addSelect.value));
  }
}

async function _editCollectionResource(collectionId, action, resourceId) {
  if (!resourceId) return;
  try {
    const res = await window.Auth.authedFetch(
      WORKER_URL + '/api/admin/collections/' + collectionId + '/resources',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, resourceId }),
      }
    );
    const data = await res.json();
    if (!res.ok) {
      showToast(data.error || 'Could not update collection.');
      return;
    }
    showToast(action === 'add' ? 'Resource added.' : 'Resource removed.');
    await loadCollections();
  } catch (e) {
    showToast('Could not reach the server.');
    console.error('[admin] collection resource edit failed:', e.message);
  }
}

/* ── Roles ──────────────────────────────────────────────────────────── */

async function tryLoadRolesPanel() {
  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/admin/roles');

    if (res.status === 403) {
      document.getElementById('rolesNavItem').hidden = true;
      return;
    }

    if (!res.ok) return;

    isSuperAdmin = true;
    document.getElementById('rolesNavItem').hidden = false;
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
    '<div class="admin-person-uid">' + escapeHtml(p.uid) + '</div>' +
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
  if (!confirm('Revoke this person\'s role?')) return;

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

  document.getElementById('grantRoleBtn').addEventListener('click', async () => {
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
  });
}

/* ── Helpers ── */

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

function relativeTime(iso) {
  if (!iso) return '';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hours = Math.floor(mins / 60);
  if (hours < 24) return hours + 'h ago';
  const days = Math.floor(hours / 24);
  if (days < 30) return days + 'd ago';
  return new Date(iso).toLocaleDateString();
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
