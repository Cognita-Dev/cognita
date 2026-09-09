// recipes/quiz.js
// Short multiple-choice quiz. Validation checks every question has exactly
// one correct option, and that the correct option's index actually exists
// in the options array.

export const QUIZ_RECIPE = {
  resourceType: 'quiz',

  requiredFields: ['subject', 'classLevel', 'topic'],
  optionalFields: ['questionCount', 'curriculum', 'educationalLevel'],

  systemPrompt:
    'You are an expert teacher creating a multiple-choice quiz. Generate the ' +
    'quiz as a single JSON object and nothing else — no markdown fences, no ' +
    'commentary before or after. The JSON object must have exactly this shape:\n' +
    '{\n' +
    '  "title": string,\n' +
    '  "questions": [\n' +
    '    {\n' +
    '      "number": number,\n' +
    '      "question": string,\n' +
    '      "options": string[],\n' +
    '      "correctOptionIndex": number\n' +
    '    }\n' +
    '  ]\n' +
    '}\n' +
    'Each question must have exactly 4 options. correctOptionIndex is ' +
    'zero-based and must point to a real index within that question\'s options ' +
    'array (0, 1, 2, or 3). Question numbers must be sequential starting at 1. ' +
    'Do not wrap the JSON in code fences.',

  buildUserPrompt(fields) {
    let prompt = 'Create a multiple-choice quiz.\n';
    prompt += 'Subject: ' + fields.subject + '\n';
    prompt += 'Class: ' + fields.classLevel + '\n';
    prompt += 'Topic: ' + fields.topic + '\n';
    prompt += 'Number of questions: ' + (fields.questionCount || 10) + '\n';
    if (fields.curriculum) prompt += 'Curriculum: ' + fields.curriculum + '\n';
    if (fields.educationalLevel) prompt += 'Educational level: ' + fields.educationalLevel + '\n';
    return prompt;
  },

  validate(content) {
    if (!content || typeof content !== 'object') {
      return { ok: false, error: 'Generated content was not a valid object.' };
    }
    if (!Array.isArray(content.questions) || content.questions.length === 0) {
      return { ok: false, error: 'Missing or empty questions array.' };
    }

    const numbers = content.questions.map((q) => q.number).sort((a, b) => a - b);
    for (let i = 0; i < numbers.length; i++) {
      if (numbers[i] !== i + 1) {
        return { ok: false, error: 'Question numbering is not sequential starting at 1.' };
      }
    }

    for (const q of content.questions) {
      if (!Array.isArray(q.options) || q.options.length !== 4) {
        return { ok: false, error: 'Question ' + q.number + ' does not have exactly 4 options.' };
      }
      if (typeof q.correctOptionIndex !== 'number' || q.correctOptionIndex < 0 || q.correctOptionIndex > 3) {
        return { ok: false, error: 'Question ' + q.number + ' has an invalid correctOptionIndex.' };
      }
    }

    return { ok: true };
  },

  toPlainTextParagraphs(content) {
    const lines = [];
    lines.push(content.title);
    content.questions.forEach((q) => {
      lines.push('');
      lines.push(q.number + '. ' + q.question);
      q.options.forEach((opt, i) => {
        const letter = String.fromCharCode(65 + i);
        lines.push(letter + ') ' + opt);
      });
    });
    lines.push('');
    lines.push('Answer Key');
    content.questions.forEach((q) => {
      lines.push(q.number + '. ' + String.fromCharCode(65 + q.correctOptionIndex));
    });
    return lines.join('\n\n');
  },
};
