// js/admin.js

import { Auth } from './auth.js';

const WORKER_URL =
  'https://cognita.cognitai.workers.dev';

const views = {
  dashboard: document.getElementById(
    'dashboardView'
  ),
  resources: document.getElementById(
    'resourcesView'
  ),
  generate: document.getElementById(
    'generateView'
  ),
  jobs: document.getElementById(
    'jobsView'
  ),
  editor: document.getElementById(
    'editorView'
  ),
};

let resources = [];
let jobs = [];
let currentResource = null;

const typeLabels = {
  lesson_plan: 'Lesson Plan',
  worksheet: 'Worksheet',
  exam: 'Examination',
  scheme_of_work: 'Scheme of Work',
  quiz: 'Quiz',
  study_guide: 'Study Guide',
  teaching_guide: 'Teaching Guide',
  classroom_activity: 'Classroom Activity',
  assignment: 'Assignment',
  marking_scheme: 'Marking Scheme',
  rubric: 'Rubric',
  flashcards: 'Flashcards',
  student_handout: 'Student Handout',
  presentation: 'Presentation',
  project: 'Project',
  test: 'Test',
};

function $(id) {
  return document.getElementById(id);
}

async function api(path, options = {}) {
  const response = await Auth.authedFetch(
    WORKER_URL + path,
    {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    }
  );

  let data = null;

  try {
    data = await response.json();
  } catch (_) {}

  if (!response.ok) {
    throw new Error(
      data?.error ||
        'Something went wrong.'
    );
  }

  return data;
}

