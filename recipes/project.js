export const PROJECT_RECIPE = {
  resourceType: 'project',
  requiredFields: ['subject', 'classLevel', 'topic'],
  optionalFields: ['duration', 'curriculum', 'educationalLevel'],

  systemPrompt:
    'You are an expert teacher designing a student project. Generate it as a ' +
    'single JSON object and nothing else — no markdown fences, no commentary. ' +
    'Shape:\n' +
    '{\n' +
    '  "title": string,\n' +
    '  "overview": string,\n' +
    '  "learningOutcomes": string[],\n' +
    '  "milestones": [ { "milestoneNumber": number, "description": string, "suggestedTimeframe": string } ],\n' +
    '  "deliverables": string[],\n' +
    '  "assessmentCriteria": string[]\n' +
    '}\n' +
    'milestoneNumber sequential starting at 1. Do not wrap in code fences.',

  buildUserPrompt(fields) {
    let p = 'Create a student project.\nSubject: ' + fields.subject + '\nClass: ' + fields.classLevel + '\nTopic: ' + fields.topic + '\n';
    if (fields.duration) p += 'Duration: ' + fields.duration + '\n';
    if (fields.curriculum) p += 'Curriculum: ' + fields.curriculum + '\n';
    return p;
  },

  validate(c) {
    if (!c || typeof c !== 'object') return { ok: false, error: 'Invalid object.' };
    if (!c.title || !c.overview) return { ok: false, error: 'Missing title or overview.' };
    if (!Array.isArray(c.learningOutcomes) || c.learningOutcomes.length === 0) return { ok: false, error: 'Missing learningOutcomes.' };
    if (!Array.isArray(c.milestones) || c.milestones.length === 0) return { ok: false, error: 'Missing milestones.' };
    const nums = c.milestones.map((m) => m.milestoneNumber).sort((a, b) => a - b);
    for (let i = 0; i < nums.length; i++) if (nums[i] !== i + 1) return { ok: false, error: 'Milestones not sequential from 1.' };
    if (!Array.isArray(c.deliverables) || c.deliverables.length === 0) return { ok: false, error: 'Missing deliverables.' };
    if (!Array.isArray(c.assessmentCriteria) || c.assessmentCriteria.length === 0) return { ok: false, error: 'Missing assessmentCriteria.' };
    return { ok: true };
  },

  toPlainTextParagraphs(c) {
    const lines = [c.title, '', c.overview, '', 'Learning Outcomes'];
    c.learningOutcomes.forEach((o) => lines.push('- ' + o));
    lines.push('', 'Milestones');
    c.milestones.forEach((m) => lines.push(m.milestoneNumber + '. ' + m.description + ' (' + m.suggestedTimeframe + ')'));
    lines.push('', 'Deliverables');
    c.deliverables.forEach((d) => lines.push('- ' + d));
    lines.push('', 'Assessment Criteria');
    c.assessmentCriteria.forEach((a) => lines.push('- ' + a));
    return lines.join('\n\n');
  },
};
