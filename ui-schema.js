// ui-schema.js
// The Cognita UI protocol: a controlled component registry, a validator, UI
// state, a safe event model and a patch format. Shared on purpose: the Worker
// (chat-endpoint.js) validates every payload before it is sent, the browser
// (js/app.js, js/ui-render.js) validates again before drawing, and prompts.js
// derives the model-facing vocabulary from the same registry. The model
// supplies DATA and component names only; it can never supply HTML, CSS,
// script, event handlers or URLs other than plain web links.
//
// Wire format (blocks in the model's reply, removed from the visible text):
//   ```cognita-ui
//   { "id": "sales", "type": "table", "props": {...}, "children": [...], "actions": [...] }
//   ```
// A fence may hold one node, an array, {"blocks":[...],"patches":[...]}, or
// patches: { "op": "append", "target": "sales", "rows": [[...]] }.
//
// To add a component: add ONE entry to REGISTRY below (props, normalize,
// children, state, events). The validator, the prompt text and the type list
// all derive from it. Then add its renderer case in js/ui-render.js.

export const UI_LIMITS = {
  blocks: 6,        // top-level components per reply
  nodes: 80,        // all components, nested included
  depth: 4,
  text: 4000,       // any single text value
  short: 200,       // titles, labels, cells
  rows: 50,
  cols: 12,
  points: 60,
  items: 60,
  actions: 4,
  fields: 12,
  options: 20,
  state: 3000,      // serialized size of one component's state
  idLen: 48,
  patches: 8,       // patches accepted per reply
  patchData: 20000, // serialized size of one patch payload
};

// Event model. Every event is classified: LOCAL events are handled entirely in
// the browser; AI events go back through the normal /api/chat flow.
export const UI_EVENTS = {
  select: 'local', change: 'local', toggle: 'local', expand: 'local', collapse: 'local',
  sort: 'local', add: 'local', remove: 'local', edit: 'local',
  submit: 'ai', approve: 'ai',
};
export const uiEventKind = (e) => UI_EVENTS[e] || 'local';

export const UI_PATCH_OPS = ['create', 'replace', 'update', 'append', 'remove', 'set_state'];

const L = UI_LIMITS;

// ── Small safe helpers ─────────────────────────────────────────────────
function str(v, max) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string') return '';
  return v.replace(/\u0000/g, '').slice(0, max || L.short);
}
function text(v) { return str(v, L.text); }
function arr(v, max) { return Array.isArray(v) ? v.slice(0, max) : []; }
function bool(v) { return v === true; }
function pick(v, allowed, fallback) { return allowed.includes(v) ? v : fallback; }
function int(v, min, max, fallback) {
  const n = typeof v === 'string' ? parseInt(v, 10) : v;
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
}
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
function idOnly(v) { return typeof v === 'string' ? v.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, L.idLen) : ''; }

// Plain JSON only (no functions, no prototypes), bounded depth/width/size.
function plain(v, depth, strMax) {
  if (v === null || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') return v.replace(/\u0000/g, '').slice(0, strMax || 500);
  if (depth <= 0) return undefined;
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => plain(x, depth - 1, strMax)).filter((x) => x !== undefined);
  if (typeof v === 'object') {
    const o = {};
    Object.keys(v).slice(0, 24).forEach((k) => {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') return;
      const x = plain(v[k], depth - 1, strMax);
      if (x !== undefined) o[k.slice(0, 40)] = x;
    });
    return o;
  }
  return undefined;
}
const sizeOf = (o) => { try { return JSON.stringify(o).length; } catch (_) { return Infinity; } };

