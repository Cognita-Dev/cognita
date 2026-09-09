// recipes/worksheet.js
// Worksheet resource type. Unlike Lesson Plan, this schema centers on a
// list of questions plus an answer key — validation checks that the
// answer key actually has one entry per question, since a mismatched
// count is the most common way this resource type goes wrong.

export const WORKSHEET_RECIPE = {
  resourceType: 'worksheet',

  requiredFields: ['subject', 'classLevel', 'topic'],
  optionalFields: ['questionCount', 'difficulty', 'curriculum', 'educationalLevel'],

  systemPrompt:
    'You are an expert teacher creating a student worksheet. Generate the ' +
    'worksheet as a single JSON object and nothing else — no markdown fences, ' +
    'no commentary before or after. The JSON object must have exactly this shape:\n' +
    '{\n' +
    '  "title": string,\n' +
    '  "instructions": string,\n' +
    '  "questions": [ { "number": number, "question": string, "type": string } ],\n' +
    '  "answerKey": [ { "number": number, "answer": string } ]\n' +
    '}\n' +
    'The "questions" array and "answerKey" array must have exactly the same ' +
    'length, and each question\'s "number" must have a matching entry in ' +
    'answerKey with the same "number". Question numbering must start at 1 and ' +
    'be sequential with no gaps or repeats. "type" should be a short label such ' +
    'as "short answer", "multiple choice", or "fill in the blank". Content must ' +
    'be age-appropriate for the given class level and match the requested ' +
    'difficulty if one is given. Do not wrap the JSON in code fences.',

  buildUserPrompt(fields) {
    let prompt = 'Create a worksheet.\n';
    prompt += 'Subject: ' + fields.subject + '\n';
    prompt += 'Class: ' + fields.classLevel + '\n';
    prompt += 'Topic: ' + fields.topic + '\n';
    prompt += 'Number of questions: ' + (fields.questionCount || 10) + '\n';
    if (fields.difficulty) prompt += 'Difficulty: ' + fields.difficulty + '\n';
    if (fields.curriculum) prompt += 'Curriculum: ' + fields.curriculum + '\n';
    if (fields.educationalLevel) prompt += 'Educational level: ' + fields.educationalLevel + '\n';
    return prompt;
  },

  validate(content) {
    if (!content || typeof content !== 'object') {
      return { ok: false, error: 'Generated content was not a valid object.' };
    }
    if (typeof content.title !== 'string' || !content.title.trim()) {
      return { ok: false, error: 'Missing title.' };
    }
    if (typeof content.instructions !== 'string' || !content.instructions.trim()) {
      return { ok: false, error: 'Missing instructions.' };
    }
    if (!Array.isArray(content.questions) || content.questions.length === 0) {
      return { ok: false, error: 'Missing or empty questions array.' };
    }
    if (!Array.isArray(content.answerKey) || content.answerKey.length === 0) {
      return { ok: false, error: 'Missing or empty answerKey array.' };
    }
    if (content.questions.length !== content.answerKey.length) {
      return { ok: false, error: 'Question count (' + content.questions.length + ') does not match answer key count (' + content.answerKey.length + ').' };
    }

    const questionNumbers = content.questions.map((q) => q.number).sort((a, b) => a - b);
    const answerNumbers = content.answerKey.map((a) => a.number).sort((a, b) => a - b);

    for (let i = 0; i < questionNumbers.length; i++) {
      if (questionNumbers[i] !== i + 1) {
        return { ok: false, error: 'Question numbering is not sequential starting at 1.' };
      }
      if (answerNumbers[i] !== i + 1) {
        return { ok: false, error: 'Answer key numbering does not match question numbering.' };
      }
    }

    for (const q of content.questions) {
      if (typeof q.question !== 'string' || !q.question.trim()) {
        return { ok: false, error: 'A question is missing its text.' };
      }
    }
    for (const a of content.answerKey) {
      if (typeof a.answer !== 'string' || !a.answer.trim()) {
        return { ok: false, error: 'An answer key entry is missing its answer.' };
      }
    }

    return { ok: true };
  },

  toPlainTextParagraphs(content) {
    const lines = [];
    lines.push(content.title);
    lines.push('');
    lines.push(content.instructions);
    lines.push('');
    content.questions.forEach((q) => {
      lines.push(q.number + '. ' + q.question);
    });
    lines.push('');
    lines.push('Answer Key');
    content.answerKey
      .slice()
      .sort((a, b) => a.number - b.number)
      .forEach((a) => {
        lines.push(a.number + '. ' + a.answer);
      });
    return lines.join('\n\n');
  },
};
