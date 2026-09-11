// A shorter, lower-stakes counterpart to Exam — same shape/validation
// pattern (marks must reconcile) but framed as a quick in-class test
// rather than a formal examination.

export const TEST_RECIPE = {
  resourceType: 'test',

  requiredFields: [
    'subject',
    'classLevel',
    'topic',
  ],

  optionalFields: [
    'duration',
    'totalMarks',
    'curriculum',
    'educationalLevel',
  ],

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
    let p =
      'Create a short test.\n' +
      'Subject: ' +
      fields.subject +
      '\n' +
      'Class: ' +
      fields.classLevel +
      '\n' +
      'Topic: ' +
      fields.topic +
      '\n';

    p +=
      'Duration: ' +
      (fields.duration || '20 minutes') +
      '\n';

    p +=
      'Total marks: ' +
      (fields.totalMarks || 20) +
      '\n';

    if (fields.curriculum) {
      p += 'Curriculum: ' + fields.curriculum + '\n';
    }

    if (fields.educationalLevel) {
      p +=
        'Educational level: ' +
        fields.educationalLevel +
        '\n';
    }

    return p;
  },

  validate(content, fields) {
    if (!content || typeof content !== 'object') {
      return {
        ok: false,
        error: 'Generated content was not a valid object.',
      };
    }

    if (
      typeof content.title !== 'string' ||
      !content.title.trim()
    ) {
      return {
        ok: false,
        error: 'Missing title.',
      };
    }

    if (
      typeof content.instructions !== 'string' ||
      !content.instructions.trim()
    ) {
      return {
        ok: false,
        error: 'Missing instructions.',
      };
    }

    if (
      typeof content.durationMinutes !==
        'number' ||
      !Number.isFinite(content.durationMinutes) ||
      content.durationMinutes <= 0
    ) {
      return {
        ok: false,
        error:
          'Invalid durationMinutes.',
      };
    }

    if (
      fields &&
      fields.duration
    ) {
      const durationMatch = String(
        fields.duration
      ).match(/\d+/);

      if (
        durationMatch &&
        Number(durationMatch[0]) !==
          content.durationMinutes
      ) {
        return {
          ok: false,
          error:
            'Generated duration does not match the requested duration.',
        };
      }
    }

    if (
      typeof content.totalMarks !== 'number' ||
      !Number.isFinite(content.totalMarks) ||
      content.totalMarks <= 0
    ) {
      return {
        ok: false,
        error: 'Invalid totalMarks.',
      };
    }

    if (
      fields &&
      fields.totalMarks !== undefined &&
      content.totalMarks !== fields.totalMarks
    ) {
      return {
        ok: false,
        error:
          'Generated totalMarks (' +
          content.totalMarks +
          ') does not match requested totalMarks (' +
          fields.totalMarks +
          ').',
      };
    }

    if (
      !Array.isArray(content.questions) ||
      content.questions.length === 0
    ) {
      return {
        ok: false,
        error: 'Missing questions.',
      };
    }

    if (
      !Array.isArray(content.answerKey) ||
      content.answerKey.length !==
        content.questions.length
    ) {
      return {
        ok: false,
        error:
          'Answer key count does not match question count.',
      };
    }

    const nums = content.questions
      .map((q) => q && q.number)
      .sort((a, b) => a - b);

    for (let i = 0; i < nums.length; i++) {
      if (nums[i] !== i + 1) {
        return {
          ok: false,
          error:
            'Questions not sequential from 1.',
        };
      }
    }

    for (const question of content.questions) {
      if (
        typeof question.question !==
          'string' ||
        !question.question.trim()
      ) {
        return {
          ok: false,
          error:
            'A question is missing its text.',
        };
      }

      if (
        typeof question.marks !== 'number' ||
        !Number.isFinite(question.marks) ||
        question.marks <= 0
      ) {
        return {
          ok: false,
          error:
            'A question has invalid marks.',
        };
      }
    }

    const sum = content.questions.reduce(
      (total, question) =>
        total + question.marks,
      0
    );

    if (sum !== content.totalMarks) {
      return {
        ok: false,
        error:
          'Marks sum to ' +
          sum +
          ' but totalMarks is ' +
          content.totalMarks +
          '.',
      };
    }

    const answerNums = new Set(
      content.answerKey.map(
        (answer) => answer && answer.number
      )
    );

    for (const number of nums) {
      if (!answerNums.has(number)) {
        return {
          ok: false,
          error:
            'Answer key missing entry for question ' +
            number +
            '.',
        };
      }
    }

    for (const answer of content.answerKey) {
      if (
        typeof answer.answer !== 'string' ||
        !answer.answer.trim()
      ) {
        return {
          ok: false,
          error:
            'An answer key entry is missing its answer.',
        };
      }
    }

    return { ok: true };
  },

  toPlainTextParagraphs(content) {
    const lines = [
      content.title,
      'Duration: ' +
        content.durationMinutes +
        ' min | Total Marks: ' +
        content.totalMarks,
      '',
      content.instructions,
      '',
    ];

    content.questions.forEach((q) => {
      lines.push(
        q.number +
          '. ' +
          q.question +
          ' (' +
          q.marks +
          ' marks)'
      );
    });

    lines.push('', 'Answer Key');

    content.answerKey
      .slice()
      .sort((a, b) => a.number - b.number)
      .forEach((a) => {
        lines.push(
          a.number + '. ' + a.answer
        );
      });

    return lines.join('\n\n');
  },
};
