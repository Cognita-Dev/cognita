// learna/courses-core.js
// Builders and shared constants for the Learna course data. Course content
// lives in learna/courses-*.js and is assembled by learna/courses.js.
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

// A teaching step: the learner reads, then continues.
export const teach = (id, phase, title, text, example = null) => ({
  id, kind: 'teach', phase, title, text: Array.isArray(text) ? text : [text], example,
});

// An activity step: the learner must answer and the server checks it.
export const activity = (id, phase, title, spec) => ({
  id, kind: 'activity', phase, title, required: true, maxAttempts: 3, hints: [], ...spec,
});

export const lesson = (id, title, objective, minutes, steps, rev = 1) => ({ id, rev, title, objective, minutes, steps });
export const section = (id, title, summary, lessons) => ({ id, title, summary, lessons });
