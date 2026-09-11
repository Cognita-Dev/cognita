const WORKER_URL =
  'https://cognita.cognitai.workers.dev';

const RESOURCE_TYPES = {
  lesson_plan: {
    label: 'Lesson Plan',
    icon: 'chalkboard-teacher',
  },
  worksheet: {
    label: 'Worksheet',
    icon: 'note-pencil',
  },
  exam: {
    label: 'Examination',
    icon: 'exam',
  },
  scheme_of_work: {
    label: 'Scheme of Work',
    icon: 'calendar-check',
  },
  quiz: {
    label: 'Quiz',
    icon: 'question',
  },
  study_guide: {
    label: 'Study Guide',
    icon: 'book-open-text',
  },
  teaching_guide: {
    label: 'Teaching Guide',
    icon: 'chalkboard',
  },
  classroom_activity: {
    label: 'Classroom Activity',
    icon: 'users-three',
  },
  assignment: {
    label: 'Assignment',
    icon: 'clipboard-text',
  },
  marking_scheme: {
    label: 'Marking Scheme',
    icon: 'check-square-offset',
  },
  rubric: {
    label: 'Rubric',
    icon: 'table',
  },
  flashcards: {
    label: 'Flashcards',
    icon: 'cards',
  },
  student_handout: {
    label: 'Student Handout',
    icon: 'file-text',
  },
  presentation: {
    label: 'Presentation Slides',
    icon: 'presentation-chart',
  },
  project: {
    label: 'Project',
    icon: 'flag-checkered',
  },
  test: {
    label: 'Test',
    icon: 'pencil-simple-line',
  },
};

const FORMAT_LABELS = {
  docx: 'Word document',
  pdf: 'PDF',
  pptx: 'PowerPoint',
};

let currentResource = null;
let versions = [];
let currentMode = 'visual';
let dirty = false;

const $ = (id) =>
  document.getElementById(id);

async function init() {
  const user =
    await window.Auth.requireAuthOrRedirect();

  if (!user) return;

  renderAccount(user);
  wireShell();
  wireEditor();

  const params =
    new URLSearchParams(
      window.location.search
    );

  const resourceId =
    params.get('id') ||
    params.get('resource');

  if (!resourceId) {
    showError(
      'No resource was selected.'
    );
    return;
  }

  await loadResource(resourceId);
}

function renderAccount(user) {
  const label =
    (user.displayName || '').trim() ||
    user.email ||
    'Signed in';

  $('accountEmail').textContent =
    label;

  $('accountEmail').classList.remove(
    'skeleton'
  );

  $('accountAvatar').textContent =
    label.charAt(0).toUpperCase();

  loadAccountPlan();
}

async function loadAccountPlan() {
  try {
    const response =
      await window.Auth.authedFetch(
        WORKER_URL +
          '/api/account'
      );

    if (!response.ok) return;

    const data =
      await response.json();

    $('accountPlan').textContent =
      data.planName || 'Free';

    $('accountPlan').classList.remove(
      'skeleton'
    );
  } catch (e) {
    console.error(
      '[resource-editor] account:',
      e.message
    );
  }
}

function wireShell() {
  const sidebar =
    $('appSidebar');

  const scrim =
    $('sidebarScrim');

  $('sidebarCollapseBtn')
    .addEventListener('click', () => {
      sidebar.classList.toggle(
        'is-collapsed'
      );
    });

  $('sidebarCloseBtn')
    .addEventListener(
      'click',
      closeMobileSidebar
    );

  $('mobileSidebarBtn')
    .addEventListener('click', () => {
      sidebar.classList.add(
        'is-open'
      );

      scrim.classList.add(
        'is-visible'
      );
    });

  scrim.addEventListener(
    'click',
    closeMobileSidebar
  );

  $('accountBtn')
    .addEventListener('click', (event) => {
      event.stopPropagation();

      const menu =
        $('accountMenu');

      menu.hidden = !menu.hidden;
    });

  document.addEventListener(
    'click',
    () => {
      $('accountMenu').hidden = true;
    }
  );

  $('logOutBtn')
    .addEventListener(
      'click',
      async () => {
        await window.Auth.logOut();
        window.location.href =
          '/login.html';
      }
    );

  window.addEventListener(
    'beforeunload',
    (event) => {
      if (!dirty) return;

      event.preventDefault();
      event.returnValue = '';
    }
  );
}

