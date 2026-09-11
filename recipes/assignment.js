// recipes/assignment.js

export const ASSIGNMENT_RECIPE = {
  resourceType: 'assignment',

  requiredFields: ['subject', 'classLevel', 'topic'],
  optionalFields: [
    'dueInDays',
    'curriculum',
    'educationalLevel',
  ],

  systemPrompt:
    'You are an expert teacher creating a homework assignment. Generate it as ' +
    'a single JSON object and nothing else — no markdown fences, no ' +
    'commentary. Shape:\n' +
    '{\n' +
    '  "title": string,\n' +
    '  "instructions": string,\n' +
    '  "tasks": [ { "number": number, "description": string } ],\n' +
    '  "submissionGuidelines": string,\n' +
    '  "gradingCriteria": string[]\n' +
    '}\n' +
    'Task numbers sequential starting at 1. Do not wrap in code fences.',

  buildUserPrompt(fields) {
    let p =
      'Create an assignment.\n' +
      'Subject: ' +
      fields.subject +
      '\n' +
      'Class: ' +
      fields.classLevel +
      '\n' +
      'Topic: ' +
      fields.topic +
      '\n';

    if (fields.dueInDays) {
      p += 'Due in: ' + fields.dueInDays + ' days\n';
    }

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
      typeof content.instructions !== 'string' ||
      !content.instructions.trim()
    ) {
      return {
        ok: false,
        error: 'Missing instructions.',
      };
    }

    if (
      !Array.isArray(content.tasks) ||
      content.tasks.length === 0
    ) {
      return {
        ok: false,
        error: 'Missing tasks.',
      };
    }

    const nums = content.tasks
      .map((t) => t && t.number)
      .sort((a, b) => a - b);

    for (let i = 0; i < nums.length; i++) {
      if (nums[i] !== i + 1) {
        return {
          ok: false,
          error: 'Tasks not sequential from 1.',
        };
      }
    }

    for (const task of content.tasks) {
      if (
        typeof task.description !== 'string' ||
        !task.description.trim()
      ) {
        return {
          ok: false,
          error: 'A task is missing its description.',
        };
      }
    }

    if (
      typeof content.submissionGuidelines !== 'string' ||
      !content.submissionGuidelines.trim()
    ) {
      return {
        ok: false,
        error: 'Missing submissionGuidelines.',
      };
    }

    if (
      !Array.isArray(content.gradingCriteria) ||
      content.gradingCriteria.length === 0
    ) {
      return {
        ok: false,
        error: 'Missing gradingCriteria.',
      };
    }

    return { ok: true };
  },

  toPlainTextParagraphs(content) {
    const lines = [
      content.title,
      '',
      content.instructions,
      '',
      'Tasks',
    ];

    content.tasks.forEach((t) => {
      lines.push(
        t.number + '. ' + t.description
      );
    });

    lines.push(
      '',
      'Submission Guidelines',
      content.submissionGuidelines,
      '',
      'Grading Criteria'
    );

    content.gradingCriteria.forEach((g) => {
      lines.push('- ' + g);
    });

    return lines.join('\n\n');
  },
};
