// js/admin.js

import { Auth } from './auth.js';

const WORKER_URL =
  'https://cognita.cognitai.workers.dev';

const views = {
  dashboard: document.getElementById('dashboardView'),
  resources: document.getElementById('resourcesView'),
  generate: document.getElementById('generateView'),
  jobs: document.getElementById('jobsView'),
  editor: document.getElementById('editorView'),
  collections: document.getElementById('collectionsView'),
};

let resources = [];
let jobs = [];
let collections = [];
let publishedResources = [];

let currentResource = null;
let currentCollection = null;

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
      data?.error || 'Something went wrong.'
    );
  }

  return data;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function showView(name) {
  Object.values(views).forEach((view) => {
    if (view) {
      view.classList.remove('active');
    }
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
    collections: 'Collections',
  };

  $('pageTitle').textContent =
    titles[name] || 'Admin';

  if (name === 'collections') {
    loadCollections().catch((error) => {
      console.error(
        '[admin] collections load failed:',
        error
      );
    });
  }
}

/* =========================================================
   RESOURCES
========================================================= */

function renderResources(target, list) {
  if (!target) return;

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
              typeLabels[resource.resourceType] ||
              resource.resourceType
            )}
          </span>

          <h3>
            ${escapeHtml(resource.title)}
          </h3>

          <p>
            ${escapeHtml(
              resource.description ||
              resource.topic ||
              'No description.'
            )}
          </p>

          <span class="status-pill">
            ${escapeHtml(resource.status)}
          </span>
        </article>
      `
    )
    .join('');

  target
    .querySelectorAll('.resource-card')
    .forEach((card) => {
      card.addEventListener('click', () => {
        openEditor(card.dataset.resourceId);
      });
    });
}

async function loadResources(status = '') {
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
    (resource) =>
      resource.status === 'draft'
  );

  renderResources(
    $('dashboardDrafts'),
    drafts.slice(0, 6)
  );

  $('statTotal').textContent =
    resources.length;

  $('statDrafts').textContent =
    resources.filter(
      (resource) =>
        resource.status === 'draft'
    ).length;

  $('statPublished').textContent =
    resources.filter(
      (resource) =>
        resource.status === 'published'
    ).length;
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
      currentResource.description || '';

    $('editTags').value = (
      currentResource.tags || []
    ).join(', ');

    $('editFeatured').value =
      String(!!currentResource.featured);

    $('editRecommended').value =
      String(!!currentResource.recommended);

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
      currentResource.status === 'published'
        ? 'none'
        : '';

    showView('editor');
  } catch (error) {
    alert(error.message);
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
  button.textContent = 'Saving…';

  try {
    const data = await api(
      `/api/admin/resources/${currentResource.id}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          title:
            $('editTitle').value.trim(),

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

    currentResource = data.resource;

    $('editorStatus').textContent =
      currentResource.status;

    $('editorTitle').textContent =
      currentResource.title;

    $('editorMeta').textContent =
      `${typeLabels[currentResource.resourceType] || currentResource.resourceType} · ${currentResource.subject || 'No subject'} · Version ${currentResource.currentVersion || 1}`;

    await loadResources();

    alert('Saved.');
  } catch (error) {
    alert(error.message);
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

    currentResource = data.resource;

    $('editorStatus').textContent =
      'published';

    button.style.display =
      'none';

    await loadResources();

    alert(
      'Published successfully.'
    );
  } catch (error) {
    alert(error.message);
  } finally {
    button.disabled = false;
    button.textContent =
      'Publish';
  }
}

/* =========================================================
   GENERATION
========================================================= */

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
  } catch (error) {
    message.textContent =
      error.message;
  } finally {
    button.disabled = false;

    button.textContent =
      'Generate draft';
  }
}

/* =========================================================
   JOBS
========================================================= */

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

  $('jobsList').innerHTML =
    jobs
      .map(
        (job) => `
          <article class="job-card">

            <div>

              <h3>
                ${escapeHtml(
                  typeLabels[job.resourceType] ||
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
              job.status === 'queued' ||
              job.status === 'running'
                ? `
                  <button
                    class="secondary-button process-job"
                    data-job-id="${escapeHtml(job.id)}"
                  >
                    Continue
                  </button>
                `
                : `
                  <span class="status-pill">
                    ${escapeHtml(job.status)}
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
        () => {
          processJob(
            button.dataset.jobId
          );
        }
      );
    });
}

