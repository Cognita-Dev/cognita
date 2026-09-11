// js/ready-made-resources.js

const READY_MADE_WORKER_URL =
  'https://cognita.cognitai.workers.dev';

const READY_MADE_TYPES = [
  {
    type: 'lesson_plan',
    label: 'Lesson Plans',
    icon: 'chalkboard-teacher',
  },
  {
    type: 'worksheet',
    label: 'Worksheets',
    icon: 'note-pencil',
  },
  {
    type: 'exam',
    label: 'Examinations',
    icon: 'exam',
  },
  {
    type: 'scheme_of_work',
    label: 'Schemes of Work',
    icon: 'calendar-check',
  },
  {
    type: 'quiz',
    label: 'Quizzes',
    icon: 'question',
  },
  {
    type: 'study_guide',
    label: 'Study Guides',
    icon: 'book-open-text',
  },
  {
    type: 'teaching_guide',
    label: 'Teaching Guides',
    icon: 'chalkboard',
  },
  {
    type: 'classroom_activity',
    label: 'Classroom Activities',
    icon: 'users-three',
  },
  {
    type: 'assignment',
    label: 'Assignments',
    icon: 'clipboard-text',
  },
  {
    type: 'marking_scheme',
    label: 'Marking Schemes',
    icon: 'check-square-offset',
  },
  {
    type: 'rubric',
    label: 'Rubrics',
    icon: 'table',
  },
  {
    type: 'flashcards',
    label: 'Flashcards',
    icon: 'cards',
  },
  {
    type: 'student_handout',
    label: 'Student Handouts',
    icon: 'file-text',
  },
  {
    type: 'presentation',
    label: 'Presentations',
    icon: 'presentation-chart',
  },
  {
    type: 'project',
    label: 'Projects',
    icon: 'flag-checkered',
  },
  {
    type: 'test',
    label: 'Tests',
    icon: 'pencil-simple-line',
  },
];

let allReadyMadeResources = [];
let activeType = '';

(async function initReadyMadeResources() {
  const user =
    await window.Auth.requireAuthOrRedirect();

  if (!user) return;

  renderReadyMadeTypeFilters();

  await loadReadyMadeResources();
})();

async function loadReadyMadeResources() {
  const list =
    document.getElementById(
      'readyMadeResourcesList'
    );

  if (!list) return;

  list.innerHTML = `
    <div class="ready-made-loading">
      <span class="ready-made-loading-dot"></span>
      <span>Loading resources…</span>
    </div>
  `;

  try {
    const response =
      await window.Auth.authedFetch(
        READY_MADE_WORKER_URL +
          '/api/ready-made-resources'
      );

    if (!response.ok) {
      throw new Error(
        'Could not load resources.'
      );
    }

    const data =
      await response.json();

    allReadyMadeResources =
      Array.isArray(data.resources)
        ? data.resources
        : [];

    renderReadyMadeResources();

    await openResourceFromQuery();
  } catch (e) {
    console.error(
      '[ready-made] load failed:',
      e.message
    );

    list.innerHTML = `
      <div class="ready-made-empty">
        <i class="ph ph-cloud-slash"></i>

        <h3>
          Couldn’t load resources
        </h3>

        <p>
          Please try again in a moment.
        </p>

        <button
          type="button"
          class="ready-made-retry"
          id="readyMadeRetry"
        >
          Try again
        </button>
      </div>
    `;

    document
      .getElementById(
        'readyMadeRetry'
      )
      ?.addEventListener(
        'click',
        loadReadyMadeResources
      );
  }
}

async function openResourceFromQuery() {
  const params =
    new URLSearchParams(
      window.location.search
    );

  const resourceId =
    params.get('resource');

  if (!resourceId) return;

  const resource =
    allReadyMadeResources.find(
      (item) =>
        item.id === resourceId
    );

  if (!resource) return;

  await openReadyMadeResource(
    resourceId
  );

  const panel =
    document.getElementById(
      'readyMadePreviewPanel'
    );

  if (panel) {
    window.setTimeout(() => {
      panel.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    }, 50);
  }
}