function closeMobileSidebar() {
  $('appSidebar').classList.remove(
    'is-open'
  );

  $('sidebarScrim').classList.remove(
    'is-visible'
  );
}

function wireEditor() {
  $('saveResourceBtn')
    .addEventListener(
      'click',
      saveResource
    );

  $('resourceTitle')
    .addEventListener(
      'input',
      () => {
        dirty = true;
        updatePreview();
        updateSaveState();
      }
    );

  $('resourceDescription')
    .addEventListener(
      'input',
      () => {
        dirty = true;
        updateSaveState();
      }
    );

  $('resourceJson')
    .addEventListener(
      'input',
      () => {
        dirty = true;
        validateJson(false);
        updatePreview();
        updateSaveState();
      }
    );

  $('formatJsonBtn')
    .addEventListener(
      'click',
      formatJson
    );

  document
    .querySelectorAll(
      '.editor-mode-btn'
    )
    .forEach((button) => {
      button.addEventListener(
        'click',
        () => {
          setMode(
            button.dataset.mode
          );
        }
      );
    });
}

async function loadResource(
  resourceId
) {
  setLoading(true);

  try {
    const response =
      await window.Auth.authedFetch(
        WORKER_URL +
          '/api/resources/' +
          encodeURIComponent(
            resourceId
          )
      );

    const data =
      await response.json();

    if (!response.ok) {
      throw new Error(
        data.error ||
          'Could not load the resource.'
      );
    }

    currentResource =
      data.resource;

    renderResource();

    await loadVersions();

    setLoading(false);
  } catch (e) {
    console.error(
      '[resource-editor] load:',
      e
    );

    setLoading(false);

    showError(
      e.message ||
        'Could not load the resource.'
    );
  }
}

function setLoading(isLoading) {
  $('editorLoading').hidden =
    !isLoading;

  $('editorShell').hidden =
    isLoading;

  $('editorError').hidden =
    true;
}

function showError(message) {
  $('editorLoading').hidden =
    true;

  $('editorShell').hidden =
    true;

  $('editorError').hidden =
    false;

  $('editorErrorMessage')
    .textContent = message;
}

function renderResource() {
  const resource =
    currentResource;

  const type =
    RESOURCE_TYPES[
      resource.resourceType
    ] || {
      label:
        resource.resourceType ||
        'Resource',
      icon: 'file-text',
    };

  $('editorTypeLabel')
    .textContent =
    type.label;

  $('editorTypeIcon')
    .innerHTML =
    '<i class="ph ph-' +
    escapeHtml(type.icon) +
    '"></i>';

  $('resourceTitle')
    .value =
    resource.title ||
    resource.structuredContent?.title ||
    '';

  $('resourceDescription')
    .value =
    resource.description || '';

  $('resourceJson')
    .value =
    JSON.stringify(
      resource.structuredContent ||
        {},
      null,
      2
    );

  $('editorVersion')
    .textContent =
    'Version ' +
    (resource.currentVersion ||
      1);

  $('previewTitle')
    .textContent =
    resource.title ||
    'Resource';

  renderVisualEditor(
    resource.structuredContent ||
      {}
  );

  updatePreview();
  renderDownloadActions();

  dirty = false;
  updateSaveState();
}

function renderVisualEditor(content) {
  const container =
    $('visualEditor');

  container.innerHTML = '';

  Object.entries(content)
    .forEach(([key, value]) => {
      if (key === 'title') return;

      const field =
        createVisualField(
          key,
          value
        );

      container.appendChild(
        field
      );
    });

  if (!container.children.length) {
    container.innerHTML =
      '<div class="visual-empty">' +
      '<i class="ph ph-pencil-simple"></i>' +
      '<p>No editable content fields were found.</p>' +
      '<span>Use JSON mode to edit the complete structure.</span>' +
      '</div>';
  }
}

