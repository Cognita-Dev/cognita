export const ASSIGNMENT_RECIPE = {
  resourceType: 'assignment',
  requiredFields: ['subject', 'classLevel', 'topic'],
  optionalFields: ['dueInDays', 'curriculum', 'educationalLevel'],

  systemPrompt:
    'You are an expert teacher creating a homework assignment. Generate it as ' +
    'a single JSON object and nothing else — no markdown fences, no ' +
    'commentary. Shape:\n' +
    '{\n' +
    '  "title": string,\n' +
    '  "instructions": string,\n' +
    '  "tasks": [ { "number": number, "description": string } ],\n' +
    '  "submissionGuidelines": string,\n' +
    '  "gradingCriteria": string[]\n' +
    '}\n' +
    'Task numbers sequential starting at 1. Do not wrap in code fences.',

  buildUserPrompt(fields) {
    let p = 'Create an assignment.\nSubject: ' + fields.subject + '\nClass: ' + fields.classLevel + '\nTopic: ' + fields.topic + '\n';
    if (fields.dueInDays) p += 'Due in: ' + fields.dueInDays + ' days\n';
    if (fields.curriculum) p += 'Curriculum: ' + fields.curriculum + '\n';
    return p;
  },

  validate(c) {
    if (!c || typeof c !== 'object') return { ok: false, error: 'Invalid object.' };
    if (!c.title || !c.instructions) return { ok: false, error: 'Missing title or instructions.' };
    if (!Array.isArray(c.tasks) || c.tasks.length === 0) return { ok: false, error: 'Missing tasks.' };
    const nums = c.tasks.map((t) => t.number).sort((a, b) => a - b);
    for (let i = 0; i < nums.length; i++) if (nums[i] !== i + 1) return { ok: false, error: 'Tasks not sequential from 1.' };
    if (!Array.isArray(c.gradingCriteria) || c.gradingCriteria.length === 0) return { ok: false, error: 'Missing gradingCriteria.' };
    return { ok: true };
  },

  toPlainTextParagraphs(c) {
    const lines = [c.title, '', c.instructions, '', 'Tasks'];
    c.tasks.forEach((t) => lines.push(t.number + '. ' + t.description));
    lines.push('', 'Submission Guidelines', c.submissionGuidelines, '', 'Grading Criteria');
    c.gradingCriteria.forEach((g) => lines.push('- ' + g));
    return lines.join('\n\n');
  },
};
