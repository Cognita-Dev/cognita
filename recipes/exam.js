// recipes/exam.js

export const EXAM_RECIPE = {
  resourceType: 'exam',

  requiredFields: ['subject', 'classLevel', 'topic'],

  optionalFields: [
    'duration',
    'totalMarks',
    'difficulty',
    'sectionCount',
    'curriculum',
    'educationalLevel',
  ],

  systemPrompt:
    'You are an expert examiner creating a formal examination paper. ' +
    'Generate one JSON object and nothing else. No markdown fences. ' +
    'Use exactly this structure:\\n' +
    '{\\n' +
    '  "title": string,\\n' +
    '  "instructions": string,\\n' +
    '  "durationMinutes": number,\\n' +
    '  "totalMarks": number,\\n' +
    '  "difficulty": "easy" | "medium" | "hard" | "mixed",\\n' +
    '  "sections": [\\n' +
    '    {\\n' +
    '      "sectionTitle": string,\\n' +
    '      "instructions": string,\\n' +
    '      "questions": [\\n' +
    '        {\\n' +
    '          "number": number,\\n' +
    '          "question": string,\\n' +
    '          "marks": number,\\n' +
    '          "difficulty": "easy" | "medium" | "hard"\\n' +
    '        }\\n' +
    '      ]\\n' +
    '    }\\n' +
    '  ],\\n' +
    '  "markingScheme": [\\n' +
    '    { "number": number, "answer": string, "marks": number }\\n' +
    '  ]\\n' +
    '}\\n' +
    'Question numbers must be unique across the entire exam and sequential starting at 1. ' +
    'The sum of all question marks must exactly equal totalMarks. The marking scheme must ' +
    'contain exactly one entry for every question and its marks must match. ' +
    'Create exactly the requested number of sections.',

  buildUserPrompt(fields) {
    const totalMarks = Number(fields.totalMarks) || 100;
    const sectionCount = Number(fields.sectionCount) || 3;

    let prompt = 'Create a formal examination.\\n';
    prompt += 'Subject: ' + fields.subject + '\\n';
    prompt += 'Class: ' + fields.classLevel + '\\n';
    prompt += 'Topic(s): ' + fields.topic + '\\n';
    prompt += 'Duration: ' + (fields.duration || '60 minutes') + '\\n';
    prompt += 'Total marks: ' + totalMarks + '\\n';
    prompt += 'Difficulty: ' + (fields.difficulty || 'mixed') + '\\n';
    prompt += 'Number of sections: ' + sectionCount + '\\n';

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

    if (!Array.isArray(content.sections) || content.sections.length === 0) {
      return { ok: false, error: 'Missing or empty sections array.' };
    }

    if (typeof content.totalMarks !== 'number') {
      return { ok: false, error: 'Missing totalMarks.' };
    }

    const requestedTotalMarks =
      Number(fields.totalMarks) || 100;

    if (content.totalMarks !== requestedTotalMarks) {
      return {
        ok: false,
        error:
          'Expected totalMarks to be ' +
          requestedTotalMarks +
          ' but received ' +
          content.totalMarks +
          '.',
      };
    }

    const requestedSectionCount =
      Number(fields.sectionCount) || 3;

    if (content.sections.length !== requestedSectionCount) {
      return {
        ok: false,
        error:
          'Expected ' +
          requestedSectionCount +
          ' sections but received ' +
          content.sections.length +
          '.',
      };
    }

    const allQuestions = [];

    for (const section of content.sections) {
      if (
        typeof section.sectionTitle !== 'string' ||
        !section.sectionTitle.trim()
      ) {
        return { ok: false, error: 'A section is missing its title.' };
      }

      if (
        !Array.isArray(section.questions) ||
        section.questions.length === 0
      ) {
        return { ok: false, error: 'A section has no questions.' };
      }

      allQuestions.push(...section.questions);
    }

    const numbers = allQuestions
      .map((q) => q.number)
      .sort((a, b) => a - b);

    for (let i = 0; i < numbers.length; i++) {
      if (numbers[i] !== i + 1) {
        return {
          ok: false,
          error:
            'Question numbering across sections is not sequential starting at 1.',
        };
      }
    }

    for (const question of allQuestions) {
      if (
        typeof question.question !== 'string' ||
        !question.question.trim()
      ) {
        return {
          ok: false,
          error:
            'Question ' +
            question.number +
            ' is missing its text.',
        };
      }

      if (
        typeof question.marks !== 'number' ||
        question.marks < 1
      ) {
        return {
          ok: false,
          error:
            'Question ' +
            question.number +
            ' has invalid marks.',
        };
      }

      if (
        !['easy', 'medium', 'hard'].includes(question.difficulty)
      ) {
        return {
          ok: false,
          error:
            'Question ' +
            question.number +
            ' has invalid difficulty.',
        };
      }
    }

    const marksSum = allQuestions.reduce(
      (sum, q) => sum + q.marks,
      0
    );

    if (marksSum !== content.totalMarks) {
      return {
        ok: false,
        error:
          'Question marks sum to ' +
          marksSum +
          ' but totalMarks is ' +
          content.totalMarks +
          '.',
      };
    }

    if (
      !Array.isArray(content.markingScheme) ||
      content.markingScheme.length !== allQuestions.length
    ) {
      return {
        ok: false,
        error:
          'Marking scheme does not have one entry per question.',
      };
    }

    const questionByNumber = new Map(
      allQuestions.map((q) => [q.number, q])
    );

    for (const entry of content.markingScheme) {
      const question = questionByNumber.get(entry.number);

      if (!question) {
        return {
          ok: false,
          error:
            'Marking scheme references question ' +
            entry.number +
            ' which does not exist.',
        };
      }

      if (
        typeof entry.answer !== 'string' ||
        !entry.answer.trim()
      ) {
        return {
          ok: false,
          error:
            'Marking scheme answer for question ' +
            entry.number +
            ' is missing.',
        };
      }

      if (entry.marks !== question.marks) {
        return {
          ok: false,
          error:
            'Marking scheme marks for question ' +
            entry.number +
            ' do not match.',
        };
      }
    }

    return { ok: true };
  },

  toPlainTextParagraphs(content) {
    const lines = [];

    lines.push(content.title);
    lines.push(
      'Duration: ' +
        content.durationMinutes +
        ' minutes | Total Marks: ' +
        content.totalMarks
    );

    lines.push('');
    lines.push(content.instructions);

    content.sections.forEach((section) => {
      lines.push('');
      lines.push(section.sectionTitle);

      if (section.instructions) {
        lines.push(section.instructions);
      }

      section.questions.forEach((q) => {
        lines.push(
          q.number +
            '. ' +
            q.question +
            ' (' +
            q.marks +
            ' marks)'
        );
      });
    });

    lines.push('');
    lines.push('Marking Scheme');

    content.markingScheme
      .slice()
      .sort((a, b) => a.number - b.number)
      .forEach((entry) => {
        lines.push(
          entry.number +
            '. ' +
            entry.answer +
            ' (' +
            entry.marks +
            ' marks)'
        );
      });

    return lines.join('\n\n');
  },
};
