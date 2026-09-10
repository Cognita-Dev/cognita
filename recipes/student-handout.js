export const STUDENT_HANDOUT_RECIPE = {
  resourceType: 'student_handout',
  requiredFields: ['subject', 'classLevel', 'topic'],
  optionalFields: ['curriculum', 'educationalLevel'],

  systemPrompt:
    'You are an expert teacher creating a one-page student handout ' +
    'summarizing a topic. Generate it as a single JSON object and nothing ' +
    'else — no markdown fences, no commentary. Shape:\n' +
    '{\n' +
    '  "title": string,\n' +
    '  "introduction": string,\n' +
    '  "keyPoints": string[],\n' +
    '  "diagramDescription": string,\n' +
    '  "checkYourUnderstanding": string[]\n' +
    '}\n' +
    '"diagramDescription" should describe what a supporting diagram would ' +
    'show, in words, since no image is generated here. Do not wrap in code fences.',

  buildUserPrompt(fields) {
    let p = 'Create a student handout.\nSubject: ' + fields.subject + '\nClass: ' + fields.classLevel + '\nTopic: ' + fields.topic + '\n';
    if (fields.curriculum) p += 'Curriculum: ' + fields.curriculum + '\n';
    return p;
  },

  validate(c) {
    if (!c || typeof c !== 'object') return { ok: false, error: 'Invalid object.' };
    if (!c.title || !c.introduction) return { ok: false, error: 'Missing title or introduction.' };
    if (!Array.isArray(c.keyPoints) || c.keyPoints.length === 0) return { ok: false, error: 'Missing keyPoints.' };
    if (!Array.isArray(c.checkYourUnderstanding) || c.checkYourUnderstanding.length === 0) return { ok: false, error: 'Missing checkYourUnderstanding.' };
    return { ok: true };
  },

  toPlainTextParagraphs(c) {
    const lines = [c.title, '', c.introduction, '', 'Key Points'];
    c.keyPoints.forEach((k) => lines.push('- ' + k));
    if (c.diagramDescription) lines.push('', 'Diagram', c.diagramDescription);
    lines.push('', 'Check Your Understanding');
    c.checkYourUnderstanding.forEach((q, i) => lines.push((i + 1) + '. ' + q));
    return lines.join('\n\n');
  },
};
