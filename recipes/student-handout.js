// recipes/student-handout.js

export const STUDENT_HANDOUT_RECIPE = {
  resourceType: 'student_handout',

  requiredFields: ['subject', 'classLevel', 'topic'],
  optionalFields: [
    'curriculum',
    'educationalLevel',
  ],

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
    let p =
      'Create a student handout.\n' +
      'Subject: ' +
      fields.subject +
      '\n' +
      'Class: ' +
      fields.classLevel +
      '\n' +
      'Topic: ' +
      fields.topic +
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
      typeof content.introduction !== 'string' ||
      !content.introduction.trim()
    ) {
      return {
        ok: false,
        error: 'Missing introduction.',
      };
    }

    if (
      !Array.isArray(content.keyPoints) ||
      content.keyPoints.length === 0
    ) {
      return {
        ok: false,
        error: 'Missing keyPoints.',
      };
    }

    for (const point of content.keyPoints) {
      if (
        typeof point !== 'string' ||
        !point.trim()
      ) {
        return {
          ok: false,
          error: 'A key point is empty.',
        };
      }
    }

    if (
      typeof content.diagramDescription !==
        'string' ||
      !content.diagramDescription.trim()
    ) {
      return {
        ok: false,
        error:
          'Missing diagramDescription.',
      };
    }

    if (
      !Array.isArray(
        content.checkYourUnderstanding
      ) ||
      content.checkYourUnderstanding.length === 0
    ) {
      return {
        ok: false,
        error:
          'Missing checkYourUnderstanding.',
      };
    }

    return { ok: true };
  },

  toPlainTextParagraphs(content) {
    const lines = [
      content.title,
      '',
      content.introduction,
      '',
      'Key Points',
    ];

    content.keyPoints.forEach((k) => {
      lines.push('- ' + k);
    });

    if (content.diagramDescription) {
      lines.push(
        '',
        'Diagram',
        content.diagramDescription
      );
    }

    lines.push(
      '',
      'Check Your Understanding'
    );

    content.checkYourUnderstanding.forEach(
      (q, i) => {
        lines.push(i + 1 + '. ' + q);
      }
    );

    return lines.join('\n\n');
  },
};
