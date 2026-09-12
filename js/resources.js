// js/resources.js
// Resources page behavior. Talks to the same Worker as the chat app,
// through window.Auth.authedFetch — never touches AI providers or B2
// directly.

import { buildExcerpt } from '../excerpt-builder.js';

const WORKER_URL = 'https://cognita.cognitai.workers.dev';

// Kept in sync with recipes/index.js's RECIPE_LABELS on the backend.
// If a new recipe is added server-side, add its label + icon here too.
const RESOURCE_TYPES = [
  { type: 'lesson_plan', label: 'Lesson Plan', icon: 'chalkboard-teacher' },
  { type: 'lesson_note', label: 'Lesson Note', icon: 'notebook' },
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
  lesson_plan: {
    topic: true,
    duration: true,
    lessonStyle: true,
    objectiveFocus: true,
  },

  // Lesson Note only needs subject/class/topic (already always sent) —
  // no lesson-plan-specific controls like duration or lesson style. The
  // AI infers structure and depth from subject/class/topic itself; class
  // level affects vocabulary only, never how much of the topic is
  // covered.
  lesson_note: {
    topic: true,
  },

  worksheet: {
    topic: true,
    questionCount: true,
    difficulty: true,
    questionMix: true,
  },

  exam: {
    topic: true,
    duration: true,
    totalMarks: true,
    difficulty: true,
    sectionCount: true,
  },

  scheme_of_work: {
    topic: false,
    term: true,
    weekCount: true,
    lessonsPerWeek: true,
  },

  quiz: {
    topic: true,
    questionCount: true,
    difficulty: true,
    questionStyle: true,
  },

  study_guide: {
    topic: true,
  },

  teaching_guide: {
    topic: true,
  },

  classroom_activity: {
    topic: true,
    duration: true,
  },

  assignment: {
    topic: true,
  },

  marking_scheme: {
    topic: true,
  },

  rubric: {
    topic: true,
  },

  flashcards: {
    topic: true,
    questionCount: true,
    difficulty: true,
    cardStyle: true,
  },

  student_handout: {
    topic: true,
  },

  presentation: {
    topic: true,
    slideCount: true,
  },

  project: {
    topic: true,
    duration: true,
  },

  test: {
    topic: true,
    duration: true,
  },
};

const RESOURCE_OPTIONS = {
  difficulty: [
    { value: 'easy', label: 'Easy' },
    { value: 'medium', label: 'Medium' },
    { value: 'hard', label: 'Hard' },
    { value: 'mixed', label: 'Mixed' },
  ],

  lessonStyle: [
    { value: 'direct_instruction', label: 'Direct Instruction' },
    { value: 'inquiry', label: 'Inquiry-Based' },
    { value: 'discussion', label: 'Discussion-Based' },
    { value: 'practical', label: 'Practical / Activity-Based' },
    { value: 'mixed', label: 'Mixed' },
  ],

  objectiveFocus: [
    { value: 'knowledge', label: 'Knowledge & Understanding' },
    { value: 'application', label: 'Application' },
    { value: 'skills', label: 'Skills Development' },
    { value: 'mixed', label: 'Mixed' },
  ],

  questionStyle: [
    { value: 'knowledge', label: 'Knowledge' },
    { value: 'conceptual', label: 'Conceptual' },
    { value: 'application', label: 'Application' },
    { value: 'mixed', label: 'Mixed' },
  ],

  questionMix: [
    { value: 'short_answer', label: 'Short Answer' },
    { value: 'multiple_choice', label: 'Multiple Choice' },
    { value: 'fill_blank', label: 'Fill in the Blank' },
    { value: 'mixed', label: 'Mixed' },
  ],

  cardStyle: [
    { value: 'concept_definition', label: 'Concept → Definition' },
    { value: 'question_answer', label: 'Question → Answer' },
    { value: 'term_example', label: 'Term → Example' },
    { value: 'mixed', label: 'Mixed' },
  ],
};

// Mirrors design-templates.js on the backend — the backend is the source
// of truth and re-validates whatever id is sent, so a stale copy here can
// only ever under- or over-offer choices in the UI, never bypass
// entitlement. Keep in sync when templates change server-side.
const DESIGN_TEMPLATES = [
  { id: 'classic', name: 'Classic', tier: 'free', accent: '#3F6B5B' },
  { id: 'midnight', name: 'Midnight', tier: 'plus', accent: '#2A3F5F' },
  { id: 'sunrise', name: 'Sunrise', tier: 'plus', accent: '#C1611D' },
  { id: 'slate', name: 'Slate', tier: 'studio', accent: '#33383D' },
  { id: 'forest', name: 'Forest', tier: 'studio', accent: '#234D35' },
  { id: 'rose', name: 'Rose', tier: 'studio', accent: '#7A2E3A' },
];

