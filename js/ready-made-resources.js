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
let searchQuery = '';
let sortMode = 'recommended';

(async function initReadyMadeResources() {
  const user =
    await window.Auth.requireAuthOrRedirect();

  if (!user) return;

  readSearchQueryFromUrl();
  renderReadyMadeTypeFilters();
  renderReadyMadeToolbar();

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

function readSearchQueryFromUrl() {
  const params =
    new URLSearchParams(
      window.location.search
    );

  const query =
    params.get('q');

  if (query) {
    searchQuery = query.trim();
  }
}

function updateSearchQueryInUrl() {
  const url =
    new URL(window.location.href);

  if (searchQuery) {
    url.searchParams.set(
      'q',
      searchQuery
    );
  } else {
    url.searchParams.delete('q');
  }

  window.history.replaceState(
    {},
    '',
    url.toString()
  );
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

function renderReadyMadeToolbar() {
  const filters =
    document.getElementById(
      'readyMadeTypeFilters'
    );

  if (!filters) return;

  const existing =
    document.getElementById(
      'readyMadeToolbar'
    );

  if (existing) return;

  const toolbar =
    document.createElement('div');

  toolbar.id =
    'readyMadeToolbar';

  toolbar.className =
    'ready-made-toolbar';

  toolbar.innerHTML = `
    <div class="ready-made-search">
      <i class="ph ph-magnifying-glass"></i>

      <input
        id="readyMadeSearch"
        type="search"
        autocomplete="off"
        placeholder="Search resources…"
        aria-label="Search ready-made resources"
        value="${escapeHtml(
          searchQuery
        )}"
      />

      <button
        type="button"
        class="ready-made-search-clear"
        id="readyMadeSearchClear"
        aria-label="Clear search"
        ${searchQuery ? '' : 'hidden'}
      >
        <i class="ph ph-x"></i>
      </button>
    </div>

    <div class="ready-made-toolbar-right">
      <span
        class="ready-made-result-count"
        id="readyMadeResultCount"
      ></span>

      <label class="ready-made-sort">
        <span>Sort</span>

        <select
          id="readyMadeSort"
          aria-label="Sort resources"
        >
          <option value="recommended">
            Recommended
          </option>
          <option value="newest">
            Newest
          </option>
          <option value="alphabetical">
            A–Z
          </option>
        </select>
      </label>
    </div>
  `;

  filters.insertAdjacentElement(
    'afterend',
    toolbar
  );

  const input =
    document.getElementById(
      'readyMadeSearch'
    );

  const clear =
    document.getElementById(
      'readyMadeSearchClear'
    );

  const sort =
    document.getElementById(
      'readyMadeSort'
    );

  input?.addEventListener(
    'input',
    () => {
      searchQuery =
        input.value.trim();

      if (clear) {
        clear.hidden =
          !searchQuery;
      }

      updateSearchQueryInUrl();
      renderReadyMadeResources();
    }
  );

  clear?.addEventListener(
    'click',
    () => {
      searchQuery = '';

      if (input) {
        input.value = '';
        input.focus();
      }

      clear.hidden = true;

      updateSearchQueryInUrl();
      renderReadyMadeResources();
    }
  );

  sort?.addEventListener(
    'change',
    () => {
      sortMode =
        sort.value ||
        'recommended';

      renderReadyMadeResources();
    }
  );
}

function getSearchableText(resource) {
  const values = [
    resource.title,
    resource.description,
    resource.subject,
    resource.educationalLevel,
    resource.classLevel,
    resource.curriculum,
    resource.topic,
    resource.resourceType,
    ...(Array.isArray(resource.tags)
      ? resource.tags
      : []),
  ];

  return values
    .filter(Boolean)
    .map((value) =>
      String(value).toLowerCase()
    )
    .join(' ');
}

function matchesSearch(resource) {
  if (!searchQuery) return true;

  const query =
    searchQuery.toLowerCase();

  return getSearchableText(
    resource
  ).includes(query);
}

function getResourceTimestamp(resource) {
  const value =
    resource.publishedAt ||
    resource.updatedAt ||
    resource.createdAt;

  if (!value) return 0;

  if (
    typeof value === 'object' &&
    value.seconds
  ) {
    return (
      Number(value.seconds) *
      1000
    );
  }

  const timestamp =
    new Date(value).getTime();

  return Number.isNaN(timestamp)
    ? 0
    : timestamp;
}

function sortResources(resources) {
  const sorted =
    [...resources];

  if (
    sortMode ===
    'alphabetical'
  ) {
    return sorted.sort(
      (a, b) =>
        String(
          a.title || ''
        ).localeCompare(
          String(
            b.title || ''
          ),
          undefined,
          {
            sensitivity:
              'base',
          }
        )
    );
  }

  if (
    sortMode ===
    'newest'
  ) {
    return sorted.sort(
      (a, b) =>
        getResourceTimestamp(
          b
        ) -
        getResourceTimestamp(
          a
        )
    );
  }

  return sorted.sort(
    (a, b) => {
      const featuredDifference =
        Number(
          Boolean(
            b.featured
          )
        ) -
        Number(
          Boolean(
            a.featured
          )
        );

      if (
        featuredDifference !==
        0
      ) {
        return featuredDifference;
      }

      const recommendedDifference =
        Number(
          Boolean(
            b.recommended
          )
        ) -
        Number(
          Boolean(
            a.recommended
          )
        );

      if (
        recommendedDifference !==
        0
      ) {
        return recommendedDifference;
      }

      const sortOrderDifference =
        Number(
          a.sortOrder ??
            999999
        ) -
        Number(
          b.sortOrder ??
            999999
        );

      if (
        sortOrderDifference !==
        0
      ) {
        return sortOrderDifference;
      }

      return (
        getResourceTimestamp(
          b
        ) -
        getResourceTimestamp(
          a
        )
      );
    }
  );
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

  resources =
    resources.filter(
      matchesSearch
    );

  resources =
    sortResources(
      resources
    );

  updateResultCount(
    resources.length
  );

  if (!resources.length) {
    renderEmptyState(
      list
    );

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
            card.dataset
              .readyMadeId
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
              card.dataset
                .readyMadeId
            );
          }
        }
      );
    });
}

