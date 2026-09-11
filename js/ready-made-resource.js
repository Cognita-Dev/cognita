const WORKER_URL =
  'https://cognita.cognitai.workers.dev';

const RESOURCE_TYPES = {
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

const RESOURCE_ICONS = {
  lesson_plan: 'chalkboard-teacher',
  worksheet: 'note-pencil',
  exam: 'exam',
  scheme_of_work: 'calendar-check',
  quiz: 'question',
  study_guide: 'book-open-text',
  teaching_guide: 'chalkboard',
  classroom_activity: 'users-three',
  assignment: 'clipboard-text',
  marking_scheme: 'check-square-offset',
  rubric: 'table',
  flashcards: 'cards',
  student_handout: 'file-text',
  presentation: 'presentation-chart',
  project: 'flag-checkered',
  test: 'pencil-simple-line',
};

const params = new URLSearchParams(
  window.location.search
);

const resourceId = params.get('id');

let currentResource = null;

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function resourceLabel(type) {
  return (
    RESOURCE_TYPES[type] ||
    String(type || 'Resource')
  );
}

function resourceIcon(type) {
  return (
    RESOURCE_ICONS[type] ||
    'file-text'
  );
}

function formatDate(value) {
  if (!value) return '';

  let date;

  if (
    typeof value === 'object' &&
    value.seconds
  ) {
    date = new Date(
      Number(value.seconds) * 1000
    );
  } else {
    date = new Date(value);
  }

  if (Number.isNaN(date.getTime())) {
    return '';
  }

  return new Intl.DateTimeFormat(
    undefined,
    {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }
  ).format(date);
}

async function api(path, options = {}) {
  const response =
    await window.Auth.authedFetch(
      WORKER_URL + path,
      options
    );

  let data = null;

  try {
    data = await response.json();
  } catch (_) {
    data = null;
  }

  if (!response.ok) {
    throw new Error(
      data?.error ||
      'Could not load this resource.'
    );
  }

  return data;
}

async function loadResource() {
  if (!resourceId) {
    throw new Error(
      'No resource was specified.'
    );
  }

  const data = await api(
    `/api/ready-made-resources/${encodeURIComponent(
      resourceId
    )}`
  );

  if (!data?.resource) {
    throw new Error(
      'This resource is no longer available.'
    );
  }

  return data.resource;
}

async function loadCollections() {
  try {
    const data = await api(
      '/api/collections'
    );

    return Array.isArray(
      data?.collections
    )
      ? data.collections
      : [];
  } catch (error) {
    console.warn(
      '[ready-made-resource] collections failed:',
      error
    );

    return [];
  }
}

function getCollectionResources(collection) {
  return Array.isArray(
    collection?.resources
  )
    ? collection.resources
    : [];
}

function findContainingCollection(
  collections,
  resource
) {
  return collections.find(
    (collection) =>
      getCollectionResources(
        collection
      ).some(
        (item) =>
          item.id === resource.id
      )
  );
}

function getRelatedResources(
  collections,
  resource
) {
  const related = [];
  const seen = new Set();

  function add(item) {
    if (!item?.id) return;
    if (item.id === resource.id) return;
    if (seen.has(item.id)) return;

    seen.add(item.id);
    related.push(item);
  }

  const containingCollection =
    findContainingCollection(
      collections,
      resource
    );

  if (containingCollection) {
    getCollectionResources(
      containingCollection
    ).forEach(add);
  }

  collections
    .filter((collection) => {
      if (
        collection.id ===
        containingCollection?.id
      ) {
        return false;
      }

      const resources =
        getCollectionResources(
          collection
        );

      return resources.some(
        (item) =>
          item.id === resource.id
      );
    })
    .forEach((collection) => {
      getCollectionResources(
        collection
      ).forEach(add);
    });

  if (
    related.length <
    4
  ) {
    const fallbackCandidates =
      window.__readyMadeResources || [];

    fallbackCandidates
      .filter(
        (item) =>
          item.subject ===
            resource.subject ||
          item.resourceType ===
            resource.resourceType
      )
      .forEach(add);
  }

  return related.slice(0, 4);
}

function renderMeta(resource) {
  const values = [
    {
      icon: 'book-open',
      label: resource.subject,
    },
    {
      icon: 'student',
      label: resource.educationalLevel,
    },
    {
      icon: 'graduation-cap',
      label: resource.classLevel,
    },
    {
      icon: 'globe',
      label: resource.curriculum,
    },
    {
      icon: 'calendar',
      label: formatDate(
        resource.publishedAt
      ),
    },
  ].filter(
    (item) => item.label
  );

  $('resourceDetailMeta').innerHTML =
    values
      .map(
        (item) => `
          <span class="resource-detail-meta-item">
            <i class="ph ph-${escapeHtml(
              item.icon
            )}"></i>
            <span>${escapeHtml(
              item.label
            )}</span>
          </span>
        `
      )
      .join('');
}

function renderTags(resource) {
  const tags = Array.isArray(
    resource.tags
  )
    ? resource.tags.filter(Boolean)
    : [];

  const container =
    $('resourceDetailTags');

  if (!tags.length) {
    container.hidden = true;
    container.innerHTML = '';
    return;
  }

  container.hidden = false;

  container.innerHTML = tags
    .slice(0, 12)
    .map(
      (tag) => `
        <span>
          ${escapeHtml(tag)}
        </span>
      `
    )
    .join('');
}

function renderHeader(resource) {
  const type =
    resourceLabel(
      resource.resourceType
    );

  document.title =
    `${resource.title || type} · Cognita`;

  $('resourceDetailType').innerHTML = `
    <i class="ph ph-${escapeHtml(
      resourceIcon(
        resource.resourceType
      )
    )}"></i>
    ${escapeHtml(type)}
  `;

  $('resourceBreadcrumbType')
    .textContent = type;

  $('resourceDetailTitle')
    .textContent =
    resource.title ||
    type;

  $('resourceDetailDescription')
    .textContent =
    resource.description ||
    resource.topic ||
    `A classroom-ready ${type.toLowerCase()}.`;

  $('resourceDetailFeatured').hidden =
    !resource.featured;

  $('resourceDetailRecommended').hidden =
    !resource.recommended;

  renderMeta(resource);
  renderTags(resource);

  $('resourceDetailVersion')
    .textContent =
    `Version ${Number(
      resource.currentVersion || 1
    )}`;
}

function renderCollection(
  collection
) {
  const section =
    $('resourceCollectionSection');

  if (!collection) {
    section.hidden = true;
    return;
  }

  section.hidden = false;

  $('resourceCollectionTitle')
    .textContent =
    collection.title ||
    'Collection';

  $('resourceCollectionDescription')
    .textContent =
    collection.description ||
    'Explore the rest of this curated collection.';

  const link =
    $('resourceCollectionLink');

  link.href =
    `/collection.html?id=${encodeURIComponent(
      collection.id
    )}`;
}

function renderResourcePreview(
  resource
) {
  const container =
    $('resourceDetailPreview');

  const content =
    resource.structuredContent ||
    {};

  try {
    if (
      window.ResourceRenderers &&
      typeof window.ResourceRenderers.render ===
        'function'
    ) {
      const rendered =
        window.ResourceRenderers.render(
          resource.resourceType,
          content
        );

      if (
        rendered &&
        typeof rendered === 'string'
      ) {
        container.innerHTML =
          rendered;

        if (
          typeof window.ResourceRenderers.mount ===
          'function'
        ) {
          window.ResourceRenderers.mount(
            container,
            resource.resourceType,
            content
          );
        }

        return;
      }
    }
  } catch (error) {
    console.warn(
      '[ready-made-resource] specialized renderer failed:',
      error
    );
  }

  container.innerHTML =
    renderStructuredContent(
      content
    );
}

function renderStructuredContent(
  value,
  depth = 0
) {
  if (
    value === null ||
    value === undefined
  ) {
    return '';
  }

  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return `
      <p class="structured-text">
        ${escapeHtml(value)}
      </p>
    `;
  }

  if (Array.isArray(value)) {
    if (!value.length) {
      return '';
    }

    return `
      <div class="structured-list">
        ${value
          .map(
            (item) =>
              `<div class="structured-list-item">
                ${renderStructuredContent(
                  item,
                  depth + 1
                )}
              </div>`
          )
          .join('')}
      </div>
    `;
  }

  const entries =
    Object.entries(value);

  if (!entries.length) {
    return '';
  }

  return `
    <div class="structured-content structured-depth-${Math.min(
      depth,
      4
    )}">
      ${entries
        .map(
          ([key, child]) => `
            <section class="structured-section">

              <div class="structured-section-label">
                ${escapeHtml(
                  prettifyKey(key)
                )}
              </div>

              <div class="structured-section-content">
                ${renderStructuredContent(
                  child,
                  depth + 1
                )}
              </div>

            </section>
          `
        )
        .join('')}
    </div>
  `;
}

