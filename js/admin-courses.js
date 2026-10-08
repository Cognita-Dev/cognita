// js/admin-courses.js
// Admin screens for Learna: the course editor and the task review queue. Loaded by admin.html.
// Everything here is only a convenience over the server. The Worker re-checks the admin role on every call and validates
// every course before it can be published (learna/validate.js), so nothing in this file is a security boundary.
const WORKER_URL = 'https://api.cognita.com.ng';
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LETTERS = 'abcdefghij';

async function api(path, opts = {}) {
  const res = await window.Auth.authedFetch(WORKER_URL + '/api/admin/learna' + path, { method: opts.method || 'GET', headers: opts.body ? { 'Content-Type': 'application/json' } : undefined, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error || 'That did not work.'); e.status = res.status; e.data = data; throw e; }
  return data;
}

const C = { view: 'list', list: null, id: null, draft: null, meta: null, problems: [], sec: 0, les: 0, step: null, msg: null, err: null, busy: false, dirty: false };
const R = { items: null, msg: null, err: null, loaded: {} };
const root = () => document.getElementById('acRoot');
const rroot = () => document.getElementById('arRoot');

// ── helpers for path-based binding ──
const getp = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
function setp(o, p, v) { const k = p.split('.'); const last = k.pop(); const t = k.reduce((a, x) => a[x], o); t[last] = v; }
const val = (path, def = '') => { const v = getp(C.draft, path); return v == null ? def : v; };
const lines = (arr) => (arr || []).join('\n');
const toLines = (t) => String(t).split('\n').map((x) => x.trim()).filter(Boolean);

