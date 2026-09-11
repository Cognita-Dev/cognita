// recipes/lesson-plan.js

export const LESSON_PLAN_RECIPE = {
  resourceType: 'lesson_plan',

  requiredFields: ['subject', 'classLevel', 'topic'],

  optionalFields: [
    'duration',
    'lessonStyle',
    'objectiveFocus',
    'curriculum',
    'educationalLevel',
  ],

  systemPrompt:
    'You are an expert curriculum designer creating a classroom-ready lesson plan. ' +
    'Generate one JSON object and nothing else. No markdown fences. No commentary. ' +
    'Use exactly this structure:\\n' +
    '{\\n' +
    '  "title": string,\\n' +
    '  "duration": string,\\n' +
    '  "lessonStyle": string,\\n' +
    '  "learningObjectives": string[],\\n' +
    '  "previousKnowledge": string,\\n' +
    '  "materials": string[],\\n' +
    '  "introduction": string,\\n' +
    '  "teacherActivities": string[],\\n' +
    '  "studentActivities": string[],\\n' +
    '  "assessment": string[],\\n' +
    '  "conclusion": string,\\n' +
    '  "homework": string,\\n' +
    '  "teacherNotes": string\\n' +
    '}\\n' +
    'The lesson must be age-appropriate, practical, and aligned with the subject, ' +
    'class level, topic, duration, lesson style, and objective focus provided. ' +
    'Objectives should be measurable where appropriate.',

  buildUserPrompt(fields) {
    let prompt = 'Create a lesson plan.\\n';
    prompt += 'Subject: ' + fields.subject + '\\n';
    prompt += 'Class: ' + fields.classLevel + '\\n';
    prompt += 'Topic: ' + fields.topic + '\\n';
    prompt += 'Duration: ' + (fields.duration || '40 minutes') + '\\n';
    prompt +=
      'Lesson style: ' +
      (fields.lessonStyle || 'direct_instruction') +
      '\\n';
    prompt +=
      'Objective focus: ' +
      (fields.objectiveFocus || 'mixed') +
      '\\n';

    if (fields.curriculum) {
      prompt += 'Curriculum: ' + fields.curriculum + '\\n';
    }

    if (fields.educationalLevel) {
      prompt += 'Educational level: ' + fields.educationalLevel + '\\n';
    }

    return prompt;
  },

  validate(content) {
    if (!content || typeof content !== 'object') {
      return { ok: false, error: 'Generated content was not a valid object.' };
    }

    const requiredArrays = [
      'learningObjectives',
      'materials',
      'teacherActivities',
      'studentActivities',
      'assessment',
    ];

    for (const field of requiredArrays) {
      if (!Array.isArray(content[field]) || content[field].length === 0) {
        return {
          ok: false,
          error: 'Missing or empty field: ' + field,
        };
      }
    }

    const requiredStrings = [
      'title',
      'duration',
      'lessonStyle',
      'previousKnowledge',
      'introduction',
      'conclusion',
      'homework',
      'teacherNotes',
    ];

    for (const field of requiredStrings) {
      if (
        typeof content[field] !== 'string' ||
        !content[field].trim()
      ) {
        return {
          ok: false,
          error: 'Missing or empty field: ' + field,
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
        content.duration +
        ' | Style: ' +
        content.lessonStyle
    );

    lines.push('');
    lines.push('Learning Objectives');
    content.learningObjectives.forEach((item) => {
      lines.push('- ' + item);
    });

    lines.push('');
    lines.push('Previous Knowledge');
    lines.push(content.previousKnowledge);

    lines.push('');
    lines.push('Materials');
    content.materials.forEach((item) => {
      lines.push('- ' + item);
    });

    lines.push('');
    lines.push('Introduction');
    lines.push(content.introduction);

    lines.push('');
    lines.push('Teacher Activities');
    content.teacherActivities.forEach((item) => {
      lines.push('- ' + item);
    });

    lines.push('');
    lines.push('Student Activities');
    content.studentActivities.forEach((item) => {
      lines.push('- ' + item);
    });

    lines.push('');
    lines.push('Assessment');
    content.assessment.forEach((item) => {
      lines.push('- ' + item);
    });

    lines.push('');
    lines.push('Conclusion');
    lines.push(content.conclusion);

    lines.push('');
    lines.push('Homework');
    lines.push(content.homework);

    lines.push('');
    lines.push('Teacher Notes');
    lines.push(content.teacherNotes);

    return lines.join('\n\n');
  },
};