async function processJob(jobId) {
  const button =
    document.querySelector(
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
  } catch (error) {
    alert(error.message);

    if (button) {
      button.disabled = false;
      button.textContent =
        'Continue';
    }
  }
}

/* =========================================================
   COLLECTIONS
========================================================= */

function collectionStatusClass(status) {
  return status || 'draft';
}

function renderCollectionList() {
  const target =
    $('collectionList');

  const filter =
    $('collectionStatusFilter').value;

  const list = filter
    ? collections.filter(
        (collection) =>
          collection.status === filter
      )
    : collections;

  $('collectionCount').textContent =
    `${list.length} collection${list.length === 1 ? '' : 's'}`;

  if (!list.length) {
    target.innerHTML = `
      <div class="collection-empty-list">
        No collections found.
      </div>
    `;

    return;
  }

  target.innerHTML =
    list
      .map(
        (collection) => `
          <button
            type="button"
            class="collection-list-item ${
              currentCollection?.id === collection.id
                ? 'active'
                : ''
            }"
            data-collection-id="${escapeHtml(collection.id)}"
          >

            <h3>
              ${escapeHtml(
                collection.title ||
                'Untitled collection'
              )}
            </h3>

            <div class="collection-list-meta">

              <span class="collection-list-status">
                ${escapeHtml(
                  collectionStatusClass(
                    collection.status
                  )
                )}
              </span>

              <span>
                ${
                  Array.isArray(
                    collection.resourceIds
                  )
                    ? collection.resourceIds.length
                    : 0
                }
                resources
              </span>

            </div>

          </button>
        `
      )
      .join('');

  target
    .querySelectorAll(
      '.collection-list-item'
    )
    .forEach((button) => {
      button.addEventListener(
        'click',
        () => {
          openCollection(
            button.dataset.collectionId
          );
        }
      );
    });
}

async function loadCollections() {
  const filter =
    $('collectionStatusFilter').value;

  const query = filter
    ? `?status=${encodeURIComponent(filter)}`
    : '';

  const data = await api(
    `/api/admin/collections${query}`
  );

  collections =
    data.collections || [];

  renderCollectionList();
}

async function loadPublishedResources() {
  const data = await api(
    '/api/admin/resources?status=published'
  );

  publishedResources =
    data.resources || [];
}

