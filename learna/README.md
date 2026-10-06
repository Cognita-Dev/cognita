# Learna

Structured, course-aware learning inside Cognita. Route: `/app.html?view=learna`
(`&course=<id>` for a course page, `&lesson=<key>` for the workspace).

## Files

| File | Role |
| --- | --- |
| `learna/courses-*.js`, `learna/courses.js` | Course data. The only instructional authority. |
| `learna/engine.js` | Pure logic: public views, answer checking, lesson state machine, versioning, tutor prompts. |
| `learna-endpoint.js` | The `/api/learna/*` handler (auth, plan, course limit, storage, AI calls). |
| `js/learna.js`, `css/learna.css` | The view. Loaded lazily by `js/router.js`. |
| `entitlements.js` | `learnaCourses` and `learnaTutorPerDay` per plan. |

## Rules that matter

- **Access.** Any signed-in user can browse. Starting a course needs a plan with `learnaCourses > 0`
  (Plus 2, Studio and Admin unlimited). Admin follows the existing verified role in `resolveAccountWithRole`.
- **Course limit.** A course is "taken" while its `learna_progress/{uid}_{courseId}` record is `active`.
  On a limited plan each active course holds a `learna_slots/{uid}_{n}` document created with `fsCreate`,
  so parallel requests cannot pass the limit. Finishing a course frees its slot.
  If a plan is later downgraded, existing courses stay open; new ones are blocked.
- **No answers in the browser.** Answer keys, rubric exemplars, accepted answers and test expectations stay on the server.
- **Grading.** Choice, fill, order and match are checked deterministically. Code tasks run in the existing browser
  sandbox and the server compares the produced values with its own expectations. Open tasks use a rubric: the model
  only reports which criteria are met, and the server decides pass or fail.
- **Progress.** Advancing is validated against the stored position, so steps cannot be skipped. A lesson is mastered at
  `masteryThreshold` (default 70%) of activities passed without the answer being shown, otherwise it goes to review.
- **Versions.** Each course has a `version`; each lesson has a `rev`. On a version change, lessons whose `rev` changed are
  reset and the learner is told. Bump `rev` whenever a lesson's activities change meaningfully.
- **Tutor.** Its prompt is built from stored state (current lesson, steps already taught, attempts, mistakes). It receives
  an answer only after that answer has been shown to the learner. It cannot mark work or change progress.

## Adding a course

1. Create `learna/courses-<name>.js` using the builders in `courses-core.js`.
2. Add it to `COURSES` in `learna/courses.js` and, for a new category, to `CATEGORIES` in `courses-core.js`.
3. Run `node tests/learna.test.mjs`. For code tasks, check that every `solution` passes its own `tests`.
