export const TEACHING_GUIDE_RECIPE = {
  resourceType: 'teaching_guide',
  requiredFields: ['subject', 'classLevel', 'topic'],
  optionalFields: ['curriculum', 'educationalLevel'],

  systemPrompt:
    'You are an expert teacher trainer creating a teaching guide for another ' +
    'teacher to follow. Generate it as a single JSON object and nothing else — ' +
    'no markdown fences, no commentary. Shape:\n' +
    '{\n' +
    '  "title": string,\n' +
    '  "topicOverview": string,\n' +
    '  "teachingSteps": [ { "step": number, "instruction": string, "tip": string } ],\n' +
    '  "commonStudentDifficulties": string[],\n' +
    '  "differentiationStrategies": string[],\n' +
    '  "suggestedResources": string[]\n' +
    '}\n' +
    'Step numbers must be sequential starting at 1. Do not wrap in code fences.',

  buildUserPrompt(fields) {
    let p = 'Create a teaching guide.\nSubject: ' + fields.subject + '\nClass: ' + fields.classLevel + '\nTopic: ' + fields.topic + '\n';
    if (fields.curriculum) p += 'Curriculum: ' + fields.curriculum + '\n';
    if (fields.educationalLevel) p += 'Educational level: ' + fields.educationalLevel + '\n';
    return p;
  },

  validate(c) {
    if (!c || typeof c !== 'object') return { ok: false, error: 'Invalid object.' };
    if (!c.title) return { ok: false, error: 'Missing title.' };
    if (!Array.isArray(c.teachingSteps) || c.teachingSteps.length === 0) return { ok: false, error: 'Missing teachingSteps.' };
    const nums = c.teachingSteps.map((s) => s.step).sort((a, b) => a - b);
    for (let i = 0; i < nums.length; i++) if (nums[i] !== i + 1) return { ok: false, error: 'Steps not sequential from 1.' };
    if (!Array.isArray(c.commonStudentDifficulties) || c.commonStudentDifficulties.length === 0) return { ok: false, error: 'Missing commonStudentDifficulties.' };
    if (!Array.isArray(c.differentiationStrategies) || c.differentiationStrategies.length === 0) return { ok: false, error: 'Missing differentiationStrategies.' };
    return { ok: true };
  },

  toPlainTextParagraphs(c) {
    const lines = [c.title, '', c.topicOverview, '', 'Teaching Steps'];
    c.teachingSteps.forEach((s) => lines.push(s.step + '. ' + s.instruction + (s.tip ? ' (Tip: ' + s.tip + ')' : '')));
    lines.push('', 'Common Student Difficulties');
    c.commonStudentDifficulties.forEach((d) => lines.push('- ' + d));
    lines.push('', 'Differentiation Strategies');
    c.differentiationStrategies.forEach((d) => lines.push('- ' + d));
    if (c.suggestedResources && c.suggestedResources.length) {
      lines.push('', 'Suggested Resources');
      c.suggestedResources.forEach((r) => lines.push('- ' + r));
    }
    return lines.join('\n\n');
  },
};
