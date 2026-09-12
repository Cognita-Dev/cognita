// js/resource-editor.js
//
// Generic, schema-driven editor for a resource's structuredContent.
// Renders plain-language form controls (text fields, list editors,
// term/explanation pairs, reorderable section/card lists) instead of
// raw JSON. Works across every resource type by inferring the shape
// of each field, with small per-resourceType configs for labels and
// section "type" choices where it helps.
//
// Public API:
//   ResourceEditor.mount(container, resourceType, structuredContent, opts)
//     -> returns a handle: { getValue(), isDirty(), destroy() }

window.ResourceEditor = (function () {
  // ── Per-resource-type customization (labels + which section "type"
  // values are offered). Falls back to sane generic defaults for any
  // resourceType not listed here — nothing breaks for future recipes. ──
  const RECIPE_EDITOR_CONFIG = {
    lesson_note: {
      topLevelLabels: { title: 'Title', introduction: 'Introduction', summary: 'Summary' },
      sectionsKey: 'sections',
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
    if (typeof value === 'number') return 'number';
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

  // Tag-style list editor for string arrays (bullets, numbered, etc.)
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
    lab.textContent = 'Sections';
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

  // Generic reorderable list of plain objects (slides, questions, cards...)
  // whose own primitive fields are each rendered recursively.
  function buildObjectList(items, label) {
    const wrap = el('div', 'redit-field redit-sectionlist-field');
    const lab = el('label', 'redit-field-label');
    lab.textContent = label;
    const list = el('div', 'redit-sections');
    const cards = [];

    const keys = items && items.length ? Object.keys(items[0]) : ['text'];

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
        const kind = classify(item[k]);
        let f;
        if (kind === 'stringlist') f = buildStringList(item[k], prettyLabel(k));
        else if (kind === 'longtext') f = buildLongText(item[k], prettyLabel(k));
        else f = buildShortText(item[k], prettyLabel(k));
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
          keys.forEach((k) => (out[k] = subFields[k].getValue()));
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
      getValue: () => cards.filter((c) => list.contains(c.card)).map((c) => c.getValue()),
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

    const fields = {}; // key -> { getValue }
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

    const skipTopLevel = new Set(['title']); // shown first, separately, below
    if (config.sectionsKey) skipTopLevel.add(config.sectionsKey);

    for (const key in structuredContent) {
      if (key === 'title') continue;
      const value = structuredContent[key];
      const label = (config.topLevelLabels && config.topLevelLabels[key]) || prettyLabel(key);
      const kind = key === config.sectionsKey ? 'sectionlist' : classify(value);

      let field;
      switch (kind) {
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

    // Title is always shown first, since it's how the resource is identified.
    if ('title' in structuredContent) {
      const titleField = buildShortText(structuredContent.title, 'Title');
      container.insertBefore(titleField.node, container.firstChild);
      fields.title = titleField;
    }

    return {
      getValue() {
        const out = {};
        for (const key in fields) out[key] = fields[key].getValue();
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
