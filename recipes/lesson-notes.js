// recipes/lesson-notes.js
//
// A Lesson Note is the actual classroom content a teacher writes on the
// board (or hands out) for pupils/students to copy into their notebooks.
// It is NOT a lesson plan (that's recipes/lesson-plan.js — teacher-facing
// planning) and NOT a study guide (that's revision-facing). This recipe
// produces the taught content itself: definitions, explanations,
// examples, formulas, and so on, structured so it reads like a real
// school note rather than an AI response.

const VALID_SECTION_TYPES = new Set([
  'paragraph',
  'bullets',
  'numbered',
  'definition',
  'example',
  'formula',
]);

export const LESSON_NOTE_RECIPE = {
  resourceType: 'lesson_note',

  requiredFields: ['subject', 'classLevel', 'topic'],
  optionalFields: ['curriculum', 'educationalLevel'],

  systemPrompt:
    'You are an experienced classroom teacher writing a Lesson Note. ' +
    'A Lesson Note is the actual academic content a teacher writes on the ' +
    'board for pupils/students to copy into their notebooks and study from. ' +
    'It is the taught content itself — NOT a lesson plan, NOT a teaching ' +
    'guide, and NOT a study guide.\n\n' +
    'Strict rules:\n' +
    '- Never include teacher-facing planning content such as learning ' +
    'objectives, previous knowledge, materials, teacher activities, student ' +
    'activities, assessment strategy, lesson duration, teaching method, ' +
    'classroom management, or homework instructions.\n' +
    '- Never address the reader conversationally, never mention being an AI, ' +
    'and never write instructions like "the teacher should..." or "ask the ' +
    'students to...". Write the actual content being taught, e.g. ' +
    '"Photosynthesis is the process by which green plants make their own food."\n' +
    '- Use simple, clear language appropriate to the stated class level. Do ' +
    'not use unnecessarily complicated vocabulary. When a technical term is ' +
    'genuinely required, include it and explain it simply, ideally as its ' +
    'own definition entry.\n' +
    '- Structure the note using whichever sections genuinely fit the topic ' +
    '(for example: definition, explanation, characteristics, process, types, ' +
    'formula, worked example, causes, effects, importance, uses, comparisons) ' +
    '— do not force the same fixed set of sections onto every topic.\n' +
    '- Depth should match the subject, class level and topic complexity: not ' +
    'padded, not so short it is unusable as an actual classroom note.\n' +
    '- Practice questions or examples may appear inside a section only if ' +
    'they support understanding the content — the note must not become a ' +
    'quiz or a flashcard deck.\n\n' +
    'Generate one JSON object and nothing else. No markdown fences, no ' +
    'commentary before or after. Use exactly this shape:\n' +
    '{\n' +
    '  "title": string,\n' +
    '  "introduction": string,\n' +
    '  "sections": [\n' +
    '    {\n' +
    '      "heading": string,\n' +
    '      "type": "paragraph" | "bullets" | "numbered" | "definition" | "example" | "formula",\n' +
    '      "content": string | string[] | { "term": string, "explanation": string }[]\n' +
    '    }\n' +
    '  ],\n' +
    '  "summary": string\n' +
    '}\n' +
    'Field rules by type:\n' +
    '- "paragraph": content is a single string.\n' +
    '- "bullets" or "numbered": content is a string array.\n' +
    '- "definition": content is an array of { "term", "explanation" } objects.\n' +
    '- "example": content is a string (a worked or illustrative example).\n' +
    '- "formula": content is a string containing the formula/equation, ' +
    'optionally followed by a short explanation on the next line.\n' +
    'Order sections the way a teacher would naturally teach the topic. ' +
    'Include at least 3 sections. "summary" is a short closing recap in ' +
    'plain language.',

  buildUserPrompt(fields) {
    let prompt = 'Write a Lesson Note.\n';
    prompt += 'Subject: ' + fields.subject + '\n';
    prompt += 'Class: ' + fields.classLevel + '\n';
    prompt += 'Topic: ' + fields.topic + '\n';

    if (fields.curriculum) {
      prompt += 'Curriculum: ' + fields.curriculum + '\n';
    }
    if (fields.educationalLevel) {
      prompt += 'Educational level: ' + fields.educationalLevel + '\n';
    }

    prompt +=
      'Write the note as the actual content a teacher would put on the ' +
      'board for this class to copy. Adapt the structure and depth to the ' +
      'subject and topic rather than using a fixed template.';

    return prompt;
  },

  validate(content) {
    if (!content || typeof content !== 'object') {
      return { ok: false, error: 'Generated content was not a valid object.' };
    }

    if (typeof content.title !== 'string' || !content.title.trim()) {
      return { ok: false, error: 'Missing title.' };
    }

    if (typeof content.introduction !== 'string' || !content.introduction.trim()) {
      return { ok: false, error: 'Missing introduction.' };
    }

    if (!Array.isArray(content.sections) || content.sections.length < 2) {
      return { ok: false, error: 'Missing or insufficient sections (need at least 2).' };
    }

    for (let i = 0; i < content.sections.length; i++) {
      const section = content.sections[i];

      if (!section || typeof section !== 'object') {
        return { ok: false, error: 'Section ' + (i + 1) + ' is not a valid object.' };
      }

      if (typeof section.heading !== 'string' || !section.heading.trim()) {
        return { ok: false, error: 'Section ' + (i + 1) + ' is missing a heading.' };
      }

      if (!VALID_SECTION_TYPES.has(section.type)) {
        return { ok: false, error: 'Section ' + (i + 1) + ' has an invalid type: ' + section.type };
      }

      const contentCheck = _validateSectionContent(section);
      if (!contentCheck.ok) {
        return { ok: false, error: 'Section ' + (i + 1) + ' (' + section.heading + '): ' + contentCheck.error };
      }
    }

    if (typeof content.summary !== 'string' || !content.summary.trim()) {
      return { ok: false, error: 'Missing summary.' };
    }

    return { ok: true };
  },

  toPlainTextParagraphs(content) {
    const lines = [];

    lines.push(content.title.toUpperCase());
    lines.push('');
    lines.push(content.introduction);

    content.sections.forEach((section) => {
      lines.push('');
      lines.push(section.heading);

      switch (section.type) {
        case 'bullets':
          (section.content || []).forEach((item) => lines.push('- ' + item));
          break;
        case 'numbered':
          (section.content || []).forEach((item, i) => lines.push(i + 1 + '. ' + item));
          break;
        case 'definition':
          (section.content || []).forEach((entry) => {
            lines.push(entry.term + ': ' + entry.explanation);
          });
          break;
        case 'example':
        case 'formula':
        case 'paragraph':
        default:
          lines.push(String(section.content || ''));
          break;
      }
    });

    lines.push('');
    lines.push('Summary');
    lines.push(content.summary);

    return lines.join('\n\n');
  },
};