const PLAN_HIERARCHY = ['free', 'plus', 'studio'];

function _planRank(planId) {
  const i = PLAN_HIERARCHY.indexOf(planId);
  return i === -1 ? 0 : i;
}

function _planSatisfies(userPlan, requiredTier) {
  return _planRank(userPlan) >= _planRank(requiredTier);
}

let selectedType = null;
let currentResource = null;
let selectedDesignTemplateId = 'classic';
let currentAccountPlanId = 'free';
let currentAccountHasDesignTemplates = false;
let activeEditorHandle = null;

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
  wireLibraryPreviewPanel();
  await loadMyResources();
  await loadRecommendedLibrary();
})();

function renderAccountInfo(user) {
  const displayName = (user.displayName || '').trim();
  const label = displayName || user.email || 'Signed in';

  document.getElementById('accountEmail').textContent = label;
  document.getElementById('accountAvatar').textContent =
    label.charAt(0).toUpperCase();
}

async function refreshAccount() {
  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/account');

    if (!res.ok) return;

    const data = await res.json();

    document.getElementById('accountPlan').textContent = data.planName;
    document.getElementById('accountPlan').classList.remove('skeleton');
    document.getElementById('accountEmail').classList.remove('skeleton');

    currentAccountPlanId = data.planId || 'free';
    currentAccountHasDesignTemplates = !!(
      data.features && data.features.designTemplates
    );

    // If the previously selected template is no longer entitled
    // (e.g. the account downgraded), fall back to the default rather
    // than silently sending a template id the server will just reject.
    const stillEntitled = DESIGN_TEMPLATES.find(
      (t) =>
        t.id === selectedDesignTemplateId &&
        _planSatisfies(currentAccountPlanId, t.tier)
    );

    if (!stillEntitled) {
      selectedDesignTemplateId = 'classic';
    }

    renderDesignTemplatePicker();
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
      document.getElementById('usageResources').textContent =
        usage.used + ' / ' + usage.limit;

      document
        .getElementById('usageResources')
        .classList.remove('skeleton');

      const pct =
        usage.limit > 0
          ? Math.min(100, (usage.used / usage.limit) * 100)
          : 0;

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

  document
    .getElementById('sidebarCollapseBtn')
    .addEventListener('click', () => {
      sidebar.classList.toggle('is-collapsed');
    });

  document
    .getElementById('sidebarCloseBtn')
    .addEventListener('click', closeMobileSidebar);

  document
    .getElementById('mobileSidebarBtn')
    .addEventListener('click', () => {
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

  document.addEventListener('click', () => {
    menu.hidden = true;
  });

  document
    .getElementById('logOutBtn')
    .addEventListener('click', async () => {
      await window.Auth.logOut();
      window.location.href = '/login.html';
    });
}

/* ════════════════════════════════════════════════════════
   RESOURCE TYPE PICKER + GUIDED FORM
════════════════════════════════════════════════════════ */

function renderResourceTypeGrid() {
  const grid = document.getElementById('resourceTypeGrid');

  grid.innerHTML = RESOURCE_TYPES.map(
    (rt) =>
      '<button type="button" class="resource-type-card" data-type="' +
      rt.type +
      '">' +
      '<i class="ph ph-' +
      rt.icon +
      '"></i>' +
      '<span>' +
      rt.label +
      '</span>' +
      '</button>'
  ).join('');

  grid.querySelectorAll('.resource-type-card').forEach((btn) => {
    btn.addEventListener('click', () => openForm(btn.dataset.type));
  });
}

function _setFieldVisibility(id, visible) {
  const wrap = document.getElementById(id);

  if (wrap) {
    wrap.hidden = !visible;
  }
}

function _populateSelect(id, options, defaultValue) {
  const select = document.getElementById(id);

  if (!select) return;

  select.innerHTML = options
    .map(
      (option) =>
        '<option value="' +
        escapeHtml(option.value) +
        '">' +
        escapeHtml(option.label) +
        '</option>'
    )
    .join('');

  if (defaultValue) {
    select.value = defaultValue;
  }
}

function renderResourceSpecificFields(config) {
  _setFieldVisibility('difficultyFieldWrap', !!config.difficulty);
  _setFieldVisibility('lessonStyleFieldWrap', !!config.lessonStyle);
  _setFieldVisibility(
    'objectiveFocusFieldWrap',
    !!config.objectiveFocus
  );
  _setFieldVisibility(
    'questionStyleFieldWrap',
    !!config.questionStyle
  );
  _setFieldVisibility('questionMixFieldWrap', !!config.questionMix);
  _setFieldVisibility('cardStyleFieldWrap', !!config.cardStyle);
  _setFieldVisibility('totalMarksFieldWrap', !!config.totalMarks);
  _setFieldVisibility(
    'sectionCountFieldWrap',
    !!config.sectionCount
  );
  _setFieldVisibility(
    'lessonsPerWeekFieldWrap',
    !!config.lessonsPerWeek
  );

  if (config.difficulty) {
    _populateSelect(
      'fieldDifficulty',
      RESOURCE_OPTIONS.difficulty,
      'medium'
    );
  }

  if (config.lessonStyle) {
    _populateSelect(
      'fieldLessonStyle',
      RESOURCE_OPTIONS.lessonStyle,
      'direct_instruction'
    );
  }

  if (config.objectiveFocus) {
    _populateSelect(
      'fieldObjectiveFocus',
      RESOURCE_OPTIONS.objectiveFocus,
      'mixed'
    );
  }

  if (config.questionStyle) {
    _populateSelect(
      'fieldQuestionStyle',
      RESOURCE_OPTIONS.questionStyle,
      'mixed'
    );
  }

  if (config.questionMix) {
    _populateSelect(
      'fieldQuestionMix',
      RESOURCE_OPTIONS.questionMix,
      'mixed'
    );
  }

  if (config.cardStyle) {
    _populateSelect(
      'fieldCardStyle',
      RESOURCE_OPTIONS.cardStyle,
      'concept_definition'
    );
  }
}

function openForm(type) {
  selectedType = type;

  const config = TYPE_FIELD_CONFIG[type] || {};
  const rt = RESOURCE_TYPES.find((r) => r.type === type);

  document.getElementById('resourceTypeGrid').hidden = true;
  document.getElementById('resourceForm').hidden = false;

  document.getElementById('resourceFormTitle').textContent =
    rt ? rt.label : type;

  document.getElementById('topicFieldWrap').hidden = !config.topic;
  document.getElementById('fieldTopic').required = !!config.topic;

  document.getElementById('durationFieldWrap').hidden = !config.duration;

  // The existing HTML field is called "question count".
  // For presentations, it now represents slideCount instead.
  document.getElementById('questionCountFieldWrap').hidden =
    !(config.questionCount || config.slideCount);

  document.getElementById('termFieldWrap').hidden = !config.term;
  document.getElementById('weekCountFieldWrap').hidden =
    !config.weekCount;

  _setFieldVisibility(
    'totalMarksFieldWrap',
    !!config.totalMarks
  );

  _setFieldVisibility(
    'sectionCountFieldWrap',
    !!config.sectionCount
  );

  _setFieldVisibility(
    'lessonsPerWeekFieldWrap',
    !!config.lessonsPerWeek
  );

  // Update the existing count label when this form is used for
  // presentations. This avoids requiring an HTML change in Batch 1.
  const questionCountWrap = document.getElementById(
    'questionCountFieldWrap'
  );

  if (questionCountWrap) {
    const label = questionCountWrap.querySelector('span');

    if (label) {
      label.textContent = config.slideCount
        ? 'Number of slides'
        : 'Number of questions';
    }
  }

  const questionCountInput = document.getElementById(
    'fieldQuestionCount'
  );

  if (questionCountInput) {
    questionCountInput.placeholder = config.slideCount
      ? '10'
      : '10';
  }

  // Reset the custom instructions field for the new form session, and
  // tailor its placeholder to the resource type so it's obvious what
  // it's for.
  const customInstructionsInput = document.getElementById(
    'fieldCustomInstructions'
  );
  if (customInstructionsInput) {
    customInstructionsInput.value = '';
    customInstructionsInput.placeholder =
      type === 'lesson_note'
        ? 'e.g. Focus more on real-world examples, or include a labeled diagram description for each stage.'
        : 'e.g. Any specific angle, emphasis, or extra requirement for this resource.';
  }

  renderResourceSpecificFields(config);
  renderDesignTemplatePicker();
}

function closeForm() {
  selectedType = null;

  document.getElementById('resourceForm').reset();
  document.getElementById('resourceForm').hidden = true;
  document.getElementById('resourceTypeGrid').hidden = false;
}

/* ── Design template picker — built via DOM insertion rather than static
   markup, so this ships without needing an HTML file edit. Inserted once,
   just before the Generate button, and re-rendered whenever the account's
   plan or the active resource type changes. ── */

function _ensureDesignTemplatePickerContainer() {
  let container = document.getElementById('designTemplatePicker');

  if (container) return container;

  container = document.createElement('div');
  container.id = 'designTemplatePicker';
  container.className = 'design-template-picker';

  const generateBtn = document.getElementById('resourceGenerateBtn');

  if (generateBtn && generateBtn.parentElement) {
    generateBtn.parentElement.insertBefore(container, generateBtn);
  } else {
    document
      .getElementById('resourceForm')
      .appendChild(container);
  }

  return container;
}

function renderDesignTemplatePicker() {
  const form = document.getElementById('resourceForm');

  if (!form || form.hidden) return;

  const container = _ensureDesignTemplatePickerContainer();

  const swatchesHtml = DESIGN_TEMPLATES.map((t) => {
    const entitled = _planSatisfies(
      currentAccountPlanId,
      t.tier
    );

    const isActive = t.id === selectedDesignTemplateId;

    return (
      '<button type="button" class="design-template-swatch' +
      (isActive ? ' is-active' : '') +
      (entitled ? '' : ' is-locked') +
      '" ' +
      'data-template-id="' +
      t.id +
      '" data-entitled="' +
      entitled +
      '" title="' +
      escapeHtml(t.name) +
      '">' +
      '<span class="design-template-swatch-dot" style="background:' +
      t.accent +
      '"></span>' +
      '<span class="design-template-swatch-name">' +
      escapeHtml(t.name) +
      '</span>' +
      (entitled
        ? ''
        : '<i class="ph ph-lock-simple design-template-swatch-lock"></i>') +
      '</button>'
    );
  }).join('');

  container.innerHTML =
    '<span class="design-template-picker-label">Design</span>' +
    '<div class="design-template-swatch-row">' +
    swatchesHtml +
    '</div>';

  container
    .querySelectorAll('.design-template-swatch')
    .forEach((btn) => {
      btn.addEventListener('click', () => {
        const entitled = btn.dataset.entitled === 'true';
        const templateId = btn.dataset.templateId;

        if (!entitled) {
          const template = DESIGN_TEMPLATES.find(
            (t) => t.id === templateId
          );

          const tierLabel =
            template && template.tier === 'studio'
              ? 'Cognita Studio'
              : 'Cognita Plus';

          showToast(
            'The "' +
              (template ? template.name : 'selected') +
              '" design is available on ' +
              tierLabel +
              ' and above.'
          );

          return;
        }

        selectedDesignTemplateId = templateId;
        renderDesignTemplatePicker();
      });
    });
}

function wireForm() {
  document
    .getElementById('resourceFormBack')
    .addEventListener('click', closeForm);

  document
    .getElementById('resourceForm')
    .addEventListener('submit', async (e) => {
      e.preventDefault();

      if (!selectedType) return;

      const fields = {
        subject: document
          .getElementById('fieldSubject')
          .value.trim(),

        classLevel: document
          .getElementById('fieldClassLevel')
          .value.trim(),

        curriculum: document
          .getElementById('fieldCurriculum')
          .value.trim(),
      };

      const customInstructionsInput = document.getElementById(
        'fieldCustomInstructions'
      );
      if (customInstructionsInput && customInstructionsInput.value.trim()) {
        fields.customInstructions = customInstructionsInput.value.trim();
      }

      const config = TYPE_FIELD_CONFIG[selectedType] || {};

      if (config.topic) {
        fields.topic = document
          .getElementById('fieldTopic')
          .value.trim();
      }

      if (config.duration) {
        fields.duration = document
          .getElementById('fieldDuration')
          .value.trim();
      }

      // questionCount is used by worksheets, quizzes and flashcards.
      if (config.questionCount) {
        const n = parseInt(
          document.getElementById('fieldQuestionCount').value,
          10
        );

        if (n) {
          fields.questionCount = n;
        }
      }

      // Presentations use the same existing count input, but the
      // backend receives the semantically correct slideCount field.
      if (config.slideCount) {
        const n = parseInt(
          document.getElementById('fieldQuestionCount').value,
          10
        );

        if (n) {
          fields.slideCount = n;
        }
      }

      if (config.term) {
        fields.term = document
          .getElementById('fieldTerm')
          .value.trim();
      }

      if (config.weekCount) {
        const n = parseInt(
          document.getElementById('fieldWeekCount').value,
          10
        );

        if (n) {
          fields.weekCount = n;
        }
      }

      // ── Resource-specific generation controls ──

      if (config.difficulty) {
        fields.difficulty =
          document.getElementById('fieldDifficulty').value;
      }

      if (config.lessonStyle) {
        fields.lessonStyle =
          document.getElementById('fieldLessonStyle').value;
      }

      if (config.objectiveFocus) {
        fields.objectiveFocus =
          document.getElementById('fieldObjectiveFocus').value;
      }

      if (config.questionStyle) {
        fields.questionStyle =
          document.getElementById('fieldQuestionStyle').value;
      }

      if (config.questionMix) {
        fields.questionMix =
          document.getElementById('fieldQuestionMix').value;
      }

      if (config.cardStyle) {
        fields.cardStyle =
          document.getElementById('fieldCardStyle').value;
      }

      if (config.totalMarks) {
        const n = parseInt(
          document.getElementById('fieldTotalMarks').value,
          10
        );

        if (n) {
          fields.totalMarks = n;
        }
      }

      if (config.sectionCount) {
        const n = parseInt(
          document.getElementById('fieldSectionCount').value,
          10
        );

        if (n) {
          fields.sectionCount = n;
        }
      }

      if (config.lessonsPerWeek) {
        const n = parseInt(
          document.getElementById('fieldLessonsPerWeek').value,
          10
        );

        if (n) {
          fields.lessonsPerWeek = n;
        }
      }

      await generateResource(selectedType, fields);
    });
}

async function generateResource(resourceType, fields) {
  const btn = document.getElementById('resourceGenerateBtn');

  setBtnLoading(btn, true);

  try {
    const res = await window.Auth.authedFetch(
      WORKER_URL + '/api/resources/generate',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          resourceType,
          fields,
          designTemplateId: selectedDesignTemplateId,
        }),
      }
    );

    const data = await res.json();

    setBtnLoading(btn, false);

    if (!res.ok) {
      showToast(
        data.error || 'Could not generate the resource.'
      );
      return;
    }

    currentResource = data.resource;

    showResultPanel(currentResource);
    closeForm();

    await refreshUsage();
    await loadMyResources();
  } catch (e) {
    setBtnLoading(btn, false);

    showToast(
      'Could not reach Cognita. Please try again.'
    );

    console.error(
      '[resources] generate failed:',
      e.message
    );
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

// Renders a reasonable generic preview from structuredContent regardless
// of resource type — walks the object shallowly rather than needing a
// bespoke renderer per recipe. A proper per-type renderer can replace
// this later without touching the backend.
function renderStructuredPreview(content, resourceType) {
  if (
    window.ResourceRenderers &&
    typeof window.ResourceRenderers.render === 'function'
  ) {
    const specialized = window.ResourceRenderers.render(
      resourceType,
      content
    );

    if (specialized) {
      return specialized;
    }
  }

  let html = '';

  for (const key in content) {
    const value = content[key];

    const label = key
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, (c) => c.toUpperCase());

    if (Array.isArray(value)) {
      html +=
        '<h4>' +
        escapeHtml(label) +
        '</h4><ul>';

      value.forEach((item) => {
        if (typeof item === 'object' && item !== null) {
          html +=
            '<li>' +
            escapeHtml(
              Object.values(item).join(' — ')
            ) +
            '</li>';
        } else {
          html +=
            '<li>' +
            escapeHtml(String(item)) +
            '</li>';
        }
      });

      html += '</ul>';
    } else if (
      typeof value === 'object' &&
      value !== null
    ) {
      html +=
        '<h4>' +
        escapeHtml(label) +
        '</h4><p>' +
        escapeHtml(JSON.stringify(value)) +
        '</p>';
    } else if (
      typeof value !== 'undefined' &&
      value !== null &&
      String(value).trim()
    ) {
      html +=
        '<h4>' +
        escapeHtml(label) +
        '</h4><p>' +
        escapeHtml(String(value)) +
        '</p>';
    }
  }

  return html;
}

