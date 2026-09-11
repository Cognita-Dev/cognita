// recipes/marking-scheme.js

export const MARKING_SCHEME_RECIPE = {
  resourceType: 'marking_scheme',

  requiredFields: ['subject', 'classLevel', 'topic'],
  optionalFields: [
    'totalMarks',
    'curriculum',
    'educationalLevel',
  ],

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
    let p =
      'Create a marking scheme.\n' +
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
      'Total marks: ' +
      (fields.totalMarks || 100) +
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
      return { ok: false, error: 'Missing title.' };
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
      !Array.isArray(content.criteria) ||
      content.criteria.length === 0
    ) {
      return {
        ok: false,
        error: 'Missing criteria.',
      };
    }

    const nums = content.criteria
      .map((x) => x && x.number)
      .sort((a, b) => a - b);

    for (let i = 0; i < nums.length; i++) {
      if (nums[i] !== i + 1) {
        return {
          ok: false,
          error: 'Criteria not sequential from 1.',
        };
      }
    }

    for (const criterion of content.criteria) {
      if (
        typeof criterion.expectedAnswer !== 'string' ||
        !criterion.expectedAnswer.trim()
      ) {
        return {
          ok: false,
          error:
            'A criterion is missing its expectedAnswer.',
        };
      }

      if (
        typeof criterion.marks !== 'number' ||
        !Number.isFinite(criterion.marks) ||
        criterion.marks <= 0
      ) {
        return {
          ok: false,
          error:
            'A criterion has invalid marks.',
        };
      }

      if (
        criterion.markingNotes !== undefined &&
        typeof criterion.markingNotes !== 'string'
      ) {
        return {
          ok: false,
          error:
            'A criterion has invalid markingNotes.',
        };
      }
    }

    const sum = content.criteria.reduce(
      (total, criterion) =>
        total + criterion.marks,
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

    return { ok: true };
  },

  toPlainTextParagraphs(content) {
    const lines = [
      content.title,
      'Total Marks: ' + content.totalMarks,
      '',
    ];

    content.criteria.forEach((x) => {
      lines.push(
        x.number +
          '. ' +
          x.expectedAnswer +
          ' (' +
          x.marks +
          ' marks)' +
          (x.markingNotes
            ? ' — ' + x.markingNotes
            : '')
      );
    });

    return lines.join('\n\n');
  },
};
