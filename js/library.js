// js/library.js
// User-facing library view. Talks only to /api/library/* — never touches
// /api/admin/* or /api/resources/* — so a normal user's session here has
// nothing that could accidentally hit an admin-only route.
//
// Exports mount(), called once by js/router.js the first time the
// library view is opened. Sidebar chrome is owned by js/shell.js.

import { escapeHtml, showToast, renderAccountInfo } from './shell.js';

const WORKER_URL = 'https://cognita.cognitai.workers.dev';

// Same labels as resources.js, kept as its own copy so this page has no
// dependency on that file loading first.
const RESOURCE_TYPES = [
  { type: 'lesson_plan', label: 'Lesson Plan', icon: 'chalkboard-teacher' },
  { type: 'lesson_note', label: 'Lesson Note', icon: 'notebook' },
  { type: 'worksheet', label: 'Worksheet', icon: 'note-pencil' },
  { type: 'exam', label: 'Examination', icon: 'exam' },
  { type: 'scheme_of_work', label: 'Scheme of Work', icon: 'calendar-check' },
  { type: 'quiz', label: 'Quiz', icon: 'question' },
  { type: 'study_guide', label: 'Study Guide', icon: 'book-open-text' },
  { type: 'teaching_guide', label: 'Teaching Guide', icon: 'chalkboard' },
  { type: 'classroom_activity', label: 'Classroom Activity', icon: 'users-three' },
  { type: 'assignment', label: 'Assignment', icon: 'clipboard-text' },
  { type: 'marking_scheme', label: 'Marking Scheme', icon: 'check-square-offset' },
  { type: 'rubric', label: 'Rubric', icon: 'table' },
  { type: 'flashcards', label: 'Flashcards', icon: 'cards' },
  { type: 'student_handout', label: 'Student Handout', icon: 'file-text' },
  { type: 'presentation', label: 'Presentation Slides', icon: 'presentation-chart' },
  { type: 'project', label: 'Project', icon: 'flag-checkered' },
  { type: 'test', label: 'Test', icon: 'pencil-simple-line' },
];

const FORMAT_LABELS = {
  docx: 'Word (.docx)',
  pdf: 'PDF',
  pptx: 'PowerPoint (.pptx)',
};

let allLibraryResources = [];
let currentTypeFilter = '';

export async function mount() {
  const user = await window.Auth.requireAuthOrRedirect();
  if (!user) return;

  renderAccountInfo(user);
  await refreshAccount();

  wireResultPanel();
  wireTypeFilter();
  wireCollectionDetailBack();

  await loadCollections();
  await loadLibraryResources();
}

async function refreshAccount() {
  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/account');
    if (!res.ok) return;
    const data = await res.json();
    document.getElementById('accountPlan').textContent = data.planName;
    document.getElementById('accountPlan').classList.remove('skeleton');
    document.getElementById('accountEmail').classList.remove('skeleton');
  } catch (e) {
    console.error('[library] could not load account:', e.message);
  }
}

/* ── Type filter ── */

function wireTypeFilter() {
  const select = document.getElementById('typeFilterSelect');

  select.innerHTML =
    '<option value="">All types</option>' +
    RESOURCE_TYPES.map((rt) => '<option value="' + rt.type + '">' + rt.label + '</option>').join('');

  select.addEventListener('change', () => {
    currentTypeFilter = select.value;
    renderResourceList();
  });
}

/* ── Collections ── */

async function loadCollections() {
  const grid = document.getElementById('libraryCollectionsGrid');

  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/library/collections');

    if (!res.ok) {
      grid.innerHTML = '<div class="my-resources-empty">Could not load collections.</div>';
      return;
    }

    const data = await res.json();
    const collections = data.collections || [];

    if (collections.length === 0) {
      document.getElementById('collectionsSection').hidden = true;
      return;
    }

    grid.innerHTML = collections.map((c) =>
      '<button type="button" class="resource-type-card" data-collection-id="' + c.id + '">' +
      '<i class="ph ph-books"></i>' +
      '<span>' + escapeHtml(c.name) + '</span>' +
      '</button>'
    ).join('');

    grid.querySelectorAll('[data-collection-id]').forEach((btn) => {
      btn.addEventListener('click', () => openCollection(btn.dataset.collectionId));
    });
  } catch (e) {
    grid.innerHTML = '<div class="my-resources-empty">Could not reach Cognita.</div>';
    console.error('[library] collections load failed:', e.message);
  }
}

async function openCollection(collectionId) {
  try {
    const res = await window.Auth.authedFetch(
      WORKER_URL + '/api/library/collections/' + collectionId
    );

    if (!res.ok) {
      showToast('Could not load that collection.');
      return;
    }

    const data = await res.json();

    document.getElementById('collectionsSection').hidden = true;
    document.getElementById('collectionDetailSection').hidden = false;
    document.getElementById('collectionDetailTitle').textContent = data.collection.name;
    document.getElementById('collectionDetailDescription').textContent = data.collection.description || '';

    renderResourceRows(document.getElementById('collectionDetailList'), data.resources);
    document.getElementById('collectionDetailSection').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    showToast('Could not reach Cognita.');
    console.error('[library] collection detail failed:', e.message);
  }
}

