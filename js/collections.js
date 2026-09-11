import { Auth } from './auth.js';

const WORKER_URL =
  'https://cognita.cognitai.workers.dev';

let collections = [];

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

async function api(path) {
  const response = await Auth.authedFetch(
    WORKER_URL + path
  );

  let data = null;

  try {
    data = await response.json();
  } catch (_) {}

  if (!response.ok) {
    throw new Error(
      data?.error ||
      'Could not load collections.'
    );
  }

  return data;
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

function render(list) {
  const grid = $('collectionsGrid');

  if (!list.length) {
    grid.innerHTML = `
      <div class="empty">
        No collections are available yet.
      </div>
    `;

    return;
  }

  grid.innerHTML = list
    .map((collection) => {
      const resources =
        collection.resources || [];

      const preview =
        resources
          .slice(0, 3)
          .map(
            (resource) => `
              <div class="resource-row">
                <span>
                  ${escapeHtml(
                    resourceLabel(
                      resource.resourceType
                    )
                  )}
                </span>

                <strong>
                  ${escapeHtml(
                    resource.title
                  )}
                </strong>
              </div>
            `
          )
          .join('');

      return `
        <article
          class="collection-card"
          data-id="${escapeHtml(
            collection.id
          )}"
        >
          <div class="card-top">

            <div class="collection-icon">
              C
            </div>

            <div class="badges">
              ${
                collection.featured
                  ? '<span>Featured</span>'
                  : ''
              }

              ${
                collection.recommended
                  ? '<span>Recommended</span>'
                  : ''
              }
            </div>

          </div>

          <div class="card-body">

            <h2>
              ${escapeHtml(
                collection.title
              )}
            </h2>

            <p>
              ${escapeHtml(
                collection.description ||
                'A curated Cognita learning collection.'
              )}
            </p>

            <div class="meta">
              ${
                collection.subject
                  ? escapeHtml(
                      collection.subject
                    )
                  : 'Learning collection'
              }

              ·

              ${collection.resourceCount}
              resource${
                collection.resourceCount === 1
                  ? ''
                  : 's'
              }
            </div>

            <div class="resource-preview">
              ${preview}
            </div>

          </div>

          <div class="card-footer">
            <span>
              Open collection
            </span>

            <span>
              →
            </span>
          </div>
        </article>
      `;
    })
    .join('');

  grid
    .querySelectorAll(
      '.collection-card'
    )
    .forEach((card) => {
      card.addEventListener(
        'click',
        () => {
          window.location.href =
            `/collection.html?id=${encodeURIComponent(
              card.dataset.id
            )}`;
        }
      );
    });
}

function applyFilter(filter) {
  let result = collections;

  if (filter === 'featured') {
    result = collections.filter(
      (item) => item.featured
    );
  }

  if (filter === 'recommended') {
    result = collections.filter(
      (item) => item.recommended
    );
  }

  render(result);
}

async function init() {
  const user =
    await Auth.requireAuthOrRedirect();

  if (!user) return;

  document
    .querySelectorAll('.filter')
    .forEach((button) => {
      button.addEventListener(
        'click',
        () => {
          document
            .querySelectorAll('.filter')
            .forEach((item) =>
              item.classList.remove(
                'active'
              )
            );

          button.classList.add(
            'active'
          );

          applyFilter(
            button.dataset.filter
          );
        }
      );
    });

  try {
    const data = await api(
      '/api/collections'
    );

    collections =
      data.collections || [];

    render(collections);
  } catch (e) {
    console.error(
      '[collections]',
      e
    );

    $('collectionsGrid').innerHTML = `
      <div class="empty">
        ${escapeHtml(e.message)}
      </div>
    `;
  }
}

init();
