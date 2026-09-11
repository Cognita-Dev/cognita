// js/resources.js
// Resources page behavior. Talks to the same Worker as the chat app,
// through window.Auth.authedFetch — never touches AI providers or B2
// directly.

const WORKER_URL = 'https://cognita.cognitai.workers.dev';

// Kept in sync with recipes/index.js's RECIPE_LABELS on the backend.
// If a new recipe is added server-side, add its label + icon here too.
const RESOURCE_TYPES = [
  { type: 'lesson_plan', label: 'Lesson Plan', icon: 'chalkboard-teacher' },
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
  await loadMyResources();
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
      document.getElementById(
        'resourcesResultPanel'
      ).hidden = true;

      currentResource = null;
    });
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

  if (availableFormats.length === 0) {
    actionsWrap.innerHTML =
      '<p style="color:var(--text-3);font-size:var(--text-sm);text-align:center;">' +
      'No export is available for this resource yet.' +
      '</p>';
  } else {
    actionsWrap.innerHTML = availableFormats
      .map(
        (format) =>
          '<button class="resource-download-btn" ' +
          'data-format="' +
          format +
          '" style="margin-bottom:8px;">' +
          '<i class="ph ph-file-arrow-down"></i>' +
          '<span>Download ' +
          (FORMAT_LABELS[format] ||
            format.toUpperCase()) +
          '</span>' +
          '</button>'
      )
      .join('');

    actionsWrap
      .querySelectorAll('.resource-download-btn')
      .forEach((btn) => {
        btn.addEventListener('click', () =>
          downloadResource(
            resource.id,
            btn.dataset.format,
            btn
          )
        );
      });
  }

  panel.scrollIntoView({
    behavior: 'smooth',
    block: 'start',
  });
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