function wireCollectionDetailBack() {
  document.getElementById('collectionDetailBack').addEventListener('click', () => {
    document.getElementById('collectionDetailSection').hidden = true;
    document.getElementById('collectionsSection').hidden = false;
  });
}

/* ── Browse all ── */

async function loadLibraryResources() {
  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/library/resources');

    if (!res.ok) {
      document.getElementById('libraryResourceList').innerHTML =
        '<div class="my-resources-empty">Could not load the library.</div>';
      return;
    }

    const data = await res.json();
    allLibraryResources = data.resources || [];
    renderResourceList();
  } catch (e) {
    document.getElementById('libraryResourceList').innerHTML =
      '<div class="my-resources-empty">Could not reach Cognita.</div>';
    console.error('[library] resource list load failed:', e.message);
  }
}

function renderResourceList() {
  const container = document.getElementById('libraryResourceList');
  const filtered = currentTypeFilter
    ? allLibraryResources.filter((r) => r.resourceType === currentTypeFilter)
    : allLibraryResources;

  // Recommended/Featured lives on the Resources view instead — here
  // it's always one flat browsable list, regardless of the
  // `recommended` flag the backend still attaches per item.
  renderResourceRows(container, filtered);
}

function renderResourceRows(container, resources) {
  if (!resources || resources.length === 0) {
    container.innerHTML = '<div class="my-resources-empty">Nothing here yet.</div>';
    return;
  }

  container.innerHTML = resources.map((r) => {
    const rt = RESOURCE_TYPES.find((t) => t.type === r.resourceType);
    const icon = rt ? rt.icon : 'file-text';
    const label = rt ? rt.label : r.resourceType;

    return (
      '<button class="my-resource-row" data-id="' + r.id + '">' +
      '<i class="ph ph-' + icon + ' resource-icon"></i>' +
      '<div class="my-resource-info">' +
      '<div class="my-resource-title">' + escapeHtml(r.title || label) + '</div>' +
      '<div class="my-resource-meta">' + escapeHtml(label) + '</div>' +
      (r.excerpt
        ? '<div class="my-resource-excerpt">' + escapeHtml(r.excerpt) + '</div>'
        : '') +
      '</div>' +
      '</button>'
    );
  }).join('');

  container.querySelectorAll('.my-resource-row').forEach((row) => {
    row.addEventListener('click', () => openLibraryResource(row.dataset.id));
  });
}

/* ── Resource preview ── */

async function openLibraryResource(resourceId) {
  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/library/resources/' + resourceId);

    if (!res.ok) {
      showToast('Could not load that resource.');
      return;
    }

    const data = await res.json();
    showResultPanel(data.resource);
  } catch (e) {
    showToast('Could not reach Cognita.');
    console.error('[library] resource fetch failed:', e.message);
  }
}

function renderStructuredPreview(content, resourceType) {
  if (window.ResourceRenderers && typeof window.ResourceRenderers.render === 'function') {
    const specialized = window.ResourceRenderers.render(resourceType, content);
    if (specialized) return specialized;
  }

  let html = '';

  for (const key in content) {
    const value = content[key];
    const label = key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

    if (Array.isArray(value)) {
      html += '<h4>' + escapeHtml(label) + '</h4><ul>';
      value.forEach((item) => {
        if (typeof item === 'object' && item !== null) {
          html += '<li>' + escapeHtml(Object.values(item).join(' — ')) + '</li>';
        } else {
          html += '<li>' + escapeHtml(String(item)) + '</li>';
        }
      });
      html += '</ul>';
    } else if (typeof value === 'object' && value !== null) {
      html += '<h4>' + escapeHtml(label) + '</h4><p>' + escapeHtml(JSON.stringify(value)) + '</p>';
    } else if (typeof value !== 'undefined' && value !== null && String(value).trim()) {
      html += '<h4>' + escapeHtml(label) + '</h4><p>' + escapeHtml(String(value)) + '</p>';
    }
  }

  return html;
}

function wireResultPanel() {
  document.getElementById('libraryResultClose').addEventListener('click', () => {
    document.getElementById('libraryResultPanel').hidden = true;
  });
}

