// recipes/index.js
// Registry of available Resource Recipes. Adding a new resource type means
// creating recipes/<name>.js and adding one line here — nothing in
// resources-endpoint.js needs to change.

import { LESSON_PLAN_RECIPE } from './lesson-plan.js';

export const RECIPES = {
  lesson_plan: LESSON_PLAN_RECIPE,
};

export function getRecipe(resourceType) {
  return RECIPES[resourceType] || null;
}
