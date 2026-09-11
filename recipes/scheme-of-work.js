// recipes/scheme-of-work.js

export const SCHEME_OF_WORK_RECIPE = {
  resourceType: 'scheme_of_work',

  requiredFields: ['subject', 'classLevel'],

  optionalFields: [
    'term',
    'weekCount',
    'lessonsPerWeek',
    'curriculum',
    'educationalLevel',
  ],

  systemPrompt:
    'You are an expert curriculum planner creating a detailed scheme of work. ' +
    'Generate one JSON object and nothing else. No markdown fences. ' +
    'Use exactly this structure:\\n' +
    '{\\n' +
    '  "title": string,\\n' +
    '  "term": string,\\n' +
    '  "weeks": [\\n' +
    '    {\\n' +
    '      "weekNumber": number,\\n' +
    '      "topic": string,\\n' +
    '      "objectives": string[],\\n' +
    '      "lessons": [\\n' +
    '        {\\n' +
    '          "lessonNumber": number,\\n' +
    '          "focus": string,\\n' +
    '          "objectives": string[],\\n' +
    '          "activities": string[],\\n' +
    '          "assessment": string,\\n' +
    '          "materials": string[]\\n' +
    '        }\\n' +
    '      ],\\n' +
    '      "assessment": string,\\n' +
    '      "materials": string[]\\n' +
    '    }\\n' +
    '  ]\\n' +
    '}\\n' +
    'Week numbers must be sequential starting at 1. Generate exactly the requested ' +
    'number of weeks and exactly the requested number of lessons in every week. ' +
    'Topics should build logically throughout the term.',

  buildUserPrompt(fields) {
    const weekCount = Number(fields.weekCount) || 12;
    const lessonsPerWeek = Number(fields.lessonsPerWeek) || 3;

    let prompt = 'Create a scheme of work.\\n';
    prompt += 'Subject: ' + fields.subject + '\\n';
    prompt += 'Class: ' + fields.classLevel + '\\n';
    prompt += 'Term: ' + (fields.term || 'First Term') + '\\n';
    prompt += 'Number of weeks: ' + weekCount + '\\n';
    prompt += 'Lessons per week: ' + lessonsPerWeek + '\\n';

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
      typeof content.term !== 'string' ||
      !content.term.trim()
    ) {
      return { ok: false, error: 'Missing term.' };
    }

    if (!Array.isArray(content.weeks) || content.weeks.length === 0) {
      return { ok: false, error: 'Missing or empty weeks array.' };
    }

    const requestedWeeks =
      Number(fields.weekCount) || 12;

    if (content.weeks.length !== requestedWeeks) {
      return {
        ok: false,
        error:
          'Expected ' +
          requestedWeeks +
          ' weeks but received ' +
          content.weeks.length +
          '.',
      };
    }

    const requestedLessonsPerWeek =
      Number(fields.lessonsPerWeek) || 3;

    for (let i = 0; i < content.weeks.length; i++) {
      const week = content.weeks[i];

      if (week.weekNumber !== i + 1) {
        return {
          ok: false,
          error:
            'Week numbering is not sequential starting at 1.',
        };
      }

      if (
        typeof week.topic !== 'string' ||
        !week.topic.trim()
      ) {
        return {
          ok: false,
          error:
            'Week ' +
            week.weekNumber +
            ' is missing its topic.',
        };
      }

      if (
        !Array.isArray(week.objectives) ||
        week.objectives.length === 0
      ) {
        return {
          ok: false,
          error:
            'Week ' +
            week.weekNumber +
            ' is missing objectives.',
        };
      }

      if (
        !Array.isArray(week.lessons) ||
        week.lessons.length !== requestedLessonsPerWeek
      ) {
        return {
          ok: false,
          error:
            'Week ' +
            week.weekNumber +
            ' must contain exactly ' +
            requestedLessonsPerWeek +
            ' lessons.',
        };
      }

      for (let j = 0; j < week.lessons.length; j++) {
        const lesson = week.lessons[j];

        if (lesson.lessonNumber !== j + 1) {
          return {
            ok: false,
            error:
              'Lesson numbering in week ' +
              week.weekNumber +
              ' is invalid.',
          };
        }

        if (
          typeof lesson.focus !== 'string' ||
          !lesson.focus.trim()
        ) {
          return {
            ok: false,
            error:
              'A lesson in week ' +
              week.weekNumber +
              ' is missing its focus.',
          };
        }

        if (
          !Array.isArray(lesson.objectives) ||
          lesson.objectives.length === 0
        ) {
          return {
            ok: false,
            error:
              'A lesson in week ' +
              week.weekNumber +
              ' is missing objectives.',
          };
        }

        if (
          !Array.isArray(lesson.activities) ||
          lesson.activities.length === 0
        ) {
          return {
            ok: false,
            error:
              'A lesson in week ' +
              week.weekNumber +
              ' is missing activities.',
          };
        }
      }
    }

    return { ok: true };
  },

  toPlainTextParagraphs(content) {
    const lines = [
      content.title,
      content.term,
    ];

    content.weeks
      .slice()
      .sort((a, b) => a.weekNumber - b.weekNumber)
      .forEach((week) => {
        lines.push('');
        lines.push(
          'Week ' +
            week.weekNumber +
            ': ' +
            week.topic
        );

        lines.push(
          'Objectives: ' +
            week.objectives.join('; ')
        );

        week.lessons.forEach((lesson) => {
          lines.push(
            'Lesson ' +
              lesson.lessonNumber +
              ': ' +
              lesson.focus
          );

          lines.push(
            'Objectives: ' +
              lesson.objectives.join('; ')
          );

          lines.push(
            'Activities: ' +
              lesson.activities.join('; ')
          );

          lines.push(
            'Assessment: ' +
              lesson.assessment
          );

          lines.push(
            'Materials: ' +
              lesson.materials.join(', ')
          );
        });

        lines.push(
          'Weekly Assessment: ' +
            week.assessment
        );

        lines.push(
          'Weekly Materials: ' +
            week.materials.join(', ')
        );
      });

    return lines.join('\n\n');
  },
};