function createVisualField(
  key,
  value
) {
  const wrapper =
    document.createElement(
      'div'
    );

  wrapper.className =
    'visual-field';

  const label =
    document.createElement(
      'label'
    );

  label.className =
    'visual-field-label';

  label.textContent =
    humanize(key);

  wrapper.appendChild(
    label
  );

  if (Array.isArray(value)) {
    const list =
      document.createElement(
        'div'
      );

    list.className =
      'visual-array';

    value.forEach(
      (item, index) => {
        const row =
          document.createElement(
            'div'
          );

        row.className =
          'visual-array-item';

        const input =
          createValueInput(
            item
          );

        input.dataset.key =
          key;

        input.dataset.index =
          String(index);

        input.addEventListener(
          'input',
          () => {
            syncVisualValue(
              key,
              value,
              list
            );
          }
        );

        row.appendChild(
          input
        );

        list.appendChild(
          row
        );
      }
    );

    const add =
      document.createElement(
        'button'
      );

    add.type = 'button';
    add.className =
      'visual-add-btn';

    add.innerHTML =
      '<i class="ph ph-plus"></i> Add item';

    add.addEventListener(
      'click',
      () => {
        value.push('');

        renderVisualEditor(
          collectVisualContent()
        );

        dirty = true;
        updatePreview();
        updateSaveState();
      }
    );

    wrapper.appendChild(
      list
    );

    wrapper.appendChild(
      add
    );

    return wrapper;
  }

  if (
    value &&
    typeof value === 'object'
  ) {
    const textarea =
      document.createElement(
        'textarea'
      );

    textarea.className =
      'visual-object-input';

    textarea.value =
      JSON.stringify(
        value,
        null,
        2
      );

    textarea.addEventListener(
      'input',
      () => {
        dirty = true;
        syncVisualObject(
          key,
          textarea.value
        );
        updatePreview();
        updateSaveState();
      }
    );

    wrapper.appendChild(
      textarea
    );

    return wrapper;
  }

  const input =
    createValueInput(
      value
    );

  input.addEventListener(
    'input',
    () => {
      dirty = true;
      updateVisualScalar(
        key,
        input.value,
        value
      );
      updatePreview();
      updateSaveState();
    }
  );

  wrapper.appendChild(
    input
  );

  return wrapper;
}

function createValueInput(value) {
  if (
    String(value ?? '').length >
    120
  ) {
    const textarea =
      document.createElement(
        'textarea'
      );

    textarea.className =
      'visual-textarea';

    textarea.value =
      typeof value === 'string'
        ? value
        : JSON.stringify(
            value
          );

    return textarea;
  }

  const input =
    document.createElement(
      'input'
    );

  input.type = 'text';

  input.className =
    'visual-input';

  input.value =
    value === null ||
    typeof value ===
      'undefined'
      ? ''
      : String(value);

  return input;
}

function collectVisualContent() {
  const content =
    JSON.parse(
      $('resourceJson')
        .value || '{}'
    );

  document
    .querySelectorAll(
      '.visual-field'
    )
    .forEach((field) => {
      const label =
        field.querySelector(
          '.visual-field-label'
        );

      if (!label) return;

      const key =
        Object.keys(content)
          .find(
            (candidate) =>
              humanize(candidate) ===
              label.textContent
          );

      if (!key) return;

      const array =
        field.querySelector(
          '.visual-array'
        );

      if (array) {
        content[key] =
          Array.from(
            array.querySelectorAll(
              '.visual-array-item input, .visual-array-item textarea'
            )
          ).map(
            (input) =>
              input.value
          );

        return;
      }

      const objectInput =
        field.querySelector(
          '.visual-object-input'
        );

      if (objectInput) {
        try {
          content[key] =
            JSON.parse(
              objectInput.value
            );
        } catch (_) {
          content[key] =
            objectInput.value;
        }

        return;
      }

      const scalar =
        field.querySelector(
          '.visual-input, .visual-textarea'
        );

      if (scalar) {
        const original =
          content[key];

        if (
          typeof original ===
          'number'
        ) {
          const number =
            Number(
              scalar.value
            );

          content[key] =
            Number.isFinite(number)
              ? number
              : scalar.value;
        } else if (
          typeof original ===
          'boolean'
        ) {
          content[key] =
            scalar.value ===
            'true';
        } else {
          content[key] =
            scalar.value;
        }
      }
    });

  return content;
}

