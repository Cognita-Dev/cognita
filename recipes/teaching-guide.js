// recipes/teaching-guide.js

export const TEACHING_GUIDE_RECIPE = {
  resourceType: 'teaching_guide',

  requiredFields: ['subject', 'classLevel', 'topic'],
  optionalFields: ['curriculum', 'educationalLevel'],

  systemPrompt:
    'You are an expert teacher trainer creating a teaching guide for another ' +
    'teacher to follow. Generate it as a single JSON object and nothing else — ' +
    'no markdown fences, no commentary. Shape:\n' +
    '{\n' +
    '  "title": string,\n' +
    '  "topicOverview": string,\n' +
    '  "teachingSteps": [ { "step": number, "instruction": string, "tip": string } ],\n' +
    '  "commonStudentDifficulties": string[],\n' +
    '  "differentiationStrategies": string[],\n' +
    '  "suggestedResources": string[]\n' +
    '}\n' +
    'Step numbers must be sequential starting at 1. ' +
    'Do not wrap in code fences.',

  buildUserPrompt(fields) {
    let p =
      'Create a teaching guide.\n' +
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
      return { ok: false, error: 'Missing title.' };
    }

    if (
      typeof content.topicOverview !== 'string' ||
      !content.topicOverview.trim()
    ) {
      return {
        ok: false,
        error: 'Missing topicOverview.',
      };
    }

    if (
      !Array.isArray(content.teachingSteps) ||
      content.teachingSteps.length === 0
    ) {
      return {
        ok: false,
        error: 'Missing teachingSteps.',
      };
    }

    const nums = content.teachingSteps
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

    for (const step of content.teachingSteps) {
      if (
        typeof step.instruction !== 'string' ||
        !step.instruction.trim()
      ) {
        return {
          ok: false,
          error: 'A teaching step is missing its instruction.',
        };
      }

      if (
        step.tip !== undefined &&
        typeof step.tip !== 'string'
      ) {
        return {
          ok: false,
          error: 'A teaching step has an invalid tip.',
        };
      }
    }

    if (
      !Array.isArray(content.commonStudentDifficulties) ||
      content.commonStudentDifficulties.length === 0
    ) {
      return {
        ok: false,
        error:
          'Missing commonStudentDifficulties.',
      };
    }

    if (
      !Array.isArray(content.differentiationStrategies) ||
      content.differentiationStrategies.length === 0
    ) {
      return {
        ok: false,
        error:
          'Missing differentiationStrategies.',
      };
    }

    if (
      !Array.isArray(content.suggestedResources)
    ) {
      return {
        ok: false,
        error: 'Invalid suggestedResources array.',
      };
    }

    return { ok: true };
  },

  toPlainTextParagraphs(content) {
    const lines = [
      content.title,
      '',
      content.topicOverview,
      '',
      'Teaching Steps',
    ];

    content.teachingSteps.forEach((s) => {
      lines.push(
        s.step +
          '. ' +
          s.instruction +
          (s.tip
            ? ' (Tip: ' + s.tip + ')'
            : '')
      );
    });

    lines.push(
      '',
      'Common Student Difficulties'
    );

    content.commonStudentDifficulties.forEach((d) => {
      lines.push('- ' + d);
    });

    lines.push(
      '',
      'Differentiation Strategies'
    );

    content.differentiationStrategies.forEach((d) => {
      lines.push('- ' + d);
    });

    if (
      content.suggestedResources &&
      content.suggestedResources.length
    ) {
      lines.push('', 'Suggested Resources');

      content.suggestedResources.forEach((r) => {
        lines.push('- ' + r);
      });
    }

    return lines.join('\n\n');
  },
};