function collectionEditorMarkup(
  collection
) {
  const resourceIds =
    Array.isArray(
      collection.resourceIds
    )
      ? collection.resourceIds
      : [];

  return `
    <div class="collection-editor">

      <div class="collection-editor-header">

        <div>

          <span class="collection-list-status">
            ${escapeHtml(
              collection.status || 'draft'
            )}
          </span>

          <h2>
            ${escapeHtml(
              collection.title ||
              'New Collection'
            )}
          </h2>

          <p>
            ${
              resourceIds.length
            }
            published resource${
              resourceIds.length === 1
                ? ''
                : 's'
            }
          </p>

        </div>

        <div class="collection-editor-actions">

          ${
            collection.status !==
            'published'
              ? `
                <button
                  type="button"
                  class="secondary-button"
                  id="collectionSaveButton"
                >
                  Save draft
                </button>

                <button
                  type="button"
                  class="primary-button"
                  id="collectionPublishButton"
                >
                  Publish
                </button>
              `
              : `
                <button
                  type="button"
                  class="secondary-button"
                  id="collectionSaveButton"
                >
                  Save changes
                </button>

                <button
                  type="button"
                  class="secondary-button"
                  id="collectionArchiveButton"
                >
                  Archive
                </button>
              `
          }

        </div>

      </div>

      <form
        id="collectionForm"
        class="collection-editor-form"
      >

        <div class="collection-form-section">

          <h3>
            Collection details
          </h3>

          <p>
            These details control how the collection
            appears in the public library.
          </p>

          <div class="collection-form-grid">

            <label>
              Title

              <input
                id="collectionTitle"
                required
                maxlength="160"
                value="${escapeHtml(
                  collection.title || ''
                )}"
                placeholder="Biology Revision Essentials"
              />
            </label>

            <label>
              Subject

              <input
                id="collectionSubject"
                maxlength="120"
                value="${escapeHtml(
                  collection.subject || ''
                )}"
                placeholder="Biology"
              />
            </label>

          </div>

          <label>
            Description

            <textarea
              id="collectionDescription"
              rows="4"
              maxlength="1000"
              placeholder="A focused collection of resources for..."
            >${escapeHtml(
              collection.description || ''
            )}</textarea>
          </label>

          <div class="collection-form-grid three">

            <label>
              Educational level

              <input
                id="collectionEducationalLevel"
                value="${escapeHtml(
                  collection.educationalLevel || ''
                )}"
                placeholder="Secondary"
              />
            </label>

            <label>
              Class / Level

              <input
                id="collectionClassLevel"
                value="${escapeHtml(
                  collection.classLevel || ''
                )}"
                placeholder="SS2"
              />
            </label>

            <label>
              Curriculum

              <input
                id="collectionCurriculum"
                value="${escapeHtml(
                  collection.curriculum || ''
                )}"
                placeholder="WAEC"
              />
            </label>

          </div>

          <label>
            Tags

            <input
              id="collectionTags"
              value="${escapeHtml(
                (collection.tags || []).join(', ')
              )}"
              placeholder="biology, revision, ss2"
            />
          </label>

        </div>

        <div class="collection-form-section">

          <h3>
            Library placement
          </h3>

          <p>
            Control how prominently this collection
            appears in the ready-made library.
          </p>

          <div class="collection-toggle-row">

            <label class="collection-toggle">

              <input
                id="collectionFeatured"
                type="checkbox"
                ${
                  collection.featured
                    ? 'checked'
                    : ''
                }
              />

              <span>
                Featured collection
              </span>

            </label>

            <label class="collection-toggle">

              <input
                id="collectionRecommended"
                type="checkbox"
                ${
                  collection.recommended
                    ? 'checked'
                    : ''
                }
              />

              <span>
                Recommended
              </span>

            </label>

          </div>

          <div
            class="collection-form-grid"
            style="margin-top: 14px;"
          >

            <label>
              Sort order

              <input
                id="collectionSortOrder"
                type="number"
                value="${Number(
                  collection.sortOrder || 0
                )}"
              />
            </label>

          </div>

        </div>

        <div class="collection-form-section">

          <h3>
            Resources
          </h3>

          <p>
            Only published ready-made resources can be
            added to a collection.
          </p>

          <div class="resource-picker">

            <div class="resource-picker-panel">

              <strong>
                Published resources
              </strong>

              <div
                class="resource-picker-search"
                style="margin-top:10px;"
              >

                <input
                  id="resourcePickerSearch"
                  placeholder="Search resources..."
                />

              </div>

              <div class="resource-picker-filters">

                <select
                  id="resourcePickerSubject"
                >
                  <option value="">
                    All subjects
                  </option>
                </select>

                <select
                  id="resourcePickerType"
                >
                  <option value="">
                    All types
                  </option>
                </select>

              </div>

              <div
                id="pickerResourceList"
                class="picker-resource-list"
              ></div>

            </div>

            <div class="resource-picker-panel">

              <strong>
                In this collection
              </strong>

              <div
                id="selectedResourceList"
                class="selected-resource-list"
                style="margin-top:10px;"
              ></div>

            </div>

          </div>

        </div>

        <div
          id="collectionMessage"
          class="collection-message"
          style="display:none;"
        ></div>

        <div class="collection-footer-actions">

          <button
            type="button"
            class="ghost-button"
            id="collectionCancelButton"
          >
            Cancel
          </button>

          <div class="collection-footer-right">

            ${
              collection.status !== 'archived'
                ? `
                  <button
                    type="button"
                    class="secondary-button"
                    id="collectionSaveBottomButton"
                  >
                    Save draft
                  </button>
                `
                : ''
            }

          </div>

        </div>

      </form>

    </div>
  `;
}

