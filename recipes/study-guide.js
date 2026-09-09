// recipes/study-guide.js
// Revision-focused resource: key concepts, definitions, and practice
// prompts, organized by topic. No numeric-consistency checks needed here
// since there's no marks/answer-key pairing — validation just confirms
// the sections that matter are present and non-empty.

export const STUDY_GUIDE_RECIPE = {
  resourceType: 'study_guide',

  requiredFields: ['subject', 'classLevel', 'topic'],
  optionalFields: ['curriculum', 'educationalLevel'],

  systemPrompt:
    'You are an expert teacher creating a student study guide for revision. ' +
    'Generate it as a single JSON object and nothing else — no markdown ' +
    'fences, no commentary before or after. The JSON object must have exactly ' +
    'this shape:\n' +
    '{\n' +
    '  "title": string,\n' +
    '  "overview": string,\n' +
    '  "keyConcepts": [ { "term": string, "explanation": string } ],\n' +
    '  "summaryPoints": string[],\n' +
    '  "practiceQuestions": string[],\n' +
    '  "commonMistakes": string[]\n' +
    '}\n' +
    'Content must be age-appropriate for the given class level and focused ' +
    'specifically on the given topic. Do not wrap the JSON in code fences.',

  buildUserPrompt(fields) {
    let prompt = 'Create a study guide.\n';
    prompt += 'Subject: ' + fields.subject + '\n';
    prompt += 'Class: ' + fields.classLevel + '\n';
    prompt += 'Topic: ' + fields.topic + '\n';
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
    if (typeof content.overview !== 'string' || !content.overview.trim()) {
      return { ok: false, error: 'Missing overview.' };
    }
    if (!Array.isArray(content.keyConcepts) || content.keyConcepts.length === 0) {
      return { ok: false, error: 'Missing or empty keyConcepts array.' };
    }
    for (const concept of content.keyConcepts) {
      if (typeof concept.term !== 'string' || !concept.term.trim() ||
          typeof concept.explanation !== 'string' || !concept.explanation.trim()) {
        return { ok: false, error: 'A key concept is missing its term or explanation.' };
      }
    }
    if (!Array.isArray(content.summaryPoints) || content.summaryPoints.length === 0) {
      return { ok: false, error: 'Missing or empty summaryPoints array.' };
    }
    if (!Array.isArray(content.practiceQuestions) || content.practiceQuestions.length === 0) {
      return { ok: false, error: 'Missing or empty practiceQuestions array.' };
    }
    return { ok: true };
  },

  toPlainTextParagraphs(content) {
    const lines = [];
    lines.push(content.title);
    lines.push('');
    lines.push(content.overview);
    lines.push('');
    lines.push('Key Concepts');
    content.keyConcepts.forEach((c) => lines.push(c.term + ': ' + c.explanation));
    lines.push('');
    lines.push('Summary Points');
    content.summaryPoints.forEach((p) => lines.push('- ' + p));
    lines.push('');
    lines.push('Practice Questions');
    content.practiceQuestions.forEach((q, i) => lines.push((i + 1) + '. ' + q));
    if (content.commonMistakes && content.commonMistakes.length) {
      lines.push('');
      lines.push('Common Mistakes to Avoid');
      content.commonMistakes.forEach((m) => lines.push('- ' + m));
    }
    return lines.join('\n\n');
  },
};
