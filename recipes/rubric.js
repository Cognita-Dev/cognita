export const RUBRIC_RECIPE = {
  resourceType: 'rubric',
  requiredFields: ['subject', 'classLevel', 'topic'],
  optionalFields: ['performanceLevels', 'curriculum', 'educationalLevel'],

  systemPrompt:
    'You are an expert assessment designer creating a grading rubric. ' +
    'Generate it as a single JSON object and nothing else — no markdown ' +
    'fences, no commentary. Shape:\n' +
    '{\n' +
    '  "title": string,\n' +
    '  "performanceLevels": string[],\n' +
    '  "criteria": [ { "criterion": string, "descriptions": string[] } ]\n' +
    '}\n' +
    'Every "descriptions" array must have exactly the same length as ' +
    '"performanceLevels", in the same order (descriptions[i] describes ' +
    'performanceLevels[i] for that criterion). Do not wrap in code fences.',

  buildUserPrompt(fields) {
    let p = 'Create a grading rubric.\nSubject: ' + fields.subject + '\nClass: ' + fields.classLevel + '\nTask/topic: ' + fields.topic + '\n';
    p += 'Performance levels: ' + (fields.performanceLevels || 'Excellent, Good, Satisfactory, Needs Improvement') + '\n';
    if (fields.curriculum) p += 'Curriculum: ' + fields.curriculum + '\n';
    return p;
  },

  validate(c) {
    if (!c || typeof c !== 'object') return { ok: false, error: 'Invalid object.' };
    if (!c.title) return { ok: false, error: 'Missing title.' };
    if (!Array.isArray(c.performanceLevels) || c.performanceLevels.length === 0) return { ok: false, error: 'Missing performanceLevels.' };
    if (!Array.isArray(c.criteria) || c.criteria.length === 0) return { ok: false, error: 'Missing criteria.' };
    for (const crit of c.criteria) {
      if (!crit.criterion) return { ok: false, error: 'A criterion is missing its name.' };
      if (!Array.isArray(crit.descriptions) || crit.descriptions.length !== c.performanceLevels.length) {
        return { ok: false, error: 'Criterion "' + crit.criterion + '" descriptions do not match performanceLevels count.' };
      }
    }
    return { ok: true };
  },

  toPlainTextParagraphs(c) {
    const lines = [c.title, 'Levels: ' + c.performanceLevels.join(' | '), ''];
    c.criteria.forEach((crit) => {
      lines.push(crit.criterion);
      crit.descriptions.forEach((d, i) => lines.push('  ' + c.performanceLevels[i] + ': ' + d));
    });
    return lines.join('\n\n');
  },
};
