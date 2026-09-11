// recipes/quiz.js

export const QUIZ_RECIPE = {
  resourceType: 'quiz',

  requiredFields: ['subject', 'classLevel', 'topic'],

  optionalFields: [
    'questionCount',
    'difficulty',
    'questionStyle',
    'curriculum',
    'educationalLevel',
  ],

  systemPrompt:
    'You are an expert teacher creating a high-quality multiple-choice quiz. ' +
    'Generate one JSON object and nothing else. No markdown fences. No commentary. ' +
    'Use exactly this structure:\\n' +
    '{\\n' +
    '  "title": string,\\n' +
    '  "difficulty": "easy" | "medium" | "hard" | "mixed",\\n' +
    '  "questions": [\\n' +
    '    {\\n' +
    '      "number": number,\\n' +
    '      "question": string,\\n' +
    '      "options": string[],\\n' +
    '      "correctOptionIndex": number,\\n' +
    '      "explanation": string,\\n' +
    '      "difficulty": "easy" | "medium" | "hard"\\n' +
    '    }\\n' +
    '  ]\\n' +
    '}\\n' +
    'Every question must have exactly four options and exactly one correct answer. ' +
    'correctOptionIndex is zero-based. Question numbers must be sequential starting at 1. ' +
    'Explanations must briefly explain why the correct answer is correct. ' +
    'Match the requested difficulty and question style.',

  buildUserPrompt(fields) {
    const count = Number(fields.questionCount) || 10;

    let prompt = 'Create a multiple-choice quiz.\\n';
    prompt += 'Subject: ' + fields.subject + '\\n';
    prompt += 'Class: ' + fields.classLevel + '\\n';
    prompt += 'Topic: ' + fields.topic + '\\n';
    prompt += 'Number of questions: ' + count + '\\n';
    prompt += 'Difficulty: ' + (fields.difficulty || 'medium') + '\\n';
    prompt += 'Question style: ' + (fields.questionStyle || 'mixed') + '\\n';

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

    if (!Array.isArray(content.questions) || content.questions.length === 0) {
      return { ok: false, error: 'Missing or empty questions array.' };
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

    for (let i = 0; i < content.questions.length; i++) {
      const q = content.questions[i];

      if (q.number !== i + 1) {
        return {
          ok: false,
          error: 'Question numbering is not sequential starting at 1.',
        };
      }

      if (typeof q.question !== 'string' || !q.question.trim()) {
        return {
          ok: false,
          error: 'Question ' + q.number + ' is missing question text.',
        };
      }

      if (!Array.isArray(q.options) || q.options.length !== 4) {
        return {
          ok: false,
          error:
            'Question ' + q.number + ' does not have exactly 4 options.',
        };
      }

      if (
        typeof q.correctOptionIndex !== 'number' ||
        q.correctOptionIndex < 0 ||
        q.correctOptionIndex > 3
      ) {
        return {
          ok: false,
          error:
            'Question ' +
            q.number +
            ' has an invalid correctOptionIndex.',
        };
      }

      if (
        typeof q.explanation !== 'string' ||
        !q.explanation.trim()
      ) {
        return {
          ok: false,
          error:
            'Question ' + q.number + ' is missing an explanation.',
        };
      }

      if (!['easy', 'medium', 'hard'].includes(q.difficulty)) {
        return {
          ok: false,
          error:
            'Question ' + q.number + ' has an invalid difficulty.',
        };
      }
    }

    return { ok: true };
  },

  toPlainTextParagraphs(content) {
    const lines = [
      content.title,
      'Difficulty: ' + (content.difficulty || ''),
    ];

    content.questions.forEach((q) => {
      lines.push('');
      lines.push(q.number + '. ' + q.question);

      q.options.forEach((option, i) => {
        lines.push(
          String.fromCharCode(65 + i) + ') ' + option
        );
      });

      lines.push('Answer: ' + String.fromCharCode(65 + q.correctOptionIndex));
      lines.push('Explanation: ' + q.explanation);
    });

    return lines.join('\n\n');
  },
};