function wireResultPanel() {
  document
    .getElementById('resourceResultClose')
    .addEventListener('click', () => {
      if (!_confirmDiscardIfDirty()) return;

      document.getElementById(
        'resourcesResultPanel'
      ).hidden = true;

      currentResource = null;
    });

  document.getElementById('resourceEditBtn').addEventListener('click', toggleEditMode);
  document.getElementById('resourceEditSaveBtn').addEventListener('click', saveEdit);
  document.getElementById('resourceEditCancelBtn').addEventListener('click', () => {
    if (_confirmDiscardIfDirty()) setEditMode(false);
  });

  document.getElementById('resourceRegenerateBtn').addEventListener('click', submitRegenerate);
}

const FORMAT_LABELS = {
  docx: 'Word (.docx)',
  pdf: 'PDF',
  pptx: 'PowerPoint (.pptx)',
};

function showResultPanel(resource) {
  const panel = document.getElementById(
    'resourcesResultPanel'
  );

  const resultTitle = document.getElementById(
    'resourceResultTitle'
  );

  const resultBody = document.getElementById(
    'resourceResultBody'
  );

  panel.hidden = false;
  setEditMode(false);
  document.getElementById('resourceRegeneratePrompt').value = '';

  resultTitle.textContent =
    resource.structuredContent.title ||
    resource.title;

  resultBody.innerHTML = renderStructuredPreview(
    resource.structuredContent,
    resource.resourceType
  );

  if (
    window.ResourceRenderers &&
    typeof window.ResourceRenderers.mount === 'function'
  ) {
    window.ResourceRenderers.mount(
      resource.resourceType,
      resultBody,
      resource.structuredContent
    );
  }

  const actionsWrap = document.querySelector(
    '.resource-result-actions'
  );

  const availableFormats = Object.keys(
    resource.fileReferences || {}
  );

  renderDownloadControl(actionsWrap, resource.id, Object.keys(resource.fileReferences || {}), downloadResource);

  panel.scrollIntoView({
    behavior: 'smooth',
    block: 'start',
  });
}

