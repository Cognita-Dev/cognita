// js/resource-editor.js
//
// Generic, schema-driven editor for a resource's structuredContent.
// Renders plain-language form controls (text fields, number fields,
// list editors, term/explanation pairs, reorderable section/card lists)
// instead of raw JSON. Works across every resource type by inferring
// the shape of each field, with small per-resourceType configs for
// labels, section "type" choices, linked arrays (e.g. worksheet
// questions + answerKey), and derived fields (e.g. exam markingScheme)
// where the generic inference isn't enough on its own.
//
// Public API:
//   ResourceEditor.mount(container, resourceType, structuredContent, opts)
//     -> returns a handle: { getValue(), isDirty(), destroy() }

window.ResourceEditor = (function () {
  // ── Per-resource-type customization. Falls back to sane generic
  // defaults for any resourceType not listed here — nothing breaks for
  // future recipes; it just won't get the extra polish below. ──
  const RECIPE_EDITOR_CONFIG = {
    lesson_note: {
      topLevelLabels: { title: 'Title', introduction: 'Introduction', summary: 'Summary' },
      sectionsKey: 'sections',
      // A Nigerian classroom lesson note is taught/copied as a run of
      // labelled sub-topics (definitions, explanations, examples) — it
      // is never presented to a student under a meta-label like
      // "Sections", which reads like a document-editing artifact rather
      // than actual lesson content.
      sectionsLabel: 'Lesson Content',
      sectionTypeOptions: [
        { value: 'paragraph', label: 'Paragraph' },
        { value: 'bullets', label: 'Bullet list' },
        { value: 'numbered', label: 'Numbered list' },
        { value: 'definition', label: 'Term definitions' },
        { value: 'example', label: 'Example' },
        { value: 'formula', label: 'Formula' },
      ],
    },

    presentation: {
      topLevelLabels: { title: 'Title' },
    },

    // Backend requires questions.length === answerKey.length and every
    // answerKey.marks to equal the matching question's marks. Editing
    // these as two independent lists risks breaking that in ways that
    // are invisible until save fails — so they're merged into one
    // question+answer card, and both arrays are rebuilt in sync from it.
    worksheet: {
      linkedList: {
        primaryKey: 'questions',
        linkedKey: 'answerKey',
        answerFields: ['answer', 'marks'], // copied/paired per question, marks mirrors the question's own marks
        questionFieldOrder: ['question', 'type', 'options', 'marks'],
        typeSelectField: {
          key: 'type',
          options: [
            { value: 'short_answer', label: 'Short answer' },
            { value: 'multiple_choice', label: 'Multiple choice' },
            { value: 'fill_blank', label: 'Fill in the blank' },
          ],
        },
      },
    },

    test: {
      linkedList: {
        primaryKey: 'questions',
        linkedKey: 'answerKey',
        answerFields: ['answer'], // test's answerKey has no marks field of its own
        questionFieldOrder: ['question', 'marks'],
      },
    },

    // Exam nests questions inside sections, and separately requires a
    // markingScheme entry per question with matching number + marks.
    // Asking a teacher to hand-sync three structures is a trap, so
    // markingScheme is treated as derived: it's rebuilt from the
    // sections' questions on every save (existing "answer" text is kept,
    // matched by position), and isn't shown as its own editable list.
    exam: {
      derivedKeys: ['markingScheme'],
      derivedNote:
        'The marking scheme is generated automatically from the questions below, and stays in sync with their numbers and marks.',
      postProcess(value) {
        let n = 1;
        const flatQuestions = [];
        (value.sections || []).forEach((section) => {
          (section.questions || []).forEach((q) => {
            q.number = n++;
            flatQuestions.push(q);
          });
        });
        const oldScheme = Array.isArray(value.markingScheme) ? value.markingScheme : [];
        value.markingScheme = flatQuestions.map((q, i) => ({
          number: q.number,
          marks: q.marks,
          answer: (oldScheme[i] && oldScheme[i].answer) || '',
        }));
        return value;
      },
    },
  };

  function getConfig(resourceType) {
    return RECIPE_EDITOR_CONFIG[resourceType] || {};
  }

  function prettyLabel(key) {
    return String(key)
      .replace(/([A-Z])/g, ' $1')
      .replace(/^./, (c) => c.toUpperCase())
      .replace(/\bId\b/, 'ID');
  }

  function el(tag, className, attrs) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (attrs) {
      for (const k in attrs) node.setAttribute(k, attrs[k]);
    }
    return node;
  }

  // ── Value classification ──
  // Decide how to render a given value so every recipe's shape is covered
  // without a bespoke renderer per type.
  function classify(value) {
    if (typeof value === 'number') return 'number';
    if (typeof value === 'string') {
      return value.length > 140 || value.includes('\n') ? 'longtext' : 'shorttext';
    }
    if (Array.isArray(value)) {
      if (value.length === 0) return 'stringlist'; // empty: assume editable string list
      const first = value[0];
      if (typeof first === 'string') return 'stringlist';
      if (
        first &&
        typeof first === 'object' &&
        'term' in first &&
        'explanation' in first
      ) {
        return 'termlist';
      }
      if (first && typeof first === 'object' && 'heading' in first && 'type' in first) {
        return 'sectionlist'; // lesson-note-style sections
      }
      if (first && typeof first === 'object') return 'objectlist'; // slides, questions, etc.
      return 'stringlist';
    }
    return 'shorttext';
  }

  // ── Field builders. Each returns { node, getValue() }. ──

  function buildShortText(value, label) {
    const wrap = el('div', 'redit-field');
    const lab = el('label', 'redit-field-label');
    lab.textContent = label;
    const input = el('input', 'redit-input', { type: 'text' });
    input.value = value == null ? '' : String(value);
    wrap.appendChild(lab);
    wrap.appendChild(input);
    return { node: wrap, getValue: () => input.value };
  }

  // Numeric fields (marks, totals, counts, indices). The backend does
  // strict typeof === 'number' checks in validate(), so this must return
  // an actual Number, never the input's raw string value.
  function buildNumberField(value, label) {
    const wrap = el('div', 'redit-field');
    const lab = el('label', 'redit-field-label');
    lab.textContent = label;
    const input = el('input', 'redit-input', { type: 'number', step: 'any' });
    input.value = value == null || Number.isNaN(value) ? '' : String(value);
    wrap.appendChild(lab);
    wrap.appendChild(input);
    return {
      node: wrap,
      getValue: () => {
        const n = Number(input.value);
        return Number.isFinite(n) ? n : 0;
      },
    };
  }

  function buildSelectField(value, label, options) {
    const wrap = el('div', 'redit-field');
    const lab = el('label', 'redit-field-label');
    lab.textContent = label;
    const select = el('select', 'redit-select');
    options.forEach((opt) => {
      const o = el('option', null, { value: opt.value });
      o.textContent = opt.label;
      select.appendChild(o);
    });
    if (value) select.value = value;
    wrap.appendChild(lab);
    wrap.appendChild(select);
    return { node: wrap, getValue: () => select.value };
  }

  function autoGrow(textarea) {
    const resize = () => {
      textarea.style.height = 'auto';
      textarea.style.height = textarea.scrollHeight + 'px';
    };
    textarea.addEventListener('input', resize);
    setTimeout(resize, 0);
  }

  function buildLongText(value, label) {
    const wrap = el('div', 'redit-field');
    const lab = el('label', 'redit-field-label');
    lab.textContent = label;
    const textarea = el('textarea', 'redit-textarea');
    textarea.value = value == null ? '' : String(value);
    textarea.rows = Math.min(12, Math.max(3, Math.ceil(String(value || '').length / 60)));
    wrap.appendChild(lab);
    wrap.appendChild(textarea);
    autoGrow(textarea);
    return { node: wrap, getValue: () => textarea.value };
  }

  // Tag-style list editor for string arrays (bullets, numbered, options, etc.)
  function buildStringList(values, label) {
    const wrap = el('div', 'redit-field');
    const lab = el('label', 'redit-field-label');
    lab.textContent = label;
    const list = el('div', 'redit-list');

    const rows = [];

    function addRow(text) {
      const row = el('div', 'redit-list-row');
      const handle = el('span', 'redit-drag-handle');
      handle.innerHTML = '<i class="ph ph-dots-six-vertical"></i>';
      const input = el('input', 'redit-input redit-list-input', { type: 'text' });
      input.value = text || '';
      const removeBtn = el('button', 'redit-icon-btn', { type: 'button', title: 'Remove' });
      removeBtn.innerHTML = '<i class="ph ph-x"></i>';
      row.appendChild(handle);
      row.appendChild(input);
      row.appendChild(removeBtn);
      list.appendChild(row);

      const rowRef = { row, input };
      removeBtn.addEventListener('click', () => {
        list.removeChild(row);
        const idx = rows.indexOf(rowRef);
        if (idx !== -1) rows.splice(idx, 1);
      });

      rows.push(rowRef);
      wireDrag(row, list);
      return rowRef;
    }

    (values || []).forEach((v) => addRow(v));

    const addBtn = el('button', 'redit-add-btn', { type: 'button' });
    addBtn.innerHTML = '<i class="ph ph-plus"></i><span>Add item</span>';
    addBtn.addEventListener('click', () => {
      addRow('').input.focus();
    });

    wrap.appendChild(lab);
    wrap.appendChild(list);
    wrap.appendChild(addBtn);

    return {
      node: wrap,
      getValue: () =>
        rows
          .filter((r) => list.contains(r.row))
          .map((r) => r.input.value.trim())
          .filter((v) => v.length > 0),
    };
  }

  // Term / explanation pair editor (definition sections)
  function buildTermList(values, label) {
    const wrap = el('div', 'redit-field');
    const lab = el('label', 'redit-field-label');
    lab.textContent = label;
    const list = el('div', 'redit-termlist');
    const rows = [];

    function addRow(term, explanation) {
      const row = el('div', 'redit-term-row');
      const termInput = el('input', 'redit-input redit-term-input', {
        type: 'text',
        placeholder: 'Term',
      });
      termInput.value = term || '';
      const explInput = el('textarea', 'redit-textarea redit-term-explanation', {
        placeholder: 'Explanation',
      });
      explInput.value = explanation || '';
      const removeBtn = el('button', 'redit-icon-btn', { type: 'button', title: 'Remove' });
      removeBtn.innerHTML = '<i class="ph ph-x"></i>';

      const top = el('div', 'redit-term-row-top');
      top.appendChild(termInput);
      top.appendChild(removeBtn);
      row.appendChild(top);
      row.appendChild(explInput);
      list.appendChild(row);
      autoGrow(explInput);

      const rowRef = { row, termInput, explInput };
      removeBtn.addEventListener('click', () => {
        list.removeChild(row);
        const idx = rows.indexOf(rowRef);
        if (idx !== -1) rows.splice(idx, 1);
      });

      rows.push(rowRef);
      return rowRef;
    }

    (values || []).forEach((v) => addRow(v.term, v.explanation));

    const addBtn = el('button', 'redit-add-btn', { type: 'button' });
    addBtn.innerHTML = '<i class="ph ph-plus"></i><span>Add term</span>';
    addBtn.addEventListener('click', () => addRow('', '').termInput.focus());

    wrap.appendChild(lab);
    wrap.appendChild(list);
    wrap.appendChild(addBtn);

    return {
      node: wrap,
      getValue: () =>
        rows
          .filter((r) => list.contains(r.row))
          .map((r) => ({
            term: r.termInput.value.trim(),
            explanation: r.explInput.value.trim(),
          }))
          .filter((r) => r.term || r.explanation),
    };
  }

  // A single section's "content", rendered based on its "type" field.
  function buildSectionContentField(section) {
    switch (section.type) {
      case 'bullets':
      case 'numbered':
        return buildStringList(section.content, 'Items');
      case 'definition':
        return buildTermList(section.content, 'Terms');
      case 'example':
      case 'formula':
      case 'paragraph':
      default:
        return buildLongText(section.content, 'Content');
    }
  }

  // Reorderable list of "sections" (lesson-note style: heading + type + content)
  function buildSectionList(sections, config) {
    const wrap = el('div', 'redit-field redit-sectionlist-field');
    const lab = el('label', 'redit-field-label');
    lab.textContent = (config && config.sectionsLabel) || 'Sections';
    const list = el('div', 'redit-sections');
    const cards = [];

    const typeOptions = (config && config.sectionTypeOptions) || [
      { value: 'paragraph', label: 'Paragraph' },
      { value: 'bullets', label: 'Bullet list' },
      { value: 'numbered', label: 'Numbered list' },
      { value: 'definition', label: 'Term definitions' },
      { value: 'example', label: 'Example' },
      { value: 'formula', label: 'Formula' },
    ];

    function addCard(section) {
      section = section || { heading: '', type: 'paragraph', content: '' };
      const card = el('div', 'redit-section-card');

      const headerRow = el('div', 'redit-section-card-header');
      const handle = el('span', 'redit-drag-handle');
      handle.innerHTML = '<i class="ph ph-dots-six-vertical"></i>';
      const headingInput = el('input', 'redit-input redit-section-heading', {
        type: 'text',
        placeholder: 'Section heading',
      });
      headingInput.value = section.heading || '';

      const typeSelect = el('select', 'redit-select');
      typeOptions.forEach((opt) => {
        const o = el('option', null, { value: opt.value });
        o.textContent = opt.label;
        typeSelect.appendChild(o);
      });
      typeSelect.value = section.type;

      const removeBtn = el('button', 'redit-icon-btn', { type: 'button', title: 'Remove section' });
      removeBtn.innerHTML = '<i class="ph ph-trash"></i>';

      headerRow.appendChild(handle);
      headerRow.appendChild(headingInput);
      headerRow.appendChild(typeSelect);
      headerRow.appendChild(removeBtn);

      const contentSlot = el('div', 'redit-section-content-slot');
      let contentField = buildSectionContentField(section);
      contentSlot.appendChild(contentField.node);

      typeSelect.addEventListener('change', () => {
        contentSlot.innerHTML = '';
        contentField = buildSectionContentField({ type: typeSelect.value, content: undefined });
        contentSlot.appendChild(contentField.node);
      });

      card.appendChild(headerRow);
      card.appendChild(contentSlot);
      list.appendChild(card);

      const cardRef = { card, headingInput, typeSelect, getContent: () => contentField.getValue() };
      removeBtn.addEventListener('click', () => {
        list.removeChild(card);
        const idx = cards.indexOf(cardRef);
        if (idx !== -1) cards.splice(idx, 1);
      });

      cards.push(cardRef);
      wireDrag(card, list);
      return cardRef;
    }

    (sections || []).forEach((s) => addCard(s));

    const addBtn = el('button', 'redit-add-btn', { type: 'button' });
    addBtn.innerHTML = '<i class="ph ph-plus"></i><span>Add section</span>';
    addBtn.addEventListener('click', () => {
      addCard(null).headingInput.focus();
      list.scrollTop = list.scrollHeight;
    });

    wrap.appendChild(lab);
    wrap.appendChild(list);
    wrap.appendChild(addBtn);

    return {
      node: wrap,
      getValue: () =>
        cards
          .filter((c) => list.contains(c.card))
          .map((c) => ({
            heading: c.headingInput.value.trim(),
            type: c.typeSelect.value,
            content: c.getContent(),
          }))
          .filter((s) => s.heading || (Array.isArray(s.content) ? s.content.length : s.content)),
    };
  }

  // Builds the right control for one sub-field inside an object-list card,
  // recursing into nested arrays/objects (e.g. exam's sections[].questions).
  function buildSubField(value, key, opts) {
    opts = opts || {};
    const label = (opts.labels && opts.labels[key]) || prettyLabel(key);

    if (opts.selectFields && opts.selectFields[key]) {
      return buildSelectField(value, label, opts.selectFields[key]);
    }

    const kind = classify(value);
    switch (kind) {
      case 'number':
        return buildNumberField(value, label);
      case 'longtext':
        return buildLongText(value, label);
      case 'stringlist':
        return buildStringList(value, label);
      case 'termlist':
        return buildTermList(value, label);
      case 'sectionlist':
        return buildSectionList(value, {});
      case 'objectlist':
        return buildObjectList(value, label);
      default:
        return buildShortText(value, label);
    }
  }

  // Generic reorderable list of plain objects (slides, questions, cards,
  // criteria...) whose own fields are each rendered recursively. Any item
  // that has a "number" field gets it auto-renumbered sequentially on
  // save, matching the "sequential starting at 1" rule most recipes need
  // — removing a common source of manual renumbering mistakes.
  function buildObjectList(items, label, opts) {
    opts = opts || {};
    const wrap = el('div', 'redit-field redit-sectionlist-field');
    const lab = el('label', 'redit-field-label');
    lab.textContent = label;
    const list = el('div', 'redit-sections');
    const cards = [];

    const keys = items && items.length ? Object.keys(items[0]) : ['text'];
    const hasNumberField = keys.includes('number');

    function addCard(item) {
      item = item || {};
      const card = el('div', 'redit-section-card');
      const headerRow = el('div', 'redit-section-card-header');
      const handle = el('span', 'redit-drag-handle');
      handle.innerHTML = '<i class="ph ph-dots-six-vertical"></i>';
      const removeBtn = el('button', 'redit-icon-btn', { type: 'button', title: 'Remove' });
      removeBtn.innerHTML = '<i class="ph ph-trash"></i>';
      headerRow.appendChild(handle);
      headerRow.appendChild(el('span', 'redit-section-card-title-spacer'));
      headerRow.appendChild(removeBtn);

      const body = el('div', 'redit-section-content-slot');
      const subFields = {};
      keys.forEach((k) => {
        if (k === 'number') return; // auto-managed, not shown
        const f = buildSubField(item[k], k, opts);
        body.appendChild(f.node);
        subFields[k] = f;
      });

      card.appendChild(headerRow);
      card.appendChild(body);
      list.appendChild(card);

      const cardRef = {
        card,
        getValue: () => {
          const out = {};
          keys.forEach((k) => {
            if (k === 'number') return;
            out[k] = subFields[k].getValue();
          });
          return out;
        },
      };
      removeBtn.addEventListener('click', () => {
        list.removeChild(card);
        const idx = cards.indexOf(cardRef);
        if (idx !== -1) cards.splice(idx, 1);
      });

      cards.push(cardRef);
      wireDrag(card, list);
      return cardRef;
    }

    (items || []).forEach((it) => addCard(it));

    const addBtn = el('button', 'redit-add-btn', { type: 'button' });
    addBtn.innerHTML = '<i class="ph ph-plus"></i><span>Add</span>';
    addBtn.addEventListener('click', () => addCard(null));

    wrap.appendChild(lab);
    wrap.appendChild(list);
    wrap.appendChild(addBtn);

    return {
      node: wrap,
      getValue: () =>
        cards
          .filter((c) => list.contains(c.card))
          .map((c, i) => {
            const v = c.getValue();
            if (hasNumberField) v.number = i + 1;
            return v;
          }),
    };
  }

  // ── Linked question + answer editor (worksheet, test) ──
  // Renders one card per question that shows the question's own fields
  // plus its paired answer fields together, so a teacher edits one
  // coherent thing instead of two arrays that must stay in sync by hand.
  // getValue() returns { [primaryKey]: [...], [linkedKey]: [...] },
  // always the same length, always sequentially numbered, with any
  // "marks" the answer needs mirrored from the question automatically.
  function buildLinkedQuestionList(primaryItems, linkedItems, linkConfig) {
    const wrap = el('div', 'redit-field redit-sectionlist-field');
    const lab = el('label', 'redit-field-label');
    lab.textContent = 'Questions & Answers';
    const list = el('div', 'redit-sections');
    const cards = [];

    const questionKeys = linkConfig.questionFieldOrder ||
      (primaryItems && primaryItems.length
        ? Object.keys(primaryItems[0]).filter((k) => k !== 'number')
        : ['question']);

    const selectFields = {};
    if (linkConfig.typeSelectField) {
      selectFields[linkConfig.typeSelectField.key] = linkConfig.typeSelectField.options;
    }

    function addCard(question, answer) {
      question = question || {};
      answer = answer || {};

      const card = el('div', 'redit-section-card redit-linked-card');
      const headerRow = el('div', 'redit-section-card-header');
      const handle = el('span', 'redit-drag-handle');
      handle.innerHTML = '<i class="ph ph-dots-six-vertical"></i>';
      const removeBtn = el('button', 'redit-icon-btn', { type: 'button', title: 'Remove' });
      removeBtn.innerHTML = '<i class="ph ph-trash"></i>';
      headerRow.appendChild(handle);
      headerRow.appendChild(el('span', 'redit-section-card-title-spacer'));
      headerRow.appendChild(removeBtn);

      const body = el('div', 'redit-section-content-slot');
      const qFields = {};
      questionKeys.forEach((k) => {
        const f = buildSubField(question[k], k, { selectFields });
        body.appendChild(f.node);
        qFields[k] = f;
      });

      const answerDivider = el('div', 'redit-linked-answer-divider');
      answerDivider.textContent = 'Answer';
      body.appendChild(answerDivider);

      const answerField = buildLongText(answer.answer, 'Correct answer');
      body.appendChild(answerField.node);

      card.appendChild(headerRow);
      card.appendChild(body);
      list.appendChild(card);

      const cardRef = {
        card,
        getQuestion: () => {
          const out = {};
          questionKeys.forEach((k) => (out[k] = qFields[k].getValue()));
          return out;
        },
        getAnswerText: () => answerField.getValue(),
      };

      removeBtn.addEventListener('click', () => {
        list.removeChild(card);
        const idx = cards.indexOf(cardRef);
        if (idx !== -1) cards.splice(idx, 1);
      });

      cards.push(cardRef);
      wireDrag(card, list);
      return cardRef;
    }

    const count = Math.max((primaryItems || []).length, (linkedItems || []).length);
    for (let i = 0; i < count; i++) {
      addCard((primaryItems || [])[i], (linkedItems || [])[i]);
    }

    const addBtn = el('button', 'redit-add-btn', { type: 'button' });
    addBtn.innerHTML = '<i class="ph ph-plus"></i><span>Add question</span>';
    addBtn.addEventListener('click', () => addCard(null, null));

    wrap.appendChild(lab);
    wrap.appendChild(list);
    wrap.appendChild(addBtn);

    return {
      node: wrap,
      getValue: () => {
        const liveCards = cards.filter((c) => list.contains(c.card));
        const questions = liveCards.map((c, i) => {
          const q = c.getQuestion();
          q.number = i + 1;
          return q;
        });
        const answerKey = liveCards.map((c, i) => {
          const entry = { number: i + 1, answer: c.getAnswerText() };
          if (linkConfig.answerFields.includes('marks')) {
            entry.marks = questions[i].marks;
          }
          return entry;
        });
        const out = {};
        out[linkConfig.primaryKey] = questions;
        out[linkConfig.linkedKey] = answerKey;
        return out;
      },
    };
  }

  // ── Minimal drag-to-reorder (pointer-based, no external deps) ──
  function wireDrag(rowEl, listEl) {
    const handle = rowEl.querySelector('.redit-drag-handle');
    if (!handle) return;

    let dragging = false;

    handle.addEventListener('pointerdown', (e) => {
      dragging = true;
      rowEl.classList.add('is-dragging');
      handle.setPointerCapture(e.pointerId);
    });

    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const after = getDragAfterElement(listEl, e.clientY, rowEl);
      if (after == null) {
        listEl.appendChild(rowEl);
      } else {
        listEl.insertBefore(rowEl, after);
      }
    });

    function stop() {
      dragging = false;
      rowEl.classList.remove('is-dragging');
    }
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
  }

  function getDragAfterElement(container, y, dragging) {
    const els = [...container.children].filter((c) => c !== dragging);
    let closest = { offset: Number.NEGATIVE_INFINITY, element: null };
    els.forEach((child) => {
      const box = child.getBoundingClientRect();
      const offset = y - box.top - box.height / 2;
      if (offset < 0 && offset > closest.offset) {
        closest = { offset, element: child };
      }
    });
    return closest.element;
  }

  // ── Top-level mount ──
  function mount(container, resourceType, structuredContent, opts) {
    opts = opts || {};
    const config = getConfig(resourceType);
    container.innerHTML = '';
    container.classList.add('resource-editor');

    const fields = {}; // key -> { getValue } | { multi: true, getValue() -> {k:v,...} }
    let dirty = false;
    const markDirty = () => {
      if (!dirty) {
        dirty = true;
        if (typeof opts.onDirty === 'function') opts.onDirty();
      }
    };
    container.addEventListener('input', markDirty);
    container.addEventListener('change', markDirty);
    container.addEventListener('click', (e) => {
      if (e.target.closest('.redit-add-btn, .redit-icon-btn')) markDirty();
    });

    const linked = config.linkedList;
    const derivedKeys = new Set(config.derivedKeys || []);
    const skipTopLevel = new Set(['title']);
    // NOTE: config.sectionsKey (e.g. lesson_note's "sections") is
    // intentionally NOT added to skipTopLevel. The loop below already
    // special-cases key === config.sectionsKey to render it with
    // buildSectionList, in its natural position among the other fields
    // (introduction, sections, summary, ...). Skipping it here meant it
    // was dropped before that check ever ran, so the editor silently
    // showed only Title/Introduction/Summary and never let anyone edit
    // the actual lesson content.
    if (linked) {
      skipTopLevel.add(linked.primaryKey);
      skipTopLevel.add(linked.linkedKey);
    }
    derivedKeys.forEach((k) => skipTopLevel.add(k));

    for (const key in structuredContent) {
      if (key === 'title') continue;
      if (skipTopLevel.has(key)) continue;

      const value = structuredContent[key];
      const label = (config.topLevelLabels && config.topLevelLabels[key]) || prettyLabel(key);
      const kind = key === config.sectionsKey ? 'sectionlist' : classify(value);

      let field;
      switch (kind) {
        case 'number':
          field = buildNumberField(value, label);
          break;
        case 'longtext':
          field = buildLongText(value, label);
          break;
        case 'shorttext':
          field = buildShortText(value, label);
          break;
        case 'stringlist':
          field = buildStringList(value, label);
          break;
        case 'termlist':
          field = buildTermList(value, label);
          break;
        case 'sectionlist':
          field = buildSectionList(value, config);
          break;
        case 'objectlist':
          field = buildObjectList(value, label);
          break;
        default:
          field = buildShortText(value, label);
      }

      container.appendChild(field.node);
      fields[key] = field;
    }

    // The linked question+answer editor (worksheet, test) is appended
    // after the intro/instruction fields already added above, since in
    // practice recipes put those before questions anyway.
    if (linked) {
      const linkedField = buildLinkedQuestionList(
        structuredContent[linked.primaryKey],
        structuredContent[linked.linkedKey],
        linked
      );
      container.appendChild(linkedField.node);
      fields.__linked = { multi: true, getValue: linkedField.getValue };
    }

    if (derivedKeys.size && config.derivedNote) {
      const note = el('p', 'redit-derived-note');
      note.textContent = config.derivedNote;
      container.appendChild(note);
    }

    // Title is always shown first, since it's how the resource is identified.
    if ('title' in structuredContent) {
      const titleField = buildShortText(structuredContent.title, 'Title');
      container.insertBefore(titleField.node, container.firstChild);
      fields.title = titleField;
    }

    return {
      getValue() {
        let out = {};
        for (const key in fields) {
          const field = fields[key];
          if (field.multi) {
            Object.assign(out, field.getValue());
          } else {
            out[key] = field.getValue();
          }
        }
        if (typeof config.postProcess === 'function') {
          out = config.postProcess(out);
        }
        return out;
      },
      isDirty() {
        return dirty;
      },
      destroy() {
        container.innerHTML = '';
      },
    };
  }

  return { mount };
})();