// ── Actions: LOCAL (set state on a component) or AI (a prompt to the model) ──
function normActions(raw) {
  return arr(raw, L.actions).map((a) => {
    if (!a || typeof a !== 'object') return null;
    const label = str(a.label, 60);
    if (!label) return null;
    if (a.kind === 'local' || (!a.prompt && a.target)) {
      const target = idOnly(a.target);
      const st = a.state && typeof a.state === 'object' ? plain(a.state, 3, 200) : null;
      if (!target || !st || sizeOf(st) > L.state) return null;
      return { label, kind: 'local', event: pick(a.event, Object.keys(UI_EVENTS).filter((k) => UI_EVENTS[k] === 'local'), 'select'), target, state: st };
    }
    const prompt = str(a.prompt, 800);
    return prompt ? { label, kind: 'ai', event: pick(a.event, Object.keys(UI_EVENTS), 'approve'), prompt, withSelection: bool(a.withSelection) } : null;
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

const bools = (v, max) => arr(v, max).map((x) => x === true);
const CHART_TYPES = ['bar_chart', 'line_chart', 'pie_chart'];

function normChart(type, p) {
  const d = chartData(p);
  if (!d) return null;
  if (type === 'pie_chart') d.series = d.series.slice(0, 1);
  return { props: { ...d, mode: pick(p.mode, ['bars', 'table'], 'bars') } };
}

function normGroup(type, p, k) {
  const key = type === 'tabs' ? 'tabs' : 'sections';
  const items = arr(Array.isArray(p[key]) ? p[key] : p.items, 12).map((t) => {   // `items` = already validated (the browser validates again)
    if (!t || typeof t !== 'object') return null;
    const label = str(type === 'tabs' ? t.label : (t.title || t.label));
    if (!label) return null;
    return { label, content: text(t.content), open: bool(t.open), children: k.list(t.children) };
  }).filter(Boolean);
  if (!items.length) return null;
  return { props: { title: str(p.title), items } };
}

const viewState = (s) => (['chart', 'table'].includes(s.view) ? { view: s.view } : {});

// ── The component registry (single source of truth) ────────────────────
// normalize(p, raw, k) -> { props, children? } or null (drop the component)
//   k.kids() normalizes raw.children; k.list(rawList) normalizes a child list.
// state(raw, node?) -> the only state keys this component accepts.
// children: [] (none) | 'any' | [allowed child types].
export const REGISTRY = {
  card: {
    purpose: 'Group related content',
    describe: '{title,description,content,collapsible}',
    children: 'any', local: ['expand', 'collapse'], ai: ['actions'],
    state: (s) => (typeof s.open === 'boolean' ? { open: s.open } : {}),
    normalize(p, raw, k) {
      const props = { title: str(p.title), description: text(p.description), content: text(p.content), collapsible: bool(p.collapsible), open: p.open !== false };
      const children = k.kids();
      if (!props.title && !props.description && !props.content && !children.length) return null;
      return { props, children };
    },
  },
  table: {
    purpose: 'Rows and columns, sortable; selectable:true lets the person pick rows',
    describe: '{title,caption,columns[],rows[][],selectable}',
    children: [], local: ['sort', 'select'], ai: ['actions (withSelection:true sends the selected rows)'],
    appendKeys: ['rows'],
    state: (s, n) => {
      const o = {};
      const cols = n && n.props ? n.props.columns.length : L.cols;
      const rows = n && n.props ? n.props.rows.length : L.rows;
      if (s.sort && typeof s.sort === 'object') {
        const col = int(s.sort.col, 0, cols - 1, -1);
        if (col >= 0) o.sort = { col, dir: pick(s.sort.dir, ['asc', 'desc'], 'asc') };
      }
      if (Array.isArray(s.selected)) o.selected = [...new Set(arr(s.selected, L.rows).map((i) => int(i, 0, rows - 1, -1)).filter((i) => i >= 0))];
      return o;
    },
    normalize(p) {
      const columns = arr(p.columns, L.cols).map((c) => str(c, 80));
      if (!columns.length) return null;
      const rows = arr(p.rows, L.rows).map((r) => arr(r, columns.length).map((c) => str(c, 300)))
        .map((r) => r.concat(Array(columns.length - r.length).fill('')));
      return { props: { title: str(p.title), caption: str(p.caption, 300), columns, rows, sortable: p.sortable !== false, selectable: bool(p.selectable) } };
    },
  },
  stat: {
    purpose: 'One headline number',
    describe: '{label,value,explanation}',
    children: [], local: [], ai: ['actions'],
    normalize(p) {
      if (!str(p.label) && !str(p.value)) return null;
      return { props: { label: str(p.label), value: str(p.value, 80), explanation: str(p.explanation, 300) } };
    },
  },
  bar_chart: {
    purpose: 'Compare values across categories',
    describe: '{title,labels[],values[] or series[{name,values[]}],xLabel,yLabel}',
    children: [], local: ['select (chart/table view)'], ai: ['actions'],
    appendKeys: ['labels', 'values', 'series'], state: viewState,
    normalize: (p) => normChart('bar_chart', p),
  },
  line_chart: {
    purpose: 'Show change over time',
    describe: 'same props as bar_chart',
    children: [], local: ['select (chart/table view)'], ai: ['actions'],
    appendKeys: ['labels', 'values', 'series'], state: viewState,
    normalize: (p) => normChart('line_chart', p),
  },
  pie_chart: {
    purpose: 'Shares of a whole (one series)',
    describe: 'same props as bar_chart, one series',
    children: [], local: ['select (chart/table view)'], ai: ['actions'],
    appendKeys: ['labels', 'values', 'series'], state: viewState,
    normalize: (p) => normChart('pie_chart', p),
  },
  list: {
    purpose: 'Plain bulleted or numbered list',
    describe: '{title,ordered,items[]}',
    children: [], local: [], ai: ['actions'], appendKeys: ['items'],
    normalize(p) {
      const items = arr(p.items, L.items).map((i) => str(i, 500)).filter(Boolean);
      if (!items.length) return null;
      return { props: { title: str(p.title), ordered: bool(p.ordered), items } };
    },
  },
  checklist: {
    purpose: 'Tick-off items with progress',
    describe: '{title,items[{text,checked}]}',
    children: [], local: ['toggle'], ai: ['actions'], appendKeys: ['items'],
    state: (s) => (Array.isArray(s.checked) ? { checked: bools(s.checked, L.items) } : {}),
    normalize(p) {
      const items = arr(p.items, L.items).map((i) => typeof i === 'string'
        ? { text: str(i, 300), checked: false }
        : (i && typeof i === 'object' ? { text: str(i.text, 300), checked: bool(i.checked) } : null))
        .filter((i) => i && i.text);
      if (!items.length) return null;
      return { props: { title: str(p.title), items } };
    },
  },
  steps: {
    purpose: 'Ordered process; the person can mark each step todo/doing/done',
    describe: '{title,items[{title,description,status:todo|doing|done}]}',
    children: [], local: ['change'], ai: ['actions'], appendKeys: ['items'],
    state: (s) => (Array.isArray(s.status) ? { status: arr(s.status, L.items).map((x) => pick(x, ['todo', 'doing', 'done'], 'todo')) } : {}),
    normalize(p) {
      const items = arr(p.items, L.items).map((i) => typeof i === 'string'
        ? { title: str(i, 200), description: '', status: 'todo' }
        : (i && typeof i === 'object' ? { title: str(i.title), description: str(i.description, 600), status: pick(i.status, ['todo', 'doing', 'done'], 'todo') } : null))
        .filter((i) => i && i.title);
      if (!items.length) return null;
      return { props: { title: str(p.title), items } };
    },
  },
  tabs: {
    purpose: 'Several categories, one visible at a time',
    describe: '{title,tabs[{label,content,children[]}]}',
    children: 'any', local: ['select'], ai: ['actions'], appendKeys: ['tabs'],
    state: (s) => (int(s.active, 0, 11, -1) >= 0 ? { active: int(s.active, 0, 11, 0) } : {}),
    normalize: (p, raw, k) => normGroup('tabs', p, k),
  },
  accordion: {
    purpose: 'Expandable sections',
    describe: '{title,sections[{title,content,children[]}]}',
    children: 'any', local: ['expand', 'collapse'], ai: ['actions'], appendKeys: ['sections'],
    state: (s) => (Array.isArray(s.open) ? { open: bools(s.open, 12) } : {}),
    normalize: (p, raw, k) => normGroup('accordion', p, k),
  },
  form: {
    purpose: 'Collect input; Cognita validates it and sends the values to you',
    describe: '{title,description,fields[{name,label,type:text|textarea|select|checkbox|switch,options[],required,placeholder,value}],submitLabel,submitPrompt}',
    children: [], local: ['change'], ai: ['submit'],
    state: (s) => {
      if (!s.values || typeof s.values !== 'object') return {};
      const values = {};
      Object.keys(s.values).slice(0, L.fields).forEach((k) => {
        const v = s.values[k];
        if (typeof v === 'boolean') values[slug(k)] = v;
        else if (typeof v === 'string' || typeof v === 'number') values[slug(k)] = str(v, 500);
      });
      return { values };
    },
    normalize(p) {
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
      const seen = new Set();
      fields.forEach((f) => {
        let name = f.name, n = 2;
        while (seen.has(name)) name = f.name.slice(0, 36) + '_' + (n++);
        seen.add(name); f.name = name;
      });
      return { props: { title: str(p.title), description: str(p.description, 500), fields,
        submitLabel: str(p.submitLabel, 40) || 'Submit', submitPrompt: str(p.submitPrompt, 600) } };
    },
  },
  timeline: {
    purpose: 'Events in order of time',
    describe: '{title,items[{date,title,description}]}',
    children: [], local: [], ai: ['actions'], appendKeys: ['items'],
    normalize(p) {
      const items = arr(p.items, L.items).map((i) => (i && typeof i === 'object')
        ? { date: str(i.date, 60), title: str(i.title), description: str(i.description, 500) } : null)
        .filter((i) => i && (i.title || i.date));
      if (!items.length) return null;
      return { props: { title: str(p.title), items } };
    },
  },
  callout: {
    purpose: 'Highlight a note, warning or success message',
    describe: '{variant:info|warning|success,title,content}',
    children: [], local: [], ai: ['actions'],
    normalize(p) {
      if (!str(p.title) && !text(p.content)) return null;
      return { props: { variant: pick(p.variant, ['info', 'warning', 'success'], 'info'), title: str(p.title), content: text(p.content) } };
    },
  },
  code: {
    purpose: 'A code listing',
    describe: '{title,language,code,runnable}',
    children: [], local: [], ai: ['run'],
    normalize(p) {
      const code = str(p.code, 20000);
      if (!code) return null;
      return { props: { title: str(p.title), language: str(p.language, 30).toLowerCase().replace(/[^a-z0-9+#.-]/g, ''), code, runnable: bool(p.runnable) } };
    },
  },
  data_summary: {
    purpose: 'Analysis result: metrics, findings and stat/table/chart children',
    describe: '{title,findings[],metrics[{label,value}]}',
    children: ['stat', 'table', 'bar_chart', 'line_chart', 'pie_chart'], local: [], ai: ['actions'],
    appendKeys: ['findings', 'metrics'],
    normalize(p, raw, k) {
      const metrics = arr(p.metrics, 12).map((m) => (m && typeof m === 'object') ? { label: str(m.label, 80), value: str(m.value, 80) } : null).filter((m) => m && (m.label || m.value));
      const findings = arr(p.findings, 12).map((f) => str(f, 500)).filter(Boolean);
      const children = k.kids();
      if (!findings.length && !metrics.length && !children.length) return null;
      return { props: { title: str(p.title), findings, metrics }, children };
    },
  },
  source_list: {
    purpose: 'Links the answer relied on',
    describe: '{title,sources[{title,url,description}]}',
    children: [], local: [], ai: ['actions'], appendKeys: ['sources'],
    normalize(p) {
      const sources = arr(p.sources, 20).map((s) => (s && typeof s === 'object')
        ? { title: str(s.title, 200), url: safeUrl(s.url), description: str(s.description, 400) } : null)
        .filter((s) => s && s.title);
      if (!sources.length) return null;
      return { props: { title: str(p.title), sources } };
    },
  },
  plan: {
    purpose: 'Editable sections of tasks the person can tick, edit and extend',
    describe: '{title,description,sections[{title,tasks[{text,done}]}],editable}',
    children: [], local: ['toggle', 'edit', 'add'], ai: ['"Turn into a document" is built in'],
    appendKeys: ['sections'],
    state: (s) => (Array.isArray(s.done) ? { done: arr(s.done, 20).map((r) => bools(r, L.items)) } : {}),
    normalize(p) {
      const sections = arr(p.sections, 20).map((s) => {
        if (!s || typeof s !== 'object') return null;
        const tasks = arr(s.tasks, L.items).map((t) => typeof t === 'string'
          ? { text: str(t, 400), done: false }
          : (t && typeof t === 'object' ? { text: str(t.text, 400), done: bool(t.done) } : null)).filter((t) => t && t.text);
        return str(s.title) || tasks.length ? { title: str(s.title), tasks } : null;
      }).filter(Boolean);
      if (!sections.length) return null;
      return { props: { title: str(p.title), description: str(p.description, 500), sections, editable: p.editable !== false } };
    },
  },
  document_result: {
    purpose: 'A document the document tool already produced',
    describe: '{title,description,format:docx|pdf|pptx|xlsx|md|txt|csv}',
    children: [], local: [], ai: [],
    normalize(p) {
      if (!str(p.title)) return null;
      return { props: { title: str(p.title), description: str(p.description, 500), format: pick(str(p.format, 10).toLowerCase(), ['docx', 'pdf', 'pptx', 'xlsx', 'md', 'txt', 'csv'], 'docx') } };
    },
  },
  media_result: {
    purpose: 'A picture or design the media tool already produced',
    describe: '{title,description,kind:image|design}',
    children: [], local: [], ai: [],
    normalize(p) {
      if (!str(p.title)) return null;
      return { props: { title: str(p.title), description: str(p.description, 500), kind: pick(p.kind, ['image', 'design'], 'image') } };
    },
  },
};

export const UI_TYPES = Object.keys(REGISTRY);

/** Compact, model-facing description of the vocabulary, derived from the registry. */
export function describeUi() {
  return UI_TYPES.map((t) => {
    const d = REGISTRY[t];
    const kids = d.children === 'any' ? ' May hold components.' : Array.isArray(d.children) && d.children.length ? ' Children: ' + d.children.join('|') + '.' : '';
    return t + d.describe + ' - ' + d.purpose + '.' + kids;
  }).join('\n');
}

// ── Node validation ────────────────────────────────────────────────────
function newBudget() { return { n: 0, seq: 0, ids: new Set() }; }

function claimId(raw, type, budget) {
  let id = idOnly(raw);
  if (!id || budget.ids.has(id)) {
    do { id = type + '-' + (++budget.seq); } while (budget.ids.has(id));
  }
  budget.ids.add(id);
  return id;
}

/** Whitelists and clamps a state object for a component type. Always returns a safe object. */
export function normalizeState(type, rawState, node) {
  const d = REGISTRY[type];
  if (!d || !d.state || !rawState || typeof rawState !== 'object') return {};
  const clean = plain(rawState, 4, 500);
  if (!clean || typeof clean !== 'object' || Array.isArray(clean)) return {};
  const out = d.state(clean, node) || {};
  return sizeOf(out) <= L.state ? out : {};
}

function nodeList(raw, depth, budget, allowed) {
  return arr(raw, L.blocks * 2).map((c) => normNode(c, depth, budget)).filter((c) => c && (!allowed || allowed.includes(c.type)));
}

const NODE_KEYS = new Set(['id', 'type', 'props', 'children', 'actions', 'state']);
function normNode(raw, depth, budget) {
  if (!raw || typeof raw !== 'object' || depth > L.depth) return null;
  if (budget.n >= L.nodes) return null;
  const type = typeof raw.type === 'string' ? raw.type : '';
  if (!Object.prototype.hasOwnProperty.call(REGISTRY, type)) return null;
  const def = REGISTRY[type];
  // Models often write a component's props flat ({"type":"table","columns":[...]}) instead of under
  // "props". Without this the whole component is silently dropped. Every value still goes through the
  // same normalize() below, so nothing gets past validation that would not have before.
  let p = raw.props && typeof raw.props === 'object' && !Array.isArray(raw.props) ? raw.props : null;
  if (!p || !Object.keys(p).length) {
    p = {};
    for (const k of Object.keys(raw)) if (!NODE_KEYS.has(k)) p[k] = raw[k];
  }
  budget.n++;
  const id = claimId(raw.id, type, budget);
  const allowed = Array.isArray(def.children) ? def.children : null;
  const k = {
    kids: () => (def.children === 'any' || allowed) ? nodeList(raw.children, depth + 1, budget, allowed) : [],
    list: (l) => (def.children === 'any' ? nodeList(l, depth + 1, budget) : []),
  };
  let res;
  try { res = def.normalize(p, raw, k); } catch (_) { res = null; }
  if (!res) return null;
  const out = { id, type, props: res.props, children: (res.children || []).slice(0, 12), actions: normActions(raw.actions) };
  const st = normalizeState(type, raw.state, out);
  if (Object.keys(st).length) out.state = st;
  return out;
}

/** Validates an unknown value (a block, an array of blocks, or {blocks}). Always returns a safe array. */
export function validateUi(raw) {
  let list = raw;
  if (list && !Array.isArray(list) && typeof list === 'object') {
    list = Array.isArray(list.blocks) ? list.blocks : [list];
  }
  if (!Array.isArray(list)) return [];
  const budget = newBudget();
  return list.slice(0, L.blocks).map((b) => normNode(b, 1, budget)).filter(Boolean);
}

// ── Finding nodes ──────────────────────────────────────────────────────
function childLists(n) {
  const lists = [n.children];
  if (n.props && Array.isArray(n.props.items) && (n.type === 'tabs' || n.type === 'accordion')) n.props.items.forEach((i) => lists.push(i.children));
  return lists.filter(Array.isArray);
}
/** Finds a node by id anywhere in the tree. Returns { node, list, index } or null. */
export function findUiNode(blocks, id) {
  const walk = (list) => {
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === id) return { node: list[i], list, index: i };
      for (const cl of childLists(list[i])) { const f = walk(cl); if (f) return f; }
    }
    return null;
  };
  return Array.isArray(blocks) && id ? walk(blocks) : null;
}

// ── Patches ────────────────────────────────────────────────────────────
const ALL_APPEND_KEYS = ['rows', 'items', 'sections', 'tabs', 'sources', 'findings', 'metrics', 'labels', 'values', 'series'];

/** Validates one patch's shape. Returns a clean patch or null. */
export function validatePatch(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const op = raw.op;
  if (!UI_PATCH_OPS.includes(op)) return null;
  const target = idOnly(raw.target);
  if (op !== 'create' && !target) return null;
  const out = { op, target };
  if (op === 'create' || op === 'replace') {
    const src = raw.node && typeof raw.node === 'object' ? raw.node : null;
    if (!src) return null;
    const node = normNode(op === 'replace' ? { ...src, id: src.id || target } : src, 1, newBudget());
    if (!node) return null;
    out.node = node;
    if (op === 'create') { out.parent = idOnly(raw.parent); out.slot = int(raw.slot, 0, 11, 0); }
    return out;
  }
  if (op === 'update') {
    const props = raw.props && typeof raw.props === 'object' ? plain(raw.props, 5, L.text) : null;
    if (!props || sizeOf(props) > L.patchData) return null;
    out.props = props;
    if (raw.state && typeof raw.state === 'object') out.state = plain(raw.state, 4, 500);
    return out;
  }
  if (op === 'append') {
    const data = {};
    ALL_APPEND_KEYS.forEach((key) => {
      const v = Array.isArray(raw[key]) ? raw[key] : (raw.props && Array.isArray(raw.props[key]) ? raw.props[key] : (raw.data && Array.isArray(raw.data[key]) ? raw.data[key] : null));  // `data` = an already validated patch (the browser validates again)
      if (v) data[key] = plain(v, 4, L.text);
    });
    if (!Object.keys(data).length || sizeOf(data) > L.patchData) return null;
    out.data = data;
    return out;
  }
  if (op === 'set_state') {
    const st = raw.state && typeof raw.state === 'object' ? plain(raw.state, 4, 500) : null;
    if (!st || sizeOf(st) > L.state) return null;
    out.state = st;
    return out;
  }
  return out; // remove
}

const clone = (v) => JSON.parse(JSON.stringify(v));

function renorm(node, props, state) {
  return normNode({ id: node.id, type: node.type, props, children: node.children, actions: node.actions, state: state || node.state }, 1, newBudget());
}

/**
 * Applies one patch to a validated tree. Pure: returns { blocks, ok }. The
 * whole tree is re-validated afterwards, so a patch can never exceed the
 * limits or leave the controlled vocabulary.
 */
export function applyPatch(blocks, rawPatch) {
  const patch = validatePatch(rawPatch);
  const base = Array.isArray(blocks) ? blocks : [];
  if (!patch) return { blocks: base, ok: false };
  const doc = clone(base);

  if (patch.op === 'create') {
    if (patch.parent) {
      const par = findUiNode(doc, patch.parent);
      if (!par) return { blocks: base, ok: false };
      const n = par.node;
      if (n.type === 'tabs' || n.type === 'accordion') {
        const item = n.props.items[patch.slot] || n.props.items[0];
        item.children = (item.children || []).concat(patch.node);
      } else n.children = (n.children || []).concat(patch.node);
    } else doc.push(patch.node);
    return { blocks: validateUi(doc), ok: true };
  }

  const hit = findUiNode(doc, patch.target);
  if (!hit) return { blocks: base, ok: false };
  const { node, list, index } = hit;

  if (patch.op === 'replace') list[index] = patch.node;
  else if (patch.op === 'remove') list.splice(index, 1);
  else if (patch.op === 'set_state') node.state = normalizeState(node.type, { ...(node.state || {}), ...patch.state }, node);
  else if (patch.op === 'update') {
    const props = { ...node.props, ...patch.props };
    if (CHART_TYPES.includes(node.type) && (patch.props.values || patch.props.series)) {
      if (patch.props.series) delete props.values; else delete props.series;
    }
    const next = renorm(node, props, patch.state ? { ...(node.state || {}), ...patch.state } : null);
    if (!next) return { blocks: base, ok: false };
    list[index] = next;
  } else if (patch.op === 'append') {
    const props = clone(node.props);
    const keys = REGISTRY[node.type].appendKeys || [];
    let used = 0;
    Object.keys(patch.data).forEach((key) => {
      if (!keys.includes(key)) return;
      used++;
      if (CHART_TYPES.includes(node.type) && key === 'values') {
        props.series = props.series.map((s, i) => (i ? s : { ...s, values: s.values.concat(patch.data.values) }));
      } else if (CHART_TYPES.includes(node.type) && key === 'series') {
        props.series = props.series.map((s, i) => {
          const add = patch.data.series[i];
          return add && Array.isArray(add.values) ? { ...s, values: s.values.concat(add.values) } : s;
        });
      } else if ((key === 'tabs' || key === 'sections') && (node.type === 'tabs' || node.type === 'accordion')) {
        props.items = props.items.concat(patch.data[key]);
      } else props[key] = (props[key] || []).concat(patch.data[key]);
    });
    if (!used) return { blocks: base, ok: false };
    const next = renorm(node, props);
    if (!next) return { blocks: base, ok: false };
    list[index] = next;
  }
  return { blocks: validateUi(doc), ok: true };
}

/** Applies several patches in order; returns the final tree and how many applied. */
export function applyPatches(blocks, patches) {
  let cur = Array.isArray(blocks) ? blocks : [];
  let applied = 0;
  arr(patches, L.patches).forEach((p) => {
    const r = applyPatch(cur, p);
    if (r.ok) { cur = r.blocks; applied++; }
  });
  return { blocks: cur, applied };
}

// ── Parsing model output (complete and incremental) ────────────────────
// Closes a half-written JSON document so a partial component can be shown
// while the rest is still arriving. Returns the parsed value or undefined.
function parsePartial(src) {
  let s = src.trim();
  for (let i = 0; i < 24 && s; i++) {
    const stack = [];
    let inStr = false, esc = false;
    for (const ch of s) {
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{') stack.push('}');
      else if (ch === '[') stack.push(']');
      else if (ch === '}' || ch === ']') stack.pop();
    }
    const tail = (inStr ? '"' : '') + stack.reverse().join('');
    try { return JSON.parse(s + tail); } catch (_) { /* trim and retry */ }
    const cut = Math.max(s.lastIndexOf(','), s.lastIndexOf('{'), s.lastIndexOf('['));
    if (cut <= 0) return undefined;
    s = s.slice(0, s[cut] === ',' ? cut : cut + 1).replace(/[,:\s]+$/, '');
  }
  return undefined;
}

function sortOut(value, blocks, patches) {
  const list = [];
  if (Array.isArray(value)) list.push(...value);
  else if (value && typeof value === 'object') {
    if (Array.isArray(value.blocks) || Array.isArray(value.patches)) {
      if (Array.isArray(value.blocks)) list.push(...value.blocks);
      if (Array.isArray(value.patches)) list.push(...value.patches);
    } else list.push(value);
  }
  list.forEach((it) => {
    if (it && typeof it === 'object' && typeof it.op === 'string' && !it.type) patches.push(it);
    else blocks.push(it);
  });
}


// ── Components a model wrote in its own tool-call syntax ──────────────
// Some models ignore the cognita-ui fence and write their components as text in the tool-call
// format they were trained on, for example
//   <|tool_call_start|>[codegen(component_id='plan', type='steps', props={'items': [...]})]<|tool_call_end|>
// or <tool_call>{"name": "...", "arguments": {...}}</tool_call>. Shown as-is that is a wall of
// code. This reads those calls (Python-style literals included), turns them into the same
// components and patches a cognita-ui block would hold, and removes the markup from the text.
function pyParse(src) {
  let i = 0;
  const TRUNC = new Error('truncated');
  const ws = () => { while (i < src.length && /\s/.test(src[i])) i++; };
  const need = () => { if (i >= src.length) throw TRUNC; };
  function str() {
    const q = src[i++]; let out = '';
    for (;;) {
      need();
      const c = src[i++];
      if (c === q) return out;
      if (c === '\\') {
        need();
        const e = src[i++];
        if (e === 'n') out += '\n'; else if (e === 't') out += '\t'; else if (e === 'r') out += '\r';
        else if (e === 'u' && /^[0-9a-fA-F]{4}$/.test(src.slice(i, i + 4))) { out += String.fromCharCode(parseInt(src.slice(i, i + 4), 16)); i += 4; }
        else out += e;
      } else out += c;
    }
  }
  function seq(close) {
    i++; const out = [];
    for (;;) {
      ws(); need();
      if (src[i] === close) { i++; return out; }
      out.push(value()); ws();
      if (src[i] === ',') i++;
    }
  }
  function dict() {
    i++; const out = {};
    for (;;) {
      ws(); need();
      if (src[i] === '}') { i++; return out; }
      const k = value(); ws(); need();
      if (src[i] !== ':') throw new Error('colon');
      i++;
      out[String(k)] = value(); ws();
      if (src[i] === ',') i++;
    }
  }
  function call(name) {
    i++; const args = [], kwargs = {};
    for (;;) {
      ws(); need();
      if (src[i] === ')') { i++; return { __call: name, args, kwargs }; }
      const m = /^([A-Za-z_]\w*)\s*=(?!=)/.exec(src.slice(i, i + 80));
      if (m) { i += m[0].length; kwargs[m[1]] = value(); } else args.push(value());
      ws();
      if (src[i] === ',') i++;
    }
  }
  function value() {
    ws(); need();
    const c = src[i];
    if (c === '{') return dict();
    if (c === '[') return seq(']');
    if (c === '(') return seq(')');
    if (c === '"' || c === "'") return str();
    const rest = src.slice(i, i + 40);
    const n = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(rest);
    if (n) { i += n[0].length; return Number(n[0]); }
    const id = /^[A-Za-z_][\w.]*/.exec(rest);
    if (!id) throw new Error('unexpected ' + c);
    i += id[0].length; ws();
    if (src[i] === '(') return call(id[0]);
    const w = id[0];
    if (w === 'True' || w === 'true') return true;
    if (w === 'False' || w === 'false') return false;
    if (w === 'None' || w === 'null') return null;
    return w;
  }
  const calls = [];
  try {
    ws();
    if (src[i] === '[') i++;
    for (;;) {
      ws();
      if (i >= src.length || src[i] === ']') break;
      const v = value();
      if (v && v.__call) calls.push(v);
      else if (v && typeof v === 'object' && !Array.isArray(v)) calls.push({ __call: 'json', args: [v], kwargs: {} });
      ws();
      if (src[i] === ',' || src[i] === ';') i++;
    }
  } catch (_e) { /* keep the calls that were complete */ }
  return calls;
}

function callToItem(c) {
  if (!c) return null;
  const name = String(c.__call || c.name || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  let a = c.kwargs && Object.keys(c.kwargs).length ? c.kwargs : (c.args && c.args[0] && typeof c.args[0] === 'object' && !Array.isArray(c.args[0]) ? c.args[0] : {});
  if (a.arguments && typeof a.arguments === 'object') a = a.arguments;
  if (a.parameters && typeof a.parameters === 'object' && !a.type && !a.op) a = a.parameters;
  if (name === 'patch' || UI_PATCH_OPS.includes(name)) {
    const op = name === 'patch' ? a.op : name;
    return UI_PATCH_OPS.includes(op) ? { ...a, op, target: a.target || a.component_id || a.id } : null;
  }
  if (typeof a.op === 'string' && UI_PATCH_OPS.includes(a.op) && !a.type) return { ...a, target: a.target || a.component_id || a.id };
  if (name === 'cognita_ui' || name === 'cognitaui' || name === 'ui' || name === 'render_ui' || name === 'show_ui') {
    if (Array.isArray(a.blocks)) return a.blocks;
    if (typeof a.type === 'string') return callToItem({ __call: 'component', kwargs: a });
    return null;
  }
  const type = typeof a.type === 'string' ? a.type : (UI_TYPES.includes(name) ? name : null);
  if (!type) return null;
  const props = a.props && typeof a.props === 'object' && !Array.isArray(a.props) ? a.props
    : Object.fromEntries(Object.entries(a).filter(([k]) => !['type', 'id', 'component_id', 'target', 'mode', 'children', 'actions'].includes(k)));
  const out = { id: a.component_id || a.id || a.target, type, props };
  if (Array.isArray(a.children)) out.children = a.children;
  if (Array.isArray(a.actions)) out.actions = a.actions;
  return out;
}

const LEAK_PY = /<\|tool_call_start\|>([\s\S]*?)(?:<\|tool_call_end\|>|$)/g;
const LEAK_XML = /<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g;
const LEAK_STRAY = /<\|tool_call_(?:start|end)\|>|<\/?tool_call>/g;
const LEAK_PREFIXES = ['<|tool_call_start|>', '<tool_call>'];

function liftLeakedCalls(src, partial) {
  if (!src.includes('<|tool_call') && !src.includes('<tool_call>') && !/<\|?t?o?o?l?_?c?a?l?l?_?s?t?a?r?t?\|?>?$|<t?o?o?l?_?c?a?l?l?>?$/.test(src.slice(-20))) return src;
  const toFence = (items) => {
    const list = [];
    items.forEach((it) => { if (Array.isArray(it)) list.push(...it); else if (it) list.push(it); });
    return list.length ? '\n\n```cognita-ui\n' + JSON.stringify(list) + '\n```\n\n' : '';
  };
  let out = src.replace(LEAK_PY, (_m, body) => toFence(pyParse(body).map(callToItem)));
  out = out.replace(LEAK_XML, (_m, body) => {
    const t = body.trim();
    let items = [];
    try {
      const j = JSON.parse(t);
      items = (Array.isArray(j) ? j : [j]).map((x) => callToItem({ name: x && x.name, kwargs: x && (x.arguments || x.parameters) || {} }));
    } catch (_e) { items = pyParse(t).map(callToItem); }
    return toFence(items);
  });
  out = out.replace(LEAK_STRAY, '');
  if (partial) {
    // A marker still being typed at the very end must not flash up as text.
    for (const tok of LEAK_PREFIXES) {
      for (let k = Math.min(tok.length - 1, out.length); k > 0; k--) {
        if (tok.startsWith(out.slice(out.length - k))) { out = out.slice(0, out.length - k); break; }
      }
    }
  }
  return out;
}

const FENCE = /(```|~~~)[ \t]*(?:json[ \t]+)?cognita-ui[ \t]*(?:\r?\n|(?=[{\[]))([\s\S]*?)(?:\1|$)/gi;
const FENCE_HEAD_PREFIX = /(?:```|~~~)[ \t]*(?:j(?:s(?:o(?:n[ \t]*)?)?)?)?(?:[ \t]*c(?:o(?:g(?:n(?:i(?:t(?:a(?:-(?:u(?:i)?)?)?)?)?)?)?)?)?)?[ \t]*$/i;

/**
 * Pulls ```cognita-ui fences out of a reply. Returns the remaining text, the
 * validated blocks and the validated patches. `partial: true` also reads a
 * fence that has not been closed yet (used while a reply is still arriving).
 */
export function parseUiReply(reply, opts) {
  let src = typeof reply === 'string' ? reply : '';
  src = liftLeakedCalls(src, !!(opts && opts.partial));
  if (opts && opts.partial) src = src.replace(FENCE_HEAD_PREFIX, '');   // a fence header still being typed must not flash up as text
  if (!/cognita-ui/i.test(src)) return { text: src, ui: [], patches: [] };
  const rawBlocks = [], rawPatches = [];
  const rest = src.replace(FENCE, (_m, _f, body) => {
    let val;
    try { val = JSON.parse(body.trim()); } catch (_e) {
      val = parsePartial(body);   // also for a fence cut off by the token limit, so the final answer matches the live preview
    }
    if (val !== undefined) sortOut(val, rawBlocks, rawPatches);
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  const ui = validateUi(rawBlocks);
  const patches = rawPatches.slice(0, L.patches).map(validatePatch).filter(Boolean);
  return { text: rest, ui, patches };
}

/** Back-compatible wrapper used by the Worker. */
export function extractUiBlocks(reply) {
  const r = parseUiReply(reply);
  return { text: r.text, ui: r.ui.slice(0, L.blocks), patches: r.patches };
}

/**
 * Incremental parser: push() text chunks as they arrive; every call returns the
 * visible text so far plus the components and patches readable so far.
 */
export function createUiStream() {
  let buf = '';
  return {
    push(chunk) { buf += String(chunk || ''); return parseUiReply(buf, { partial: true }); },
    end() { return parseUiReply(buf); },
  };
}
