// js/admin.js
// Admin curation UI. Talks to the same Worker as resources.js. If a
// signed-in user isn't an admin, every request here comes back 401/403
// from the server (requireAdmin) — this page has no client-side gate of
// its own beyond that, since the server check is the only one that
// actually matters.

const WORKER_URL = 'https://cognita.cognitai.workers.dev';

const RESOURCE_TYPES = [
  'lesson_plan', 'worksheet', 'exam', 'scheme_of_work', 'quiz', 'study_guide',
  'teaching_guide', 'classroom_activity', 'assignment', 'marking_scheme',
  'rubric', 'flashcards', 'student_handout', 'presentation', 'project', 'test',
];

const STATUSES = ['draft', 'in_review', 'validated', 'published', 'archived'];

let currentStatusFilter = 'draft';
let currentResources = [];
let currentDetailResource = null;

(async function init() {
  const user = await window.Auth.requireAuthOrRedirect();
  if (!user) return;

  document.getElementById('accountEmail').textContent = user.email || 'Signed in';
  document.getElementById('accountAvatar').textContent = (user.email || 'A').charAt(0).toUpperCase();

  populateResourceTypeSelect();
  renderStatusTabs();
  wireCreateForm();
  wireDetailPanel();
  wireCollections();
  await loadResourceList();
  await loadCollections();
})();

function populateResourceTypeSelect() {
  const select = document.getElementById('fieldResourceType');
  select.innerHTML = RESOURCE_TYPES.map((t) => '<option value="' + t + '">' + t + '</option>').join('');
}

function renderStatusTabs() {
  const wrap = document.getElementById('statusTabs');
  wrap.innerHTML = STATUSES.map((s) =>
    '<button type="button" class="resource-type-card" data-status="' + s + '" style="padding:10px;">' +
    '<span>' + s + '</span></button>'
  ).join('');

  wrap.querySelectorAll('[data-status]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      currentStatusFilter = btn.dataset.status;
      await loadResourceList();
    });
  });
}

/* ── Create ── */

function wireCreateForm() {
  document.querySelectorAll('input[name="createMode"]').forEach((radio) => {
    radio.addEventListener('change', () => {
      const isBatch = document.querySelector('input[name="createMode"]:checked').value === 'batch';
      document.getElementById('singleCreateForm').hidden = isBatch;
      document.getElementById('batchCreateForm').hidden = !isBatch;
    });
  });

  document.getElementById('fieldCreationMode').addEventListener('change', (e) => {
    const isManual = e.target.value === 'manual';
    document.getElementById('aiFieldsWrap').hidden = isManual;
    document.getElementById('manualContentWrap').hidden = !isManual;
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
      await loadResourceList();
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
      return '<div style="color:#3F6B5B;">#' + r.index + ' ok — ' +
        escapeHtml(r.resource?.structuredContent?.title || r.resource?.id || '') +
        (r.wasExisting ? ' (already existed — idempotent replay)' : '') + '</div>';
    }
    return '<div style="color:#7A2E3A;">#' + r.index + ' failed — ' + escapeHtml(r.error) + '</div>';
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

    if (currentResources.length === 0) {
      list.innerHTML = '<div class="my-resources-empty">No resources in this status.</div>';
      return;
    }

    list.innerHTML = currentResources.map((r) =>
      '<button class="my-resource-row" data-id="' + r.id + '">' +
      '<div class="my-resource-info">' +
      '<div class="my-resource-title">' + escapeHtml(r.structuredContent?.title || r.id) + '</div>' +
      '<div class="my-resource-meta">' + escapeHtml(r.resourceType) + ' · ' + escapeHtml(r.createdMode) + '</div>' +
      '</div>' +
      '<span class="my-resource-status">' + r.status + '</span>' +
      '</button>'
    ).join('');

    list.querySelectorAll('.my-resource-row').forEach((row) => {
      row.addEventListener('click', () => openDetail(row.dataset.id));
    });
  } catch (e) {
    console.error('[admin] list load failed:', e.message);
  }
}