function showResultPanel(resource) {
  const panel = document.getElementById('libraryResultPanel');
  const resultTitle = document.getElementById('libraryResultTitle');
  const resultBody = document.getElementById('libraryResultBody');
  const actionsWrap = document.getElementById('libraryResultActions');

  panel.hidden = false;
  resultTitle.textContent = resource.structuredContent.title || 'Resource';
  resultBody.innerHTML = renderStructuredPreview(resource.structuredContent, resource.resourceType);

  if (window.ResourceRenderers && typeof window.ResourceRenderers.mount === 'function') {
    window.ResourceRenderers.mount(resource.resourceType, resultBody, resource.structuredContent);
  }

  renderDownloadControl(actionsWrap, resource.id, Object.keys(resource.fileReferences || {}));

  panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Small download icon that opens a popover listing whichever export
// formats (docx/pdf/pptx) are actually available for this resource,
// instead of a stacked full-width button per format.
//
// The popover is appended straight to <body> and positioned with fixed
// coordinates computed from the toggle button's bounding rect (see
// _openDownloadMenu below), instead of being absolutely positioned inside
// the result panel. That's what makes it show up reliably on both mobile
// and desktop: nested + absolutely positioned, it used to get clipped
// down to nothing by the result panel's overflow:hidden, which is why the
// download menu (and the options inside it) looked like they weren't
// working at all.
let _openDownloadMenuState = null; // { menu, toggle, cleanup }

function _closeOpenDownloadMenu() {
  if (_openDownloadMenuState) {
    _openDownloadMenuState.cleanup();
    _openDownloadMenuState = null;
  }
}

function renderDownloadControl(actionsWrap, resourceId, availableFormats) {
  if (availableFormats.length === 0) {
    actionsWrap.innerHTML =
      '<p style="color:var(--text-3);font-size:var(--text-sm);text-align:center;">' +
      'No export is available for this resource yet.' +
      '</p>';
    return;
  }

  actionsWrap.innerHTML =
    '<div class="resource-download-control">' +
    '<button type="button" class="resource-download-btn resource-download-toggle" ' +
    'aria-haspopup="true" aria-expanded="false" title="Download">' +
    '<i class="ph ph-download-simple" style="font-size:18px;"></i>' +
    '</button>' +
    '</div>';

  const toggle = actionsWrap.querySelector('.resource-download-toggle');

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();

    if (_openDownloadMenuState && _openDownloadMenuState.toggle === toggle) {
      _closeOpenDownloadMenu();
      return;
    }
    _closeOpenDownloadMenu();
    _openDownloadMenu(toggle, resourceId, availableFormats);
  });
}

function _openDownloadMenu(toggle, resourceId, availableFormats) {
  const menu = document.createElement('div');
  menu.className = 'resource-download-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = availableFormats
    .map(
      (format) =>
        '<button type="button" class="resource-download-option" data-format="' + format + '" role="menuitem">' +
        '<i class="ph ph-file-arrow-down"></i><span>' +
        (FORMAT_LABELS[format] || format.toUpperCase()) +
        '</span></button>'
    )
    .join('');

  document.body.appendChild(menu);
  toggle.setAttribute('aria-expanded', 'true');

  function position() {
    const rect = toggle.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const gap = 8;

    let left = rect.right - menuRect.width;
    left = Math.max(gap, Math.min(left, window.innerWidth - menuRect.width - gap));

    // Prefer opening upward (the button usually sits at the bottom of a
    // result panel), but flip below the button if there isn't room above
    // — important on short mobile viewports.
    let top = rect.top - menuRect.height - gap;
    if (top < gap) {
      top = Math.min(rect.bottom + gap, window.innerHeight - menuRect.height - gap);
    }

    menu.style.left = left + 'px';
    menu.style.top = Math.max(gap, top) + 'px';
  }

  position();
  requestAnimationFrame(position);

  window.addEventListener('resize', position);
  window.addEventListener('scroll', position, true);

  const onOutsideClick = (e) => {
    if (!menu.contains(e.target) && e.target !== toggle) {
      _closeOpenDownloadMenu();
    }
  };
  const onKeydown = (e) => {
    if (e.key === 'Escape') _closeOpenDownloadMenu();
  };
  document.addEventListener('click', onOutsideClick);
  document.addEventListener('keydown', onKeydown);

  menu.querySelectorAll('.resource-download-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      const format = btn.dataset.format;
      _closeOpenDownloadMenu();
      downloadResource(resourceId, format, toggle);
    });
  });

  _openDownloadMenuState = {
    menu,
    toggle,
    cleanup: () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      document.removeEventListener('click', onOutsideClick);
      document.removeEventListener('keydown', onKeydown);
      toggle.setAttribute('aria-expanded', 'false');
      menu.remove();
    },
  };
}

async function downloadResource(resourceId, format, btn) {
  if (btn) btn.disabled = true;

  try {
    const res = await window.Auth.authedFetch(
      WORKER_URL + '/api/library/resources/' + resourceId + '/download?format=' + encodeURIComponent(format),
      { method: 'POST' }
    );

    const data = await res.json();

    if (!res.ok) {
      showToast(data.error || 'Could not prepare the download.');
      if (btn) btn.disabled = false;
      return;
    }

    const a = document.createElement('a');
    a.href = data.url;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (e) {
    showToast('Could not reach Cognita. Please try again.');
    console.error('[library] download failed:', e.message);
  }

  if (btn) btn.disabled = false;
}