// Small download icon that opens a popover listing whichever export
// formats (docx/pdf/pptx) are actually available for this resource,
// instead of a stacked full-width button per format. downloadFn lets
// this be reused for both a user's own resource (/api/resources/...)
// and a read-only library resource (/api/library/resources/...),
// which use different download endpoints.
function renderDownloadControl(actionsWrap, resourceId, availableFormats, downloadFn) {
  if (availableFormats.length === 0) {
    actionsWrap.innerHTML =
      '<p style="color:var(--text-3);font-size:var(--text-sm);text-align:center;">' +
      'No export is available for this resource yet.' +
      '</p>';
    return;
  }

  actionsWrap.innerHTML =
    '<div class="resource-download-control" style="position:relative;display:inline-block;">' +
    '<button type="button" class="resource-download-btn resource-download-toggle" ' +
    'aria-haspopup="true" aria-expanded="false" title="Download" ' +
    'style="width:36px;height:36px;padding:0;border-radius:50%;display:inline-flex;' +
    'align-items:center;justify-content:center;">' +
    '<i class="ph ph-download-simple" style="font-size:18px;"></i>' +
    '</button>' +
    '<div class="resource-download-menu" hidden style="position:absolute;bottom:44px;right:0;' +
    'background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius-md);' +
    'box-shadow:var(--shadow-lg);min-width:180px;z-index:20;overflow:hidden;">' +
    availableFormats
      .map(
        (format) =>
          '<button type="button" class="resource-download-option" data-format="' + format + '" ' +
          'style="display:flex;align-items:center;gap:8px;width:100%;padding:10px 14px;' +
          'background:none;border:none;text-align:left;cursor:pointer;font-size:var(--text-sm);">' +
          '<i class="ph ph-file-arrow-down"></i><span>' +
          (FORMAT_LABELS[format] || format.toUpperCase()) +
          '</span></button>'
      )
      .join('') +
    '</div>' +
    '</div>';

  const menu = actionsWrap.querySelector('.resource-download-menu');
  const toggle = actionsWrap.querySelector('.resource-download-toggle');

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = !menu.hidden;
    menu.hidden = isOpen;
    toggle.setAttribute('aria-expanded', String(!isOpen));
  });

  actionsWrap.querySelectorAll('.resource-download-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      menu.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      downloadFn(resourceId, btn.dataset.format, btn);
    });
  });

  // Close the popover on any click outside it. Attached once per render
  // and self-removed so repeated result panels don't stack listeners.
  const closeOnOutsideClick = (e) => {
    if (!actionsWrap.contains(e.target)) {
      menu.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
      document.removeEventListener('click', closeOnOutsideClick);
    }
  };
  document.addEventListener('click', closeOnOutsideClick);
}