function renderResourcePicker() {
  const search =
    (
      $('resourcePickerSearch')?.value ||
      ''
    )
      .trim()
      .toLowerCase();

  const subject =
    $('resourcePickerSubject')?.value ||
    '';

  const type =
    $('resourcePickerType')?.value ||
    '';

  const selectedIds =
    new Set(
      currentCollection?.resourceIds ||
      []
    );

  const filtered =
    publishedResources.filter(
      (resource) => {
        const haystack = [
          resource.title,
          resource.description,
          resource.subject,
          resource.topic,
          ...(resource.tags || []),
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase();

        if (
          search &&
          !haystack.includes(search)
        ) {
          return false;
        }

        if (
          subject &&
          resource.subject !== subject
        ) {
          return false;
        }

        if (
          type &&
          resource.resourceType !== type
        ) {
          return false;
        }

        return true;
      }
    );

  const target =
    $('pickerResourceList');

  if (!target) return;

  if (!filtered.length) {
    target.innerHTML = `
      <div class="collection-empty-list">
        No matching published resources.
      </div>
    `;

    return;
  }

  target.innerHTML =
    filtered
      .map(
        (resource) => `
          <div class="picker-resource">

            <div class="picker-resource-main">

              <div class="picker-resource-title">
                ${escapeHtml(
                  resource.title ||
                  'Untitled'
                )}
              </div>

              <div class="picker-resource-meta">
                ${escapeHtml(
                  typeLabels[
                    resource.resourceType
                  ] ||
                  resource.resourceType ||
                  'Resource'
                )}

                ${
                  resource.subject
                    ? ` · ${escapeHtml(resource.subject)}`
                    : ''
                }

                ${
                  resource.classLevel
                    ? ` · ${escapeHtml(resource.classLevel)}`
                    : ''
                }
              </div>

            </div>

            <button
              type="button"
              class="${
                selectedIds.has(resource.id)
                  ? 'secondary-button'
                  : 'primary-button'
              } picker-add-resource"
              data-resource-id="${escapeHtml(resource.id)}"
              ${
                selectedIds.has(resource.id)
                  ? 'disabled'
                  : ''
              }
            >
              ${
                selectedIds.has(resource.id)
                  ? 'Added'
                  : 'Add'
              }
            </button>

          </div>
        `
      )
      .join('');

  target
    .querySelectorAll(
      '.picker-add-resource'
    )
    .forEach((button) => {
      button.addEventListener(
        'click',
        () => {
          addResourceToCollection(
            button.dataset.resourceId
          );
        }
      );
    });
}

function renderSelectedResources() {
  const target =
    $('selectedResourceList');

  if (!target) return;

  const ids =
    currentCollection?.resourceIds ||
    [];

  if (!ids.length) {
    target.innerHTML = `
      <div class="collection-empty-list">
        No resources selected yet.
      </div>
    `;

    return;
  }

  const resourcesById =
    new Map(
      publishedResources.map(
        (resource) => [
          resource.id,
          resource,
        ]
      )
    );

  target.innerHTML =
    ids
      .map((resourceId, index) => {
        const resource =
          resourcesById.get(
            resourceId
          );

        if (!resource) {
          return `
            <div class="selected-resource">
              <div class="selected-resource-number">
                ${index + 1}
              </div>

              <div class="selected-resource-main">
                <div class="selected-resource-title">
                  Missing resource
                </div>

                <div class="selected-resource-meta">
                  ${escapeHtml(resourceId)}
                </div>
              </div>

              <button
                type="button"
                class="icon-button remove-selected-resource"
                data-resource-id="${escapeHtml(resourceId)}"
                title="Remove"
              >
                ×
              </button>
            </div>
          `;
        }

        return `
          <div class="selected-resource">

            <div class="selected-resource-number">
              ${index + 1}
            </div>

            <div class="selected-resource-main">

              <div class="selected-resource-title">
                ${escapeHtml(
                  resource.title ||
                  'Untitled'
                )}
              </div>

              <div class="selected-resource-meta">
                ${escapeHtml(
                  typeLabels[
                    resource.resourceType
                  ] ||
                  resource.resourceType ||
                  'Resource'
                )}
              </div>

            </div>

            <div class="selected-resource-actions">

              <button
                type="button"
                class="icon-button move-resource-up"
                data-index="${index}"
                ${
                  index === 0
                    ? 'disabled'
                    : ''
                }
                title="Move up"
              >
                ↑
              </button>

              <button
                type="button"
                class="icon-button move-resource-down"
                data-index="${index}"
                ${
                  index === ids.length - 1
                    ? 'disabled'
                    : ''
                }
                title="Move down"
              >
                ↓
              </button>

              <button
                type="button"
                class="icon-button remove-selected-resource"
                data-resource-id="${escapeHtml(resource.id)}"
                title="Remove"
              >
                ×
              </button>

            </div>

          </div>
        `;
      })
      .join('');

  target
    .querySelectorAll(
      '.remove-selected-resource'
    )
    .forEach((button) => {
      button.addEventListener(
        'click',
        () => {
          removeResourceFromCollection(
            button.dataset.resourceId
          );
        }
      );
    });

  target
    .querySelectorAll(
      '.move-resource-up'
    )
    .forEach((button) => {
      button.addEventListener(
        'click',
        () => {
          moveCollectionResource(
            Number(button.dataset.index),
            -1
          );
        }
      );
    });

  target
    .querySelectorAll(
      '.move-resource-down'
    )
    .forEach((button) => {
      button.addEventListener(
        'click',
        () => {
          moveCollectionResource(
            Number(button.dataset.index),
            1
          );
        }
      );
    });
}

function populateResourceFilters() {
  const subjectSelect =
    $('resourcePickerSubject');

  const typeSelect =
    $('resourcePickerType');

  if (!subjectSelect || !typeSelect) {
    return;
  }

  const subjects = [
    ...new Set(
      publishedResources
        .map(
          (resource) =>
            resource.subject
        )
        .filter(Boolean)
    ),
  ].sort();

  const types = [
    ...new Set(
      publishedResources
        .map(
          (resource) =>
            resource.resourceType
        )
        .filter(Boolean)
    ),
  ].sort();

  subjectSelect.innerHTML = `
    <option value="">
      All subjects
    </option>

    ${subjects
      .map(
        (subject) => `
          <option value="${escapeHtml(subject)}">
            ${escapeHtml(subject)}
          </option>
        `
      )
      .join('')}
  `;

  typeSelect.innerHTML = `
    <option value="">
      All types
    </option>

    ${types
      .map(
        (type) => `
          <option value="${escapeHtml(type)}">
            ${escapeHtml(
              typeLabels[type] || type
            )}
          </option>
        `
      )
      .join('')}
  `;
}

function addResourceToCollection(
  resourceId
) {
  if (!currentCollection) return;

  const ids = [
    ...(currentCollection.resourceIds || []),
  ];

  if (ids.includes(resourceId)) {
    return;
  }

  ids.push(resourceId);

  currentCollection = {
    ...currentCollection,
    resourceIds: ids,
  };

  renderSelectedResources();
  renderResourcePicker();
  updateCollectionHeader();
}

function removeResourceFromCollection(
  resourceId
) {
  if (!currentCollection) return;

  currentCollection = {
    ...currentCollection,

    resourceIds: (
      currentCollection.resourceIds || []
    ).filter(
      (id) => id !== resourceId
    ),
  };

  renderSelectedResources();
  renderResourcePicker();
  updateCollectionHeader();
}

function moveCollectionResource(
  index,
  direction
) {
  if (!currentCollection) return;

  const ids = [
    ...(currentCollection.resourceIds || []),
  ];

  const newIndex =
    index + direction;

  if (
    newIndex < 0 ||
    newIndex >= ids.length
  ) {
    return;
  }

  [
    ids[index],
    ids[newIndex],
  ] = [
    ids[newIndex],
    ids[index],
  ];

  currentCollection = {
    ...currentCollection,
    resourceIds: ids,
  };

  renderSelectedResources();
  renderResourcePicker();
}

function updateCollectionHeader() {
  const header =
    $('collectionEditor')
      ?.querySelector(
        '.collection-editor-header p'
      );

  if (!header) return;

  const count =
    currentCollection?.resourceIds
      ?.length || 0;

  header.textContent =
    `${count} published resource${count === 1 ? '' : 's'}`;
}

function showCollectionMessage(
  message,
  type = ''
) {
  const element =
    $('collectionMessage');

  if (!element) return;

  element.textContent =
    message;

  element.className =
    `collection-message ${type}`;

  element.style.display =
    message ? '' : 'none';
}

function readCollectionForm() {
  return {
    title:
      $('collectionTitle').value.trim(),

    description:
      $('collectionDescription').value.trim(),

    subject:
      $('collectionSubject').value.trim(),

    educationalLevel:
      $('collectionEducationalLevel')
        .value.trim(),

    classLevel:
      $('collectionClassLevel')
        .value.trim(),

    curriculum:
      $('collectionCurriculum')
        .value.trim(),

    tags:
      $('collectionTags')
        .value
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),

    resourceIds:
      currentCollection?.resourceIds || [],

    featured:
      $('collectionFeatured').checked,

    recommended:
      $('collectionRecommended').checked,

    sortOrder:
      Number(
        $('collectionSortOrder').value
      ) || 0,
  };
}