function prettifyKey(key) {
  return String(key || '')
    .replace(/[_-]+/g, ' ')
    .replace(
      /([a-z])([A-Z])/g,
      '$1 $2'
    )
    .replace(/\b\w/g, (char) =>
      char.toUpperCase()
    );
}

function createDownloadButton(
  resource,
  format
) {
  const references =
    resource.fileReferences || {};

  const reference =
    references[format];

  if (!reference) {
    return '';
  }

  const labels = {
    pdf: 'Download PDF',
    docx: 'Download DOCX',
    pptx: 'Download PowerPoint',
  };

  const icons = {
    pdf: 'file-pdf',
    docx: 'file-doc',
    pptx: 'presentation-chart',
  };

  return `
    <button
      type="button"
      class="resource-download-button"
      data-download-format="${format}"
    >
      <span class="resource-download-icon">
        <i class="ph ph-${icons[format]}"></i>
      </span>

      <span class="resource-download-copy">
        <strong>
          ${labels[format]}
        </strong>

        <small>
          Classroom-ready file
        </small>
      </span>

      <i class="ph ph-arrow-down"></i>
    </button>
  `;
}

function renderDownloadActions(
  resource
) {
  const container =
    $('resourceDownloadActions');

  const formats = [
    'pdf',
    'docx',
    'pptx',
  ];

  const buttons = formats
    .map(
      (format) =>
        createDownloadButton(
          resource,
          format
        )
    )
    .filter(Boolean);

  if (!buttons.length) {
    container.innerHTML = `
      <div class="resource-no-downloads">
        <i class="ph ph-info"></i>
        <span>
          Download files are not available for this resource yet.
        </span>
      </div>
    `;

    return;
  }

  container.innerHTML =
    buttons.join('');

  container
    .querySelectorAll(
      '[data-download-format]'
    )
    .forEach((button) => {
      button.addEventListener(
        'click',
        () =>
          downloadResource(
            resource,
            button.dataset
              .downloadFormat,
            button
          )
      );
    });
}