function syncVisualValue(
  key,
  original,
  list
) {
  const content =
    collectVisualContent();

  $('resourceJson').value =
    JSON.stringify(
      content,
      null,
      2
    );

  dirty = true;
  updatePreview();
  updateSaveState();
}

function syncVisualObject(
  key,
  text
) {
  const content =
    collectVisualContent();

  $('resourceJson').value =
    JSON.stringify(
      content,
      null,
      2
    );
}

function updateVisualScalar(
  key,
  value
) {
  const content =
    collectVisualContent();

  content[key] =
    value;

  $('resourceJson').value =
    JSON.stringify(
      content,
      null,
      2
    );
}

function setMode(mode) {
  if (
    mode === currentMode
  ) {
    return;
  }

  if (
    currentMode === 'visual'
  ) {
    const content =
      collectVisualContent();

    $('resourceJson').value =
      JSON.stringify(
        content,
        null,
        2
      );
  }

  currentMode = mode;

  document
    .querySelectorAll(
      '.editor-mode-btn'
    )
    .forEach((button) => {
      button.classList.toggle(
        'is-active',
        button.dataset.mode ===
          mode
      );
    });

  $('visualEditor').hidden =
    mode !== 'visual';

  $('jsonEditor').hidden =
    mode !== 'json';

  if (mode === 'visual') {
    try {
      const content =
        JSON.parse(
          $('resourceJson')
            .value
        );

      renderVisualEditor(
        content
      );
    } catch (_) {
      showToast(
        'Fix the JSON before returning to Visual mode.'
      );
    }
  }
}

function validateJson(
  showMessage = true
) {
  const status =
    $('jsonEditorStatus');

  try {
    JSON.parse(
      $('resourceJson').value
    );

    status.textContent =
      'JSON is valid.';

    status.classList.remove(
      'is-invalid'
    );

    status.classList.add(
      'is-valid'
    );

    return true;
  } catch (e) {
    status.textContent =
      'Invalid JSON: ' +
      e.message;

    status.classList.remove(
      'is-valid'
    );

    status.classList.add(
      'is-invalid'
    );

    if (showMessage) {
      showToast(
        'Fix the JSON before saving.'
      );
    }

    return false;
  }
}

function formatJson() {
  try {
    const parsed =
      JSON.parse(
        $('resourceJson')
          .value
      );

    $('resourceJson')
      .value =
      JSON.stringify(
        parsed,
        null,
        2
      );

    validateJson(
      false
    );

    if (
      currentMode ===
      'visual'
    ) {
      renderVisualEditor(
        parsed
      );
    }

    dirty = true;
    updatePreview();
    updateSaveState();
  } catch (e) {
    showToast(
      'The JSON is invalid.'
    );
  }
}

function getEditedContent() {
  let content;

  if (
    currentMode ===
    'visual'
  ) {
    content =
      collectVisualContent();
  } else {
    try {
      content =
        JSON.parse(
          $('resourceJson')
            .value
        );
    } catch (_) {
      throw new Error(
        'Fix the JSON before saving.'
      );
    }
  }

  const title =
    $('resourceTitle')
      .value.trim();

  content.title =
    title;

  return content;
}