function _validateSectionContent(section) {
  const { type, content } = section;

  if (type === 'paragraph' || type === 'example' || type === 'formula') {
    if (typeof content !== 'string' || !content.trim()) {
      return { ok: false, error: 'content must be a non-empty string for type "' + type + '".' };
    }
    return { ok: true };
  }

  if (type === 'bullets' || type === 'numbered') {
    if (!Array.isArray(content) || content.length === 0) {
      return { ok: false, error: 'content must be a non-empty array for type "' + type + '".' };
    }
    for (const item of content) {
      if (typeof item !== 'string' || !item.trim()) {
        return { ok: false, error: 'An item in a "' + type + '" section is empty.' };
      }
    }
    return { ok: true };
  }

  if (type === 'definition') {
    if (!Array.isArray(content) || content.length === 0) {
      return { ok: false, error: 'content must be a non-empty array of term/explanation pairs.' };
    }
    for (const entry of content) {
      if (
        !entry ||
        typeof entry.term !== 'string' || !entry.term.trim() ||
        typeof entry.explanation !== 'string' || !entry.explanation.trim()
      ) {
        return { ok: false, error: 'A definition entry is missing its term or explanation.' };
      }
    }
    return { ok: true };
  }

  return { ok: false, error: 'Unrecognized section type.' };
}