async function downloadResource(
  resource,
  format,
  button
) {
  if (
    !format ||
    !resource?.id
  ) {
    return;
  }

  const original =
    button.innerHTML;

  button.disabled = true;

  button.innerHTML = `
    <span class="resource-download-spinner"></span>
    <span class="resource-download-copy">
      <strong>Preparing download…</strong>
      <small>Please wait</small>
    </span>
  `;

  try {
    const data =
      await api(
        `/api/ready-made-resources/${encodeURIComponent(
          resource.id
        )}/download`,
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

    if (!data?.downloadUrl) {
      throw new Error(
        'The download is not available.'
      );
    }

    const anchor =
      document.createElement('a');

    anchor.href =
      data.downloadUrl;

    anchor.target = '_blank';
    anchor.rel = 'noopener';
    anchor.click();
  } catch (error) {
    console.error(
      '[ready-made-resource] download failed:',
      error
    );

    showToast(
      error.message ||
        'Could not prepare the download.'
    );
  } finally {
    button.disabled = false;
    button.innerHTML = original;
  }
}

function renderRelatedResources(
  resources
) {
  const section =
    $('resourceRelatedSection');

  const grid =
    $('resourceRelatedGrid');

  if (!resources.length) {
    section.hidden = true;
    return;
  }

  section.hidden = false;

  grid.innerHTML =
    resources
      .map(
        (resource) => `
          <a
            href="/ready-made-resource.html?id=${encodeURIComponent(
              resource.id
            )}"
            class="resource-related-card"
          >

            <div class="resource-related-icon">
              <i class="ph ph-${escapeHtml(
                resourceIcon(
                  resource.resourceType
                )
              )}"></i>
            </div>

            <div class="resource-related-copy">

              <span>
                ${escapeHtml(
                  resourceLabel(
                    resource.resourceType
                  )
                )}
              </span>

              <h3>
                ${escapeHtml(
                  resource.title ||
                    'Untitled resource'
                )}
              </h3>

              <p>
                ${escapeHtml(
                  resource.description ||
                    resource.topic ||
                    'Classroom-ready resource.'
                )}
              </p>

            </div>

            <i class="ph ph-arrow-up-right"></i>

          </a>
        `
      )
      .join('');
}

function showToast(message) {
  let toast =
    document.getElementById(
      'resourceDetailToast'
    );

  if (!toast) {
    toast =
      document.createElement('div');

    toast.id =
      'resourceDetailToast';

    toast.className =
      'resource-detail-toast';

    document.body.appendChild(
      toast
    );
  }

  toast.textContent = message;
  toast.classList.add('is-visible');

  window.clearTimeout(
    toast._timer
  );

  toast._timer =
    window.setTimeout(
      () => {
        toast.classList.remove(
          'is-visible'
        );
      },
      3500
    );
}

function showLoading() {
  $('resourceDetailLoading').hidden =
    false;

  $('resourceDetailError').hidden =
    true;

  $('resourceDetailContent').hidden =
    true;
}

function showError(error) {
  $('resourceDetailLoading').hidden =
    true;

  $('resourceDetailContent').hidden =
    true;

  $('resourceDetailError').hidden =
    false;

  $('resourceDetailErrorMessage')
    .textContent =
    error?.message ||
    'Could not load this resource.';
}

function showContent() {
  $('resourceDetailLoading').hidden =
    true;

  $('resourceDetailError').hidden =
    true;

  $('resourceDetailContent').hidden =
    false;
}

async function init() {
  const user =
    await window.Auth.requireAuthOrRedirect();

  if (!user) return;

  showLoading();

  $('resourceDetailRetry')
    ?.addEventListener(
      'click',
      init
    );

  try {
    const [
      resource,
      collections,
    ] = await Promise.all([
      loadResource(),
      loadCollections(),
    ]);

    currentResource =
      resource;

    window.__readyMadeResources =
      collections.flatMap(
        (collection) =>
          getCollectionResources(
            collection
          )
      );

    renderHeader(resource);
    renderDownloadActions(resource);
    renderResourcePreview(resource);

    const collection =
      findContainingCollection(
        collections,
        resource
      );

    renderCollection(
      collection
    );

    const related =
      getRelatedResources(
        collections,
        resource
      );

    renderRelatedResources(
      related
    );

    showContent();

    window.scrollTo({
      top: 0,
      behavior: 'instant',
    });
  } catch (error) {
    console.error(
      '[ready-made-resource]',
      error
    );

    showError(error);
  }
}

init();