async function saveResource() {
  if (!currentResource) {
    return;
  }

  let structuredContent;

  try {
    structuredContent =
      getEditedContent();
  } catch (e) {
    showToast(e.message);
    return;
  }

  const title =
    $('resourceTitle')
      .value.trim();

  const description =
    $('resourceDescription')
      .value.trim();

  if (!title) {
    showToast(
      'A resource title is required.'
    );
    return;
  }

  const button =
    $('saveResourceBtn');

  button.disabled = true;
  button.classList.add(
    'is-saving'
  );

  button.innerHTML =
    '<span class="editor-save-spinner"></span>' +
    '<span>Saving…</span>';

  try {
    const response =
      await window.Auth.authedFetch(
        WORKER_URL +
          '/api/resources/' +
          encodeURIComponent(
            currentResource.id
          ),
        {
          method: 'PATCH',
          headers: {
            'Content-Type':
              'application/json',
          },
          body: JSON.stringify({
            title,
            description,
            structuredContent,
            baseVersion:
              currentResource.currentVersion ||
              1,
          }),
        }
      );

    const data =
      await response.json();

    if (!response.ok) {
      if (
        data.code ===
        'VERSION_CONFLICT'
      ) {
        showToast(
          'This resource changed elsewhere. Reload it before saving.'
        );
      } else {
        showToast(
          data.error ||
            'Could not save the resource.'
        );
      }

      return;
    }

    currentResource =
      data.resource;

    renderResource();

    await loadVersions();

    showToast(
      'Resource saved as version ' +
        data.version +
        '.'
    );
  } catch (e) {
    console.error(
      '[resource-editor] save:',
      e
    );

    showToast(
      'Could not reach Cognita. Please try again.'
    );
  } finally {
    button.classList.remove(
      'is-saving'
    );

    button.innerHTML =
      '<i class="ph ph-check"></i>' +
      '<span>Save</span>';

    updateSaveState();
  }
}

async function loadVersions() {
  if (!currentResource) {
    return;
  }

  try {
    const response =
      await window.Auth.authedFetch(
        WORKER_URL +
          '/api/resources/' +
          encodeURIComponent(
            currentResource.id
          ) +
          '/versions'
      );

    const data =
      await response.json();

    if (!response.ok) {
      return;
    }

    versions =
      data.versions || [];

    renderVersions();
  } catch (e) {
    console.error(
      '[resource-editor] versions:',
      e.message
    );
  }
}

function renderVersions() {
  const list =
    $('versionList');

  if (!versions.length) {
    list.innerHTML =
      '<div class="version-empty">' +
      'No saved versions yet.' +
      '</div>';

    return;
  }

  list.innerHTML =
    versions
      .map(
        (version) => {
          const active =
            Number(
              version.version
            ) ===
            Number(
              currentResource.currentVersion
            );

          const date =
            formatDate(
              version.createdAt
            );

          return (
            '<div class="version-row' +
            (active
              ? ' is-current'
              : '') +
            '">' +
            '<span class="version-number">' +
            'v' +
            escapeHtml(
              version.version
            ) +
            '</span>' +
            '<div class="version-info">' +
            '<strong>' +
            (active
              ? 'Current version'
              : 'Saved version') +
            '</strong>' +
            '<span>' +
            escapeHtml(
              date
            ) +
            '</span>' +
            '</div>' +
            (active
              ? '<span class="version-current-badge">Current</span>'
              : '') +
            '</div>'
          );
        }
      )
      .join('');
}

function updatePreview() {
  if (!currentResource) {
    return;
  }

  let content;

  try {
    content =
      getEditedContent();
  } catch (_) {
    return;
  }

  $('previewTitle')
    .textContent =
    $('resourceTitle')
      .value.trim() ||
    'Resource';

  const body =
    $('previewBody');

  body.innerHTML = '';

  if (
    window.ResourceRenderers &&
    typeof window.ResourceRenderers.render ===
      'function'
  ) {
    const html =
      window.ResourceRenderers.render(
        currentResource.resourceType,
        content
      );

    if (html) {
      body.innerHTML =
        html;

      if (
        typeof window.ResourceRenderers.mount ===
        'function'
      ) {
        window.ResourceRenderers.mount(
          currentResource.resourceType,
          body,
          content
        );
      }

      return;
    }
  }

  body.innerHTML =
    genericPreview(
      content
    );
}

