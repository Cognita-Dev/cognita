// learna/courses-core.js
// Builders and shared constants for the Learna course data. Course content
// lives in learna/courses-*.js and is assembled by learna/courses.js. Courses
// created in the admin editor have the same shape and are stored in Firestore
// (see learna/course-store.js).
// This data is the ONLY instructional authority: the tutor, the checkers and
// the progress rules all read from it. Nothing here is sent to the browser
// without first passing through learna/engine.js (publicLesson / publicCourse),
// which strips answer keys.

export const CATEGORIES = [
  { id: 'languages', name: 'Languages' },
  { id: 'public-speaking', name: 'Public Speaking' },
  { id: 'coding', name: 'Coding & Programming' },
  { id: 'ui-ux', name: 'UI/UX Design' },
  { id: 'sales-marketing', name: 'Sales & Marketing' },
];

// Lesson phases, in the order a lesson normally moves through them.
export const PHASES = ['introduction', 'explanation', 'example', 'guided', 'attempt', 'independent', 'checkpoint', 'reflection'];

// Every activity type the engine understands.
export const ACTIVITY_TYPES = ['choice', 'fill', 'order', 'match', 'open', 'code', 'speak', 'assignment'];

// A picture or diagram shown with a teaching step. `src` is a repository path under /assets/learna/.
// `hotspots` (optional) are tappable points: x and y are percentages of the image width and height.
export const visual = (src, alt, caption, hotspots = []) => ({ src, alt, caption, hotspots });

// A teaching step: the learner reads, then continues.
// extra.visual: a visual() block. extra.listen: true shows a "Listen" button that reads the step aloud.
// In text, [[word]] shows the word with a small speaker button that pronounces only that word.
export const teach = (id, phase, title, text, example = null, extra = {}) => ({
  id, kind: 'teach', phase, title, text: Array.isArray(text) ? text : [text], example, ...extra,
});

// An activity step: the learner must answer and the server checks it.
export const activity = (id, phase, title, spec) => ({
  id, kind: 'activity', phase, title, required: true, maxAttempts: 3, hints: [], ...spec,
});

const LETTERS = 'abcdefghij';

// choice(id, phase, title, prompt, ['opt A', 'opt B', ...], correctIndex, explain, { why: {0: '...'}, hints: [...] })
export const choice = (id, phase, title, prompt, options, answerIndex, explain, extra = {}) => {
  const why = {};
  for (const [i, t] of Object.entries(extra.why || {})) why[LETTERS[+i]] = t;
  const { why: _w, ...rest } = extra;
  return activity(id, phase, title, {
    type: 'choice', prompt, options: options.map((text, i) => ({ id: LETTERS[i], text })), answer: LETTERS[answerIndex], why, explain, ...rest,
  });
};

// fill(id, phase, title, prompt, ['accepted', ...], explain, { hints })
export const fill = (id, phase, title, prompt, accept, explain, extra = {}) =>
  activity(id, phase, title, { type: 'fill', prompt, accept, explain, ...extra });

// A visible test (the learner can read the expression) and a hidden one (only the expression is sent, at run time).
export const T = (expr, expect, name) => ({ name: name || expr, expr, expect });
export const H = (expr, expect) => ({ expr, expect });

// codeTask: tests are shown to the learner (expressions only). `hidden` is a pool of extra cases; two are picked at random
// for every run, so a result cannot be replayed. `mustDefine` lists names the code must declare.
export const codeTask = (id, phase, title, spec) => activity(id, phase, title, { type: 'code', language: 'javascript', hidden: [], mustDefine: [], ...spec });

// A speaking practice step. Practice only: it never blocks progress and is not part of mastery.
// mode 'repeat' = hear it, then say it. 'read' = read the target aloud. lang is a BCP-47 tag such as fr-FR or en-NG.
export const speakTask = (id, phase, title, prompt, target, extra = {}) =>
  activity(id, phase, title, { type: 'speak', graded: false, mode: 'repeat', prompt, target, lang: 'en-NG', maxAttempts: 5, ...extra });

// A real task: written, recorded voice, recorded video, or a file or link. review: 'auto' (marked at once from the rubric),
// 'admin' (a person reviews it) or 'both'. certRequired: must be passed or approved before a certificate is issued.
export const assignment = (id, phase, title, spec) =>
  activity(id, phase, title, { type: 'assignment', format: 'text', review: 'auto', certRequired: true, minWords: 1, maxAttempts: 3, ...spec });

// lesson(id, title, objective, minutes, steps, rev, { exam: true, threshold: 0.75 })
export const lesson = (id, title, objective, minutes, steps, rev = 1, opts = {}) => ({ id, rev, title, objective, minutes, steps, ...opts });
export const section = (id, title, summary, lessons) => ({ id, title, summary, lessons });
