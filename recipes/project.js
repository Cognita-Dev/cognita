// recipes/project.js

export const PROJECT_RECIPE = {
  resourceType: 'project',

  requiredFields: ['subject', 'classLevel', 'topic'],
  optionalFields: [
    'duration',
    'curriculum',
    'educationalLevel',
  ],

  systemPrompt:
    'You are an expert teacher designing a student project. Generate it as a ' +
    'single JSON object and nothing else — no markdown fences, no commentary. ' +
    'Shape:\n' +
    '{\n' +
    '  "title": string,\n' +
    '  "overview": string,\n' +
    '  "learningOutcomes": string[],\n' +
    '  "milestones": [ { "milestoneNumber": number, "description": string, "suggestedTimeframe": string } ],\n' +
    '  "deliverables": string[],\n' +
    '  "assessmentCriteria": string[]\n' +
    '}\n' +
    'milestoneNumber sequential starting at 1. Do not wrap in code fences.',

  buildUserPrompt(fields) {
    let p =
      'Create a student project.\n' +
      'Subject: ' +
      fields.subject +
      '\n' +
      'Class: ' +
      fields.classLevel +
      '\n' +
      'Topic: ' +
      fields.topic +
      '\n';

    if (fields.duration) {
      p += 'Duration: ' + fields.duration + '\n';
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
      return {
        ok: false,
        error: 'Missing title.',
      };
    }

    if (
      typeof content.overview !== 'string' ||
      !content.overview.trim()
    ) {
      return {
        ok: false,
        error: 'Missing overview.',
      };
    }

    if (
      !Array.isArray(content.learningOutcomes) ||
      content.learningOutcomes.length === 0
    ) {
      return {
        ok: false,
        error: 'Missing learningOutcomes.',
      };
    }

    if (
      !Array.isArray(content.milestones) ||
      content.milestones.length === 0
    ) {
      return {
        ok: false,
        error: 'Missing milestones.',
      };
    }

    const nums = content.milestones
      .map((m) => m && m.milestoneNumber)
      .sort((a, b) => a - b);

    for (let i = 0; i < nums.length; i++) {
      if (nums[i] !== i + 1) {
        return {
          ok: false,
          error:
            'Milestones not sequential from 1.',
        };
      }
    }

    for (const milestone of content.milestones) {
      if (
        typeof milestone.description !== 'string' ||
        !milestone.description.trim()
      ) {
        return {
          ok: false,
          error:
            'A milestone is missing its description.',
        };
      }

      if (
        typeof milestone.suggestedTimeframe !==
          'string' ||
        !milestone.suggestedTimeframe.trim()
      ) {
        return {
          ok: false,
          error:
            'A milestone is missing its suggestedTimeframe.',
        };
      }
    }

    if (
      !Array.isArray(content.deliverables) ||
      content.deliverables.length === 0
    ) {
      return {
        ok: false,
        error: 'Missing deliverables.',
      };
    }

    if (
      !Array.isArray(content.assessmentCriteria) ||
      content.assessmentCriteria.length === 0
    ) {
      return {
        ok: false,
        error:
          'Missing assessmentCriteria.',
      };
    }

    return { ok: true };
  },

  toPlainTextParagraphs(content) {
    const lines = [
      content.title,
      '',
      content.overview,
      '',
      'Learning Outcomes',
    ];

    content.learningOutcomes.forEach((o) => {
      lines.push('- ' + o);
    });

    lines.push('', 'Milestones');

    content.milestones.forEach((m) => {
      lines.push(
        m.milestoneNumber +
          '. ' +
          m.description +
          ' (' +
          m.suggestedTimeframe +
          ')'
      );
    });

    lines.push('', 'Deliverables');

    content.deliverables.forEach((d) => {
      lines.push('- ' + d);
    });

    lines.push('', 'Assessment Criteria');

    content.assessmentCriteria.forEach((a) => {
      lines.push('- ' + a);
    });

    return lines.join('\n\n');
  },
};
