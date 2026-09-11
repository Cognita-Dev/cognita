// recipes/worksheet.js

export const WORKSHEET_RECIPE = {
  resourceType: 'worksheet',

  requiredFields: ['subject', 'classLevel', 'topic'],

  optionalFields: [
    'questionCount',
    'difficulty',
    'questionMix',
    'curriculum',
    'educationalLevel',
  ],

  systemPrompt:
    'You are an expert teacher creating a classroom worksheet. ' +
    'Generate one JSON object and nothing else. No markdown fences. ' +
    'Use exactly this structure:\\n' +
    '{\\n' +
    '  "title": string,\\n' +
    '  "instructions": string,\\n' +
    '  "difficulty": "easy" | "medium" | "hard" | "mixed",\\n' +
    '  "questions": [\\n' +
    '    {\\n' +
    '      "number": number,\\n' +
    '      "question": string,\\n' +
    '      "type": "short_answer" | "multiple_choice" | "fill_blank",\\n' +
    '      "options": string[],\\n' +
    '      "marks": number\\n' +
    '    }\\n' +
    '  ],\\n' +
    '  "answerKey": [\\n' +
    '    { "number": number, "answer": string, "marks": number }\\n' +
    '  ]\\n' +
    '}\\n' +
    'Question numbers must be sequential starting at 1. The answer key must contain ' +
    'exactly one entry per question. For non-multiple-choice questions, options should ' +
    'be an empty array. Match the requested difficulty and question mix.',

  buildUserPrompt(fields) {
    const count = Number(fields.questionCount) || 10;

    let prompt = 'Create a worksheet.\\n';
    prompt += 'Subject: ' + fields.subject + '\\n';
    prompt += 'Class: ' + fields.classLevel + '\\n';
    prompt += 'Topic: ' + fields.topic + '\\n';
    prompt += 'Number of questions: ' + count + '\\n';
    prompt += 'Difficulty: ' + (fields.difficulty || 'medium') + '\\n';
    prompt += 'Question mix: ' + (fields.questionMix || 'mixed') + '\\n';

    if (fields.curriculum) {
      prompt += 'Curriculum: ' + fields.curriculum + '\\n';
    }

    if (fields.educationalLevel) {
      prompt += 'Educational level: ' + fields.educationalLevel + '\\n';
    }

    return prompt;
  },

  validate(content, fields = {}) {
    if (!content || typeof content !== 'object') {
      return { ok: false, error: 'Generated content was not a valid object.' };
    }

    if (
      typeof content.title !== 'string' ||
      !content.title.trim()
    ) {
      return { ok: false, error: 'Missing title.' };
    }

    if (
      typeof content.instructions !== 'string' ||
      !content.instructions.trim()
    ) {
      return { ok: false, error: 'Missing instructions.' };
    }

    if (!Array.isArray(content.questions) || content.questions.length === 0) {
      return { ok: false, error: 'Missing or empty questions array.' };
    }

    if (!Array.isArray(content.answerKey)) {
      return { ok: false, error: 'Missing answer key.' };
    }

    const requestedCount = Number(fields.questionCount) || 10;

    if (content.questions.length !== requestedCount) {
      return {
        ok: false,
        error:
          'Expected ' +
          requestedCount +
          ' questions but received ' +
          content.questions.length +
          '.',
      };
    }

    if (content.answerKey.length !== content.questions.length) {
      return {
        ok: false,
        error: 'Question count does not match answer key count.',
      };
    }

    for (let i = 0; i < content.questions.length; i++) {
      const q = content.questions[i];

      if (q.number !== i + 1) {
        return {
          ok: false,
          error: 'Question numbering is not sequential starting at 1.',
        };
      }

      if (!q.question || typeof q.question !== 'string') {
        return {
          ok: false,
          error: 'Question ' + q.number + ' is missing its text.',
        };
      }

      if (
        !['short_answer', 'multiple_choice', 'fill_blank'].includes(q.type)
      ) {
        return {
          ok: false,
          error: 'Question ' + q.number + ' has an invalid type.',
        };
      }

      if (!Array.isArray(q.options)) {
        return {
          ok: false,
          error: 'Question ' + q.number + ' has invalid options.',
        };
      }

      if (q.type === 'multiple_choice' && q.options.length !== 4) {
        return {
          ok: false,
          error:
            'Multiple-choice question ' +
            q.number +
            ' must have exactly 4 options.',
        };
      }

      if (q.type !== 'multiple_choice' && q.options.length !== 0) {
        return {
          ok: false,
          error:
            'Non-multiple-choice question ' +
            q.number +
            ' must have no options.',
        };
      }

      if (
        typeof q.marks !== 'number' ||
        q.marks < 1
      ) {
        return {
          ok: false,
          error:
            'Question ' + q.number + ' has invalid marks.',
        };
      }
    }

    for (let i = 0; i < content.answerKey.length; i++) {
      const answer = content.answerKey[i];

      if (answer.number !== i + 1) {
        return {
          ok: false,
          error: 'Answer key numbering does not match question numbering.',
        };
      }

      if (
        typeof answer.answer !== 'string' ||
        !answer.answer.trim()
      ) {
        return {
          ok: false,
          error:
            'Answer key entry ' + answer.number + ' is missing its answer.',
        };
      }

      if (answer.marks !== content.questions[i].marks) {
        return {
          ok: false,
          error:
            'Answer key marks for question ' +
            answer.number +
            ' do not match the question.',
        };
      }
    }

    return { ok: true };
  },

  toPlainTextParagraphs(content) {
    const lines = [
      content.title,
      'Difficulty: ' + (content.difficulty || ''),
      '',
      content.instructions,
    ];

    content.questions.forEach((q) => {
      lines.push('');
      lines.push(
        q.number +
          '. ' +
          q.question +
          ' (' +
          q.marks +
          ' marks)'
      );

      q.options.forEach((option, i) => {
        lines.push(
          String.fromCharCode(65 + i) + ') ' + option
        );
      });
    });

    lines.push('');
    lines.push('Answer Key');

    content.answerKey.forEach((answer) => {
      lines.push(
        answer.number +
          '. ' +
          answer.answer +
          ' (' +
          answer.marks +
          ' marks)'
      );
    });

    return lines.join('\n\n');
  },
};
