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
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function resourceLabel(type) {
  const labels = {
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

  return labels[type] || type;
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
          collection.resourceCount === 1
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
              View resource →
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
          window.location.href =
            `/resources.html?resource=${encodeURIComponent(
              card.dataset.id
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

    render(
      data.collection
    );
  } catch (e) {
    console.error(
      '[collection]',
      e
    );

    $('collectionMain').innerHTML = `
      <div class="empty">
        ${escapeHtml(
          e.message
        )}
      </div>
    `;
  }
}

init();