/* ── Detail / edit / transitions ── */

async function openDetail(resourceId) {
  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/admin/resources/' + resourceId);
    if (!res.ok) {
      showToast('Could not load resource.');
      return;
    }
    const data = await res.json();
    currentDetailResource = data.resource;

    document.getElementById('detailPanel').hidden = false;
    document.getElementById('detailTitle').textContent = currentDetailResource.structuredContent?.title || resourceId;
    document.getElementById('detailStatusBadge').textContent = currentDetailResource.status;
    document.getElementById('detailContentJson').value = JSON.stringify(currentDetailResource.structuredContent, null, 2);

    await loadVersionHistory(resourceId);
    document.getElementById('detailPanel').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    showToast('Could not reach the server.');
    console.error('[admin] detail load failed:', e.message);
  }
}

async function loadVersionHistory(resourceId) {
  const wrap = document.getElementById('versionHistory');
  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/admin/resources/' + resourceId + '/versions');
    if (!res.ok) return;
    const data = await res.json();
    const versions = data.versions || [];

    wrap.innerHTML = versions.length === 0
      ? '<p>No previous versions yet.</p>'
      : versions.map((v) =>
          '<div>v' + v.version + ' — ' + v.snapshotReason + ' — ' + new Date(v.createdAt).toLocaleString() + '</div>'
        ).join('');
  } catch (e) {
    console.error('[admin] version history load failed:', e.message);
  }
}

function wireDetailPanel() {
  document.getElementById('detailClose').addEventListener('click', () => {
    document.getElementById('detailPanel').hidden = true;
    currentDetailResource = null;
  });

  document.getElementById('saveEditBtn').addEventListener('click', async () => {
    if (!currentDetailResource) return;

    let structuredContent;
    try {
      structuredContent = JSON.parse(document.getElementById('detailContentJson').value);
    } catch (e) {
      showToast('Content is not valid JSON.');
      return;
    }

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
        return;
      }

      showToast('Saved.' + (data.resource.status === 'draft' ? ' Sent back to draft for re-review.' : ''));
      currentDetailResource = data.resource;
      document.getElementById('detailStatusBadge').textContent = currentDetailResource.status;
      await loadResourceList();
      await loadVersionHistory(currentDetailResource.id);
    } catch (e) {
      showToast('Could not reach the server.');
      console.error('[admin] edit failed:', e.message);
    }
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
      currentDetailResource = null;
      await loadResourceList();
    } catch (e) {
      showToast('Could not reach the server.');
      console.error('[admin] delete failed:', e.message);
    }
  });
}

async function runTransition(action) {
  if (!currentDetailResource) return;

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
      return;
    }

    currentDetailResource = data.resource;
    document.getElementById('detailStatusBadge').textContent = currentDetailResource.status;
    showToast('Now: ' + currentDetailResource.status);
    await loadResourceList();
    await loadVersionHistory(currentDetailResource.id);
  } catch (e) {
    showToast('Could not reach the server.');
    console.error('[admin] transition failed:', e.message);
  }
}

/* ── Collections ── */

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
      list.innerHTML = '<div class="my-resources-empty">No collections yet.</div>';
      return;
    }

    list.innerHTML = collections.map((c) =>
      '<div class="my-resource-row" style="cursor:default;">' +
      '<div class="my-resource-info">' +
      '<div class="my-resource-title">' + escapeHtml(c.name) + '</div>' +
      '<div class="my-resource-meta">' + (c.resourceIds || []).length + ' resource(s)</div>' +
      '</div>' +
      '<button data-cid="' + c.id + '" data-vis="' + c.visibility + '" class="toggle-vis-btn resource-download-btn">' +
      (c.visibility === 'published' ? 'Unpublish' : 'Publish') +
      '</button>' +
      '</div>'
    ).join('');

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
  } catch (e) {
    console.error('[admin] collections load failed:', e.message);
  }
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

function showToast(message) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}
