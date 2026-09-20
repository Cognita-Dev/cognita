// js/resources.js
// Resources view behavior. Talks to the same Worker as the chat app,
// through window.Auth.authedFetch — never touches AI providers or B2
// directly.
//
// Exports mount(), called once by js/router.js the first time the
// resources view is opened. Sidebar chrome is owned by js/shell.js.

import { buildExcerpt } from '../excerpt-builder.js';
import { escapeHtml, showToast, renderAccountInfo } from './shell.js';

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
    includeImages: true,
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
let currentAccountHasFlashcardImages = false;
let activeEditorHandle = null;

export async function mount() {
  const user = await window.Auth.requireAuthOrRedirect();
  if (!user) return;

  renderAccountInfo(user);
  await refreshUsage();
  await refreshAccount();

  renderResourceTypeGrid();
  wireForm();
  wireResultPanel();
  wireLibraryPreviewPanel();
  await loadMyResources();
  await loadRecommendedLibrary();
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
    // Whether this account's plan is entitled to real AI-generated
    // flashcard images (see entitlements.js models.flashcardImages,
    // surfaced here by account-endpoint.js). Drives whether the
    // "Include real images" checkbox is usable or shown as locked.
    currentAccountHasFlashcardImages = !!(
      data.models && data.models.flashcardImages
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
    syncIncludeImagesFieldLock();
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

// Locks/unlocks the "Include real images" flashcard checkbox based on the
// resolved account plan. Free users see it disabled with a "Plus" badge
// and an upgrade-flavored hint instead of a working control — the server
// enforces this too (see resources-endpoint.js#_attachCardImages), this
// is purely so a free user isn't left checking a box that silently does
// nothing.
function syncIncludeImagesFieldLock() {
  const checkbox = document.getElementById('fieldIncludeImages');
  const badge = document.getElementById('includeImagesBadge');
  const hint = document.getElementById('includeImagesHint');

  if (!checkbox) return;

  if (currentAccountHasFlashcardImages) {
    checkbox.disabled = false;
    if (badge) badge.hidden = true;
    if (hint) {
      hint.textContent =
        'Cognita generates a real illustration for each card using AI, alongside the question and answer — great for visual learners and picture-based vocabulary decks.';
    }
  } else {
    checkbox.disabled = true;
    checkbox.checked = false;
    if (badge) badge.hidden = false;
    if (hint) {
      hint.textContent =
        'Available on Cognita Plus and above. Upgrade to add real AI-generated illustrations to each flashcard.';
    }
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

  _setFieldVisibility('includeImagesFieldWrap', !!config.includeImages);
  if (config.includeImages) {
    const includeImagesInput = document.getElementById('fieldIncludeImages');
    if (includeImagesInput) includeImagesInput.checked = false;
    syncIncludeImagesFieldLock();
  }

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

          // The flashcards recipe reads this as `cardCount`.
          if (selectedType === 'flashcards') {
            fields.cardCount = n;
          }
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

      if (config.includeImages) {
        const includeImagesInput = document.getElementById('fieldIncludeImages');
        // Only ever sent as true when the checkbox is both checked AND
        // not disabled (locked) — belt-and-braces alongside the
        // server-side plan check in resources-endpoint.js.
        fields.includeImages = !!(
          includeImagesInput &&
          includeImagesInput.checked &&
          !includeImagesInput.disabled
        );
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

    // Flashcard pictures are made afterwards, one card at a time, so the
    // deck itself appears straight away.
    if (resourceType === 'flashcards' && fields.includeImages) {
      runCardImageJobs(currentResource);
    }
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

/* ── Flashcard pictures (made one card at a time) ── */

let cardImageJobId = 0;

function getImageStatusEl() {
  let el = document.getElementById('resourceImageStatus');
  if (!el) {
    el = document.createElement('div');
    el.id = 'resourceImageStatus';
    el.style.cssText = 'font-size:0.85rem;opacity:0.75;padding:6px 0;';
    const body = document.getElementById('resourceResultBody');
    body.parentNode.insertBefore(el, body);
  }
  return el;
}

function hideImageStatus() {
  const el = document.getElementById('resourceImageStatus');
  if (el) el.remove();
}

// Redraws just the preview (without jumping the page) so freshly added
// pictures show up. Skipped while the user is editing, so nothing they
// are typing gets wiped.
function refreshResultBody(resource) {
  if (activeEditorHandle) return;
  const resultBody = document.getElementById('resourceResultBody');
  resultBody.innerHTML = renderStructuredPreview(
    resource.structuredContent,
    resource.resourceType
  );
  if (window.ResourceRenderers && typeof window.ResourceRenderers.mount === 'function') {
    window.ResourceRenderers.mount(resource.resourceType, resultBody, resource.structuredContent);
  }
}

async function runCardImageJobs(resource) {
  const cards = resource && resource.structuredContent && resource.structuredContent.cards;
  if (!Array.isArray(cards)) return;

  const pending = [];
  cards.forEach((card, index) => {
    if (card && card.imagePrompt && !card.image) pending.push(index);
  });
  if (!pending.length) return;

  const jobId = ++cardImageJobId;
  const resourceId = resource.id;
  let added = 0;
  let stopMessage = '';
  let consecutiveFailures = 0;

  for (let n = 0; n < pending.length; n++) {
    // Stop quietly if the person started something else or opened a
    // different resource.
    if (jobId !== cardImageJobId || !currentResource || currentResource.id !== resourceId) {
      hideImageStatus();
      return;
    }

    getImageStatusEl().textContent =
      'Adding pictures to your cards… ' + (n + 1) + ' of ' + pending.length;

    const index = pending[n];

    try {
      const res = await window.Auth.authedFetch(
        WORKER_URL + '/api/resources/' + resourceId + '/cards/' + index + '/image',
        { method: 'POST' }
      );
      const data = await res.json().catch(() => ({}));

      if (res.status === 403 || res.status === 429) {
        stopMessage = data.error || '';
        break;
      }

      if (res.ok && data.image) {
        const target = currentResource.structuredContent.cards[index];
        if (target) {
          target.image = data.image;
          added++;
        }
        consecutiveFailures = 0;
      } else {
        consecutiveFailures++;
      }
    } catch (e) {
      console.error('[resources] card image request failed:', e.message);
      consecutiveFailures++;
    }

    if (consecutiveFailures >= 3) {
      stopMessage = 'Some pictures could not be added. Please try again later.';
      break;
    }
  }

  if (jobId !== cardImageJobId) return;

  hideImageStatus();

  if (currentResource && currentResource.id === resourceId && added) {
    refreshResultBody(currentResource);
  }

  if (stopMessage) {
    showToast(stopMessage);
  } else if (added) {
    showToast('Pictures added.');
  }

  await refreshUsage();
  await loadMyResources();
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
  // Always start the preview scrolled to the top, so the title/intro
  // is what's visible first — not wherever a previous resource's
  // scroll position happened to be left.
  resultBody.scrollTop = 0;

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

  const actionsWrap = document.getElementById('resourceResultActions');

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
//
// The popover itself is appended straight to <body> and positioned with
// fixed coordinates computed from the toggle button's bounding rect (see
// _openDownloadMenu below), instead of being absolutely positioned inside
// the result panel. That's what makes it show up reliably on both mobile
// and desktop: nested + absolutely positioned, it used to get clipped
// down to nothing by an ancestor panel's overflow:hidden, which is why
// the menu (and the download options inside it) looked like they weren't
// working at all.
let _openDownloadMenuState = null; // { menu, toggle, cleanup }

function _closeOpenDownloadMenu() {
  if (_openDownloadMenuState) {
    _openDownloadMenuState.cleanup();
    _openDownloadMenuState = null;
  }
}

function renderDownloadControl(actionsWrap, resourceId, availableFormats, downloadFn) {
  if (availableFormats.length === 0) {
    actionsWrap.innerHTML =
      '<p style="color:var(--text-3);font-size:var(--text-sm);text-align:center;">' +
      'No export is available for this resource yet.' +
      '</p>';
    return;
  }

  actionsWrap.innerHTML =
    '<div class="resource-download-control">' +
    '<button type="button" class="resource-download-btn resource-download-toggle" ' +
    'aria-haspopup="true" aria-expanded="false" title="Download">' +
    '<i class="ph ph-download-simple" style="font-size:18px;"></i>' +
    '</button>' +
    '</div>';

  const toggle = actionsWrap.querySelector('.resource-download-toggle');

  toggle.addEventListener('click', (e) => {
    e.stopPropagation();

    // Clicking the same toggle again closes it; clicking a different
    // resource's toggle closes whichever menu was open and opens this one.
    if (_openDownloadMenuState && _openDownloadMenuState.toggle === toggle) {
      _closeOpenDownloadMenu();
      return;
    }
    _closeOpenDownloadMenu();
    _openDownloadMenu(toggle, resourceId, availableFormats, downloadFn);
  });
}

function _openDownloadMenu(toggle, resourceId, availableFormats, downloadFn) {
  const menu = document.createElement('div');
  menu.className = 'resource-download-menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = availableFormats
    .map(
      (format) =>
        '<button type="button" class="resource-download-option" data-format="' + format + '" role="menuitem">' +
        '<i class="ph ph-file-arrow-down"></i><span>' +
        (FORMAT_LABELS[format] || format.toUpperCase()) +
        '</span></button>'
    )
    .join('');

  document.body.appendChild(menu);
  toggle.setAttribute('aria-expanded', 'true');

  function position() {
    const rect = toggle.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const gap = 8;

    let left = rect.right - menuRect.width;
    left = Math.max(gap, Math.min(left, window.innerWidth - menuRect.width - gap));

    // Prefer opening upward (the button usually sits at the bottom of a
    // result panel), but flip below the button if there isn't room above
    // — important on short mobile viewports.
    let top = rect.top - menuRect.height - gap;
    if (top < gap) {
      top = Math.min(rect.bottom + gap, window.innerHeight - menuRect.height - gap);
    }

    menu.style.left = left + 'px';
    menu.style.top = Math.max(gap, top) + 'px';
  }

  position();
  // The menu's real size can shift slightly after first paint (icon
  // fonts loading in); re-measure once more on the next frame.
  requestAnimationFrame(position);

  window.addEventListener('resize', position);
  window.addEventListener('scroll', position, true);

  const onOutsideClick = (e) => {
    if (!menu.contains(e.target) && e.target !== toggle) {
      _closeOpenDownloadMenu();
    }
  };
  const onKeydown = (e) => {
    if (e.key === 'Escape') _closeOpenDownloadMenu();
  };
  document.addEventListener('click', onOutsideClick);
  document.addEventListener('keydown', onKeydown);

  menu.querySelectorAll('.resource-download-option').forEach((btn) => {
    btn.addEventListener('click', () => {
      const format = btn.dataset.format;
      _closeOpenDownloadMenu();
      downloadFn(resourceId, format, toggle);
    });
  });

  _openDownloadMenuState = {
    menu,
    toggle,
    cleanup: () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      document.removeEventListener('click', onOutsideClick);
      document.removeEventListener('keydown', onKeydown);
      toggle.setAttribute('aria-expanded', 'false');
      menu.remove();
    },
  };
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
   Shown here since Resources is the view a user sees first.
   Read-only — no edit/regenerate, unlike a user's own
   resources above.
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
    body.scrollTop = 0;

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
