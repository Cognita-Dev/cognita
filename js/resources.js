// js/resources.js
// Resources page behavior. Talks to the same Worker as the chat app,
// through window.Auth.authedFetch — never touches AI providers or B2
// directly.

const WORKER_URL = 'https://cognita.cognitai.workers.dev';

// Kept in sync with recipes/index.js's RECIPE_LABELS on the backend.
// If a new recipe is added server-side, add its label + icon here too.
const RESOURCE_TYPES = [
  { type: 'lesson_plan', label: 'Lesson Plan', icon: 'chalkboard-teacher' },
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

const TYPE_FIELD_CONFIG = {
  lesson_plan: { topic: true, duration: true },
  worksheet: { topic: true, questionCount: true },
  exam: { topic: true, duration: true },
  scheme_of_work: { topic: false, term: true, weekCount: true },
  quiz: { topic: true, questionCount: true },
  study_guide: { topic: true },
  teaching_guide: { topic: true },
  classroom_activity: { topic: true, duration: true },
  assignment: { topic: true },
  marking_scheme: { topic: true },
  rubric: { topic: true },
  flashcards: { topic: true, questionCount: true },
  student_handout: { topic: true },
  presentation: { topic: true, questionCount: true },
  project: { topic: true, duration: true },
  test: { topic: true, duration: true },
};

let selectedType = null;
let currentResource = null;

(async function init() {
  const user = await window.Auth.requireAuthOrRedirect();
  if (!user) return;

  renderAccountInfo(user);
  await refreshUsage();
  await refreshAccount();

  renderResourceTypeGrid();
  wireForm();
  wireSidebar();
  wireAccountMenu();
  wireResultPanel();
  await loadMyResources();
})();

function renderAccountInfo(user) {
  const email = user.email || 'Signed in';
  document.getElementById('accountEmail').textContent = email;
  document.getElementById('accountAvatar').textContent = email.charAt(0).toUpperCase();
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
    console.error('[resources] could not load account:', e.message);
  }
}

async function refreshUsage() {
  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/usage');
    if (!res.ok) return;
    const data = await res.json();
    // usage endpoint doesn't return resourceGen yet in this batch — this
    // reads it defensively so the widget just shows blank rather than
    // breaking if the field isn't present.
    const usage = data.usage.resourceGen;
    if (usage) {
      document.getElementById('usageResources').textContent = usage.used + ' / ' + usage.limit;
      document.getElementById('usageResources').classList.remove('skeleton');
      const pct = usage.limit > 0 ? Math.min(100, (usage.used / usage.limit) * 100) : 0;
      document.getElementById('usageResourcesBar').style.width = pct + '%';
    }
  } catch (e) {
    console.error('[resources] could not load usage:', e.message);
  }
}

/* ════════════════════════════════════════════════════════
   SIDEBAR / ACCOUNT MENU (same behavior as app.js)
════════════════════════════════════════════════════════ */

function wireSidebar() {
  const sidebar = document.getElementById('appSidebar');
  const scrim = document.getElementById('sidebarScrim');

  document.getElementById('sidebarCollapseBtn').addEventListener('click', () => {
    sidebar.classList.toggle('is-collapsed');
  });
  document.getElementById('sidebarCloseBtn').addEventListener('click', closeMobileSidebar);
  document.getElementById('mobileSidebarBtn').addEventListener('click', () => {
    sidebar.classList.add('is-open');
    scrim.classList.add('is-visible');
  });
  scrim.addEventListener('click', closeMobileSidebar);
}

function closeMobileSidebar() {
  document.getElementById('appSidebar').classList.remove('is-open');
  document.getElementById('sidebarScrim').classList.remove('is-visible');
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

/* ════════════════════════════════════════════════════════
   RESOURCE TYPE PICKER + GUIDED FORM
════════════════════════════════════════════════════════ */

function renderResourceTypeGrid() {
  const grid = document.getElementById('resourceTypeGrid');
  grid.innerHTML = RESOURCE_TYPES.map((rt) =>
    '<button type="button" class="resource-type-card" data-type="' + rt.type + '">' +
      '<i class="ph ph-' + rt.icon + '"></i>' +
      '<span>' + rt.label + '</span>' +
    '</button>'
  ).join('');

  grid.querySelectorAll('.resource-type-card').forEach((btn) => {
    btn.addEventListener('click', () => openForm(btn.dataset.type));
  });
}

function openForm(type) {
  selectedType = type;
  const config = TYPE_FIELD_CONFIG[type] || {};
  const rt = RESOURCE_TYPES.find((r) => r.type === type);

  document.getElementById('resourceTypeGrid').hidden = true;
  document.getElementById('resourceForm').hidden = false;
  document.getElementById('resourceFormTitle').textContent = rt ? rt.label : type;

  document.getElementById('topicFieldWrap').hidden = !config.topic;
  document.getElementById('fieldTopic').required = !!config.topic;

  document.getElementById('durationFieldWrap').hidden = !config.duration;
  document.getElementById('questionCountFieldWrap').hidden = !config.questionCount;
  document.getElementById('termFieldWrap').hidden = !config.term;
  document.getElementById('weekCountFieldWrap').hidden = !config.weekCount;
}

function closeForm() {
  selectedType = null;
  document.getElementById('resourceForm').reset();
  document.getElementById('resourceForm').hidden = true;
  document.getElementById('resourceTypeGrid').hidden = false;
}

function wireForm() {
  document.getElementById('resourceFormBack').addEventListener('click', closeForm);

  document.getElementById('resourceForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!selectedType) return;

    const fields = {
      subject: document.getElementById('fieldSubject').value.trim(),
      classLevel: document.getElementById('fieldClassLevel').value.trim(),
      curriculum: document.getElementById('fieldCurriculum').value.trim(),
    };

    const config = TYPE_FIELD_CONFIG[selectedType] || {};
    if (config.topic) fields.topic = document.getElementById('fieldTopic').value.trim();
    if (config.duration) fields.duration = document.getElementById('fieldDuration').value.trim();
    if (config.questionCount) {
      const n = parseInt(document.getElementById('fieldQuestionCount').value, 10);
      if (n) fields.questionCount = n;
    }
    if (config.term) fields.term = document.getElementById('fieldTerm').value.trim();
    if (config.weekCount) {
      const n = parseInt(document.getElementById('fieldWeekCount').value, 10);
      if (n) fields.weekCount = n;
    }

    await generateResource(selectedType, fields);
  });
}