function field(label, path, kind = 'text', opts = {}) {
  const v = val(path);
  const id = 'f_' + path.replace(/\./g, '_');
  const attr = `data-bind="${esc(path)}" data-kind="${kind}"`;
  let ctl;
  if (kind === 'area' || kind === 'lines' || kind === 'paras' || kind === 'rubric' || kind === 'opts' || kind === 'pairs') {
    const text = kind === 'lines' ? lines(v) : kind === 'paras' ? (v || []).join('\n\n') : kind === 'rubric' ? (v || []).map((r) => r.id + ' | ' + r.label).join('\n') : kind === 'opts' ? (v || []).map((o) => o.text).join('\n') : kind === 'pairs' ? (v || []).map((p) => p.left + ' | ' + p.right).join('\n') : v;
    ctl = `<textarea id="${id}" ${attr} rows="${opts.rows || 3}">${esc(text)}</textarea>`;
  } else if (kind === 'select') ctl = `<select id="${id}" ${attr}>${opts.options.map(([k, n]) => `<option value="${esc(k)}" ${String(v) === String(k) ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
  else if (kind === 'bool') return `<label class="ac-check"><input type="checkbox" ${attr} ${v ? 'checked' : ''}> ${esc(label)}</label>`;
  else if (kind === 'csv') ctl = `<input id="${id}" type="text" ${attr} value="${esc((v || []).join(', '))}">`;
  else ctl = `<input id="${id}" type="${kind === 'num' ? 'number' : 'text'}" ${attr} value="${esc(v)}" ${kind === 'num' ? 'step="any"' : ''}>`;
  return `<div class="ac-field"><label for="${id}">${esc(label)}</label>${ctl}${opts.help ? `<p class="ac-help">${esc(opts.help)}</p>` : ''}</div>`;
}

function applyBind(el) {
  const path = el.dataset.bind, kind = el.dataset.kind; let v = el.value;
  if (kind === 'bool') v = el.checked;
  else if (kind === 'num') v = v === '' ? 0 : Number(v);
  else if (kind === 'lines') v = toLines(v);
  else if (kind === 'csv') v = String(v).split(',').map((x) => x.trim()).filter(Boolean);
  else if (kind === 'paras') v = String(v).split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
  else if (kind === 'rubric') v = toLines(v).map((l, i) => { const [a, ...b] = l.split('|'); return b.length ? { id: a.trim().replace(/[^A-Za-z0-9_-]/g, '') || 'c' + (i + 1), label: b.join('|').trim() } : { id: 'c' + (i + 1), label: l }; });
  else if (kind === 'pairs') v = toLines(v).map((l) => { const [a, ...b] = l.split('|'); return { left: a.trim(), right: b.join('|').trim() }; });
  else if (kind === 'opts') { const old = getp(C.draft, path) || []; v = toLines(v).map((t, i) => ({ id: LETTERS[i], text: t })); const stepPath = path.replace(/\.options$/, ''); const ans = getp(C.draft, stepPath + '.answer'); if (!v.some((o) => o.id === ans)) setp(C.draft, stepPath + '.answer', v[0] ? v[0].id : 'a'); void old; }
  else if (kind === 'select' && /^(true|false)$/.test(v) && el.dataset.bool) v = v === 'true';
  else if (kind === 'select' && el.dataset.num) v = Number(v);
  setp(C.draft, path, v); C.dirty = true;
  const b = document.getElementById('acDirty'); if (b) b.hidden = false;
}

// ── list view ──
function tag(s) { return `<span class="ac-tag ac-tag--${esc(s)}">${esc({ published: 'Published', draft: 'Draft', unpublished: 'Unpublished' }[s] || s)}</span>`; }
function listView() {
  const rows = (C.list || []).map((c) => `<tr><td><strong>${esc(c.title)}</strong><br><span class="ac-help">${esc(c.id)}${c.builtIn ? ' · built in' : ''}${c.edited ? ' · edited' : ''}</span></td><td>${tag(c.status)}${c.hasUnpublishedChanges ? ' <span class="ac-tag ac-tag--warn">Unpublished changes</span>' : ''}</td><td>${esc(c.version || '-')}</td><td>${c.lessons}</td>
    <td class="ac-actions"><button class="admin-btn admin-btn--ghost" data-ac="edit" data-id="${esc(c.id)}">Edit</button>${c.status === 'published' ? `<button class="admin-btn admin-btn--ghost" data-ac="unpublish" data-id="${esc(c.id)}">Unpublish</button>` : `<button class="admin-btn admin-btn--ghost" data-ac="publish" data-id="${esc(c.id)}">Publish</button>`}<button class="admin-btn admin-btn--ghost" data-ac="copy" data-id="${esc(c.id)}">Copy</button></td></tr>`).join('');
  root().innerHTML = `<div class="admin-panel-head"><h2>Learna courses</h2><button class="admin-btn admin-btn--primary" data-ac="new">New course</button></div>
    ${C.msg ? `<p class="ac-msg" role="status">${esc(C.msg)}</p>` : ''}${C.err ? `<p class="ac-err" role="alert">${esc(C.err)}</p>` : ''}
    <p class="ac-help">Learners only ever see the published version. Editing saves a draft. Built-in courses can be improved here too: your edited version replaces the built-in one when you publish, and you can revert to the original at any time.</p>
    <div class="ac-tablewrap"><table class="ac-table"><thead><tr><th>Course</th><th>Status</th><th>Version</th><th>Lessons</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="5">No courses yet.</td></tr>'}</tbody></table></div>`;
}

// ── editor view ──
const STEP_TYPES = [['teach', 'Teaching text'], ['choice', 'Multiple choice'], ['fill', 'Fill in the blank'], ['open', 'Written answer (marked by AI against a checklist)'], ['assignment', 'Task for submission (written, recorded or video)'], ['speak', 'Say it aloud (practice)'], ['order', 'Put in order'], ['match', 'Match pairs'], ['code', 'JavaScript coding task']];
function newStep(kind, n) {
  const id = (kind === 'teach' ? 't' : 'a') + (n + 1);
  const base = { id, kind: kind === 'teach' ? 'teach' : 'activity', phase: kind === 'teach' ? 'explanation' : 'guided', title: 'New step' };
  if (kind === 'teach') return { ...base, text: ['Write the explanation here.'], example: null };
  const act = { ...base, required: true, maxAttempts: 3, hints: [], prompt: 'Write the question or instruction here.' };
  if (kind === 'choice') return { ...act, type: 'choice', options: [{ id: 'a', text: 'Right answer' }, { id: 'b', text: 'Wrong answer' }], answer: 'a', why: {}, explain: 'Explain why the answer is right.' };
  if (kind === 'fill') return { ...act, type: 'fill', accept: ['answer'], explain: 'Explain the answer.' };
  if (kind === 'open') return { ...act, type: 'open', mode: 'writing', minWords: 10, minCriteria: 1, rubric: [{ id: 'c1', label: 'The answer does this.' }], exemplar: 'A model answer.', explain: 'What a good answer contains.' };
  if (kind === 'order') return { ...act, type: 'order', items: ['First', 'Second', 'Third'], explain: 'Why this order.' };
  if (kind === 'match') return { ...act, type: 'match', pairs: [{ left: 'A', right: '1' }, { left: 'B', right: '2' }], explain: 'Why these match.' };
  if (kind === 'speak') return { ...act, type: 'speak', graded: false, mode: 'repeat', target: 'Say this sentence.', lang: 'en-NG', maxAttempts: 5 };
  if (kind === 'code') return { ...act, type: 'code', language: 'javascript', starter: 'function example(n) {\n  // your code here\n}\n', tests: [{ name: 'example(1)', expr: 'example(1)', expect: 1 }], hidden: [{ expr: 'example(2)', expect: 2 }], mustDefine: ['example'], solution: 'function example(n) { return n; }', explain: 'What the solution does.' };
  return { ...act, type: 'assignment', format: 'text', review: 'admin', certRequired: true, minWords: 20, rubric: [], metricRules: [], checklist: [], reviewGuide: 'What the reviewer should look for.' };
}

function stepForm(st, base) {
  const f = (l, p, k, o) => field(l, base + '.' + p, k, o);
  const head = f('Title', 'title', 'text');
  if (st.kind === 'teach') return head + f('Teaching text (leave a blank line between paragraphs)', 'text', 'paras', { rows: 7, help: 'Put [[word]] around a word to give it a pronunciation speaker button.' }) + f('Example label (optional)', 'example.label', 'text') + f('Example text (optional)', 'example.text', 'area', { rows: 4 }) + visualForm(st, base);
  const common = head + f('Prompt', 'prompt', 'area', { rows: 3 }) + f('Tries allowed', 'maxAttempts', 'num') + f('Hints, one per line (shown one at a time)', 'hints', 'lines', { rows: 2 });
  if (st.type === 'choice') return common + f('Options, one per line', 'options', 'opts', { rows: 4 }) + f('Correct option', 'answer', 'select', { options: (st.options || []).map((o) => [o.id, o.id.toUpperCase() + ': ' + o.text.slice(0, 40)]) }) + f('Explanation (shown when right)', 'explain', 'area') + visualForm(st, base);
  if (st.type === 'fill') return common + f('Accepted answers, one per line', 'accept', 'lines') + f('Explanation', 'explain', 'area');
  if (st.type === 'open') return common + f('Checklist: one line per point, as "id | what the answer must do"', 'rubric', 'rubric', { rows: 4 }) + f('Points needed to pass', 'minCriteria', 'num') + f('Minimum words', 'minWords', 'num') + f('Model answer (shown only when tries run out)', 'exemplar', 'area') + f('Explanation', 'explain', 'area') + f('Learners may dictate this answer', 'voice', 'bool');
  if (st.type === 'speak') return head + f('Prompt', 'prompt', 'area') + f('Text to say aloud', 'target', 'area') + f('Language code (en-NG or fr-FR)', 'lang', 'text');
  if (st.type === 'order') return common + f('Items in the CORRECT order, one per line', 'items', 'lines', { rows: 4 }) + f('Explanation', 'explain', 'area');
  if (st.type === 'match') return common + f('Pairs, one per line as "left | right"', 'pairs', 'pairs', { rows: 4 }) + f('Explanation', 'explain', 'area');
  if (st.type === 'assignment') return common + f('Format', 'format', 'select', { options: [['text', 'Written'], ['audio', 'Voice recording'], ['video', 'Video recording'], ['code', 'JavaScript project']] }) + f('Who reviews it', 'review', 'select', { options: [['auto', 'Marked automatically'], ['admin', 'A person reviews it'], ['both', 'Automatic check, then a person']] }) + f('Needed for the certificate', 'certRequired', 'bool') + (['audio', 'video'].includes(st.format) ? f('Shortest recording (seconds)', 'minSeconds', 'num') + f('Longest recording (seconds)', 'maxSeconds', 'num') : f('Minimum words', 'minWords', 'num')) + f('Checklist (rubric), one line per point as "id | label"', 'rubric', 'rubric', { rows: 3 }) + f('Tips shown before the learner starts, one per line', 'checklist', 'lines', { rows: 2 }) + f('Guidance for the reviewer', 'reviewGuide', 'area') + '<p class="ac-help">Pace and filler-word rules and code tests for tasks are set in "Edit this step as JSON".</p>';
  return common + '<p class="ac-help">Use "Edit this step as JSON" for the tests and solution of coding tasks.</p>';
}
function visualForm(st, base) {
  return `<details class="ac-details"><summary>Picture (optional)</summary>${field('Picture path, such as /assets/learna/js/loop.png', base + '.visual.src', 'text')}${field('Description for people who cannot see it (required with a picture)', base + '.visual.alt', 'text')}${field('Caption', base + '.visual.caption', 'text')}<p class="ac-help">Upload the image to the repository under assets/learna/ first. Clear the path to remove the picture.</p></details>`;
}

function editorView() {
  const d = C.draft, secs = d.sections;
  if (C.sec >= secs.length) C.sec = Math.max(0, secs.length - 1);
  const sec = secs[C.sec]; if (C.les >= (sec ? sec.lessons.length : 0)) C.les = 0;
  const les = sec && sec.lessons[C.les];
  const base = `sections.${C.sec}.lessons.${C.les}`;
  const stepSel = les && C.step != null && les.steps[C.step] ? les.steps[C.step] : null;
  const outline = secs.map((s, si) => `<li class="ac-sec ${si === C.sec ? 'is-on' : ''}"><div class="ac-row"><button class="ac-link" data-ac="pick-sec" data-i="${si}">${esc(s.title || 'Section ' + (si + 1))}</button><span><button class="ac-mini" data-ac="sec-up" data-i="${si}" aria-label="Move section up">↑</button><button class="ac-mini" data-ac="sec-down" data-i="${si}" aria-label="Move section down">↓</button><button class="ac-mini" data-ac="sec-del" data-i="${si}" aria-label="Delete section">✕</button></span></div>
    <ul>${s.lessons.map((l, li) => `<li class="ac-les ${si === C.sec && li === C.les ? 'is-on' : ''}"><div class="ac-row"><button class="ac-link" data-ac="pick-les" data-s="${si}" data-i="${li}">${esc(l.title || 'Lesson')}${l.exam ? ' (assessment)' : ''}</button><span><button class="ac-mini" data-ac="les-up" data-s="${si}" data-i="${li}" aria-label="Move lesson up">↑</button><button class="ac-mini" data-ac="les-down" data-s="${si}" data-i="${li}" aria-label="Move lesson down">↓</button><button class="ac-mini" data-ac="les-del" data-s="${si}" data-i="${li}" aria-label="Delete lesson">✕</button></span></div></li>`).join('')}<li><button class="ac-add" data-ac="les-add" data-s="${si}">+ Add lesson</button></li></ul></li>`).join('');
  const steps = les ? les.steps.map((st, k) => `<li class="ac-step ${k === C.step ? 'is-on' : ''}"><div class="ac-row"><button class="ac-link" data-ac="pick-step" data-i="${k}">${k + 1}. ${esc(st.title || st.kind)} <span class="ac-help">${esc(st.kind === 'teach' ? 'teach' : st.type)}</span></button><span><button class="ac-mini" data-ac="st-up" data-i="${k}" aria-label="Move step up">↑</button><button class="ac-mini" data-ac="st-down" data-i="${k}" aria-label="Move step down">↓</button><button class="ac-mini" data-ac="st-del" data-i="${k}" aria-label="Delete step">✕</button></span></div></li>`).join('') : '';
  root().innerHTML = `<div class="admin-panel-head"><div><button class="admin-btn admin-btn--ghost" data-ac="back">Back to courses</button> <strong class="ac-title">${esc(d.title)}</strong> ${tag(C.meta.status)}<span id="acDirty" class="ac-tag ac-tag--warn" ${C.dirty ? '' : 'hidden'}>Not saved</span></div>
      <div class="ac-actions"><button class="admin-btn admin-btn--ghost" data-ac="save" ${C.busy ? 'disabled' : ''}>Save draft</button><button class="admin-btn admin-btn--primary" data-ac="publish-now" ${C.busy ? 'disabled' : ''}>Save and publish</button>${C.meta.status === 'published' ? '<button class="admin-btn admin-btn--ghost" data-ac="unpublish-now">Unpublish</button>' : ''}${C.meta.builtIn && C.meta.hasDoc ? '<button class="admin-btn admin-btn--danger" data-ac="revert">Revert to original</button>' : ''}${!C.meta.builtIn && C.meta.status !== 'published' ? '<button class="admin-btn admin-btn--danger" data-ac="delete">Delete</button>' : ''}</div></div>
    ${C.msg ? `<p class="ac-msg" role="status">${esc(C.msg)}</p>` : ''}${C.err ? `<p class="ac-err" role="alert">${esc(C.err)}</p>` : ''}
    ${C.problems.length ? `<div class="ac-problems" role="alert"><strong>${C.problems.length} thing${C.problems.length === 1 ? '' : 's'} to fix before this can be published:</strong><ul>${C.problems.slice(0, 12).map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>` : ''}
    <details class="ac-details" ${C.detailsOpen ? 'open' : ''}><summary data-ac="toggle-details">Course details</summary><div class="ac-grid">
      ${field('Title', 'title')}${field('Short description', 'shortDescription', 'area')}${field('Full description', 'fullDescription', 'area', { rows: 4 })}
      ${field('Category', 'category', 'select', { options: [['languages', 'Languages'], ['public-speaking', 'Public Speaking'], ['coding', 'Coding'], ['ui-ux', 'UI/UX'], ['sales-marketing', 'Sales & Marketing']] })}${field('Level', 'level', 'select', { options: ['Beginner', 'Intermediate', 'Advanced'].map((x) => [x, x]) })}${field('Who can start it', 'access', 'select', { options: [['plus', 'Plus and above'], ['studio', 'Studio and above'], ['admin', 'Admins only']] })}
      ${field('Estimated time (words)', 'estimatedDuration')}${field('Estimated minutes', 'estimatedMinutes', 'num')}${field('Who the course is for', 'whoFor', 'area')}${field('Prerequisites, one per line', 'prerequisites', 'lines')}${field('Learning outcomes, one per line', 'learningOutcomes', 'lines', { rows: 5 })}${field('Skills, comma separated', 'skills', 'csv')}${field('Practical work', 'practical', 'area')}${field('How learners are assessed', 'assessment', 'area')}
      ${field('Mastery needed in each lesson (0.5 to 1)', 'masteryThreshold', 'num')}${field('This course issues a certificate', 'certificate.enabled', 'bool')}${field('Certificate title', 'certificate.title')}</div></details>
    <div class="ac-cols"><nav class="ac-outline" aria-label="Course outline"><ul>${outline}</ul><button class="ac-add" data-ac="sec-add">+ Add section</button></nav>
      <div class="ac-main">${les ? `<h3>${esc(sec.title)}: ${esc(les.title)}</h3><div class="ac-grid">${field('Section title', `sections.${C.sec}.title`)}${field('Lesson title', base + '.title')}${field('Objective ("By the end of this lesson, you can ...")', base + '.objective', 'area')}${field('Minutes', base + '.minutes', 'num')}${field('This is an assessment lesson (no hints, stricter pass mark)', base + '.exam', 'bool')}</div>
        <h4>Steps</h4><ul class="ac-steps">${steps}</ul><div class="ac-addrow"><select id="acNewType">${STEP_TYPES.map(([k, n]) => `<option value="${k}">${esc(n)}</option>`).join('')}</select><button class="admin-btn admin-btn--ghost" data-ac="st-add">Add step</button></div>
        ${stepSel ? `<div class="ac-stepform"><h4>Step ${C.step + 1}</h4>${stepForm(stepSel, base + '.steps.' + C.step)}<details class="ac-details"><summary>Edit this step as JSON (advanced)</summary><textarea id="acJson" rows="14" spellcheck="false">${esc(JSON.stringify(stepSel, null, 2))}</textarea><button class="admin-btn admin-btn--ghost" data-ac="json-apply">Apply JSON</button></details></div>` : '<p class="ac-help">Pick a step to edit it.</p>'}` : '<p>Add a lesson to begin.</p>'}</div></div>`;
}

function render() { if (!root()) return; if (C.view === 'list') listView(); else editorView(); }

async function loadList() {
  try { C.list = (await api('/courses')).courses; C.err = null; } catch (e) { C.err = e.status === 403 ? 'You need to be an admin to manage courses.' : e.message; C.list = C.list || []; }
  render();
}
async function openCourse(id) {
  try { const r = await api('/courses/' + encodeURIComponent(id)); C.id = id; C.draft = r.course; C.meta = { status: r.status, builtIn: r.builtIn, hasDoc: r.dirty || r.status !== 'published' || true }; C.problems = r.problems || []; C.sec = 0; C.les = 0; C.step = null; C.dirty = false; C.view = 'edit'; C.msg = null; C.err = null; render(); }
  catch (e) { C.err = e.message; render(); }
}
async function save(publishAfter) {
  C.busy = true; C.err = null; C.msg = null; render();
  try {
    const r = await api('/courses/' + encodeURIComponent(C.id), { method: 'PUT', body: { course: C.draft } });
    C.problems = r.problems || []; C.dirty = false; C.msg = C.problems.length ? 'Saved as a draft. Fix the items below before publishing.' : 'Saved.';
    if (publishAfter) {
      if (C.problems.length) C.err = 'Not published: ' + C.problems[0];
      else { const p = await api('/courses/' + encodeURIComponent(C.id) + '/publish', { method: 'POST' }); C.meta.status = 'published'; C.msg = 'Published as version ' + p.version + (p.lessonsChanged ? '. ' + p.lessonsChanged + ' changed lesson' + (p.lessonsChanged === 1 ? '' : 's') + ' will be repeated by learners who already did them.' : '.'); }
    }
  } catch (e) { C.err = e.data && e.data.errors ? e.data.errors.slice(0, 3).join(' ') : e.message; if (e.data && e.data.errors) C.problems = e.data.errors; }
  C.busy = false; render();
}

function mutate(fn) { fn(); C.dirty = true; render(); }
async function onClick(e) {
  const b = e.target.closest('[data-ac]'); if (!b || !root().contains(b)) return;
  const a = b.dataset.ac, i = +b.dataset.i, s = +b.dataset.s;
  const sec = C.draft && C.draft.sections[C.sec];
  const les = sec && sec.lessons[C.les];
  const move = (arr, from, to) => { if (to < 0 || to >= arr.length) return; const [x] = arr.splice(from, 1); arr.splice(to, 0, x); };
  if (a === 'new') { const id = prompt('A short id for the course: lowercase letters, numbers and dashes, for example intro-to-sales'); if (!id) return; const title = prompt('Course title'); if (!title) return; try { await api('/courses', { method: 'POST', body: { id: id.trim(), title } }); await loadList(); await openCourse(id.trim()); } catch (er) { C.err = er.message; render(); } return; }
  if (a === 'copy') { const id = prompt('A new id for the copy (lowercase letters, numbers, dashes)'); if (!id) return; try { await api('/courses', { method: 'POST', body: { id: id.trim(), cloneFrom: b.dataset.id, title: undefined } }); await loadList(); await openCourse(id.trim()); } catch (er) { C.err = er.message; render(); } return; }
  if (a === 'edit') return openCourse(b.dataset.id);
  if (a === 'publish' || a === 'unpublish') { try { const r = await api('/courses/' + encodeURIComponent(b.dataset.id) + '/' + a, { method: 'POST' }); C.msg = a === 'publish' ? 'Published as version ' + r.version + '.' : 'Unpublished. Learners already enrolled can still finish it.'; C.err = null; } catch (er) { C.err = er.message; C.msg = null; } return loadList(); }
  if (a === 'back') { if (C.dirty && !confirm('You have unsaved changes. Leave without saving?')) return; C.view = 'list'; C.msg = null; return loadList(); }
  if (a === 'save') return save(false);
  if (a === 'publish-now') return save(true);
  if (a === 'unpublish-now') { try { await api('/courses/' + encodeURIComponent(C.id) + '/unpublish', { method: 'POST' }); C.meta.status = 'unpublished'; C.msg = 'Unpublished.'; } catch (er) { C.err = er.message; } return render(); }
  if (a === 'revert') { if (!confirm('Throw away every edit and go back to the original built-in course?')) return; try { await api('/courses/' + encodeURIComponent(C.id) + '/revert', { method: 'POST' }); C.view = 'list'; C.msg = 'Reverted to the original.'; } catch (er) { C.err = er.message; } return loadList(); }
  if (a === 'delete') { if (!confirm('Delete this draft course for good?')) return; try { await fetchDelete(C.id); C.view = 'list'; C.msg = 'Deleted.'; } catch (er) { C.err = er.message; render(); return; } return loadList(); }
  if (a === 'toggle-details') { C.detailsOpen = !C.detailsOpen; return; }
  if (a === 'pick-sec') return mutateNoDirty(() => { C.sec = i; C.les = 0; C.step = null; });
  if (a === 'pick-les') return mutateNoDirty(() => { C.sec = s; C.les = i; C.step = null; });
  if (a === 'pick-step') return mutateNoDirty(() => { C.step = i; });
  if (a === 'sec-add') return mutate(() => { const n = C.draft.sections.length + 1; C.draft.sections.push({ id: 's' + n, title: 'Section ' + n, summary: '', lessons: [{ id: 'l1', rev: 1, title: 'Lesson 1', objective: 'By the end of this lesson, you can ...', minutes: 15, steps: [newStep('teach', 0)] }] }); C.sec = n - 1; C.les = 0; C.step = null; });
  if (a === 'sec-del') return mutate(() => { if (C.draft.sections.length > 1 && confirm('Delete this section and its lessons?')) { C.draft.sections.splice(i, 1); C.sec = 0; C.les = 0; C.step = null; } });
  if (a === 'sec-up') return mutate(() => move(C.draft.sections, i, i - 1)); if (a === 'sec-down') return mutate(() => move(C.draft.sections, i, i + 1));
  if (a === 'les-add') return mutate(() => { const ls = C.draft.sections[s].lessons; const n = ls.length + 1; let id = 'l' + n; while (ls.some((x) => x.id === id)) id += 'x'; ls.push({ id, rev: 1, title: 'Lesson ' + n, objective: 'By the end of this lesson, you can ...', minutes: 15, steps: [newStep('teach', 0)] }); C.sec = s; C.les = ls.length - 1; C.step = null; });
  if (a === 'les-del') return mutate(() => { const ls = C.draft.sections[s].lessons; if (ls.length > 1 && confirm('Delete this lesson?')) { ls.splice(i, 1); C.les = 0; C.step = null; } });
  if (a === 'les-up') return mutate(() => move(C.draft.sections[s].lessons, i, i - 1)); if (a === 'les-down') return mutate(() => move(C.draft.sections[s].lessons, i, i + 1));
  if (a === 'st-add') return mutate(() => { const kind = document.getElementById('acNewType').value; const st = newStep(kind, les.steps.length); let id = st.id, n = les.steps.length + 1; while (les.steps.some((x) => x.id === id)) id = st.id.charAt(0) + (++n); st.id = id; les.steps.push(st); C.step = les.steps.length - 1; });
  if (a === 'st-del') return mutate(() => { if (les.steps.length > 1 && confirm('Delete this step?')) { les.steps.splice(i, 1); C.step = null; } });
  if (a === 'st-up') return mutate(() => { move(les.steps, i, i - 1); C.step = Math.max(0, i - 1); }); if (a === 'st-down') return mutate(() => { move(les.steps, i, i + 1); C.step = Math.min(les.steps.length - 1, i + 1); });
  if (a === 'json-apply') { try { const o = JSON.parse(document.getElementById('acJson').value); if (!o || typeof o !== 'object' || !o.id || !o.kind) throw new Error('The step needs an id and a kind.'); les.steps[C.step] = o; C.dirty = true; C.err = null; } catch (er) { C.err = 'That JSON could not be used: ' + er.message; } return render(); }
}
async function fetchDelete(id) { const res = await window.Auth.authedFetch(WORKER_URL + '/api/admin/learna/courses/' + encodeURIComponent(id), { method: 'DELETE' }); const j = await res.json().catch(() => ({})); if (!res.ok) throw new Error(j.error || 'Could not delete.'); }
function mutateNoDirty(fn) { fn(); render(); }

// ── task reviews ──
function mediaBox(s) { return s.hasMedia ? `<div class="ar-media" data-media="${esc(s.id)}"><button class="admin-btn admin-btn--ghost" data-ar="load" data-id="${esc(s.id)}" data-type="${esc(s.mediaType || '')}">Load ${s.format === 'video' ? 'video' : 'recording'}</button></div>` : ''; }
function reviewView() {
  const items = R.items || [];
  rroot().innerHTML = `<div class="admin-panel-head"><h2>Tasks waiting for review</h2><button class="admin-btn admin-btn--ghost" data-ar="refresh">Refresh</button></div>
    ${R.msg ? `<p class="ac-msg" role="status">${esc(R.msg)}</p>` : ''}${R.err ? `<p class="ac-err" role="alert">${esc(R.err)}</p>` : ''}
    ${items.length ? items.map((s) => `<article class="ar-card" data-sub="${esc(s.id)}"><div class="ar-head"><strong>${esc(s.taskTitle)}</strong><span class="ac-help">${esc(s.courseId)} · ${esc(s.lessonTitle)} · ${esc(s.format)} · attempt ${s.attempt} · ${esc(new Date(s.createdAt).toLocaleString())} · learner ${esc(String(s.uid).slice(0, 8))}</span></div>
      ${mediaBox(s)}${s.format === 'code' ? `<pre class="ar-code">${esc(s.text || '')}</pre>${(s.flags || []).length ? `<p class="ac-err">Automatic scan: ${esc(s.flags.join('; '))}</p>` : ''}` : s.text ? `<p class="ar-text">${esc(s.text)}</p>` : ''}
      ${s.transcript ? `<details class="ac-details"><summary>Transcript made by the server</summary><p>${esc(s.transcript)}</p></details>` : ''}
      ${s.metrics ? `<p class="ac-help">${s.metrics.words} words · ${s.metrics.wpm} per minute · ${s.metrics.fillerTotal} filler words</p>` : ''}
      ${s.checklist ? `<ul class="ar-list">${s.checklist.map((c) => `<li>${c.met ? '✓' : '✗'} ${esc(c.label)}</li>`).join('')}</ul>` : ''}
      <label class="ac-field"><span>Note to the learner (required when asking for changes)</span><textarea rows="3" data-ar-note="${esc(s.id)}"></textarea></label>
      <div class="ac-actions"><button class="admin-btn admin-btn--primary" data-ar="approve" data-id="${esc(s.id)}">Approve</button><button class="admin-btn admin-btn--ghost" data-ar="changes" data-id="${esc(s.id)}">Ask for changes</button></div></article>`).join('') : '<p class="ac-help">Nothing is waiting. New submissions appear here.</p>'}`;
}
async function loadReviews() {
  try { R.items = (await api('/submissions?status=pending')).submissions; R.err = null; } catch (e) { R.err = e.message; R.items = R.items || []; }
  reviewView();
}
async function onReviewClick(e) {
  const b = e.target.closest('[data-ar]'); if (!b) return; const a = b.dataset.ar, id = b.dataset.id;
  if (a === 'refresh') return loadReviews();
  if (a === 'load') {
    b.disabled = true; b.textContent = 'Loading';
    try { const res = await window.Auth.authedFetch(WORKER_URL + '/api/learna/submissions/' + id + '/media'); if (!res.ok) throw new Error('The recording could not be loaded.'); const url = URL.createObjectURL(await res.blob()); const box = b.parentElement; box.innerHTML = (b.dataset.type || '').startsWith('video') ? `<video controls playsinline class="ar-video" src="${url}"></video>` : `<audio controls class="ar-audio" src="${url}"></audio>`; }
    catch (er) { b.disabled = false; b.textContent = er.message; }
    return;
  }
  if (a === 'approve' || a === 'changes') {
    const note = (rroot().querySelector('[data-ar-note="' + id + '"]') || {}).value || '';
    try { await api('/submissions/' + id + '/review', { method: 'POST', body: { decision: a === 'approve' ? 'approve' : 'changes', note } }); R.msg = a === 'approve' ? 'Approved. The learner has been told if they allow notifications.' : 'Sent back with your note.'; R.err = null; await loadReviews(); }
    catch (er) { R.err = er.message; reviewView(); }
  }
}

function init() {
  if (!root()) return;
  root().addEventListener('click', onClick);
  root().addEventListener('input', (e) => { if (e.target.dataset && e.target.dataset.bind) applyBind(e.target); });
  root().addEventListener('change', (e) => { if (e.target.dataset && e.target.dataset.bind) { applyBind(e.target); if (e.target.dataset.kind === 'select' || e.target.dataset.kind === 'opts' || e.target.dataset.bind.endsWith('.format') || e.target.dataset.bind.endsWith('.title')) render(); } });
  rroot().addEventListener('click', onReviewClick);
  document.addEventListener('admin:section', (e) => { if (e.detail === 'courses') { if (C.view === 'list') loadList(); } if (e.detail === 'reviews') loadReviews(); });
  window.addEventListener('beforeunload', (e) => { if (C.dirty) { e.preventDefault(); e.returnValue = ''; } });
  if ((location.hash || '') === '#courses') loadList();
  if ((location.hash || '') === '#reviews') loadReviews();
}
init();
