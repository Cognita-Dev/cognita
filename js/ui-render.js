// js/ui-render.js
// Draws the controlled Cognita component vocabulary (see ../ui-schema.js)
// inside an assistant message. Everything is built from validated data and
// escaped text; there is no model-supplied HTML, CSS or script anywhere here.
//
// Local interactions (tabs, accordion, checklist, step status, table sort,
// chart/table toggle, plan editing) never call the model. Anything that needs
// reasoning (action buttons, forms, "turn into a document") goes through the
// `send` callback, which is the app's normal sendMessage -> /api/chat flow.

import { escapeHtml as h } from './shell.js';
import { buildCodeBlockHtml } from './code-highlight.js';
import { validateUi, safeUrl } from '../ui-schema.js';

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
  return '<div class="cui-actions">' + n.actions.map((a) =>
    '<button type="button" class="cui-btn" data-cui-act="ai" data-prompt="' + h(a.prompt) + '">' + h(a.label) + '</button>').join('') + '</div>';
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

function tableHtml(columns, rows, sortable) {
  return '<div class="cui-scroll"><table class="cui-table"><thead><tr>' +
    columns.map((c, i) => '<th' + (sortable ? ' data-cui-sort="' + i + '" tabindex="0" role="button"' : '') + '>' + h(c) + '</th>').join('') +
    '</tr></thead><tbody>' +
    rows.map((r) => '<tr>' + r.map((c) => '<td>' + h(c) + '</td>').join('') + '</tr>').join('') +
    '</tbody></table></div>';
}

function chartNode(n) {
  const p = n.props;
  const body = n.type === 'pie_chart' ? pieSvg(n) : chartSvg(n);
  const cols = [p.xLabel || 'Label'].concat(p.series.map((s, i) => s.name || (p.yLabel || 'Value') + (p.series.length > 1 ? ' ' + (i + 1) : '')));
  const rows = p.labels.map((lb, i) => [lb].concat(p.series.map((s) => fmt(s.values[i]))));
  const legend = p.series.length > 1 && n.type !== 'pie_chart'
    ? '<ul class="cui-legend cui-legend--row">' + p.series.map((s, i) => '<li><span class="cui-swatch cui-s' + i + '"></span>' + h(s.name || 'Series ' + (i + 1)) + '</li>').join('') + '</ul>' : '';
  return head(p.title) +
    '<div class="cui-toggle"><button type="button" class="cui-chip is-on" data-cui-view="chart">Chart</button><button type="button" class="cui-chip" data-cui-view="table">Table</button></div>' +
    '<div class="cui-view" data-cui-pane="chart">' + body + legend + '</div>' +
    '<div class="cui-view" data-cui-pane="table" hidden>' + tableHtml(cols, rows, true) + '</div>';
}

// ── Node renderer ──────────────────────────────────────────────────────
function kids(list, ctx) { return (list || []).map((c) => node(c, ctx)).join(''); }