/* ── Edit (structured form editor, no AI call) ── */

function setEditMode(isEditing) {
  document.getElementById('resourceResultBody').hidden = isEditing;
  document.getElementById('resourceEditWrap').hidden = !isEditing;
  document.getElementById('resourceEditBtn').hidden = isEditing;

  const saveBtn = document.getElementById('resourceEditSaveBtn');

  if (isEditing && currentResource) {
    const mountEl = document.getElementById('resourceEditForm');

    saveBtn.disabled = true;

    activeEditorHandle = window.ResourceEditor.mount(
      mountEl,
      currentResource.resourceType,
      currentResource.structuredContent,
      {
        onDirty: () => {
          saveBtn.disabled = false;
        },
      }
    );
  } else if (activeEditorHandle) {
    activeEditorHandle.destroy();
    activeEditorHandle = null;
  }
}

function toggleEditMode() {
  setEditMode(true);
}

function _confirmDiscardIfDirty() {
  if (activeEditorHandle && activeEditorHandle.isDirty()) {
    return window.confirm('You have unsaved changes. Discard them?');
  }
  return true;
}

async function saveEdit() {
  if (!currentResource || !activeEditorHandle) return;

  const structuredContent = activeEditorHandle.getValue();

  const btn = document.getElementById('resourceEditSaveBtn');
  setBtnLoading(btn, true);

  try {
    const res = await window.Auth.authedFetch(
      WORKER_URL + '/api/resources/' + currentResource.id + '/edit',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ structuredContent }),
      }
    );
    const data = await res.json();
    setBtnLoading(btn, false);

    if (!res.ok) {
      showToast(
        data.error ||
          'Could not save your changes. Check that every section has the details it needs.'
      );
      return;
    }

    currentResource = data.resource;
    showResultPanel(currentResource);
    showToast('Saved.');
    await loadMyResources();
  } catch (e) {
    setBtnLoading(btn, false);
    showToast('Could not reach Cognita. Please try again.');
    console.error('[resources] edit save failed:', e.message);
  }
}

