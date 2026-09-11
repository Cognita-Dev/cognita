// recipes/rubric.js

export const RUBRIC_RECIPE = {
  resourceType: 'rubric',

  requiredFields: ['subject', 'classLevel', 'topic'],
  optionalFields: [
    'performanceLevels',
    'curriculum',
    'educationalLevel',
  ],

  systemPrompt:
    'You are an expert assessment designer creating a grading rubric. ' +
    'Generate it as a single JSON object and nothing else — no markdown ' +
    'fences, no commentary. Shape:\n' +
    '{\n' +
    '  "title": string,\n' +
    '  "performanceLevels": string[],\n' +
    '  "criteria": [ { "criterion": string, "descriptions": string[] } ]\n' +
    '}\n' +
    'Every "descriptions" array must have exactly the same length as ' +
    '"performanceLevels", in the same order. Do not wrap in code fences.',

  buildUserPrompt(fields) {
    let p =
      'Create a grading rubric.\n' +
      'Subject: ' +
      fields.subject +
      '\n' +
      'Class: ' +
      fields.classLevel +
      '\n' +
      'Task/topic: ' +
      fields.topic +
      '\n';

    p +=
      'Performance levels: ' +
      (fields.performanceLevels ||
        'Excellent, Good, Satisfactory, Needs Improvement') +
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
      !Array.isArray(content.performanceLevels) ||
      content.performanceLevels.length < 2
    ) {
      return {
        ok: false,
        error:
          'Missing or invalid performanceLevels.',
      };
    }

    const levelNames = content.performanceLevels.map(
      (level) =>
        typeof level === 'string'
          ? level.trim()
          : ''
    );

    if (levelNames.some((level) => !level)) {
      return {
        ok: false,
        error:
          'Performance levels must all be non-empty strings.',
      };
    }

    if (
      fields &&
      fields.performanceLevels
    ) {
      const requested = String(
        fields.performanceLevels
      )
        .split(',')
        .map((level) => level.trim())
        .filter(Boolean);

      if (
        requested.length > 0 &&
        content.performanceLevels.length !==
          requested.length
      ) {
        return {
          ok: false,
          error:
            'Generated performance level count does not match the requested levels.',
        };
      }
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

    for (const criterion of content.criteria) {
      if (
        !criterion ||
        typeof criterion.criterion !== 'string' ||
        !criterion.criterion.trim()
      ) {
        return {
          ok: false,
          error:
            'A criterion is missing its name.',
        };
      }

      if (
        !Array.isArray(criterion.descriptions) ||
        criterion.descriptions.length !==
          content.performanceLevels.length
      ) {
        return {
          ok: false,
          error:
            'Criterion "' +
            criterion.criterion +
            '" descriptions do not match performanceLevels count.',
        };
      }

      for (const description of criterion.descriptions) {
        if (
          typeof description !== 'string' ||
          !description.trim()
        ) {
          return {
            ok: false,
            error:
              'A rubric description is empty.',
          };
        }
      }
    }

    return { ok: true };
  },

  toPlainTextParagraphs(content) {
    const lines = [
      content.title,
      'Levels: ' +
        content.performanceLevels.join(' | '),
      '',
    ];

    content.criteria.forEach((criterion) => {
      lines.push(criterion.criterion);

      criterion.descriptions.forEach(
        (description, i) => {
          lines.push(
            '  ' +
              content.performanceLevels[i] +
              ': ' +
              description
          );
        }
      );
    });

    return lines.join('\n\n');
  },
};
