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

export const RECIPES = {
  lesson_plan: LESSON_PLAN_RECIPE,
  worksheet: WORKSHEET_RECIPE,
  exam: EXAM_RECIPE,
  scheme_of_work: SCHEME_OF_WORK_RECIPE,
  quiz: QUIZ_RECIPE,
  study_guide: STUDY_GUIDE_RECIPE,
};

export function getRecipe(resourceType) {
  return RECIPES[resourceType] || null;
}

// Used by the frontend to build the "choose a resource type" list without
// hard-coding labels in resources.js.
export const RECIPE_LABELS = {
  lesson_plan: 'Lesson Plan',
  worksheet: 'Worksheet',
  exam: 'Examination',
  scheme_of_work: 'Scheme of Work',
  quiz: 'Quiz',
  study_guide: 'Study Guide',
};
