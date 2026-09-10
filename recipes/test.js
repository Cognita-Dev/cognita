// A shorter, lower-stakes counterpart to Exam — same shape/validation
// pattern (marks must reconcile) but framed as a quick in-class test
// rather than a formal examination.

export const TEST_RECIPE = {
  resourceType: 'test',
  requiredFields: ['subject', 'classLevel', 'topic'],
  optionalFields: ['duration', 'totalMarks', 'curriculum', 'educationalLevel'],

  systemPrompt:
    'You are an expert teacher creating a short in-class test. Generate it as ' +
    'a single JSON object and nothing else — no markdown fences, no ' +
    'commentary. Shape:\n' +
    '{\n' +
    '  "title": string,\n' +
    '  "instructions": string,\n' +
    '  "durationMinutes": number,\n' +
    '  "totalMarks": number,\n' +
    '  "questions": [ { "number": number, "question": string, "marks": number } ],\n' +
    '  "answerKey": [ { "number": number, "answer": string } ]\n' +
    '}\n' +
    'Question numbers sequential starting at 1. Sum of all "marks" must equal ' +
    'totalMarks exactly. answerKey must have one entry per question, matching ' +
    'by number. Do not wrap in code fences.',

  buildUserPrompt(fields) {
    let p = 'Create a short test.\nSubject: ' + fields.subject + '\nClass: ' + fields.classLevel + '\nTopic: ' + fields.topic + '\n';
    p += 'Duration: ' + (fields.duration || '20 minutes') + '\n';
    p += 'Total marks: ' + (fields.totalMarks || 20) + '\n';
    if (fields.curriculum) p += 'Curriculum: ' + fields.curriculum + '\n';
    return p;
  },

  validate(c) {
    if (!c || typeof c !== 'object') return { ok: false, error: 'Invalid object.' };
    if (!c.title || typeof c.totalMarks !== 'number') return { ok: false, error: 'Missing title or totalMarks.' };
    if (!Array.isArray(c.questions) || c.questions.length === 0) return { ok: false, error: 'Missing questions.' };
    if (!Array.isArray(c.answerKey) || c.answerKey.length !== c.questions.length) {
      return { ok: false, error: 'Answer key count does not match question count.' };
    }
    const nums = c.questions.map((q) => q.number).sort((a, b) => a - b);
    for (let i = 0; i < nums.length; i++) if (nums[i] !== i + 1) return { ok: false, error: 'Questions not sequential from 1.' };
    const sum = c.questions.reduce((s, q) => s + (q.marks || 0), 0);
    if (sum !== c.totalMarks) return { ok: false, error: 'Marks sum to ' + sum + ' but totalMarks is ' + c.totalMarks + '.' };
    const answerNums = new Set(c.answerKey.map((a) => a.number));
    for (const n of nums) if (!answerNums.has(n)) return { ok: false, error: 'Answer key missing entry for question ' + n + '.' };
    return { ok: true };
  },

  toPlainTextParagraphs(c) {
    const lines = [c.title, 'Duration: ' + c.durationMinutes + ' min | Total Marks: ' + c.totalMarks, '', c.instructions, ''];
    c.questions.forEach((q) => lines.push(q.number + '. ' + q.question + ' (' + q.marks + ' marks)'));
    lines.push('', 'Answer Key');
    c.answerKey.slice().sort((a, b) => a.number - b.number).forEach((a) => lines.push(a.number + '. ' + a.answer));
    return lines.join('\n\n');
  },
};
