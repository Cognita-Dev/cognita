// js/ui-render.js
// Draws the controlled Cognita component vocabulary (see ../ui-schema.js)
// inside an assistant message. Everything is built from validated data and
// escaped text; there is no model-supplied HTML, CSS or script anywhere here.
//
// Every component carries a stable id (data-cui-id) and may carry controlled
// state (node.state). LOCAL events (tabs, accordion, checklist, step status,
// table sort/select, chart/table view, plan editing, form values) update that
// state in the browser and never call the model. AI events (action buttons,
// form submit, "turn into a document") go through the `send` callback, which
// is the app's normal sendMessage -> /api/chat flow.

import { escapeHtml as h } from './shell.js';
import { buildCodeBlockHtml } from './code-highlight.js';
import { validateUi, safeUrl, findUiNode, normalizeState, uiEventKind } from '../ui-schema.js';

let _seq = 0;
const uid = (p) => p + '-' + (++_seq);

const fmt = (n) => {
  if (!Number.isFinite(n)) return '0';
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
  if (a >= 1e4) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(Math.round(n * 100) / 100);
};
const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function actionsHtml(n) {
  if (!n.actions || !n.actions.length) return '';
  return '<div class="cui-actions">' + n.actions.map((a) => a.kind === 'local'
    ? '<button type="button" class="cui-btn" data-cui-act="local" data-target="' + h(a.target) + '" data-state="' + h(JSON.stringify(a.state)) + '">' + h(a.label) + '</button>'
    : '<button type="button" class="cui-btn" data-cui-act="ai" data-prompt="' + h(a.prompt) + '"' + (a.withSelection ? ' data-with-selection="1"' : '') + '>' + h(a.label) + '</button>').join('') + '</div>';
}

function head(title) { return title ? '<div class="cui-title">' + h(title) + '</div>' : ''; }
function para(t) { return t ? '<div class="cui-text">' + h(t).replace(/\n/g, '<br>') + '</div>' : ''; }

// ── Charts (inline SVG built here, never supplied) ─────────────────────
function chartSvg(n) {
  const W = 520, H = 230, L = 44, R = 12, T = 12, B = 44;
  const { labels, series } = n.props;
  const all = series.flatMap((s) => s.values);
  const lo = Math.min(0, ...all), hi = Math.max(0, ...all) || 1;
  const span = hi - lo || 1;
  const y = (v) => T + (H - T - B) * (1 - (v - lo) / span);
  const cw = (W - L - R) / labels.length;
  let g = '';
  for (let i = 0; i <= 4; i++) {
    const v = lo + (span * i) / 4, yy = y(v);
    g += '<line class="cui-grid" x1="' + L + '" x2="' + (W - R) + '" y1="' + yy + '" y2="' + yy + '"/>' +
      '<text class="cui-axis" x="' + (L - 6) + '" y="' + (yy + 3) + '" text-anchor="end">' + h(fmt(v)) + '</text>';
  }
  const step = Math.ceil(labels.length / 10);
  labels.forEach((lb, i) => {
    if (i % step) return;
    g += '<text class="cui-axis" x="' + (L + cw * i + cw / 2) + '" y="' + (H - B + 16) + '" text-anchor="middle">' + h(short(lb, 10)) + '</text>';
  });
  if (n.props.xLabel) g += '<text class="cui-axis" x="' + (W / 2) + '" y="' + (H - 6) + '" text-anchor="middle">' + h(n.props.xLabel) + '</text>';
  if (n.props.yLabel) g += '<text class="cui-axis" x="10" y="' + (T + 8) + '">' + h(n.props.yLabel) + '</text>';
  if (n.type === 'bar_chart') {
    const bw = Math.max(2, (cw * 0.72) / series.length);
    series.forEach((s, si) => s.values.forEach((v, i) => {
      const x = L + cw * i + cw * 0.14 + bw * si, y0 = y(0), y1 = y(v);
      g += '<rect class="cui-bar cui-s' + si + '" x="' + x + '" y="' + Math.min(y0, y1) + '" width="' + bw + '" height="' + Math.max(1, Math.abs(y0 - y1)) +
        '" rx="2"><title>' + h((labels[i] || '') + ': ' + fmt(v)) + '</title></rect>';
    }));
  } else {
    series.forEach((s, si) => {
      const pts = s.values.map((v, i) => [L + cw * i + cw / 2, y(v)]);
      g += '<polyline class="cui-line cui-s' + si + '" fill="none" points="' + pts.map((p) => p.join(',')).join(' ') + '"/>';
      pts.forEach((p, i) => { g += '<circle class="cui-dot cui-s' + si + '" cx="' + p[0] + '" cy="' + p[1] + '" r="3"><title>' + h((labels[i] || '') + ': ' + fmt(s.values[i])) + '</title></circle>'; });
    });
  }
  return '<svg class="cui-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + h(n.props.title || 'Chart') + '">' + g + '</svg>';
}

