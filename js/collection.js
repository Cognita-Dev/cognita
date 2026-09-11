import { Auth } from './auth.js';

const WORKER_URL =
  'https://cognita.cognitai.workers.dev';

const params =
  new URLSearchParams(
    window.location.search
  );

const collectionId =
  params.get('id');

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll(
      '&',
      '&amp;'
    )
    .replaceAll(
      '<',
      '&lt;'
    )
    .replaceAll(
      '>',
      '&gt;'
    )
    .replaceAll(
      '"',
      '&quot;'
    )
    .replaceAll(
      "'",
      '&#039;'
    );
}

function resourceLabel(type) {
  const labels = {
    lesson_plan:
      'Lesson Plan',
    worksheet:
      'Worksheet',
    exam:
      'Examination',
    scheme_of_work:
      'Scheme of Work',
    quiz:
      'Quiz',
    study_guide:
      'Study Guide',
    teaching_guide:
      'Teaching Guide',
    classroom_activity:
      'Classroom Activity',
    assignment:
      'Assignment',
    marking_scheme:
      'Marking Scheme',
    rubric:
      'Rubric',
    flashcards:
      'Flashcards',
    student_handout:
      'Student Handout',
    presentation:
      'Presentation',
    project:
      'Project',
    test:
      'Test',
  };

  return (
    labels[type] ||
    type
  );
}

function resourceIcon(type) {
  const icons = {
    lesson_plan:
      'chalkboard-teacher',
    worksheet:
      'note-pencil',
    exam:
      'exam',
    scheme_of_work:
      'calendar-check',
    quiz:
      'question',
    study_guide:
      'book-open-text',
    teaching_guide:
      'chalkboard',
    classroom_activity:
      'users-three',
    assignment:
      'clipboard-text',
    marking_scheme:
      'check-square-offset',
    rubric:
      'table',
    flashcards:
      'cards',
    student_handout:
      'file-text',
    presentation:
      'presentation-chart',
    project:
      'flag-checkered',
    test:
      'pencil-simple-line',
  };

  return (
    icons[type] ||
    'file-text'
  );
}

async function api(path) {
  const response =
    await Auth.authedFetch(
      WORKER_URL + path
    );

  let data = null;

  try {
    data =
      await response.json();
  } catch (_) {}

  if (!response.ok) {
    throw new Error(
      data?.error ||
        'Could not load collection.'
    );
  }

  return data;
}

function render(collection) {
  document.title =
    `Cognita · ${collection.title}`;

  $('collectionHero').innerHTML = `
    <span class="eyebrow">
      CURATED COLLECTION
    </span>

    <h1>
      ${escapeHtml(
        collection.title
      )}
    </h1>

    <p>
      ${escapeHtml(
        collection.description ||
          'A curated set of classroom-ready resources.'
      )}
    </p>

    <div class="collection-meta">

      ${
        collection.subject
          ? `
            <span>
              ${escapeHtml(
                collection.subject
              )}
            </span>
          `
          : ''
      }

      ${
        collection.classLevel
          ? `
            <span>
              ${escapeHtml(
                collection.classLevel
              )}
            </span>
          `
          : ''
      }

      ${
        collection.curriculum
          ? `
            <span>
              ${escapeHtml(
                collection.curriculum
              )}
            </span>
          `
          : ''
      }

      <span>
        ${collection.resourceCount}
        resource${
          collection.resourceCount ===
          1
            ? ''
            : 's'
        }
      </span>

    </div>
  `;

  const resources =
    collection.resources ||
    [];

  if (!resources.length) {
    $('resourcesGrid').innerHTML = `
      <div class="empty">
        This collection currently has no
        available resources.
      </div>
    `;

    return;
  }

  $('resourcesGrid').innerHTML =
    resources
      .map(
        (resource) => `
          <article
            class="resource-card"
            data-id="${escapeHtml(
              resource.id
            )}"
            tabindex="0"
            role="button"
            aria-label="View ${escapeHtml(
              resource.title
            )}"
          >

            <div class="resource-card-icon">
              <i class="ph ph-${escapeHtml(
                resourceIcon(
                  resource.resourceType
                )
              )}"></i>
            </div>

            <span class="resource-type">
              ${escapeHtml(
                resourceLabel(
                  resource.resourceType
                )
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
                  'Classroom-ready resource.'
              )}
            </p>

            <div class="resource-meta">

              ${
                resource.subject
                  ? escapeHtml(
                      resource.subject
                    )
                  : ''
              }

              ${
                resource.classLevel
                  ? ` · ${escapeHtml(
                      resource.classLevel
                    )}`
                  : ''
              }

            </div>

            <div class="resource-action">
              View resource
              <i class="ph ph-arrow-up-right"></i>
            </div>

          </article>
        `
      )
      .join('');

  document
    .querySelectorAll(
      '.resource-card'
    )
    .forEach((card) => {
      const openResource =
        () => {
          const id =
            card.dataset.id;

          if (!id) return;

          window.location.href =
            `/ready-made-resource.html?id=${encodeURIComponent(
              id
            )}`;
        };

      card.addEventListener(
        'click',
        openResource
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
            openResource();
          }
        }
      );
    });
}

async function init() {
  const user =
    await Auth.requireAuthOrRedirect();

  if (!user) return;

  if (!collectionId) {
    $('collectionMain').innerHTML = `
      <div class="empty">
        Collection not found.
      </div>
    `;

    return;
  }

  try {
    const data =
      await api(
        `/api/collections/${encodeURIComponent(
          collectionId
        )}`
      );

    if (!data?.collection) {
      throw new Error(
        'Collection not found.'
      );
    }

    render(
      data.collection
    );
  } catch (error) {
    console.error(
      '[collection]',
      error
    );

    $('collectionMain').innerHTML = `
      <div class="empty">
        ${escapeHtml(
          error.message
        )}
      </div>
    `;
  }
}

init();
