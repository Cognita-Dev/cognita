// learna/validate.js
// The safety net for admin-edited courses. Nothing is stored or published until validateCourse() returns no errors,
// so a typing mistake in the editor can never produce a course that breaks the learner screens or the checkers.
import { ACTIVITY_TYPES, CATEGORIES } from './courses-core.js';

const SLUG = /^[a-z0-9][a-z0-9-]{1,60}$/;
const ID = /^[A-Za-z0-9_-]{1,24}$/;
const LEVELS = ['Beginner', 'Intermediate', 'Advanced', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const PLANS = ['plus', 'studio', 'admin'];
const FORMATS = ['text', 'audio', 'video', 'file', 'code'];
const REVIEWS = ['auto', 'admin', 'both'];
const MAX_BYTES = 700 * 1024; // a Firestore document is limited to 1 MB

export const emptyCourse = (id, title = 'New course') => ({
  id, title, shortDescription: '', fullDescription: '', category: 'coding', level: 'Beginner', estimatedDuration: '1 hour', estimatedMinutes: 60,
  whoFor: '', prerequisites: ['None'], learningOutcomes: [''], skills: [], practical: '', assessment: 'Questions are checked exactly. A lesson is complete when you pass at least 70% of its activities without being shown the answer.',
  modes: [], access: 'plus', status: 'available', featured: false, version: '0.1.0', masteryThreshold: 0.7, references: [], certificate: { enabled: false, title: '' },
  sections: [{ id: 's1', title: 'Section 1', summary: '', lessons: [{ id: 'l1', rev: 1, title: 'Lesson 1', objective: 'By the end of this lesson, you can ...', minutes: 15, steps: [{ id: 't1', kind: 'teach', phase: 'explanation', title: 'Introduction', text: [''], example: null }] }] }],
});

const isStr = (v, min = 1, max = 4000) => typeof v === 'string' && v.trim().length >= min && v.length <= max;
const isArr = (v, min = 0, max = 200) => Array.isArray(v) && v.length >= min && v.length <= max;

function checkVisual(v, where, err) {
  if (v == null) return;
  if (typeof v !== 'object') return err(where + ': visual must be an object.');
  if (!isStr(v.src, 5, 200) || !/^\/assets\/learna\/[A-Za-z0-9_\-./]+\.(png|svg|jpg|jpeg|webp)$/.test(v.src) || v.src.includes('..')) err(where + ': visual.src must be a path such as /assets/learna/js/loop.png.');
  if (!isStr(v.alt, 5, 300)) err(where + ': a visual needs alt text (at least 5 characters) so the picture can be described to learners who cannot see it.');
  if (v.hotspots != null) {
    if (!isArr(v.hotspots, 0, 12)) err(where + ': hotspots must be a list of up to 12.');
    else v.hotspots.forEach((h, i) => { if (!(h && h.x >= 0 && h.x <= 100 && h.y >= 0 && h.y <= 100 && isStr(h.label, 1, 60) && isStr(h.text, 1, 400))) err(where + ': hotspot ' + (i + 1) + ' needs x and y (0 to 100), a label and text.'); });
  }
}

function checkRubric(r, where, err, required = true) {
  if (!isArr(r, required ? 1 : 0, 10)) return err(where + ': needs ' + (required ? 'at least one' : 'a list of') + ' rubric criteria.');
  const ids = new Set();
  r.forEach((c, i) => {
    if (!c || !ID.test(c.id || '') || !isStr(c.label, 3, 200)) err(where + ': rubric item ' + (i + 1) + ' needs a short id and a label.');
    else if (ids.has(c.id)) err(where + ': duplicate rubric id ' + c.id + '.');
    else ids.add(c.id);
  });
}

function checkTests(st, where, err) {
  if (!isArr(st.tests, 1, 12)) return err(where + ': a code task needs 1 to 12 visible tests.');
  st.tests.forEach((t, i) => { if (!(t && isStr(t.name, 1, 200) && isStr(t.expr, 1, 400) && 'expect' in t)) err(where + ': test ' + (i + 1) + ' needs a name, an expression and an expected value.'); });
  if (st.hidden != null) {
    if (!isArr(st.hidden, 0, 20)) err(where + ': hidden cases must be a list of up to 20.');
    else st.hidden.forEach((t, i) => { if (!(t && isStr(t.expr, 1, 400) && 'expect' in t)) err(where + ': hidden case ' + (i + 1) + ' needs an expression and an expected value.'); });
  }
  if (!isStr(st.starter, 0, 6000) && st.starter !== '') err(where + ': starter code must be text.');
  if (!isStr(st.solution, 1, 8000)) err(where + ': a reference solution is required so the course can be checked.');
}

/** Returns { ok, errors, warnings }. Never throws. */
export function validateCourse(c) {
  const errors = [], warnings = [];
  const err = (m) => { if (errors.length < 60) errors.push(m); };
  if (!c || typeof c !== 'object') return { ok: false, errors: ['The course is empty.'], warnings };
  let size = 0; try { size = JSON.stringify(c).length; } catch (_) { return { ok: false, errors: ['The course contains data that cannot be saved.'], warnings }; }
  if (size > MAX_BYTES) err('The course is too large (' + Math.round(size / 1024) + ' KB). Split it into two courses.');
  if (!SLUG.test(c.id || '')) err('The course id must be lowercase letters, numbers and dashes, such as intro-to-sales.');
  if (!isStr(c.title, 3, 120)) err('Give the course a title (3 to 120 characters).');
  if (!isStr(c.shortDescription, 10, 240)) err('Write a short description (10 to 240 characters).');
  if (!isStr(c.fullDescription, 20, 3000)) err('Write a full description (at least 20 characters).');
  if (!CATEGORIES.some((x) => x.id === c.category)) err('Choose a valid category.');
  if (!LEVELS.includes(c.level)) err('Choose a valid level.');
  if (!PLANS.includes(c.access)) err('Access must be plus, studio or admin.');
  if (!isStr(c.estimatedDuration, 1, 40) || !(c.estimatedMinutes > 0 && c.estimatedMinutes < 20000)) err('Give an estimated duration, and minutes as a number.');
  if (!isStr(c.whoFor, 5, 600)) err('Say who the course is for.');
  if (!isArr(c.prerequisites, 1, 12) || c.prerequisites.some((x) => !isStr(x, 1, 200))) err('List at least one prerequisite (write "None" if there are none).');
  if (!isArr(c.learningOutcomes, 1, 16) || c.learningOutcomes.some((x) => !isStr(x, 3, 200))) err('List at least one learning outcome.');
  if (!isArr(c.skills, 0, 20)) err('Skills must be a list.');
  if (!isStr(c.practical, 5, 800)) err('Describe the practical work.');
  if (!isStr(c.assessment, 5, 1200)) err('Describe how learners are assessed.');
  if (!(c.masteryThreshold >= 0.5 && c.masteryThreshold <= 1)) err('The mastery threshold must be between 0.5 and 1.');
  if (!/^\d+\.\d+\.\d+$/.test(c.version || '')) err('The version must look like 1.0.0.');
  if (c.language && !(isStr(c.language.target, 2, 40) && isStr(c.language.explanation, 2, 40))) err('A language course needs a target and an explanation language.');
  if (c.cover) checkVisual({ src: c.cover, alt: 'cover' }, 'cover', err);
  if (!isArr(c.sections, 1, 30)) return { ok: false, errors: [...errors, 'A course needs at least one section.'], warnings };

  const secIds = new Set(); let lessons = 0, certTasks = 0, anyAdminReview = false;
  c.sections.forEach((s, si) => {
    const sw = 'Section ' + (si + 1);
    if (!ID.test(s.id || '') || secIds.has(s.id)) err(sw + ': needs a unique id.'); else secIds.add(s.id);
    if (!isStr(s.title, 2, 120)) err(sw + ': needs a title.');
    if (typeof s.summary !== 'string' || s.summary.length > 400) err(sw + ': the summary must be text under 400 characters.');
    if (!isArr(s.lessons, 1, 40)) return err(sw + ': needs at least one lesson.');
    const lids = new Set();
    s.lessons.forEach((l, li) => {
      lessons++;
      const lw = sw + ', lesson ' + (li + 1);
      if (!ID.test(l.id || '') || lids.has(l.id)) err(lw + ': needs a unique id.'); else lids.add(l.id);
      if (!isStr(l.title, 2, 140)) err(lw + ': needs a title.');
      if (!isStr(l.objective, 10, 400)) err(lw + ': needs an objective.');
      if (!(l.minutes > 0 && l.minutes <= 600)) err(lw + ': minutes must be between 1 and 600.');
      if (!(Number.isInteger(l.rev) && l.rev >= 1)) err(lw + ': rev must be a whole number from 1.');
      if (l.threshold != null && !(l.threshold >= 0.5 && l.threshold <= 1)) err(lw + ': threshold must be between 0.5 and 1.');
      if (!isArr(l.steps, 1, 60)) return err(lw + ': needs at least one step.');
      const stepIds = new Set(); let graded = 0;
      l.steps.forEach((st, k) => {
        const w = lw + ', step ' + (k + 1);
        if (!ID.test(st.id || '') || stepIds.has(st.id)) err(w + ': needs a unique id.'); else stepIds.add(st.id);
        if (!isStr(st.title, 1, 160)) err(w + ': needs a title.');
        checkVisual(st.visual, w, err);
        if (st.kind === 'teach') {
          if (!isArr(st.text, 1, 20) || st.text.some((t) => !isStr(t, 1, 2500))) err(w + ': teaching text must be 1 to 20 paragraphs of text.');
          if (st.example != null && !(st.example && isStr(st.example.label, 1, 80) && isStr(st.example.text, 1, 3000))) err(w + ': an example needs a label and text.');
          return;
        }
        if (st.kind !== 'activity') return err(w + ': kind must be teach or activity.');
        if (!ACTIVITY_TYPES.includes(st.type)) return err(w + ': unknown activity type ' + st.type + '.');
        if (!isStr(st.prompt, 3, 3000)) err(w + ': needs a prompt.');
        if (!(Number.isInteger(st.maxAttempts) && st.maxAttempts >= 1 && st.maxAttempts <= 10)) err(w + ': maxAttempts must be 1 to 10.');
        if (st.graded !== false) graded++;
        if (st.type === 'choice') {
          if (!isArr(st.options, 2, 8) || st.options.some((o) => !(o && ID.test(o.id || '') && isStr(o.text, 1, 400)))) err(w + ': a choice needs 2 to 8 options with ids and text.');
          else if (!st.options.some((o) => o.id === st.answer)) err(w + ': the answer must be the id of one option.');
          if (!isStr(st.explain, 1, 800)) err(w + ': needs an explanation.');
        } else if (st.type === 'fill') {
          if (!isArr(st.accept, 1, 20) || st.accept.some((a) => !isStr(a, 1, 200))) err(w + ': needs at least one accepted answer.');
          if (!isStr(st.explain, 1, 800)) err(w + ': needs an explanation.');
        } else if (st.type === 'order') {
          if (!isArr(st.items, 2, 10) || new Set(st.items).size !== st.items.length) err(w + ': needs 2 to 10 different items in the correct order.');
          if (!isStr(st.explain, 1, 800)) err(w + ': needs an explanation.');
        } else if (st.type === 'match') {
          if (!isArr(st.pairs, 2, 8) || st.pairs.some((p) => !(p && isStr(p.left, 1, 200) && isStr(p.right, 1, 200)))) err(w + ': needs 2 to 8 pairs.');
          else if (new Set(st.pairs.map((p) => p.left)).size !== st.pairs.length) err(w + ': every left side must be different.');
          if (!isStr(st.explain, 1, 800)) err(w + ': needs an explanation.');
        } else if (st.type === 'open') {
          checkRubric(st.rubric, w, err);
          if (!isStr(st.exemplar, 1, 2000)) err(w + ': needs a model answer (shown only after the learner runs out of tries).');
          if (!(st.minWords >= 1 && st.minWords <= 500)) err(w + ': minWords must be 1 to 500.');
        } else if (st.type === 'code') {
          checkTests(st, w, err);
          if (!isStr(st.explain, 1, 800)) err(w + ': needs an explanation.');
        } else if (st.type === 'speak') {
          if (!isStr(st.target, 1, 400)) err(w + ': needs the text to say aloud.');
          if (st.graded !== false) err(w + ': speaking practice must have graded set to false.');
        } else if (st.type === 'assignment') {
          if (!FORMATS.includes(st.format)) err(w + ': format must be one of ' + FORMATS.join(', ') + '.');
          if (!REVIEWS.includes(st.review)) err(w + ': review must be auto, admin or both.');
          if (st.review !== 'admin' && st.format !== 'code' && !((st.rubric || []).length || (st.metricRules || []).length)) err(w + ': automatic marking needs a rubric or measurement rules.');
          if (st.rubric && st.rubric.length) checkRubric(st.rubric, w, err, false);
          if (st.format === 'code') checkTests(st, w, err);
          if (['audio', 'video'].includes(st.format) && !(st.maxSeconds > 0 && st.maxSeconds <= 600)) err(w + ': recorded tasks need maxSeconds up to 600.');
          if (st.format === 'video' && st.review === 'auto') err(w + ': video cannot be marked automatically. Use admin review.');
          if (st.certRequired) certTasks++;
          if (st.review !== 'auto') anyAdminReview = true;
        }
      });
      if (!graded) warnings.push(lw + ': has no graded activity, so it is complete as soon as the learner reaches the end.');
    });
  });
  if (!lessons) err('A course needs at least one lesson.');
  if (c.certificate && c.certificate.enabled) {
    if (!isStr(c.certificate.title, 3, 120)) err('Give the certificate a title.');
    if (!certTasks && !c.sections.some((s) => s.lessons.some((l) => l.exam))) warnings.push('The certificate has no required task or final assessment. A certificate that only needs the learner to click through lessons is weak. Add a final assessment lesson or a required task.');
  }
  void anyAdminReview;
  return { ok: !errors.length, errors, warnings };
}