function pieSvg(n) {
  const { labels, series } = n.props;
  const vals = series[0].values.map((v) => Math.max(0, v));
  const total = vals.reduce((a, b) => a + b, 0);
  if (!total) return '<div class="cui-text">No data to show.</div>';
  const cx = 90, cy = 90, r = 80;
  let a0 = -Math.PI / 2, paths = '', legend = '';
  vals.forEach((v, i) => {
    const frac = v / total, a1 = a0 + frac * Math.PI * 2;
    const c = 'cui-s' + (i % 6);
    if (frac >= 0.9999) paths += '<circle class="cui-slice ' + c + '" cx="' + cx + '" cy="' + cy + '" r="' + r + '"/>';
    else if (frac > 0) {
      const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0), x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
      paths += '<path class="cui-slice ' + c + '" d="M' + cx + ' ' + cy + ' L' + x0 + ' ' + y0 + ' A' + r + ' ' + r + ' 0 ' + (frac > 0.5 ? 1 : 0) + ' 1 ' + x1 + ' ' + y1 + ' Z"><title>' + h((labels[i] || '') + ': ' + fmt(v)) + '</title></path>';
    }
    legend += '<li><span class="cui-swatch ' + c + '"></span>' + h(labels[i] || '') + ' <b>' + Math.round(frac * 100) + '%</b></li>';
    a0 = a1;
  });
  return '<div class="cui-pie"><svg class="cui-svg cui-svg--pie" viewBox="0 0 180 180" role="img" aria-label="' + h(n.props.title || 'Pie chart') + '">' + paths + '</svg><ul class="cui-legend">' + legend + '</ul></div>';
}

// rows: array of arrays. opts: { sortable, sort:{col,dir}, selectable, selected:[idx] }
function tableHtml(columns, rows, opts) {
  const o = opts || {};
  const sel = new Set(o.selected || []);
  let order = rows.map((r, i) => ({ r, i }));
  if (o.sort) {
    const { col, dir } = o.sort;
    order.sort((a, b) => {
      const x = a.r[col] || '', y = b.r[col] || '';
      const nx = numOf(x), ny = numOf(y);
      const c = nx !== null && ny !== null ? nx - ny : String(x).localeCompare(String(y), undefined, { numeric: true });
      return dir === 'desc' ? -c : c;
    });
  }
  return '<div class="cui-scroll"><table class="cui-table' + (o.selectable ? ' cui-table--selectable' : '') + '"><thead><tr>' +
    columns.map((c, i) => '<th' + (o.sortable ? ' data-cui-sort="' + i + '" tabindex="0" role="button"' + (o.sort && o.sort.col === i ? ' data-dir="' + o.sort.dir + '"' : '') : '') + '>' + h(c) + '</th>').join('') +
    '</tr></thead><tbody>' +
    order.map(({ r, i }) => '<tr data-row="' + i + '"' + (o.selectable ? ' tabindex="0" aria-selected="' + sel.has(i) + '"' : '') + (sel.has(i) ? ' class="is-selected"' : '') + '>' + r.map((c) => '<td>' + h(c) + '</td>').join('') + '</tr>').join('') +
    '</tbody></table></div>';
}