function genericPreview(
  content
) {
  let html = '';

  Object.entries(
    content || {}
  ).forEach(
    ([key, value]) => {
      if (key === 'title') {
        return;
      }

      const label =
        humanize(key);

      if (Array.isArray(value)) {
        html +=
          '<section class="preview-section">' +
          '<h3>' +
          escapeHtml(label) +
          '</h3>' +
          '<ul>';

        value.forEach(
          (item) => {
            if (
              item &&
              typeof item ===
                'object'
            ) {
              html +=
                '<li>' +
                escapeHtml(
                  Object.values(
                    item
                  ).join(
                    ' — '
                  )
                ) +
                '</li>';
            } else {
              html +=
                '<li>' +
                escapeHtml(
                  String(item)
                ) +
                '</li>';
            }
          }
        );

        html +=
          '</ul></section>';

        return;
      }

      if (
        value &&
        typeof value ===
          'object'
      ) {
        html +=
          '<section class="preview-section">' +
          '<h3>' +
          escapeHtml(label) +
          '</h3>' +
          '<pre>' +
          escapeHtml(
            JSON.stringify(
              value,
              null,
              2
            )
          ) +
          '</pre></section>';

        return;
      }

      if (
        value !== null &&
        typeof value !==
          'undefined'
      ) {
        html +=
          '<section class="preview-section">' +
          '<h3>' +
          escapeHtml(label) +
          '</h3>' +
          '<p>' +
          escapeHtml(
            String(value)
          ) +
          '</p>' +
          '</section>';
      }
    }
  );

  return html;
}

function renderDownloadActions() {
  const wrap =
    $('editorDownloadActions');

  const references =
    currentResource.fileReferences ||
    {};

  const formats =
    Object.keys(references);

  if (!formats.length) {
    wrap.innerHTML =
      '<span class="editor-download-empty">' +
      'No exports available yet.' +
      '</span>';

    return;
  }

  wrap.innerHTML =
    formats
      .map(
        (format) =>
          '<button type="button" class="editor-download-btn" data-format="' +
          escapeHtml(
            format
          ) +
          '">' +
          '<i class="ph ph-download-simple"></i>' +
          '<span>' +
          escapeHtml(
            FORMAT_LABELS[
              format
            ] ||
              format.toUpperCase()
          ) +
          '</span>' +
          '</button>'
      )
      .join('');

  wrap
    .querySelectorAll(
      '.editor-download-btn'
    )
    .forEach((button) => {
      button.addEventListener(
        'click',
        () =>
          downloadResource(
            button.dataset.format,
            button
          )
      );
    });
}

async function downloadResource(
  format,
  button
) {
  button.disabled = true;

  try {
    const response =
      await window.Auth.authedFetch(
        WORKER_URL +
          '/api/resources/' +
          encodeURIComponent(
            currentResource.id
          ) +
          '/download?format=' +
          encodeURIComponent(
            format
          ),
        {
          method: 'POST',
        }
      );

    const data =
      await response.json();

    if (!response.ok) {
      showToast(
        data.error ||
          'Could not prepare the download.'
      );

      return;
    }

    const link =
      document.createElement(
        'a'
      );

    link.href =
      data.url;

    link.download = '';

    document.body.appendChild(
      link
    );

    link.click();

    link.remove();
  } catch (e) {
    console.error(
      '[resource-editor] download:',
      e
    );

    showToast(
      'Could not prepare the download.'
    );
  } finally {
    button.disabled =
      false;
  }
}

function updateSaveState() {
  const button =
    $('saveResourceBtn');

  const title =
    $('resourceTitle')
      .value.trim();

  button.disabled =
    !dirty ||
    !title ||
    button.classList.contains(
      'is-saving'
    );
}

function humanize(value) {
  return String(value)
    .replace(/([A-Z])/g, ' $1')
    .replace(/[_-]/g, ' ')
    .replace(/^./, (c) =>
      c.toUpperCase()
    );
}

function formatDate(value) {
  if (!value) {
    return 'Unknown date';
  }

  try {
    return new Intl.DateTimeFormat(
      undefined,
      {
        dateStyle: 'medium',
        timeStyle: 'short',
      }
    ).format(
      new Date(value)
    );
  } catch (_) {
    return String(value);
  }
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
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

function showToast(message) {
  const existing =
    document.querySelector(
      '.editor-toast'
    );

  if (existing) {
    existing.remove();
  }

  const toast =
    document.createElement(
      'div'
    );

  toast.className =
    'editor-toast';

  toast.textContent =
    message;

  document.body.appendChild(
    toast
  );

  setTimeout(
    () => toast.remove(),
    3200
  );
}

init();