function node(n, ctx) {
  const p = n.props;
  let inner = '';
  switch (n.type) {
    case 'card':
      inner = p.collapsible
        ? '<details class="cui-details"' + (p.open ? ' open' : '') + '><summary>' + h(p.title || 'Details') + '</summary>' + para(p.description) + para(p.content) + kids(n.children, ctx) + '</details>'
        : head(p.title) + para(p.description) + para(p.content) + kids(n.children, ctx);
      break;
    case 'table':
      inner = head(p.title) + tableHtml(p.columns, p.rows, p.sortable) + (p.caption ? '<div class="cui-caption">' + h(p.caption) + '</div>' : '');
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
    case 'checklist':
      inner = head(p.title) + '<div class="cui-progress" data-cui-progress></div><ul class="cui-check">' +
        p.items.map((i) => '<li><label><input type="checkbox" data-cui-check' + (i.checked ? ' checked' : '') + '><span>' + h(i.text) + '</span></label></li>').join('') + '</ul>';
      break;
    case 'steps':
      inner = head(p.title) + '<ol class="cui-steps">' + p.items.map((i, k) =>
        '<li class="cui-step is-' + i.status + '" data-cui-step data-status="' + i.status + '"><button type="button" class="cui-step-dot" aria-label="Change status">' + (k + 1) + '</button><div><div class="cui-step-title">' + h(i.title) + '</div>' + (i.description ? '<div class="cui-caption">' + h(i.description) + '</div>' : '') + '</div></li>').join('') + '</ol>';
      break;
    case 'tabs': {
      const id = uid('tabs');
      inner = head(p.title) + '<div class="cui-tabbar" role="tablist">' + p.items.map((t, i) =>
        '<button type="button" role="tab" class="cui-tab' + (i ? '' : ' is-on') + '" data-cui-tab="' + id + '-' + i + '" aria-selected="' + (i ? 'false' : 'true') + '">' + h(t.label) + '</button>').join('') + '</div>' +
        p.items.map((t, i) => '<div class="cui-panel" role="tabpanel" data-cui-panel="' + id + '-' + i + '"' + (i ? ' hidden' : '') + '>' + para(t.content) + kids(t.children, ctx) + '</div>').join('');
      break;
    }
    case 'accordion':
      inner = head(p.title) + p.items.map((t) => '<details class="cui-details"' + (t.open ? ' open' : '') + '><summary>' + h(t.label) + '</summary>' + para(t.content) + kids(t.children, ctx) + '</details>').join('');
      break;
    case 'form':
      inner = head(p.title) + para(p.description) + '<div class="cui-form" data-cui-form data-submit-prompt="' + h(p.submitPrompt) + '" data-form-title="' + h(p.title) + '">' +
        p.fields.map((f) => {
          const id = uid('f');
          const req = f.required ? ' data-required="1"' : '';
          const base = 'id="' + id + '" data-name="' + h(f.name) + '" data-label="' + h(f.label) + '"' + req;
          if (f.type === 'checkbox' || f.type === 'switch') {
            return '<label class="cui-field cui-field--inline" for="' + id + '"><input type="checkbox" ' + base + (f.value ? ' checked' : '') + '><span>' + h(f.label) + '</span></label>';
          }
          let ctl;
          if (f.type === 'textarea') ctl = '<textarea ' + base + ' rows="3" maxlength="2000" placeholder="' + h(f.placeholder) + '">' + h(f.value) + '</textarea>';
          else if (f.type === 'select') ctl = '<select ' + base + '>' + f.options.map((o) => '<option' + (o === f.value ? ' selected' : '') + '>' + h(o) + '</option>').join('') + '</select>';
          else ctl = '<input type="text" ' + base + ' maxlength="500" placeholder="' + h(f.placeholder) + '" value="' + h(f.value) + '">';
          return '<label class="cui-field" for="' + id + '"><span>' + h(f.label) + (f.required ? ' *' : '') + '</span>' + ctl + '</label>';
        }).join('') +
        '<button type="button" class="cui-btn cui-btn--primary" data-cui-act="submit">' + h(p.submitLabel) + '</button></div>';
      break;
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
    case 'plan':
      inner = head(p.title) + para(p.description) + '<div data-cui-plan data-editable="' + (p.editable ? '1' : '0') + '">' + p.sections.map((s) =>
        '<div class="cui-plan-sec"><div class="cui-plan-title"' + (p.editable ? ' contenteditable="plaintext-only" spellcheck="false"' : '') + '>' + h(s.title) + '</div><ul class="cui-check">' +
        s.tasks.map((t) => '<li><label><input type="checkbox" data-cui-check' + (t.done ? ' checked' : '') + '><span' + (p.editable ? ' contenteditable="plaintext-only" spellcheck="false"' : '') + '>' + h(t.text) + '</span></label></li>').join('') + '</ul>' +
        (p.editable ? '<button type="button" class="cui-chip" data-cui-act="addtask">+ Add task</button>' : '') + '</div>').join('') + '</div>' +
        '<div class="cui-actions"><button type="button" class="cui-btn" data-cui-act="plandoc"><i class="ph ph-file-text"></i> Turn into a document</button></div>';
      break;
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
  return '<section class="cui-node cui-' + n.type + mod + '" data-cui="' + n.type + '">' + inner + actionsHtml(n) + '</section>';
}

/** Returns the HTML for a message's UI blocks ('' when there are none or none are valid). */
export function renderUiHtml(blocks) {
  const safe = validateUi(blocks);
  if (!safe.length) return '';
  return '<div class="cui" data-cui-root>' + safe.map((b) => node(b, {})).join('') + '</div>';
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
}

function updateProgress(root) {
  root.querySelectorAll('.cui-checklist').forEach((c) => {
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

/**
 * Wires every .cui root under `scope` once. `send(text)` is the app's normal
 * chat send; `busy()` says whether a reply is already being written.
 */
export function wireUi(scope, { send, busy, notify }) {
  scope.querySelectorAll('[data-cui-root]').forEach((root) => {
    if (root.dataset.wired) return;
    root.dataset.wired = '1';
    updateProgress(root);

    const ask = (text) => {
      if (busy()) { notify('Please wait for the current reply to finish.'); return; }
      send(String(text).slice(0, 4000));
    };

    root.addEventListener('change', (e) => { if (e.target.matches('input[data-cui-check]')) updateProgress(root); });

    root.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('th[data-cui-sort]')) { e.preventDefault(); sortTable(e.target); }
      if (e.key === 'Enter' && e.target.matches('[contenteditable]')) { e.preventDefault(); e.target.blur(); }
    });

    root.addEventListener('click', (e) => {
      const t = e.target;
      const th = t.closest('th[data-cui-sort]');
      if (th) { sortTable(th); return; }

      const tab = t.closest('[data-cui-tab]');
      if (tab) {
        const bar = tab.parentElement, node = bar.closest('.cui-node');
        bar.querySelectorAll('.cui-tab').forEach((b) => { const on = b === tab; b.classList.toggle('is-on', on); b.setAttribute('aria-selected', String(on)); });
        node.querySelectorAll(':scope > [data-cui-panel]').forEach((p) => { p.hidden = p.dataset.cuiPanel !== tab.dataset.cuiTab; });
        return;
      }

      const view = t.closest('[data-cui-view]');
      if (view) {
        const node = view.closest('.cui-node');
        node.querySelectorAll('[data-cui-view]').forEach((b) => b.classList.toggle('is-on', b === view));
        node.querySelectorAll('[data-cui-pane]').forEach((p) => { p.hidden = p.dataset.cuiPane !== view.dataset.cuiView; });
        return;
      }

      const dot = t.closest('.cui-step-dot');
      if (dot) {
        const li = dot.closest('[data-cui-step]');
        const next = { todo: 'doing', doing: 'done', done: 'todo' }[li.dataset.status] || 'todo';
        li.dataset.status = next; li.className = 'cui-step is-' + next;
        return;
      }

      const btn = t.closest('[data-cui-act]');
      if (!btn) return;
      const act = btn.dataset.cuiAct;

      if (act === 'ai') { ask(btn.dataset.prompt); return; }
      if (act === 'run') { ask('Run this code and show me the output:\n\n```' + (btn.dataset.lang || '') + '\n' + btn.dataset.code + '\n```'); return; }
      if (act === 'plandoc') { ask('Turn this plan into a document I can download:\n\n' + planText(btn.closest('.cui-node').querySelector('[data-cui-plan]'))); return; }
      if (act === 'addtask') {
        const ul = btn.parentElement.querySelector('ul');
        const li = document.createElement('li');
        li.innerHTML = '<label><input type="checkbox" data-cui-check><span contenteditable="plaintext-only" spellcheck="false">New task</span></label>';
        ul.appendChild(li);
        const span = li.querySelector('span');
        span.focus();
        const range = document.createRange(); range.selectNodeContents(span);
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
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
        ask((form.dataset.submitPrompt || ('Here is the completed form' + (form.dataset.formTitle ? ' "' + form.dataset.formTitle + '"' : '') + '.')) + '\n\n' + lines.join('\n'));
      }
    });
  });
}