async function generateResource(resourceType, fields) {
  const btn = document.getElementById('resourceGenerateBtn');
  setBtnLoading(btn, true);

  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/resources/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ resourceType, fields }),
    });

    const data = await res.json();
    setBtnLoading(btn, false);

    if (!res.ok) {
      showToast(data.error || 'Could not generate the resource.');
      return;
    }

    currentResource = data.resource;
    showResultPanel(currentResource);
    closeForm();
    await refreshUsage();
    await loadMyResources();
  } catch (e) {
    setBtnLoading(btn, false);
    showToast('Could not reach Cognita. Please try again.');
    console.error('[resources] generate failed:', e.message);
  }
}

function setBtnLoading(btn, isLoading) {
  btn.disabled = isLoading;
  btn.querySelector('.btn-label').hidden = isLoading;
  btn.querySelector('.btn-spinner').hidden = !isLoading;
}

/* ════════════════════════════════════════════════════════
   RESULT PREVIEW
════════════════════════════════════════════════════════ */

function wireResultPanel() {
  document.getElementById('resourceResultClose').addEventListener('click', () => {
    document.getElementById('resourcesResultPanel').hidden = true;
    currentResource = null;
  });

  document.getElementById('resourceDownloadBtn').addEventListener('click', async () => {
    if (!currentResource) return;
    await downloadResource(currentResource.id);
  });
}

// Renders a reasonable generic preview from structuredContent regardless
// of resource type — walks the object shallowly rather than needing a
// bespoke renderer per recipe. Good enough for a first preview; a proper
// per-type renderer can replace this later without touching the backend.
function renderStructuredPreview(content) {
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

function showResultPanel(resource) {
  document.getElementById('resourcesResultPanel').hidden = false;
  document.getElementById('resourceResultTitle').textContent = resource.structuredContent.title || resource.title;
  document.getElementById('resourceResultBody').innerHTML = renderStructuredPreview(resource.structuredContent);

  const downloadBtn = document.getElementById('resourceDownloadBtn');
  downloadBtn.disabled = !(resource.fileReferences && resource.fileReferences.docx);
  downloadBtn.querySelector('span').textContent = downloadBtn.disabled
    ? 'Export not available yet'
    : 'Download DOCX';

  document.getElementById('resourcesResultPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function downloadResource(resourceId) {
  const btn = document.getElementById('resourceDownloadBtn');
  btn.disabled = true;

  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/resources/' + resourceId + '/download', {
      method: 'POST',
    });
    const data = await res.json();

    if (!res.ok) {
      showToast(data.error || 'Could not prepare the download.');
      btn.disabled = false;
      return;
    }

    // Open the time-limited B2 URL directly — it's already scoped and
    // expiring, so a plain navigation/download is fine here.
    const a = document.createElement('a');
    a.href = data.url;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (e) {
    showToast('Could not reach Cognita. Please try again.');
    console.error('[resources] download failed:', e.message);
  }

  btn.disabled = false;
}

/* ════════════════════════════════════════════════════════
   MY RESOURCES LIST
════════════════════════════════════════════════════════ */

async function loadMyResources() {
  const list = document.getElementById('myResourcesList');

  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/resources/list');
    if (!res.ok) return;
    const data = await res.json();

    if (!data.resources || data.resources.length === 0) {
      list.innerHTML = '<div class="my-resources-empty">Your generated resources will appear here.</div>';
      return;
    }

    list.innerHTML = data.resources.map((r) => {
      const rt = RESOURCE_TYPES.find((t) => t.type === r.resourceType);
      const icon = rt ? rt.icon : 'file-text';
      const label = rt ? rt.label : r.resourceType;
      return (
        '<button class="my-resource-row" data-id="' + r.id + '">' +
          '<i class="ph ph-' + icon + ' resource-icon"></i>' +
          '<div class="my-resource-info">' +
            '<div class="my-resource-title">' + escapeHtml(r.title || label) + '</div>' +
            '<div class="my-resource-meta">' + escapeHtml(label) + (r.subject ? ' · ' + escapeHtml(r.subject) : '') + '</div>' +
          '</div>' +
          '<span class="my-resource-status status-' + r.status + '">' + r.status + '</span>' +
        '</button>'
      );
    }).join('');

    list.querySelectorAll('.my-resource-row').forEach((row) => {
      row.addEventListener('click', () => {
        const resource = data.resources.find((r) => r.id === row.dataset.id);
        if (resource && resource.status === 'ready' && resource.structuredContent) {
          currentResource = resource;
          showResultPanel(resource);
        } else if (resource && resource.status === 'failed') {
          showToast('This resource failed to generate. Try creating it again.');
        }
      });
    });
  } catch (e) {
    console.error('[resources] could not load resource list:', e.message);
  }
}

/* ════════════════════════════════════════════════════════
   HELPERS
════════════════════════════════════════════════════════ */

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