/* ── Regenerate with a follow-up prompt (real AI call, revises in place) ── */

async function submitRegenerate() {
  if (!currentResource) return;

  const instruction = document
    .getElementById('resourceRegeneratePrompt')
    .value.trim();

  if (!instruction) {
    showToast('Describe what you would like changed.');
    return;
  }

  const btn = document.getElementById('resourceRegenerateBtn');
  setBtnLoading(btn, true);

  try {
    const res = await window.Auth.authedFetch(
      WORKER_URL + '/api/resources/' + currentResource.id + '/regenerate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instruction }),
      }
    );
    const data = await res.json();
    setBtnLoading(btn, false);

    if (!res.ok) {
      showToast(data.error || 'Could not regenerate the resource.');
      return;
    }

    currentResource = data.resource;
    showResultPanel(currentResource);
    showToast('Updated.');
    await refreshUsage();
    await loadMyResources();
  } catch (e) {
    setBtnLoading(btn, false);
    showToast('Could not reach Cognita. Please try again.');
    console.error('[resources] regenerate failed:', e.message);
  }
}

async function downloadResource(resourceId, format, btn) {
  if (btn) {
    btn.disabled = true;
  }

  try {
    const res = await window.Auth.authedFetch(
      WORKER_URL +
        '/api/resources/' +
        resourceId +
        '/download?format=' +
        encodeURIComponent(format),
      {
        method: 'POST',
      }
    );

    const data = await res.json();

    if (!res.ok) {
      showToast(
        data.error ||
          'Could not prepare the download.'
      );

      if (btn) {
        btn.disabled = false;
      }

      return;
    }

    const a = document.createElement('a');

    a.href = data.url;
    a.download = '';

    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (e) {
    showToast(
      'Could not reach Cognita. Please try again.'
    );

    console.error(
      '[resources] download failed:',
      e.message
    );
  }

  if (btn) {
    btn.disabled = false;
  }
}

/* ════════════════════════════════════════════════════════
   RECOMMENDED / FEATURED (admin-curated library content)
   Moved here from library.html since this is the page a user
   sees first. Read-only — no edit/regenerate, unlike a user's
   own resources above.
════════════════════════════════════════════════════════ */

async function loadRecommendedLibrary() {
  const section = document.getElementById('libraryRecommendedSection');
  try {
    const res = await window.Auth.authedFetch(WORKER_URL + '/api/library/resources');
    if (!res.ok) {
      section.hidden = true;
      return;
    }
    const data = await res.json();
    const recommended = (data.resources || []).filter((r) => r.recommended);

    if (recommended.length === 0) {
      section.hidden = true;
      return;
    }

    document.getElementById('libraryRecommendedHeading').textContent =
      recommended[0].recommendedReason === 'featured' ? 'Featured' : 'Recommended for you';

    section.hidden = false;
    await renderLibraryRecommendedGrid(recommended);
  } catch (e) {
    section.hidden = true;
    console.error('[resources] recommended library load failed:', e.message);
  }
}

// Each entry from /api/library/resources already carries an `excerpt`
// (built once, server-side, by the shared excerpt builder, and cached
// alongside the rest of the index entry) — so the card can show a
// real preview synchronously, with no per-card fetch and no
// "Loading previews..." step.
function renderLibraryRecommendedGrid(recommended) {
  const grid = document.getElementById('libraryRecommendedGrid');

  grid.innerHTML = recommended
    .map((r) => {
      const rt = RESOURCE_TYPES.find((t) => t.type === r.resourceType);
      const label = rt ? rt.label : r.resourceType;
      const previewText = r.excerpt ? escapeHtml(r.excerpt) : 'Preview unavailable.';

      return (
        '<button type="button" class="library-recommended-card" data-id="' + r.id + '">' +
        '<div class="library-recommended-card-preview">' + previewText + '</div>' +
        '<div class="library-recommended-card-foot">' +
        '<div class="library-recommended-card-title">' + escapeHtml(r.title || label) + '</div>' +
        '<div class="library-recommended-card-meta">' + escapeHtml(label) + '</div>' +
        '</div>' +
        '</button>'
      );
    })
    .join('');

  grid.querySelectorAll('.library-recommended-card').forEach((card) => {
    card.addEventListener('click', () => openLibraryPreview(card.dataset.id));
  });
}

function wireLibraryPreviewPanel() {
  document.getElementById('libraryPreviewClose').addEventListener('click', () => {
    document.getElementById('libraryPreviewPanel').hidden = true;
  });
}

async function openLibraryPreview(resourceId) {
  try {
    const res = await window.Auth.authedFetch(
      WORKER_URL + '/api/library/resources/' + resourceId
    );
    if (!res.ok) {
      showToast('Could not load that resource.');
      return;
    }
    const data = await res.json();
    const resource = data.resource;

    const panel = document.getElementById('libraryPreviewPanel');
    const body = document.getElementById('libraryPreviewBody');
    const actionsWrap = document.getElementById('libraryPreviewActions');

    document.getElementById('libraryPreviewTitle').textContent =
      resource.structuredContent.title || 'Resource';

    body.innerHTML = renderStructuredPreview(resource.structuredContent, resource.resourceType);

    if (window.ResourceRenderers && typeof window.ResourceRenderers.mount === 'function') {
      window.ResourceRenderers.mount(resource.resourceType, body, resource.structuredContent);
    }

    renderDownloadControl(
      actionsWrap,
      resource.id,
      Object.keys(resource.fileReferences || {}),
      downloadLibraryResource
    );

    panel.hidden = false;
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (e) {
    showToast('Could not reach Cognita.');
    console.error('[resources] library preview load failed:', e.message);
  }
}

async function downloadLibraryResource(resourceId, format, btn) {
  if (btn) btn.disabled = true;

  try {
    const res = await window.Auth.authedFetch(
      WORKER_URL + '/api/library/resources/' + resourceId + '/download?format=' + encodeURIComponent(format),
      { method: 'POST' }
    );
    const data = await res.json();

    if (!res.ok) {
      showToast(data.error || 'Could not prepare the download.');
      if (btn) btn.disabled = false;
      return;
    }

    const a = document.createElement('a');
    a.href = data.url;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } catch (e) {
    showToast('Could not reach Cognita. Please try again.');
    console.error('[resources] library download failed:', e.message);
  }

  if (btn) btn.disabled = false;
}

/* ════════════════════════════════════════════════════════
   MY RESOURCES LIST
════════════════════════════════════════════════════════ */

async function loadMyResources() {
  const list = document.getElementById(
    'myResourcesList'
  );

  try {
    const res = await window.Auth.authedFetch(
      WORKER_URL + '/api/resources/list'
    );

    if (!res.ok) return;

    const data = await res.json();

    if (
      !data.resources ||
      data.resources.length === 0
    ) {
      list.innerHTML =
        '<div class="my-resources-empty">' +
        'Your generated resources will appear here.' +
        '</div>';

      return;
    }

    list.innerHTML = data.resources
      .map((r) => {
        const rt = RESOURCE_TYPES.find(
          (t) => t.type === r.resourceType
        );

        const icon = rt ? rt.icon : 'file-text';
        const label = rt
          ? rt.label
          : r.resourceType;

        // Already have the full resource here (handleResourceList
        // returns full docs, not a summary), so the excerpt is just
        // built locally — no extra fetch per row.
        const excerpt =
          r.status === 'ready' && r.structuredContent
            ? buildExcerpt(r.structuredContent)
            : '';

        return (
          '<button class="my-resource-row" data-id="' +
          r.id +
          '">' +
          '<i class="ph ph-' +
          icon +
          ' resource-icon"></i>' +
          '<div class="my-resource-info">' +
          '<div class="my-resource-title">' +
          escapeHtml(r.title || label) +
          '</div>' +
          '<div class="my-resource-meta">' +
          escapeHtml(label) +
          (r.subject
            ? ' · ' + escapeHtml(r.subject)
            : '') +
          '</div>' +
          (excerpt
            ? '<div class="my-resource-excerpt">' + escapeHtml(excerpt) + '</div>'
            : '') +
          '</div>' +
          '<span class="my-resource-status status-' +
          r.status +
          '">' +
          r.status +
          '</span>' +
          '</button>'
        );
      })
      .join('');

    list
      .querySelectorAll('.my-resource-row')
      .forEach((row) => {
        row.addEventListener('click', () => {
          const resource = data.resources.find(
            (r) => r.id === row.dataset.id
          );

          if (
            resource &&
            resource.status === 'ready' &&
            resource.structuredContent
          ) {
            currentResource = resource;
            showResultPanel(resource);
          } else if (
            resource &&
            resource.status === 'failed'
          ) {
            showToast(
              'This resource failed to generate. Try creating it again.'
            );
          }
        });
      });
  } catch (e) {
    console.error(
      '[resources] could not load resource list:',
      e.message
    );
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

  if (existing) {
    existing.remove();
  }

  const toast = document.createElement('div');

  toast.className = 'toast';
  toast.textContent = message;

  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), 3000);
}
