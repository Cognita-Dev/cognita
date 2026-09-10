export const CLASSROOM_ACTIVITY_RECIPE = {
  resourceType: 'classroom_activity',
  requiredFields: ['subject', 'classLevel', 'topic'],
  optionalFields: ['duration', 'groupSize', 'curriculum', 'educationalLevel'],

  systemPrompt:
    'You are an expert teacher designing an engaging classroom activity. ' +
    'Generate it as a single JSON object and nothing else — no markdown ' +
    'fences, no commentary. Shape:\n' +
    '{\n' +
    '  "title": string,\n' +
    '  "objective": string,\n' +
    '  "materials": string[],\n' +
    '  "setupInstructions": string,\n' +
    '  "steps": [ { "step": number, "instruction": string } ],\n' +
    '  "wrapUpDiscussion": string[]\n' +
    '}\n' +
    'Step numbers sequential starting at 1. Do not wrap in code fences.',

  buildUserPrompt(fields) {
    let p = 'Create a classroom activity.\nSubject: ' + fields.subject + '\nClass: ' + fields.classLevel + '\nTopic: ' + fields.topic + '\n';
    if (fields.duration) p += 'Duration: ' + fields.duration + '\n';
    if (fields.groupSize) p += 'Group size: ' + fields.groupSize + '\n';
    if (fields.curriculum) p += 'Curriculum: ' + fields.curriculum + '\n';
    return p;
  },

  validate(c) {
    if (!c || typeof c !== 'object') return { ok: false, error: 'Invalid object.' };
    if (!c.title || !c.objective) return { ok: false, error: 'Missing title or objective.' };
    if (!Array.isArray(c.materials) || c.materials.length === 0) return { ok: false, error: 'Missing materials.' };
    if (!Array.isArray(c.steps) || c.steps.length === 0) return { ok: false, error: 'Missing steps.' };
    const nums = c.steps.map((s) => s.step).sort((a, b) => a - b);
    for (let i = 0; i < nums.length; i++) if (nums[i] !== i + 1) return { ok: false, error: 'Steps not sequential from 1.' };
    if (!Array.isArray(c.wrapUpDiscussion) || c.wrapUpDiscussion.length === 0) return { ok: false, error: 'Missing wrapUpDiscussion.' };
    return { ok: true };
  },

  toPlainTextParagraphs(c) {
    const lines = [c.title, '', c.objective, '', 'Materials'];
    c.materials.forEach((m) => lines.push('- ' + m));
    lines.push('', 'Setup', c.setupInstructions, '', 'Steps');
    c.steps.forEach((s) => lines.push(s.step + '. ' + s.instruction));
    lines.push('', 'Wrap-Up Discussion');
    c.wrapUpDiscussion.forEach((q) => lines.push('- ' + q));
    return lines.join('\n\n');
  },
};