function chartNode(n) {
  const p = n.props, st = n.state || {};
  const view = st.view || (p.mode === 'table' ? 'table' : 'chart');
  const body = n.type === 'pie_chart' ? pieSvg(n) : chartSvg(n);
  const cols = [p.xLabel || 'Label'].concat(p.series.map((s, i) => s.name || (p.yLabel || 'Value') + (p.series.length > 1 ? ' ' + (i + 1) : '')));
  const rows = p.labels.map((lb, i) => [lb].concat(p.series.map((s) => fmt(s.values[i]))));
  const legend = p.series.length > 1 && n.type !== 'pie_chart'
    ? '<ul class="cui-legend cui-legend--row">' + p.series.map((s, i) => '<li><span class="cui-swatch cui-s' + i + '"></span>' + h(s.name || 'Series ' + (i + 1)) + '</li>').join('') + '</ul>' : '';
  return head(p.title) +
    '<div class="cui-toggle"><button type="button" class="cui-chip' + (view === 'chart' ? ' is-on' : '') + '" data-cui-view="chart">Chart</button><button type="button" class="cui-chip' + (view === 'table' ? ' is-on' : '') + '" data-cui-view="table">Table</button></div>' +
    '<div class="cui-view" data-cui-pane="chart"' + (view === 'chart' ? '' : ' hidden') + '>' + body + legend + '</div>' +
    '<div class="cui-view" data-cui-pane="table"' + (view === 'table' ? '' : ' hidden') + '>' + tableHtml(cols, rows, { sortable: true }) + '</div>';
}

// ── Node renderer ──────────────────────────────────────────────────────
function kids(list, ctx) { return (list || []).map((c) => node(c, ctx)).join(''); }

