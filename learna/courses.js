// learna/courses.js
// Assembles the catalogue. To add a course, create its file and list it here.
import { CATEGORIES } from './courses-core.js';
import { french } from './courses-french.js';
import { javascript } from './courses-js.js';
import { speaking } from './courses-speaking.js';
import { uiux, sales } from './courses-soft.js';

export { CATEGORIES };
export const COURSES = [french, javascript, speaking, uiux, sales];
export const COURSE_MAP = Object.fromEntries(COURSES.map((c) => [c.id, c]));
