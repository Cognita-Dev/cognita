// recipes/scheme-of-work.js
// Term-long plan broken into weeks. Validation checks week numbers are
// sequential and match the requested term length.

export const SCHEME_OF_WORK_RECIPE = {
  resourceType: 'scheme_of_work',

  requiredFields: ['subject', 'classLevel'],
  optionalFields: ['term', 'weekCount', 'curriculum', 'educationalLevel'],

  systemPrompt:
    'You are an expert curriculum planner. Generate a term scheme of work as a ' +
    'single JSON object and nothing else — no markdown fences, no commentary ' +
    'before or after. The JSON object must have exactly this shape:\n' +
    '{\n' +
    '  "title": string,\n' +
    '  "term": string,\n' +
    '  "weeks": [\n' +
    '    {\n' +
    '      "weekNumber": number,\n' +
    '      "topic": string,\n' +
    '      "objectives": string[],\n' +
    '      "activities": string[],\n' +
    '      "assessment": string,\n' +
    '      "materials": string[]\n' +
    '    }\n' +
    '  ]\n' +
    '}\n' +
    'Week numbers must be sequential starting at 1 with no gaps or repeats, and ' +
    'the number of weeks must match what was requested. Topics across the term ' +
    'should build on each other logically. Do not wrap the JSON in code fences.',

  buildUserPrompt(fields) {
    let prompt = 'Create a scheme of work.\n';
    prompt += 'Subject: ' + fields.subject + '\n';
    prompt += 'Class: ' + fields.classLevel + '\n';
    prompt += 'Term: ' + (fields.term || 'First Term') + '\n';
    prompt += 'Number of weeks: ' + (fields.weekCount || 12) + '\n';
    if (fields.curriculum) prompt += 'Curriculum: ' + fields.curriculum + '\n';
    if (fields.educationalLevel) prompt += 'Educational level: ' + fields.educationalLevel + '\n';
    return prompt;
  },

  validate(content) {
    if (!content || typeof content !== 'object') {
      return { ok: false, error: 'Generated content was not a valid object.' };
    }
    if (typeof content.title !== 'string' || !content.title.trim()) {
      return { ok: false, error: 'Missing title.' };
    }
    if (!Array.isArray(content.weeks) || content.weeks.length === 0) {
      return { ok: false, error: 'Missing or empty weeks array.' };
    }

    const numbers = content.weeks.map((w) => w.weekNumber).sort((a, b) => a - b);
    for (let i = 0; i < numbers.length; i++) {
      if (numbers[i] !== i + 1) {
        return { ok: false, error: 'Week numbering is not sequential starting at 1.' };
      }
    }

    for (const week of content.weeks) {
      if (typeof week.topic !== 'string' || !week.topic.trim()) {
        return { ok: false, error: 'A week is missing its topic.' };
      }
      if (!Array.isArray(week.objectives) || week.objectives.length === 0) {
        return { ok: false, error: 'A week is missing objectives.' };
      }
      if (!Array.isArray(week.activities) || week.activities.length === 0) {
        return { ok: false, error: 'A week is missing activities.' };
      }
    }

    return { ok: true };
  },

  toPlainTextParagraphs(content) {
    const lines = [];
    lines.push(content.title);
    lines.push(content.term);
    content.weeks
      .slice()
      .sort((a, b) => a.weekNumber - b.weekNumber)
      .forEach((week) => {
        lines.push('');
        lines.push('Week ' + week.weekNumber + ': ' + week.topic);
        lines.push('Objectives: ' + week.objectives.join('; '));
        lines.push('Activities: ' + week.activities.join('; '));
        lines.push('Assessment: ' + week.assessment);
        lines.push('Materials: ' + week.materials.join(', '));
      });
    return lines.join('\n\n');
  },
};