function updateResultCount(count) {
  const element =
    document.getElementById(
      'readyMadeResultCount'
    );

  if (!element) return;

  const total =
    allReadyMadeResources.length;

  if (
    searchQuery ||
    activeType
  ) {
    element.textContent =
      `${count} of ${total} resource${
        total === 1
          ? ''
          : 's'
      }`;
    return;
  }

  element.textContent =
    `${count} resource${
      count === 1
        ? ''
        : 's'
    }`;
}

function renderEmptyState(list) {
  const hasSearch =
    Boolean(searchQuery);

  const hasFilter =
    Boolean(activeType);

  let icon = 'books';
  let heading =
    'No resources here yet';
  let message =
    'New curated resources will appear here as Cognita publishes them.';

  if (hasSearch) {
    icon = 'magnifying-glass';
    heading =
      'No matching resources';
    message =
      `We couldn't find anything matching “${escapeHtml(
        searchQuery
      )}”. Try another search or clear the search.`;
  } else if (hasFilter) {
    icon = 'folder-simple';
    heading =
      'Nothing in this category yet';
    message =
      'Try another resource type or browse all resources.';
  }

  list.innerHTML = `
    <div class="ready-made-empty">
      <i class="ph ph-${icon}"></i>

      <h3>
        ${heading}
      </h3>

      <p>
        ${message}
      </p>

      ${
        hasSearch
          ? `
            <button
              type="button"
              class="ready-made-retry"
              id="readyMadeClearSearch"
            >
              Clear search
            </button>
          `
          : ''
      }
    </div>
  `;

  document
    .getElementById(
      'readyMadeClearSearch'
    )
    ?.addEventListener(
      'click',
      () => {
        searchQuery = '';

        const input =
          document.getElementById(
            'readyMadeSearch'
          );

        const clear =
          document.getElementById(
            'readyMadeSearchClear'
          );

        if (input) {
          input.value = '';
          input.focus();
        }

        if (clear) {
          clear.hidden = true;
        }

        updateSearchQueryInUrl();
        renderReadyMadeResources();
      }
    );
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