function node(n, ctx) {
  const p = n.props, st = n.state || {};
  let inner = '';
  switch (n.type) {
    case 'card': {
      const open = typeof st.open === 'boolean' ? st.open : p.open;
      inner = p.collapsible
        ? '<details class="cui-details" data-cui-card' + (open ? ' open' : '') + '><summary>' + h(p.title || 'Details') + '</summary>' + para(p.description) + para(p.content) + kids(n.children, ctx) + '</details>'
        : head(p.title) + para(p.description) + para(p.content) + kids(n.children, ctx);
      break;
    }
    case 'table':
      inner = head(p.title) + tableHtml(p.columns, p.rows, { sortable: p.sortable, sort: st.sort, selectable: p.selectable, selected: st.selected }) + (p.caption ? '<div class="cui-caption">' + h(p.caption) + '</div>' : '');
      break;
    case 'stat':
      inner = '<div class="cui-stat-label">' + h(p.label) + '</div><div class="cui-stat-value">' + h(p.value) + '</div>' + (p.explanation ? '<div class="cui-caption">' + h(p.explanation) + '</div>' : '');
      break;
    case 'bar_chart': case 'line_chart': case 'pie_chart':
      inner = chartNode(n);
      break;
    case 'list':
      inner = head(p.title) + '<' + (p.ordered ? 'ol' : 'ul') + ' class="cui-list">' + p.items.map((i) => '<li>' + h(i) + '</li>').join('') + '</' + (p.ordered ? 'ol' : 'ul') + '>';
      break;
    case 'checklist': {
      const ck = st.checked || [];
      inner = head(p.title) + '<div class="cui-progress" data-cui-progress></div><ul class="cui-check">' +
        p.items.map((i, k) => '<li><label><input type="checkbox" data-cui-check' + ((k < ck.length ? ck[k] : i.checked) ? ' checked' : '') + '><span>' + h(i.text) + '</span></label></li>').join('') + '</ul>';
      break;
    }
    case 'steps': {
      const sts = st.status || [];
      inner = head(p.title) + '<ol class="cui-steps">' + p.items.map((i, k) => {
        const status = sts[k] || i.status;
        return '<li class="cui-step is-' + status + '" data-cui-step data-status="' + status + '"><button type="button" class="cui-step-dot" aria-label="Change status">' + (k + 1) + '</button><div><div class="cui-step-title">' + h(i.title) + '</div>' + (i.description ? '<div class="cui-caption">' + h(i.description) + '</div>' : '') + '</div></li>';
      }).join('') + '</ol>';
      break;
    }
    case 'tabs': {
      const pid = uid('tabs');
      const act = Math.min(st.active || 0, p.items.length - 1);
      inner = head(p.title) + '<div class="cui-tabbar" role="tablist">' + p.items.map((t, i) =>
        '<button type="button" role="tab" class="cui-tab' + (i === act ? ' is-on' : '') + '" data-cui-tab="' + pid + '-' + i + '" data-i="' + i + '" aria-selected="' + (i === act) + '">' + h(t.label) + '</button>').join('') + '</div>' +
        p.items.map((t, i) => '<div class="cui-panel" role="tabpanel" data-cui-panel="' + pid + '-' + i + '"' + (i === act ? '' : ' hidden') + '>' + para(t.content) + kids(t.children, ctx) + '</div>').join('');
      break;
    }
    case 'accordion': {
      const op = st.open || [];
      inner = head(p.title) + p.items.map((t, i) => '<details class="cui-details" data-cui-acc="' + i + '"' + ((i < op.length ? op[i] : t.open) ? ' open' : '') + '><summary>' + h(t.label) + '</summary>' + para(t.content) + kids(t.children, ctx) + '</details>').join('');
      break;
    }
    case 'form': {
      const vals = st.values || {};
      inner = head(p.title) + para(p.description) + '<div class="cui-form" data-cui-form data-submit-prompt="' + h(p.submitPrompt) + '" data-form-title="' + h(p.title) + '">' +
        p.fields.map((f) => {
          const id = uid('f');
          const v = Object.prototype.hasOwnProperty.call(vals, f.name) ? vals[f.name] : f.value;
          const req = f.required ? ' data-required="1"' : '';
          const base = 'id="' + id + '" data-name="' + h(f.name) + '" data-label="' + h(f.label) + '"' + req;
          if (f.type === 'checkbox' || f.type === 'switch') {
            return '<label class="cui-field cui-field--inline" for="' + id + '"><input type="checkbox" ' + base + (v === true ? ' checked' : '') + '><span>' + h(f.label) + '</span></label>';
          }
          const sv = typeof v === 'string' ? v : '';
          let ctl;
          if (f.type === 'textarea') ctl = '<textarea ' + base + ' rows="3" maxlength="2000" placeholder="' + h(f.placeholder) + '">' + h(sv) + '</textarea>';
          else if (f.type === 'select') ctl = '<select ' + base + '>' + f.options.map((o) => '<option' + (o === sv ? ' selected' : '') + '>' + h(o) + '</option>').join('') + '</select>';
          else ctl = '<input type="text" ' + base + ' maxlength="500" placeholder="' + h(f.placeholder) + '" value="' + h(sv) + '">';
          return '<label class="cui-field" for="' + id + '"><span>' + h(f.label) + (f.required ? ' *' : '') + '</span>' + ctl + '</label>';
        }).join('') +
        '<button type="button" class="cui-btn cui-btn--primary" data-cui-act="submit">' + h(p.submitLabel) + '</button></div>';
      break;
    }
    case 'timeline':
      inner = head(p.title) + '<ol class="cui-timeline">' + p.items.map((i) =>
        '<li>' + (i.date ? '<div class="cui-date">' + h(i.date) + '</div>' : '') + '<div class="cui-step-title">' + h(i.title) + '</div>' + (i.description ? '<div class="cui-caption">' + h(i.description) + '</div>' : '') + '</li>').join('') + '</ol>';
      break;
    case 'callout':
      inner = '<div class="cui-callout-icon"><i class="ph ph-' + (p.variant === 'warning' ? 'warning' : p.variant === 'success' ? 'check-circle' : 'info') + '"></i></div><div>' + head(p.title) + para(p.content) + '</div>';
      break;
    case 'code': {
      const id = uid('uicode');
      inner = head(p.title) + buildCodeBlockHtml({ lang: p.language, code: h(p.code), id }) +
        (p.runnable ? '<div class="cui-actions"><button type="button" class="cui-btn" data-cui-act="run" data-lang="' + h(p.language) + '" data-code="' + h(p.code) + '"><i class="ph ph-play"></i> Run it</button></div>' : '');
      break;
    }
    case 'data_summary':
      inner = head(p.title) +
        (p.metrics.length ? '<div class="cui-metrics">' + p.metrics.map((m) => '<div class="cui-metric"><div class="cui-stat-value">' + h(m.value) + '</div><div class="cui-stat-label">' + h(m.label) + '</div></div>').join('') + '</div>' : '') +
        (p.findings.length ? '<ul class="cui-list">' + p.findings.map((f) => '<li>' + h(f) + '</li>').join('') + '</ul>' : '') + kids(n.children, ctx);
      break;
    case 'source_list':
      inner = head(p.title) + '<ul class="cui-sources">' + p.sources.map((s) => {
        const url = safeUrl(s.url);
        let host = '';
        try { host = url ? new URL(url).hostname.replace(/^www\./, '') : ''; } catch (_) { /* ignore */ }
        return '<li>' + (url ? '<a href="' + h(url) + '" target="_blank" rel="noopener noreferrer nofollow">' + h(s.title) + '</a>' : '<span class="cui-step-title">' + h(s.title) + '</span>') +
          (host ? '<span class="cui-host">' + h(host) + '</span>' : '') + (s.description ? '<div class="cui-caption">' + h(s.description) + '</div>' : '') + '</li>';
      }).join('') + '</ul>';
      break;
    case 'plan': {
      const done = st.done || [];
      inner = head(p.title) + para(p.description) + '<div data-cui-plan data-editable="' + (p.editable ? '1' : '0') + '">' + p.sections.map((s, si) =>
        '<div class="cui-plan-sec"><div class="cui-plan-title"' + (p.editable ? ' contenteditable="plaintext-only" spellcheck="false"' : '') + '>' + h(s.title) + '</div><ul class="cui-check">' +
        s.tasks.map((t, ti) => {
          const d = done[si] && ti < done[si].length ? done[si][ti] : t.done;
          return '<li><label><input type="checkbox" data-cui-check' + (d ? ' checked' : '') + '><span' + (p.editable ? ' contenteditable="plaintext-only" spellcheck="false"' : '') + '>' + h(t.text) + '</span></label></li>';
        }).join('') + '</ul>' +
        (p.editable ? '<button type="button" class="cui-chip" data-cui-act="addtask">+ Add task</button>' : '') + '</div>').join('') + '</div>' +
        '<div class="cui-progress" data-cui-progress></div>' +
        '<div class="cui-actions"><button type="button" class="cui-btn" data-cui-act="plandoc"><i class="ph ph-file-text"></i> Turn into a document</button></div>';
      break;
    }
    case 'document_result':
      inner = '<div class="cui-result-icon"><i class="ph ph-file-text"></i></div><div><div class="cui-title">' + h(p.title) + '</div>' + (p.description ? '<div class="cui-caption">' + h(p.description) + '</div>' : '') + '<span class="cui-host">' + h(p.format.toUpperCase()) + '</span></div>';
      break;
    case 'media_result':
      inner = '<div class="cui-result-icon"><i class="ph ph-' + (p.kind === 'design' ? 'paint-brush' : 'image') + '"></i></div><div><div class="cui-title">' + h(p.title) + '</div>' + (p.description ? '<div class="cui-caption">' + h(p.description) + '</div>' : '') + '</div>';
      break;
    default:
      return '';
  }
  const mod = n.type === 'callout' ? ' cui-callout--' + p.variant : '';
  return '<section class="cui-node cui-' + n.type + mod + '" data-cui="' + n.type + '" data-cui-id="' + h(n.id) + '">' + inner + actionsHtml(n) + '</section>';
}