function showView(name) {
  Object.values(views).forEach((view) => {
    view.classList.remove('active');
  });

  views[name]?.classList.add('active');

  document
    .querySelectorAll('.nav-item')
    .forEach((button) => {
      button.classList.toggle(
        'active',
        button.dataset.view === name
      );
    });

  const titles = {
    dashboard: 'Dashboard',
    resources: 'Ready-made Resources',
    generate: 'Generate Resources',
    jobs: 'Generation Jobs',
    editor: 'Edit Resource',
  };

  $('pageTitle').textContent =
    titles[name] || 'Admin';
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderResources(target, list) {
  if (!list.length) {
    target.innerHTML = `
      <div class="empty-state">
        No resources here yet.
      </div>
    `;
    return;
  }

  target.innerHTML = list
    .map(
      (resource) => `
        <article
          class="resource-card"
          data-resource-id="${escapeHtml(resource.id)}"
        >
          <span class="resource-type">
            ${escapeHtml(
              typeLabels[
                resource.resourceType
              ] ||
                resource.resourceType
            )}
          </span>

          <h3>
            ${escapeHtml(
              resource.title
            )}
          </h3>

          <p>
            ${escapeHtml(
              resource.description ||
                resource.topic ||
                'No description.'
            )}
          </p>

          <span class="status-pill">
            ${escapeHtml(
              resource.status
            )}
          </span>
        </article>
      `
    )
    .join('');

  target
    .querySelectorAll(
      '.resource-card'
    )
    .forEach((card) => {
      card.addEventListener(
        'click',
        () =>
          openEditor(
            card.dataset.resourceId
          )
      );
    });
}

async function loadResources(
  status = ''
) {
  const query = status
    ? `?status=${encodeURIComponent(status)}`
    : '';

  const data = await api(
    `/api/admin/resources${query}`
  );

  resources = data.resources || [];

  renderResources(
    $('resourceGrid'),
    resources
  );

  const drafts = resources.filter(
    (r) => r.status === 'draft'
  );

  renderResources(
    $('dashboardDrafts'),
    drafts.slice(0, 6)
  );

  $('statTotal').textContent =
    resources.length;

  $('statDrafts').textContent =
    resources.filter(
      (r) => r.status === 'draft'
    ).length;

  $('statPublished').textContent =
    resources.filter(
      (r) => r.status === 'published'
    ).length;
}

async function loadJobs() {
  const data = await api(
    '/api/admin/generation-jobs'
  );

  jobs = data.jobs || [];

  $('statJobs').textContent =
    jobs.filter(
      (job) =>
        job.status === 'queued' ||
        job.status === 'running'
    ).length;

  if (!jobs.length) {
    $('jobsList').innerHTML = `
      <div class="empty-state">
        No generation jobs yet.
      </div>
    `;
    return;
  }

  $('jobsList').innerHTML = jobs
    .map(
      (job) => `
        <article class="job-card">
          <div>
            <h3>
              ${escapeHtml(
                typeLabels[
                  job.resourceType
                ] ||
                  job.resourceType
              )}
            </h3>

            <div class="job-progress">
              ${job.completed || 0}
              / ${job.total}
              completed ·
              ${job.failed || 0}
              failed
            </div>
          </div>

          ${
            job.status ===
              'queued' ||
            job.status === 'running'
              ? `
                <button
                  class="secondary-button process-job"
                  data-job-id="${job.id}"
                >
                  Continue
                </button>
              `
              : `
                <span class="status-pill">
                  ${escapeHtml(
                    job.status
                  )}
                </span>
              `
          }
        </article>
      `
    )
    .join('');

  document
    .querySelectorAll('.process-job')
    .forEach((button) => {
      button.addEventListener(
        'click',
        () =>
          processJob(
            button.dataset.jobId
          )
      );
    });
}

async function processJob(jobId) {
  const button = document.querySelector(
    `[data-job-id="${jobId}"]`
  );

  if (button) {
    button.disabled = true;
    button.textContent =
      'Generating…';
  }

  try {
    await api(
      `/api/admin/generation-jobs/${jobId}/process`,
      {
        method: 'POST',
      }
    );

    await loadJobs();
    await loadResources();
  } catch (e) {
    alert(e.message);
    if (button) {
      button.disabled = false;
      button.textContent =
        'Continue';
    }
  }
}

async function openEditor(resourceId) {
  try {
    const data = await api(
      `/api/admin/resources/${resourceId}`
    );

    currentResource = data.resource;

    $('editTitle').value =
      currentResource.title || '';

    $('editDescription').value =
      currentResource.description ||
      '';

    $('editTags').value = (
      currentResource.tags || []
    ).join(', ');

    $('editFeatured').value =
      String(
        !!currentResource.featured
      );

    $('editRecommended').value =
      String(
        !!currentResource.recommended
      );

    $('editContent').value =
      JSON.stringify(
        currentResource.structuredContent,
        null,
        2
      );

    $('editorTitle').textContent =
      currentResource.title;

    $('editorMeta').textContent =
      `${typeLabels[currentResource.resourceType] || currentResource.resourceType} · ${currentResource.subject || 'No subject'} · Version ${currentResource.currentVersion || 1}`;

    $('editorStatus').textContent =
      currentResource.status;

    $('publishButton').style.display =
      currentResource.status ===
      'published'
        ? 'none'
        : '';

    showView('editor');
  } catch (e) {
    alert(e.message);
  }
}

async function saveResource() {
  if (!currentResource) return;

  let structuredContent;

  try {
    structuredContent = JSON.parse(
      $('editContent').value
    );
  } catch (_) {
    alert(
      'Structured content must be valid JSON.'
    );
    return;
  }

  const tags = $('editTags').value
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);

  const button = $('saveButton');
  button.disabled = true;
  button.textContent =
    'Saving…';

  try {
    const data = await api(
      `/api/admin/resources/${currentResource.id}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          title: $('editTitle').value.trim(),
          description:
            $('editDescription').value.trim(),
          tags,
          featured:
            $('editFeatured').value ===
            'true',
          recommended:
            $('editRecommended').value ===
            'true',
          structuredContent,
        }),
      }
    );

    currentResource =
      data.resource;

    $('editorStatus').textContent =
      currentResource.status;

    $('editorMeta').textContent =
      `${typeLabels[currentResource.resourceType] || currentResource.resourceType} · ${currentResource.subject || 'No subject'} · Version ${currentResource.currentVersion || 1}`;

    await loadResources();

    alert('Saved.');
  } catch (e) {
    alert(e.message);
  } finally {
    button.disabled = false;
    button.textContent =
      'Save changes';
  }
}

async function publishResource() {
  if (!currentResource) return;

  const confirmed = confirm(
    'Publish this resource to the Cognita ready-made library?'
  );

  if (!confirmed) return;

  const button = $('publishButton');

  button.disabled = true;
  button.textContent =
    'Publishing…';

  try {
    const data = await api(
      `/api/admin/resources/${currentResource.id}/publish`,
      {
        method: 'POST',
      }
    );

    currentResource =
      data.resource;

    $('editorStatus').textContent =
      'published';

    button.style.display =
      'none';

    await loadResources();

    alert(
      'Published successfully.'
    );
  } catch (e) {
    alert(e.message);
  } finally {
    button.disabled = false;
    button.textContent =
      'Publish';
  }
}

async function generateResource(event) {
  event.preventDefault();

  const button =
    $('generateButton');

  const message =
    $('generateMessage');

  const count =
    Number($('count').value) || 1;

  const fields = {
    subject:
      $('subject').value.trim(),

    classLevel:
      $('classLevel').value.trim(),

    educationalLevel:
      $('educationalLevel').value.trim(),

    curriculum:
      $('curriculum').value.trim(),

    topic:
      $('topic').value.trim(),

    instructions:
      $('instructions').value.trim(),
  };

  button.disabled = true;
  button.textContent =
    count > 1
      ? 'Creating batch…'
      : 'Generating…';

  message.textContent = '';

  try {
    const data = await api(
      '/api/admin/resources/generate',
      {
        method: 'POST',
        body: JSON.stringify({
          resourceType:
            $('resourceType').value,

          fields,

          designTemplateId:
            $('designTemplateId').value.trim(),

          count,
        }),
      }
    );

    if (data.job) {
      message.textContent =
        `Batch job created: ${data.job.id}`;

      showView('jobs');

      await loadJobs();

      // Process the first item immediately.
      await processJob(
        data.job.id
      );
    } else if (data.resource) {
      message.textContent =
        'Draft generated successfully.';

      await loadResources();

      await openEditor(
        data.resource.id
      );
    }
  } catch (e) {
    message.textContent =
      e.message;
  } finally {
    button.disabled = false;
    button.textContent =
      'Generate draft';
  }
}

function setupNavigation() {
  document
    .querySelectorAll(
      '[data-view]'
    )
    .forEach((button) => {
      button.addEventListener(
        'click',
        () =>
          showView(
            button.dataset.view
          )
      );
    });
}

function setupFilters() {
  document
    .querySelectorAll(
      '.filter-button'
    )
    .forEach((button) => {
      button.addEventListener(
        'click',
        async () => {
          document
            .querySelectorAll(
              '.filter-button'
            )
            .forEach((b) =>
              b.classList.remove(
                'active'
              )
            );

          button.classList.add(
            'active'
          );

          await loadResources(
            button.dataset.status
          );
        }
      );
    });
}

async function init() {
  const user =
    await Auth.requireAuthOrRedirect();

  if (!user) return;

  setupNavigation();
  setupFilters();

  $('logoutButton').addEventListener(
    'click',
    async () => {
      await Auth.logOut();
      window.location.href =
        '/login.html';
    }
  );

  $('generateForm').addEventListener(
    'submit',
    generateResource
  );

  $('saveButton').addEventListener(
    'click',
    saveResource
  );

  $('publishButton').addEventListener(
    'click',
    publishResource
  );

  $('backToResources').addEventListener(
    'click',
    async () => {
      showView('resources');
      await loadResources();
    }
  );

  document
    .querySelectorAll(
      '.primary-button[data-view]'
    )
    .forEach((button) => {
      button.addEventListener(
        'click',
        () =>
          showView(
            button.dataset.view
          )
      );
    });

  try {
    await loadResources();
    await loadJobs();
  } catch (e) {
    console.error(
      '[admin] initialization failed:',
      e
    );

    document.body.innerHTML = `
      <div style="
        padding:40px;
        font-family:system-ui;
      ">
        <h2>Admin access required</h2>
        <p>${escapeHtml(
          e.message
        )}</p>
      </div>
    `;
  }
}

init();