function renderReadyMadeTypeFilters() {
  const container =
    document.getElementById(
      'readyMadeTypeFilters'
    );

  if (!container) return;

  container.innerHTML = [
    `
      <button
        type="button"
        class="ready-made-filter is-active"
        data-type=""
      >
        All
      </button>
    `,
    ...READY_MADE_TYPES.map(
      (item) => `
        <button
          type="button"
          class="ready-made-filter"
          data-type="${escapeHtml(
            item.type
          )}"
        >
          <i class="ph ph-${escapeHtml(
            item.icon
          )}"></i>

          ${escapeHtml(
            item.label
          )}
        </button>
      `
    ),
  ].join('');

  container
    .querySelectorAll(
      '.ready-made-filter'
    )
    .forEach((button) => {
      button.addEventListener(
        'click',
        () => {
          activeType =
            button.dataset.type ||
            '';

          container
            .querySelectorAll(
              '.ready-made-filter'
            )
            .forEach((item) =>
              item.classList.remove(
                'is-active'
              )
            );

          button.classList.add(
            'is-active'
          );

          renderReadyMadeResources();
        }
      );
    });
}

function renderReadyMadeResources() {
  const list =
    document.getElementById(
      'readyMadeResourcesList'
    );

  if (!list) return;

  let resources =
    allReadyMadeResources;

  if (activeType) {
    resources =
      resources.filter(
        (resource) =>
          resource.resourceType ===
          activeType
      );
  }

  if (!resources.length) {
    list.innerHTML = `
      <div class="ready-made-empty">

        <i class="ph ph-books"></i>

        <h3>
          No resources here yet
        </h3>

        <p>
          New curated resources will appear here
          as Cognita publishes them.
        </p>

      </div>
    `;

    return;
  }

  list.innerHTML =
    resources
      .map(
        (resource) =>
          renderResourceCard(
            resource
          )
      )
      .join('');

  list
    .querySelectorAll(
      '[data-ready-made-id]'
    )
    .forEach((card) => {
      card.addEventListener(
        'click',
        () =>
          openReadyMadeResource(
            card.dataset.readyMadeId
          )
      );

      card.addEventListener(
        'keydown',
        (event) => {
          if (
            event.key ===
              'Enter' ||
            event.key ===
              ' '
          ) {
            event.preventDefault();

            openReadyMadeResource(
              card.dataset.readyMadeId
            );
          }
        }
      );
    });
}

function renderResourceCard(
  resource
) {
  const type =
    READY_MADE_TYPES.find(
      (item) =>
        item.type ===
        resource.resourceType
    );

  const meta = [
    resource.subject,
    resource.classLevel,
    resource.curriculum,
  ].filter(Boolean);

  return `
    <article
      class="ready-made-card"
      data-ready-made-id="${escapeHtml(
        resource.id
      )}"
      tabindex="0"
      role="button"
      aria-label="Open ${escapeHtml(
        resource.title
      )}"
    >

      <div class="ready-made-card-top">

        <div class="ready-made-card-icon">
          <i class="ph ph-${
            type
              ? escapeHtml(
                  type.icon
                )
              : 'file-text'
          }"></i>
        </div>

        <div class="ready-made-card-badges">

          ${
            resource.featured
              ? `
                <span class="ready-made-badge featured">
                  Featured
                </span>
              `
              : ''
          }

          ${
            resource.recommended
              ? `
                <span class="ready-made-badge">
                  Recommended
                </span>
              `
              : ''
          }

        </div>

      </div>

      <div class="ready-made-card-content">

        <span class="ready-made-card-type">
          ${
            type
              ? escapeHtml(
                  type.label
                )
              : escapeHtml(
                  resource.resourceType
                )
          }
        </span>

        <h3>
          ${escapeHtml(
            resource.title
          )}
        </h3>

        ${
          resource.description
            ? `
              <p>
                ${escapeHtml(
                  resource.description
                )}
              </p>
            `
            : ''
        }

        ${
          meta.length
            ? `
              <div class="ready-made-card-meta">

                ${meta
                  .map(
                    (item) =>
                      `<span>${escapeHtml(
                        item
                      )}</span>`
                  )
                  .join('')}

              </div>
            `
            : ''
        }

      </div>

      <div class="ready-made-card-arrow">
        <i class="ph ph-arrow-up-right"></i>
      </div>

    </article>
  `;
}

