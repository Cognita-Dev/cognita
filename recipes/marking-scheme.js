export const MARKING_SCHEME_RECIPE = {
  resourceType: 'marking_scheme',
  requiredFields: ['subject', 'classLevel', 'topic'],
  optionalFields: ['totalMarks', 'curriculum', 'educationalLevel'],

  systemPrompt:
    'You are an expert examiner creating a standalone marking scheme document ' +
    '(for questions the teacher already has). Generate it as a single JSON ' +
    'object and nothing else — no markdown fences, no commentary. Shape:\n' +
    '{\n' +
    '  "title": string,\n' +
    '  "totalMarks": number,\n' +
    '  "criteria": [ { "number": number, "expectedAnswer": string, "marks": number, "markingNotes": string } ]\n' +
    '}\n' +
    'Numbers sequential starting at 1. The sum of every "marks" must equal ' +
    'totalMarks exactly. Do not wrap in code fences.',

  buildUserPrompt(fields) {
    let p = 'Create a marking scheme.\nSubject: ' + fields.subject + '\nClass: ' + fields.classLevel + '\nTopic: ' + fields.topic + '\n';
    p += 'Total marks: ' + (fields.totalMarks || 100) + '\n';
    if (fields.curriculum) p += 'Curriculum: ' + fields.curriculum + '\n';
    return p;
  },

  validate(c) {
    if (!c || typeof c !== 'object') return { ok: false, error: 'Invalid object.' };
    if (!c.title || typeof c.totalMarks !== 'number') return { ok: false, error: 'Missing title or totalMarks.' };
    if (!Array.isArray(c.criteria) || c.criteria.length === 0) return { ok: false, error: 'Missing criteria.' };
    const nums = c.criteria.map((x) => x.number).sort((a, b) => a - b);
    for (let i = 0; i < nums.length; i++) if (nums[i] !== i + 1) return { ok: false, error: 'Criteria not sequential from 1.' };
    const sum = c.criteria.reduce((s, x) => s + (x.marks || 0), 0);
    if (sum !== c.totalMarks) return { ok: false, error: 'Marks sum to ' + sum + ' but totalMarks is ' + c.totalMarks + '.' };
    return { ok: true };
  },

  toPlainTextParagraphs(c) {
    const lines = [c.title, 'Total Marks: ' + c.totalMarks, ''];
    c.criteria.forEach((x) => lines.push(x.number + '. ' + x.expectedAnswer + ' (' + x.marks + ' marks)' + (x.markingNotes ? ' — ' + x.markingNotes : '')));
    return lines.join('\n\n');
  },
};