function nodesHtml(blocks) { return blocks.map((b) => node(b, {})).join(''); }

/**
 * Returns the HTML for a message's UI blocks ('' when there are none or none
 * are valid). `msgIndex` ties the root to its message so state can be saved;
 * `fresh` lets a just-arrived reply fade its components in one by one.
 */
export function renderUiHtml(blocks, msgIndex, fresh) {
  const safe = validateUi(blocks);
  if (!safe.length) return '';
  return '<div class="cui' + (fresh ? ' cui--fresh' : '') + '" data-cui-root' + (Number.isInteger(msgIndex) ? ' data-cui-msg="' + msgIndex + '"' : '') + '>' + nodesHtml(safe) + '</div>';
}

/** Re-draws one message's UI in place (after a patch). Returns true when drawn. */
export function refreshUi(scope, msgIndex, blocks) {
  const root = scope.querySelector('[data-cui-root][data-cui-msg="' + msgIndex + '"]');
  const safe = validateUi(blocks);
  if (!root) return false;
  root.innerHTML = nodesHtml(safe);
  updateProgress(root);
  return true;
}

// ── Local + AI interactions ────────────────────────────────────────────
function numOf(s) { const x = parseFloat(String(s).replace(/[^0-9.\-]/g, '')); return Number.isFinite(x) && /\d/.test(s) ? x : null; }