async function saveCollection(
  publish = false
) {
  if (!currentCollection) {
    return;
  }

  const form =
    $('collectionForm');

  if (!form.reportValidity()) {
    return;
  }

  const payload =
    readCollectionForm();

  if (
    publish &&
    !payload.resourceIds.length
  ) {
    showCollectionMessage(
      'A collection needs at least one published resource before it can be published.',
      'error'
    );

    return;
  }

  const saveButtons =
    document.querySelectorAll(
      '#collectionSaveButton, #collectionSaveBottomButton, #collectionPublishButton'
    );

  saveButtons.forEach(
    (button) => {
      button.disabled = true;
    }
  );

  showCollectionMessage(
    publish
      ? 'Publishing…'
      : 'Saving…'
  );

  try {
    let data;

    if (currentCollection.isNew) {
      data = await api(
        '/api/admin/collections',
        {
          method: 'POST',
          body: JSON.stringify(
            payload
          ),
        }
      );
    } else {
      data = await api(
        `/api/admin/collections/${currentCollection.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify(
            payload
          ),
        }
      );
    }

    currentCollection =
      data.collection;

    if (publish) {
      data = await api(
        `/api/admin/collections/${currentCollection.id}/publish`,
        {
          method: 'POST',
        }
      );

      currentCollection =
        data.collection;
    }

    await loadCollections();

    renderCollectionList();

    renderCurrentCollection();

    showCollectionMessage(
      publish
        ? 'Collection published successfully.'
        : 'Collection saved.',
      'success'
    );
  } catch (error) {
    showCollectionMessage(
      error.message,
      'error'
    );
  } finally {
    saveButtons.forEach(
      (button) => {
        button.disabled = false;
      }
    );
  }
}

async function archiveCollection() {
  if (!currentCollection?.id) {
    return;
  }

  if (
    !confirm(
      'Archive this collection? It will no longer appear in the public library.'
    )
  ) {
    return;
  }

  try {
    const data = await api(
      `/api/admin/collections/${currentCollection.id}/archive`,
      {
        method: 'POST',
      }
    );

    currentCollection =
      data.collection;

    await loadCollections();

    renderCollectionList();

    renderCurrentCollection();
  } catch (error) {
    showCollectionMessage(
      error.message,
      'error'
    );
  }
}

function renderCurrentCollection() {
  if (!currentCollection) {
    $('collectionEditor').innerHTML = `
      <div class="collection-empty-editor">

        <div class="collection-empty-icon">
          ▦
        </div>

        <h3>
          Select a collection
        </h3>

        <p>
          Choose an existing collection or create
          a new one to start building your library.
        </p>

        <button
          id="emptyNewCollectionButton"
          class="secondary-button"
        >
          New Collection
        </button>

      </div>
    `;

    $('emptyNewCollectionButton')
      .addEventListener(
        'click',
        createNewCollection
      );

    return;
  }

  $('collectionEditor').innerHTML =
    collectionEditorMarkup(
      currentCollection
    );

  populateResourceFilters();

  renderResourcePicker();

  renderSelectedResources();

  $('collectionSaveButton')
    ?.addEventListener(
      'click',
      () => saveCollection(false)
    );

  $('collectionSaveBottomButton')
    ?.addEventListener(
      'click',
      () => saveCollection(false)
    );

  $('collectionPublishButton')
    ?.addEventListener(
      'click',
      () => saveCollection(true)
    );

  $('collectionArchiveButton')
    ?.addEventListener(
      'click',
      archiveCollection
    );

  $('collectionCancelButton')
    ?.addEventListener(
      'click',
      () => {
        currentCollection = null;
        renderCollectionList();
        renderCurrentCollection();
      }
    );

  $('resourcePickerSearch')
    ?.addEventListener(
      'input',
      renderResourcePicker
    );

  $('resourcePickerSubject')
    ?.addEventListener(
      'change',
      renderResourcePicker
    );

  $('resourcePickerType')
    ?.addEventListener(
      'change',
      renderResourcePicker
    );
}

async function openCollection(
  collectionId
) {
  try {
    const data = await api(
      `/api/admin/collections/${collectionId}`
    );

    currentCollection =
      data.collection;

    currentCollection.isNew =
      false;

    renderCollectionList();

    renderCurrentCollection();
  } catch (error) {
    alert(error.message);
  }
}

async function createNewCollection() {
  if (!publishedResources.length) {
    try {
      await loadPublishedResources();
    } catch (error) {
      alert(error.message);
      return;
    }
  }

  currentCollection = {
    isNew: true,
    id: null,
    title: '',
    description: '',
    subject: '',
    educationalLevel: '',
    classLevel: '',
    curriculum: '',
    tags: [],
    resourceIds: [],
    status: 'draft',
    featured: false,
    recommended: false,
    sortOrder: 0,
  };

  renderCollectionList();

  renderCurrentCollection();
}

function setupCollectionControls() {
  $('newCollectionButton')
    ?.addEventListener(
      'click',
      createNewCollection
    );

  $('emptyNewCollectionButton')
    ?.addEventListener(
      'click',
      createNewCollection
    );

  $('collectionStatusFilter')
    ?.addEventListener(
      'change',
      async () => {
        currentCollection = null;

        await loadCollections();

        renderCurrentCollection();
      }
    );
}

/* =========================================================
   NAVIGATION
========================================================= */

function setupNavigation() {
  document
    .querySelectorAll('[data-view]')
    .forEach((button) => {
      button.addEventListener(
        'click',
        () => {
          showView(
            button.dataset.view
          );
        }
      );
    });
}

function setupFilters() {
  document
    .querySelectorAll('.filter-button')
    .forEach((button) => {
      button.addEventListener(
        'click',
        async () => {
          document
            .querySelectorAll(
              '.filter-button'
            )
            .forEach((item) => {
              item.classList.remove(
                'active'
              );
            });

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

/* =========================================================
   INIT
========================================================= */

async function init() {
  const user =
    await Auth.requireAuthOrRedirect();

  if (!user) return;

  setupNavigation();
  setupFilters();
  setupCollectionControls();

  $('logoutButton')
    .addEventListener(
      'click',
      async () => {
        await Auth.logOut();

        window.location.href =
          '/login.html';
      }
    );

  $('generateForm')
    .addEventListener(
      'submit',
      generateResource
    );

  $('saveButton')
    .addEventListener(
      'click',
      saveResource
    );

  $('publishButton')
    .addEventListener(
      'click',
      publishResource
    );

  $('backToResources')
    .addEventListener(
      'click',
      async () => {
        showView('resources');

        await loadResources();
      }
    );

  try {
    await loadResources();

    await loadJobs();

    await loadPublishedResources();
  } catch (error) {
    console.error(
      '[admin] initialization failed:',
      error
    );

    document.body.innerHTML = `
      <div style="
        padding:40px;
        font-family:system-ui;
      ">

        <h2>
          Admin access required
        </h2>

        <p>
          ${escapeHtml(
            error.message
          )}
        </p>

      </div>
    `;
  }
}

init();
