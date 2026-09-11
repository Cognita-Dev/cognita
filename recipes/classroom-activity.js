// recipes/classroom-activity.js

export const CLASSROOM_ACTIVITY_RECIPE = {
  resourceType: 'classroom_activity',

  requiredFields: ['subject', 'classLevel', 'topic'],
  optionalFields: [
    'duration',
    'groupSize',
    'curriculum',
    'educationalLevel',
  ],

  systemPrompt:
    'You are an expert teacher designing an engaging classroom activity. ' +
    'Generate it as a single JSON object and nothing else — no markdown ' +
    'fences, no commentary. Shape:\n' +
    '{\n' +
    '  "title": string,\n' +
    '  "objective": string,\n' +
    '  "materials": string[],\n' +
    '  "setupInstructions": string,\n' +
    '  "steps": [ { "step": number, "instruction": string } ],\n' +
    '  "wrapUpDiscussion": string[]\n' +
    '}\n' +
    'Step numbers sequential starting at 1. Do not wrap in code fences.',

  buildUserPrompt(fields) {
    let p =
      'Create a classroom activity.\n' +
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

    if (fields.groupSize) {
      p += 'Group size: ' + fields.groupSize + '\n';
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
      typeof content.objective !== 'string' ||
      !content.objective.trim()
    ) {
      return {
        ok: false,
        error: 'Missing objective.',
      };
    }

    if (
      !Array.isArray(content.materials) ||
      content.materials.length === 0
    ) {
      return {
        ok: false,
        error: 'Missing materials.',
      };
    }

    if (
      typeof content.setupInstructions !== 'string' ||
      !content.setupInstructions.trim()
    ) {
      return {
        ok: false,
        error: 'Missing setupInstructions.',
      };
    }

    if (
      !Array.isArray(content.steps) ||
      content.steps.length === 0
    ) {
      return {
        ok: false,
        error: 'Missing steps.',
      };
    }

    const nums = content.steps
      .map((s) => s && s.step)
      .sort((a, b) => a - b);

    for (let i = 0; i < nums.length; i++) {
      if (nums[i] !== i + 1) {
        return {
          ok: false,
          error: 'Steps not sequential from 1.',
        };
      }
    }

    for (const step of content.steps) {
      if (
        typeof step.instruction !== 'string' ||
        !step.instruction.trim()
      ) {
        return {
          ok: false,
          error: 'A step is missing its instruction.',
        };
      }
    }

    if (
      !Array.isArray(content.wrapUpDiscussion) ||
      content.wrapUpDiscussion.length === 0
    ) {
      return {
        ok: false,
        error: 'Missing wrapUpDiscussion.',
      };
    }

    return { ok: true };
  },

  toPlainTextParagraphs(content) {
    const lines = [
      content.title,
      '',
      content.objective,
      '',
      'Materials',
    ];

    content.materials.forEach((m) => {
      lines.push('- ' + m);
    });

    lines.push(
      '',
      'Setup',
      content.setupInstructions,
      '',
      'Steps'
    );

    content.steps.forEach((s) => {
      lines.push(s.step + '. ' + s.instruction);
    });

    lines.push('', 'Wrap-Up Discussion');

    content.wrapUpDiscussion.forEach((q) => {
      lines.push('- ' + q);
    });

    return lines.join('\n\n');
  },
};