function sortTable(th) {
  const table = th.closest('table'), tbody = table.tBodies[0], i = Number(th.dataset.cuiSort);
  const dir = th.dataset.dir === 'asc' ? 'desc' : 'asc';
  table.querySelectorAll('th').forEach((x) => { delete x.dataset.dir; });
  th.dataset.dir = dir;
  const rows = Array.from(tbody.rows);
  rows.sort((a, b) => {
    const x = a.cells[i].textContent.trim(), y = b.cells[i].textContent.trim();
    const nx = numOf(x), ny = numOf(y);
    const c = nx !== null && ny !== null ? nx - ny : x.localeCompare(y, undefined, { numeric: true });
    return dir === 'asc' ? c : -c;
  });
  rows.forEach((r) => tbody.appendChild(r));
  return { col: i, dir };
}

function updateProgress(root) {
  root.querySelectorAll('.cui-checklist, .cui-plan').forEach((c) => {
    const boxes = c.querySelectorAll('input[data-cui-check]');
    const done = Array.from(boxes).filter((b) => b.checked).length;
    const el = c.querySelector('[data-cui-progress]');
    if (el) el.textContent = done + ' of ' + boxes.length + ' done';
  });
}

function planText(plan) {
  const title = plan.closest('.cui-node').querySelector('.cui-title');
  let out = (title ? title.textContent : 'Plan') + '\n';
  plan.querySelectorAll('.cui-plan-sec').forEach((s) => {
    out += '\n' + s.querySelector('.cui-plan-title').textContent.trim() + '\n';
    s.querySelectorAll('li').forEach((li) => {
      out += '- [' + (li.querySelector('input').checked ? 'x' : ' ') + '] ' + li.querySelector('span').textContent.trim() + '\n';
    });
  });
  return out.trim();
}

// Elements that belong to this component and not to a component nested inside it.
const own = (nodeEl, sel) => Array.from(nodeEl.querySelectorAll(sel)).filter((e) => e.closest('[data-cui-id]') === nodeEl);

/**
 * Wires every .cui root under `scope` once.
 *  send(text)            the app's normal chat send (the only AI path)
 *  busy()                whether a reply is already being written
 *  notify(msg)           toast
 *  getBlocks(msgIndex)   the live validated blocks for that message
 *  onChange(msgIndex)    called after state/props changed so the app can save
 */