async function openReadyMadeResource(
  resourceId
) {
  const resource =
    allReadyMadeResources.find(
      (item) =>
        item.id === resourceId
    );

  if (!resource) return;

  const panel =
    document.getElementById(
      'readyMadePreviewPanel'
    );

  const body =
    document.getElementById(
      'readyMadePreviewBody'
    );

  const title =
    document.getElementById(
      'readyMadePreviewTitle'
    );

  if (
    !panel ||
    !body ||
    !title
  ) {
    return;
  }

  title.textContent =
    resource.title;

  panel.hidden = false;

  if (
    window.ResourceRenderers &&
    typeof window
      .ResourceRenderers
      .render === 'function'
  ) {
    body.innerHTML =
      window.ResourceRenderers.render(
        resource.resourceType,
        resource.structuredContent
      );
  } else {
    body.innerHTML =
      renderFallbackPreview(
        resource.structuredContent
      );
  }

  renderDownloadButtons(
    resource
  );
}

function renderDownloadButtons(
  resource
) {
  const container =
    document.getElementById(
      'readyMadeDownloadActions'
    );

  if (!container) return;

  const refs =
    resource.fileReferences ||
    {};

  const formats =
    [
      'pdf',
      'docx',
      'pptx',
    ].filter(
      (format) =>
        refs[format]
    );

  if (!formats.length) {
    container.innerHTML = '';

    return;
  }

  container.innerHTML =
    formats
      .map(
        (format) => `
          <button
            type="button"
            class="ready-made-download-btn"
            data-format="${format}"
          >
            <i class="ph ph-download-simple"></i>
            Download ${format.toUpperCase()}
          </button>
        `
      )
      .join('');

  container
    .querySelectorAll(
      '[data-format]'
    )
    .forEach((button) => {
      button.addEventListener(
        'click',
        () =>
          downloadReadyMadeResource(
            resource.id,
            button.dataset.format,
            button
          )
      );
    });
}

async function downloadReadyMadeResource(
  resourceId,
  format,
  button
) {
  const original =
    button.innerHTML;

  button.disabled = true;

  button.innerHTML =
    '<i class="ph ph-spinner ph-spin"></i> Preparing…';

  try {
    const response =
      await window.Auth.authedFetch(
        READY_MADE_WORKER_URL +
          '/api/ready-made-resources/' +
          encodeURIComponent(
            resourceId
          ) +
          '/download',
        {
          method: 'POST',
          headers: {
            'Content-Type':
              'application/json',
          },
          body: JSON.stringify({
            format,
          }),
        }
      );

    const data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.error ||
          'Download unavailable.'
      );
    }

    window.location.href =
      data.downloadUrl;
  } catch (e) {
    console.error(
      '[ready-made] download failed:',
      e.message
    );

    alert(
      e.message ||
        'Could not prepare the download.'
    );
  } finally {
    button.disabled = false;
    button.innerHTML =
      original;
  }
}

function renderFallbackPreview(
  content
) {
  if (!content) {
    return `
      <p>
        No preview available.
      </p>
    `;
  }

  return Object.entries(
    content
  )
    .filter(
      ([key]) =>
        key !== 'title'
    )
    .map(
      ([key, value]) => `
        <section
          class="ready-made-fallback-section"
        >

          <h3>
            ${escapeHtml(
              key
                .replace(
                  /([A-Z])/g,
                  ' $1'
                )
                .replace(
                  /^./,
                  (c) =>
                    c.toUpperCase()
                )
            )}
          </h3>

          <p>
            ${escapeHtml(
              typeof value ===
                'string'
                ? value
                : JSON.stringify(
                    value
                  )
            )}
          </p>

        </section>
      `
    )
    .join('');
}

function escapeHtml(value) {
  return String(
    value ?? ''
  )
    .replace(
      /&/g,
      '&amp;'
    )
    .replace(
      /</g,
      '&lt;'
    )
    .replace(
      />/g,
      '&gt;'
    )
    .replace(
      /"/g,
      '&quot;'
    )
    .replace(
      /'/g,
      '&#039;'
    );
}
