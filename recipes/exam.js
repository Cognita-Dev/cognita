// recipes/exam.js
// Examination resource type. Has sections (each with its own questions),
// per-question marks, and a marking scheme. Validation checks that marks
// actually sum to the stated total — the most common way exams go wrong.

export const EXAM_RECIPE = {
  resourceType: 'exam',

  requiredFields: ['subject', 'classLevel', 'topic'],
  optionalFields: ['duration', 'totalMarks', 'curriculum', 'educationalLevel'],

  systemPrompt:
    'You are an expert examiner creating a formal examination. Generate the ' +
    'exam as a single JSON object and nothing else — no markdown fences, no ' +
    'commentary before or after. The JSON object must have exactly this shape:\n' +
    '{\n' +
    '  "title": string,\n' +
    '  "instructions": string,\n' +
    '  "durationMinutes": number,\n' +
    '  "totalMarks": number,\n' +
    '  "sections": [\n' +
    '    {\n' +
    '      "sectionTitle": string,\n' +
    '      "questions": [ { "number": number, "question": string, "marks": number } ]\n' +
    '    }\n' +
    '  ],\n' +
    '  "markingScheme": [ { "number": number, "answer": string, "marks": number } ]\n' +
    '}\n' +
    'Question numbers must be unique across the WHOLE exam (not restarting per ' +
    'section) and sequential starting at 1. The sum of every question\'s "marks" ' +
    'across all sections must exactly equal "totalMarks". The markingScheme must ' +
    'have exactly one entry per question, matching by number, and each entry\'s ' +
    '"marks" must match that question\'s marks exactly. Do not wrap the JSON in ' +
    'code fences.',

  buildUserPrompt(fields) {
    let prompt = 'Create an examination.\n';
    prompt += 'Subject: ' + fields.subject + '\n';
    prompt += 'Class: ' + fields.classLevel + '\n';
    prompt += 'Topic(s): ' + fields.topic + '\n';
    prompt += 'Duration: ' + (fields.duration || '60 minutes') + '\n';
    prompt += 'Total marks: ' + (fields.totalMarks || 100) + '\n';
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
    if (!Array.isArray(content.sections) || content.sections.length === 0) {
      return { ok: false, error: 'Missing or empty sections array.' };
    }
    if (typeof content.totalMarks !== 'number') {
      return { ok: false, error: 'Missing totalMarks.' };
    }

    const allQuestions = [];
    for (const section of content.sections) {
      if (!Array.isArray(section.questions) || section.questions.length === 0) {
        return { ok: false, error: 'A section has no questions.' };
      }
      allQuestions.push(...section.questions);
    }

    const numbers = allQuestions.map((q) => q.number).sort((a, b) => a - b);
    for (let i = 0; i < numbers.length; i++) {
      if (numbers[i] !== i + 1) {
        return { ok: false, error: 'Question numbering across sections is not sequential starting at 1.' };
      }
    }

    const marksSum = allQuestions.reduce((sum, q) => sum + (q.marks || 0), 0);
    if (marksSum !== content.totalMarks) {
      return { ok: false, error: 'Question marks sum to ' + marksSum + ' but totalMarks is ' + content.totalMarks + '.' };
    }

    if (!Array.isArray(content.markingScheme) || content.markingScheme.length !== allQuestions.length) {
      return { ok: false, error: 'Marking scheme does not have one entry per question.' };
    }

    const questionByNumber = new Map(allQuestions.map((q) => [q.number, q]));
    for (const entry of content.markingScheme) {
      const q = questionByNumber.get(entry.number);
      if (!q) {
        return { ok: false, error: 'Marking scheme references question ' + entry.number + ' which does not exist.' };
      }
      if (entry.marks !== q.marks) {
        return { ok: false, error: 'Marking scheme marks for question ' + entry.number + ' do not match the question\'s marks.' };
      }
    }

    return { ok: true };
  },

  toPlainTextParagraphs(content) {
    const lines = [];
    lines.push(content.title);
    lines.push('Duration: ' + content.durationMinutes + ' minutes | Total Marks: ' + content.totalMarks);
    lines.push('');
    lines.push(content.instructions);
    content.sections.forEach((section) => {
      lines.push('');
      lines.push(section.sectionTitle);
      section.questions.forEach((q) => {
        lines.push(q.number + '. ' + q.question + ' (' + q.marks + ' marks)');
      });
    });
    lines.push('');
    lines.push('Marking Scheme');
    content.markingScheme
      .slice()
      .sort((a, b) => a.number - b.number)
      .forEach((m) => {
        lines.push(m.number + '. ' + m.answer + ' (' + m.marks + ' marks)');
      });
    return lines.join('\n\n');
  },
};