export function wireUi(scope, { send, busy, notify, getBlocks, onChange }) {
  scope.querySelectorAll('[data-cui-root]').forEach((root) => {
    if (root.dataset.wired) return;
    root.dataset.wired = '1';
    updateProgress(root);

    const msg = Number(root.dataset.cuiMsg);
    const blocks = () => (getBlocks && Number.isInteger(msg) ? getBlocks(msg) : null);
    const changed = () => { if (onChange && Number.isInteger(msg)) onChange(msg); };
    const nodeEl = (el) => el.closest('[data-cui-id]');
    const modelOf = (el) => { const ne = nodeEl(el), b = blocks(); const hit = ne && b ? findUiNode(b, ne.dataset.cuiId) : null; return hit ? hit.node : null; };

    // Events are classified in ui-schema.js (UI_EVENTS): local ones only touch state.
    const setState = (el, event, patch) => {
      if (uiEventKind(event) !== 'local') return;
      const n = modelOf(el);
      if (!n) return;
      const next = normalizeState(n.type, { ...(n.state || {}), ...patch }, n);
      if (Object.keys(next).length) n.state = next; else delete n.state;
      changed();
    };

    const ask = (text, el) => {
      if (busy()) { notify('Please wait for the current reply to finish.'); return; }
      const ne = el && nodeEl(el);
      const tag = ne ? '\n\n(Component id: ' + ne.dataset.cuiId + '. To change it in place, answer with a cognita-ui patch for this id.)' : '';
      send((String(text).slice(0, 3600) + tag).slice(0, 4000));
    };

    const syncPlan = (el) => {
      const ne = nodeEl(el), n = modelOf(el);
      if (!n || n.type !== 'plan') return;
      n.props.sections = Array.from(ne.querySelectorAll('.cui-plan-sec')).map((s) => ({
        title: s.querySelector('.cui-plan-title').textContent.trim().slice(0, 200),
        tasks: Array.from(s.querySelectorAll('li')).map((li) => ({ text: li.querySelector('span').textContent.trim().slice(0, 400), done: li.querySelector('input').checked })).filter((t) => t.text),
      }));
      delete n.state;
      changed();
    };

    root.addEventListener('change', (e) => {
      const t = e.target;
      if (t.matches('input[data-cui-check]')) {
        updateProgress(root);
        const ne = nodeEl(t), n = modelOf(t);
        if (!n) return;
        if (n.type === 'plan') syncPlan(t);
        else setState(t, 'toggle', { checked: own(ne, 'input[data-cui-check]').map((b) => b.checked) });
      } else if (t.matches('[data-name]')) {
        const ne = nodeEl(t), values = {};
        own(ne, '[data-name]').forEach((f) => { values[f.dataset.name] = f.type === 'checkbox' ? f.checked : String(f.value || ''); });
        setState(t, 'change', { values });
      }
    });

    root.addEventListener('focusout', (e) => { if (e.target.matches && e.target.matches('.cui-plan [contenteditable]')) syncPlan(e.target); });

    // <details> toggle does not bubble, so it is caught in the capture phase.
    root.addEventListener('toggle', (e) => {
      const d = e.target;
      if (!d.matches || !d.matches('details.cui-details')) return;
      const ne = d.closest('[data-cui-id]');
      if (d.hasAttribute('data-cui-card')) setState(d, d.open ? 'expand' : 'collapse', { open: d.open });
      else if (ne) setState(d, d.open ? 'expand' : 'collapse', { open: own(ne, 'details[data-cui-acc]').map((x) => x.open) });
    }, true);

    root.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('th[data-cui-sort]')) { e.preventDefault(); const s = sortTable(e.target); setState(e.target, 'sort', { sort: s }); }
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr[data-row]') && e.target.closest('.cui-table--selectable')) { e.preventDefault(); e.target.click(); }
      if (e.key === 'Enter' && e.target.matches('[contenteditable]')) { e.preventDefault(); e.target.blur(); }
    });

    root.addEventListener('click', (e) => {
      const t = e.target;
      const th = t.closest('th[data-cui-sort]');
      if (th) { const s = sortTable(th); setState(th, 'sort', { sort: s }); return; }

      const tab = t.closest('[data-cui-tab]');
      if (tab) {
        const bar = tab.parentElement, ne = bar.closest('.cui-node');
        bar.querySelectorAll('.cui-tab').forEach((b) => { const on = b === tab; b.classList.toggle('is-on', on); b.setAttribute('aria-selected', String(on)); });
        ne.querySelectorAll(':scope > [data-cui-panel]').forEach((p) => { p.hidden = p.dataset.cuiPanel !== tab.dataset.cuiTab; });
        setState(tab, 'select', { active: Number(tab.dataset.i) });
        return;
      }

      const view = t.closest('[data-cui-view]');
      if (view) {
        const ne = view.closest('.cui-node');
        ne.querySelectorAll('[data-cui-view]').forEach((b) => b.classList.toggle('is-on', b === view));
        ne.querySelectorAll('[data-cui-pane]').forEach((p) => { p.hidden = p.dataset.cuiPane !== view.dataset.cuiView; });
        setState(view, 'select', { view: view.dataset.cuiView });
        return;
      }

      const dot = t.closest('.cui-step-dot');
      if (dot) {
        const li = dot.closest('[data-cui-step]');
        const next = { todo: 'doing', doing: 'done', done: 'todo' }[li.dataset.status] || 'todo';
        li.dataset.status = next; li.className = 'cui-step is-' + next;
        const ne = nodeEl(dot);
        setState(dot, 'change', { status: own(ne, '[data-cui-step]').map((s) => s.dataset.status) });
        return;
      }

      const row = t.closest('tr[data-row]');
      if (row && row.closest('.cui-table--selectable') && !t.closest('a')) {
        row.classList.toggle('is-selected');
        row.setAttribute('aria-selected', String(row.classList.contains('is-selected')));
        const ne = nodeEl(row);
        setState(row, 'select', { selected: own(ne, 'tr.is-selected').map((r) => Number(r.dataset.row)) });
        return;
      }

      const btn = t.closest('[data-cui-act]');
      if (!btn) return;
      const act = btn.dataset.cuiAct;

      if (act === 'local') {
        const b = blocks();
        const hit = b ? findUiNode(b, btn.dataset.target) : null;
        if (!hit) return;
        let st = {};
        try { st = JSON.parse(btn.dataset.state || '{}'); } catch (_) { /* ignore */ }
        const next = normalizeState(hit.node.type, { ...(hit.node.state || {}), ...st }, hit.node);
        if (Object.keys(next).length) hit.node.state = next; else delete hit.node.state;
        root.innerHTML = nodesHtml(validateUi(b));
        updateProgress(root);
        changed();
        return;
      }
      if (act === 'ai') {
        let prompt = btn.dataset.prompt;
        if (btn.dataset.withSelection) {
          const ne = nodeEl(btn);
          const scopeEl = ne.querySelector('.cui-table--selectable') ? ne : root;
          const rows = Array.from(scopeEl.querySelectorAll('.cui-table--selectable tr.is-selected'));
          if (!rows.length) { notify('Select one or more rows first.'); return; }
          const cols = Array.from(rows[0].closest('table').tHead.rows[0].cells).map((c) => c.textContent.trim());
          prompt += '\n\nSelected rows (' + cols.join(' | ') + '):\n' + rows.map((r) => Array.from(r.cells).map((c) => c.textContent.trim()).join(' | ')).join('\n');
        }
        ask(prompt, btn);
        return;
      }
      if (act === 'run') { ask('Run this code and show me the output:\n\n```' + (btn.dataset.lang || '') + '\n' + btn.dataset.code + '\n```', null); return; }
      if (act === 'plandoc') { ask('Turn this plan into a document I can download:\n\n' + planText(btn.closest('.cui-node').querySelector('[data-cui-plan]')), null); return; }
      if (act === 'addtask') {
        const ul = btn.parentElement.querySelector('ul');
        const li = document.createElement('li');
        li.innerHTML = '<label><input type="checkbox" data-cui-check><span contenteditable="plaintext-only" spellcheck="false">New task</span></label>';
        ul.appendChild(li);
        const span = li.querySelector('span');
        span.focus();
        const range = document.createRange(); range.selectNodeContents(span);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
        updateProgress(root);
        syncPlan(btn);
        return;
      }
      if (act === 'submit') {
        const form = btn.closest('[data-cui-form]');
        const lines = [];
        let missing = null;
        form.querySelectorAll('[data-name]').forEach((el) => {
          const val = el.type === 'checkbox' ? (el.checked ? 'Yes' : 'No') : String(el.value || '').trim();
          if (el.dataset.required && !val && !missing) missing = el;
          lines.push(el.dataset.label + ': ' + val);
        });
        if (missing) { missing.focus(); notify('Please fill in "' + missing.dataset.label + '".'); return; }
        ask((form.dataset.submitPrompt || ('Here is the completed form' + (form.dataset.formTitle ? ' "' + form.dataset.formTitle + '"' : '') + '.')) + '\n\n' + lines.join('\n'), btn);
      }
    });
  });
}
