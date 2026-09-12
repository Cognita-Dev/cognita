// recipes/lesson-notes.js
//
// A Lesson Note is the actual classroom content a teacher writes on the
// board (or hands out) for pupils/students to copy into their notebooks.
// It is NOT a lesson plan (that's recipes/lesson-plan.js — teacher-facing
// planning) and NOT a study guide (that's revision-facing). This recipe
// produces the taught content itself: definitions, explanations,
// examples, formulas, and so on, structured so it reads like a real
// school note rather than an AI response.
//
// IMPORTANT: class level controls tone and vocabulary ONLY. It must
// never be used to shrink coverage of the topic. A Primary 5 note and an
// SS2 note on the same topic should both be thorough — the SS2 note may
// use more technical vocabulary and go into more depth on mechanisms,
// but a younger class level is not a license to produce a shorter or
// less complete note. Length and section count are not capped; they are
// whatever the topic genuinely requires.

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
  optionalFields: ['curriculum', 'educationalLevel', 'customInstructions'],

  // Lesson notes need far more room than most other resource types
  // because they must cover a topic exhaustively rather than
  // summarizing it. resources-endpoint.js reads this if present and
  // falls back to its own default otherwise.
  maxTokens: 14000,

  systemPrompt:
    'You are an experienced classroom teacher writing a Lesson Note. ' +
    'A Lesson Note is the actual academic content a teacher writes on the ' +
    'board for pupils/students to copy into their notebooks and study from. ' +
    'It is the taught content itself — NOT a lesson plan, NOT a teaching ' +
    'guide, and NOT a study guide.\n\n' +

    'THE MOST IMPORTANT RULE: class level controls vocabulary and style ' +
    'ONLY. It never controls how much of the topic you cover. Do not write ' +
    'a shorter or thinner note because the class level is younger — write ' +
    'the full, complete picture of the topic every time, and simply adjust ' +
    'the words, sentence complexity, and depth of technical explanation to ' +
    'suit the stated class level. A note for a younger class should still ' +
    'walk through every major idea the topic has, just in simpler language ' +
    'and with more concrete, relatable examples. A note for an older class ' +
    'can use more technical vocabulary and go deeper into mechanisms, ' +
    'reasoning, and edge cases — but "deeper," not "the same idea with a ' +
    'harder textbook. Both must be thorough.\n\n' +

    'COVERAGE, NOT BREVITY: there is no target length or target number of ' +
    'sections. Do not artificially stop after covering just one or two ' +
    'angles of the topic. Think about everything a student would actually ' +
    'need to know about this exact topic, and include it. Depending on the ' +
    'topic, that typically means covering (only where genuinely relevant ' +
    'to the topic — do not force irrelevant ones): a clear definition; ' +
    'background or context; every major concept or sub-topic; important ' +
    'terms and their definitions; classifications or types; the process or ' +
    'mechanism involved, step by step; relevant formulas or equations with ' +
    'explanation; worked examples; causes and effects; comparisons or ' +
    'differences with related concepts; characteristics or properties; ' +
    'uses, applications, or real-world relevance; common misconceptions or ' +
    'points of confusion; and a closing summary. A genuinely thorough note ' +
    'on most topics will need many sections, not three or four — write as ' +
    'many as the topic actually has material for. Prefer being ' +
    'comprehensive over being concise. Do not pad with filler or repeat ' +
    'yourself just to look longer — every section must add real content.\n\n' +

    'Strict rules:\n' +
    '- Never include teacher-facing planning content such as learning ' +
    'objectives, previous knowledge, materials, teacher activities, student ' +
    'activities, assessment strategy, lesson duration, teaching method, ' +
    'classroom management, or homework instructions.\n' +
    '- Never address the reader conversationally, never mention being an AI, ' +
    'and never write instructions like "the teacher should..." or "ask the ' +
    'students to...". Write the actual content being taught, e.g. ' +
    '"Photosynthesis is the process by which green plants make their own food."\n' +
    '- Use words the stated class level can understand. Do not use ' +
    'unnecessarily complicated vocabulary. When a technical term is ' +
    'genuinely required for the subject, include it and explain it simply, ' +
    'ideally as its own definition entry.\n' +
    '- Structure the note using whichever sections genuinely fit the topic ' +
    '— do not force the same fixed set of sections onto every topic, and do ' +
    'not limit yourself to a small fixed number of them either.\n' +
    '- Practice questions or examples may appear inside a section only if ' +
    'they support understanding the content — the note must not become a ' +
    'quiz or a flashcard deck.\n' +
    '- If the user provides additional instructions, follow them carefully ' +
    'in addition to everything above, unless they directly conflict with ' +
    'producing a genuine, complete Lesson Note.\n\n' +

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
    '- "paragraph": content is a single string (can be a substantial, ' +
    'multi-sentence explanation — do not artificially shorten it).\n' +
    '- "bullets" or "numbered": content is a string array.\n' +
    '- "definition": content is an array of { "term", "explanation" } objects.\n' +
    '- "example": content is a string (a worked or illustrative example).\n' +
    '- "formula": content is a string containing the formula/equation, ' +
    'optionally followed by a short explanation on the next line.\n' +
    'Order sections the way a teacher would naturally teach the topic, ' +
    'building from foundational ideas to more advanced ones. "summary" is a ' +
    'closing recap that touches on the major points covered, in plain ' +
    'language.',

  buildUserPrompt(fields) {
    let prompt = 'Write a complete, thorough Lesson Note.\n';
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
      '\nWrite the note as the actual content a teacher would put on the ' +
      'board for this class to copy. Cover the topic exhaustively — every ' +
      'major concept, term, process, example, and related idea a student at ' +
      'this level should walk away knowing. Remember: the class level ' +
      'changes your vocabulary and depth of technical explanation, not how ' +
      'much of the topic you cover. Adapt the structure to whatever this ' +
      'specific topic needs rather than using a fixed template, and do not ' +
      'limit the number of sections.';

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

    // A genuinely thorough note needs more than a couple of sections —
    // this is a floor, not a ceiling. There is no upper limit.
    if (!Array.isArray(content.sections) || content.sections.length < 3) {
      return { ok: false, error: 'Missing or insufficient sections (need at least 3 for a thorough note).' };
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
