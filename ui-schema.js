// ui-schema.js
// The controlled Cognita UI vocabulary. Shared on purpose: the Worker
// (chat-endpoint.js) validates every payload before it is sent, and the
// browser (js/app.js) validates again before rendering. The model supplies
// DATA and component names only; it can never supply HTML, CSS or script.
//
// Wire format (a block in the model's reply):
//   ```cognita-ui
//   { "type": "table", "props": { ... }, "children": [ ... ], "actions": [ ... ] }
//   ```
// The Worker removes the block from the text and returns it as `ui: [...]`.

export const UI_LIMITS = {
  blocks: 6,        // top-level components per reply
  nodes: 80,        // all components, nested included
  depth: 3,
  text: 4000,       // any single text value
  short: 200,       // titles, labels, cells
  rows: 50,
  cols: 12,
  points: 60,
  items: 60,
  actions: 4,
  fields: 12,
  options: 20,
};

export const UI_TYPES = [
  'card', 'table', 'stat', 'bar_chart', 'line_chart', 'pie_chart', 'list',
  'checklist', 'steps', 'tabs', 'accordion', 'form', 'timeline', 'callout',
  'code', 'data_summary', 'source_list', 'plan', 'document_result', 'media_result',
];

const L = UI_LIMITS;

function str(v, max) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return '';
  return v.replace(/\u0000/g, '').slice(0, max || L.short);
}
function text(v) { return str(v, L.text); }
function arr(v, max) { return Array.isArray(v) ? v.slice(0, max) : []; }
function bool(v) { return v === true; }
function pick(v, allowed, fallback) { return allowed.includes(v) ? v : fallback; }
function numList(v, max) {
  return arr(v, max).map((n) => {
    const x = typeof n === 'string' ? parseFloat(n.replace(/,/g, '')) : n;
    return Number.isFinite(x) ? x : 0;
  });
}
// Only plain web links. Anything else (javascript:, data:, etc.) is dropped.
export function safeUrl(u) {
  if (typeof u !== 'string') return '';
  const s = u.trim().slice(0, 500);
  return /^https?:\/\/[^\s<>"']+$/i.test(s) ? s : '';
}
function slug(v) { return str(v, 40).replace(/[^a-zA-Z0-9_-]/g, '_') || 'field'; }

function normActions(raw) {
  return arr(raw, L.actions).map((a) => {
    if (!a || typeof a !== 'object') return null;
    const label = str(a.label, 60);
    const prompt = str(a.prompt, 800);
    return label && prompt ? { label, prompt } : null;
  }).filter(Boolean);
}

function chartData(p) {
  const labels = arr(p.labels, L.points).map((x) => str(x, 60));
  let series = [];
  if (Array.isArray(p.series)) {
    series = arr(p.series, 6).map((s) => (s && typeof s === 'object')
      ? { name: str(s.name, 60), values: numList(s.values, L.points) } : null).filter(Boolean);
  } else {
    series = [{ name: '', values: numList(p.values, L.points) }];
  }
  const n = Math.min(labels.length || Infinity, ...series.map((s) => s.values.length));
  if (!Number.isFinite(n) || n < 1) return null;
  return {
    title: str(p.title), xLabel: str(p.xLabel, 60), yLabel: str(p.yLabel, 60),
    labels: labels.slice(0, n).concat(Array(Math.max(0, n - labels.length)).fill('')),
    series: series.map((s) => ({ name: s.name, values: s.values.slice(0, n) })),
  };
}

function nodeList(raw, depth, budget) {
  return arr(raw, L.blocks * 2).map((c) => normNode(c, depth, budget)).filter(Boolean);
}

function normNode(raw, depth, budget) {
  if (!raw || typeof raw !== 'object' || depth > L.depth) return null;
  if (budget.n >= L.nodes) return null;
  const type = typeof raw.type === 'string' ? raw.type : '';
  if (!UI_TYPES.includes(type)) return null;
  const p = raw.props && typeof raw.props === 'object' ? raw.props : {};
  budget.n++;
  const out = { type, props: {}, children: [], actions: normActions(raw.actions) };
  const kids = () => nodeList(raw.children, depth + 1, budget);

  switch (type) {
    case 'card':
      out.props = { title: str(p.title), description: text(p.description), content: text(p.content), collapsible: bool(p.collapsible), open: p.open !== false };
      out.children = kids();
      if (!out.props.title && !out.props.description && !out.props.content && !out.children.length) return null;
      break;
    case 'table': {
      const columns = arr(p.columns, L.cols).map((c) => str(c, 80));
      if (!columns.length) return null;
      const rows = arr(p.rows, L.rows).map((r) => arr(r, columns.length).map((c) => str(c, 300)))
        .map((r) => r.concat(Array(columns.length - r.length).fill('')));
      out.props = { title: str(p.title), caption: str(p.caption, 300), columns, rows, sortable: p.sortable !== false };
      break;
    }
    case 'stat':
      if (!str(p.label) && !str(p.value)) return null;
      out.props = { label: str(p.label), value: str(p.value, 80), explanation: str(p.explanation, 300) };
      break;
    case 'bar_chart': case 'line_chart': case 'pie_chart': {
      const d = chartData(p);
      if (!d) return null;
      if (type === 'pie_chart') d.series = d.series.slice(0, 1);
      out.props = { ...d, mode: pick(p.mode, ['bars', 'table'], 'bars') };
      break;
    }
    case 'list': {
      const items = arr(p.items, L.items).map((i) => str(i, 500)).filter(Boolean);
      if (!items.length) return null;
      out.props = { title: str(p.title), ordered: bool(p.ordered), items };
      break;
    }
    case 'checklist': {
      const items = arr(p.items, L.items).map((i) => typeof i === 'string'
        ? { text: str(i, 300), checked: false }
        : (i && typeof i === 'object' ? { text: str(i.text, 300), checked: bool(i.checked) } : null))
        .filter((i) => i && i.text);
      if (!items.length) return null;
      out.props = { title: str(p.title), items };
      break;
    }
    case 'steps': {
      const items = arr(p.items, L.items).map((i) => typeof i === 'string'
        ? { title: str(i, 200), description: '', status: 'todo' }
        : (i && typeof i === 'object' ? { title: str(i.title), description: str(i.description, 600), status: pick(i.status, ['todo', 'doing', 'done'], 'todo') } : null))
        .filter((i) => i && i.title);
      if (!items.length) return null;
      out.props = { title: str(p.title), items };
      break;
    }
    case 'tabs': case 'accordion': {
      const key = type === 'tabs' ? 'tabs' : 'sections';
      const items = arr(p[key], 12).map((t) => {
        if (!t || typeof t !== 'object') return null;
        const label = str(type === 'tabs' ? t.label : (t.title || t.label));
        if (!label) return null;
        return { label, content: text(t.content), open: bool(t.open),
          children: nodeList(t.children, depth + 1, budget) };
      }).filter(Boolean);
      if (!items.length) return null;
      out.props = { title: str(p.title), items };
      break;
    }
    case 'form': {
      const fields = arr(p.fields, L.fields).map((f) => {
        if (!f || typeof f !== 'object') return null;
        const ftype = pick(f.type, ['text', 'textarea', 'select', 'checkbox', 'switch'], 'text');
        const label = str(f.label);
        if (!label) return null;
        return {
          name: slug(f.name || label), label, type: ftype,
          placeholder: str(f.placeholder, 120), required: bool(f.required),
          options: ftype === 'select' ? arr(f.options, L.options).map((o) => str(o, 100)).filter(Boolean) : [],
          value: ftype === 'checkbox' || ftype === 'switch' ? bool(f.value) : str(f.value, 500),
        };
      }).filter(Boolean);
      if (!fields.length) return null;
      out.props = { title: str(p.title), description: str(p.description, 500), fields,
        submitLabel: str(p.submitLabel, 40) || 'Submit', submitPrompt: str(p.submitPrompt, 600) };
      break;
    }
    case 'timeline': {
      const items = arr(p.items, L.items).map((i) => (i && typeof i === 'object')
        ? { date: str(i.date, 60), title: str(i.title), description: str(i.description, 500) } : null)
        .filter((i) => i && (i.title || i.date));
      if (!items.length) return null;
      out.props = { title: str(p.title), items };
      break;
    }
    case 'callout':
      if (!str(p.title) && !text(p.content)) return null;
      out.props = { variant: pick(p.variant, ['info', 'warning', 'success'], 'info'), title: str(p.title), content: text(p.content) };
      break;
    case 'code': {
      const code = str(p.code, 20000);
      if (!code) return null;
      out.props = { title: str(p.title), language: str(p.language, 30).toLowerCase().replace(/[^a-z0-9+#.-]/g, ''), code, runnable: bool(p.runnable) };
      break;
    }
    case 'data_summary': {
      const metrics = arr(p.metrics, 12).map((m) => (m && typeof m === 'object') ? { label: str(m.label, 80), value: str(m.value, 80) } : null).filter((m) => m && (m.label || m.value));
      const findings = arr(p.findings, 12).map((f) => str(f, 500)).filter(Boolean);
      out.props = { title: str(p.title), findings, metrics };
      out.children = kids().filter((c) => ['table', 'bar_chart', 'line_chart', 'pie_chart'].includes(c.type)).slice(0, 2);
      if (!findings.length && !metrics.length && !out.children.length) return null;
      break;
    }
    case 'source_list': {
      const sources = arr(p.sources, 20).map((s) => (s && typeof s === 'object')
        ? { title: str(s.title, 200), url: safeUrl(s.url), description: str(s.description, 400) } : null)
        .filter((s) => s && s.title);
      if (!sources.length) return null;
      out.props = { title: str(p.title), sources };
      break;
    }
    case 'plan': {
      const sections = arr(p.sections, 20).map((s) => {
        if (!s || typeof s !== 'object') return null;
        const tasks = arr(s.tasks, L.items).map((t) => typeof t === 'string'
          ? { text: str(t, 400), done: false }
          : (t && typeof t === 'object' ? { text: str(t.text, 400), done: bool(t.done) } : null)).filter((t) => t && t.text);
        return str(s.title) || tasks.length ? { title: str(s.title), tasks } : null;
      }).filter(Boolean);
      if (!sections.length) return null;
      out.props = { title: str(p.title), description: str(p.description, 500), sections, editable: p.editable !== false };
      break;
    }
    case 'document_result':
      if (!str(p.title)) return null;
      out.props = { title: str(p.title), description: str(p.description, 500), format: pick(str(p.format, 10).toLowerCase(), ['docx', 'pdf', 'pptx', 'xlsx', 'md', 'txt', 'csv'], 'docx') };
      break;
    case 'media_result':
      if (!str(p.title)) return null;
      out.props = { title: str(p.title), description: str(p.description, 500), kind: pick(p.kind, ['image', 'design'], 'image') };
      break;
    default:
      return null;
  }
  return out;
}

/** Validates an unknown value (a block, an array of blocks, or {blocks}). Always returns a safe array. */
export function validateUi(raw) {
  let list = raw;
  if (list && !Array.isArray(list) && typeof list === 'object') {
    list = Array.isArray(list.blocks) ? list.blocks : [list];
  }
  if (!Array.isArray(list)) return [];
  const budget = { n: 0 };
  return list.slice(0, L.blocks).map((b) => normNode(b, 1, budget)).filter(Boolean);
}

/** Pulls ```cognita-ui fences out of a reply. Returns the remaining text and the validated blocks. */
export function extractUiBlocks(reply) {
  const src = typeof reply === 'string' ? reply : '';
  if (!src.includes('cognita-ui')) return { text: src, ui: [] };
  const found = [];
  let rest = src.replace(/```[ \t]*cognita-ui[ \t]*\r?\n([\s\S]*?)(?:```|$)/g, (_, body) => {
    try { found.push(...validateUi(JSON.parse(body.trim()))); } catch (_) { /* malformed block: dropped */ }
    return '';
  });
  rest = rest.replace(/\n{3,}/g, '\n\n').trim();
  return { text: rest, ui: found.slice(0, L.blocks) };
}
