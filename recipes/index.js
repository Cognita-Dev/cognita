// recipes/index.js
// Registry of available Resource Recipes. Adding a new resource type means
// creating recipes/<name>.js and adding one line here — nothing in
// resources-endpoint.js needs to change.

import { LESSON_PLAN_RECIPE } from './lesson-plan.js';
import { WORKSHEET_RECIPE } from './worksheet.js';
import { EXAM_RECIPE } from './exam.js';
import { SCHEME_OF_WORK_RECIPE } from './scheme-of-work.js';
import { QUIZ_RECIPE } from './quiz.js';
import { STUDY_GUIDE_RECIPE } from './study-guide.js';
import { TEACHING_GUIDE_RECIPE } from './teaching-guide.js';
import { CLASSROOM_ACTIVITY_RECIPE } from './classroom-activity.js';
import { ASSIGNMENT_RECIPE } from './assignment.js';
import { MARKING_SCHEME_RECIPE } from './marking-scheme.js';
import { RUBRIC_RECIPE } from './rubric.js';
import { FLASHCARDS_RECIPE } from './flashcards.js';
import { STUDENT_HANDOUT_RECIPE } from './student-handout.js';
import { PRESENTATION_RECIPE } from './presentation.js';
import { PROJECT_RECIPE } from './project.js';
import { TEST_RECIPE } from './test.js';

export const RECIPES = {
  lesson_plan: LESSON_PLAN_RECIPE,
  worksheet: WORKSHEET_RECIPE,
  exam: EXAM_RECIPE,
  scheme_of_work: SCHEME_OF_WORK_RECIPE,
  quiz: QUIZ_RECIPE,
  study_guide: STUDY_GUIDE_RECIPE,
  teaching_guide: TEACHING_GUIDE_RECIPE,
  classroom_activity: CLASSROOM_ACTIVITY_RECIPE,
  assignment: ASSIGNMENT_RECIPE,
  marking_scheme: MARKING_SCHEME_RECIPE,
  rubric: RUBRIC_RECIPE,
  flashcards: FLASHCARDS_RECIPE,
  student_handout: STUDENT_HANDOUT_RECIPE,
  presentation: PRESENTATION_RECIPE,
  project: PROJECT_RECIPE,
  test: TEST_RECIPE,
};

export function getRecipe(resourceType) {
  return RECIPES[resourceType] || null;
}

export const RECIPE_LABELS = {
  lesson_plan: 'Lesson Plan',
  worksheet: 'Worksheet',
  exam: 'Examination',
  scheme_of_work: 'Scheme of Work',
  quiz: 'Quiz',
  study_guide: 'Study Guide',
  teaching_guide: 'Teaching Guide',
  classroom_activity: 'Classroom Activity',
  assignment: 'Assignment',
  marking_scheme: 'Marking Scheme',
  rubric: 'Rubric',
  flashcards: 'Flashcards',
  student_handout: 'Student Handout',
  presentation: 'Presentation Slides',
  project: 'Project',
  test: 'Test',
};
