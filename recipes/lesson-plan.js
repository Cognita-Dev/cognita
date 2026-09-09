// recipes/lesson-plan.js
// Defines the Lesson Plan resource type: what inputs it needs, the exact
// structured shape the AI must return, and how to turn that structure into
// plain-text paragraphs for docx export. Adding a new resource type later
// means adding a new file like this one — not touching the generate
// pipeline itself.

export const LESSON_PLAN_RECIPE = {
  resourceType: 'lesson_plan',

  // Fields the guided form collects. Natural-language requests get parsed
  // into this same shape before generation — see _inferFieldsFromText in
  // resources-endpoint.js.
  requiredFields: ['subject', 'classLevel', 'topic'],
  optionalFields: ['duration', 'curriculum', 'educationalLevel'],

  systemPrompt:
    'You are an expert curriculum designer. Generate a complete, ready-to-use ' +
    'lesson plan as a single JSON object and nothing else — no markdown fences, ' +
    'no commentary before or after. The JSON object must have exactly this shape:\n' +
    '{\n' +
    '  "title": string,\n' +
    '  "learningObjectives": string[],\n' +
    '  "previousKnowledge": string,\n' +
    '  "materials": string[],\n' +
    '  "introduction": string,\n' +
    '  "teacherActivities": string[],\n' +
    '  "studentActivities": string[],\n' +
    '  "assessment": string[],\n' +
    '  "conclusion": string,\n' +
    '  "homework": string,\n' +
    '  "teacherNotes": string\n' +
    '}\n' +
    'Content must be age-appropriate for the given class level, aligned to the ' +
    'given subject and topic, and usable without further editing. Do not include ' +
    'any field not listed above. Do not wrap the JSON in code fences.',

  buildUserPrompt(fields) {
    let prompt = 'Create a lesson plan.\n';
    prompt += 'Subject: ' + fields.subject + '\n';
    prompt += 'Class: ' + fields.classLevel + '\n';
    prompt += 'Topic: ' + fields.topic + '\n';
    if (fields.duration) prompt += 'Duration: ' + fields.duration + '\n';
    if (fields.curriculum) prompt += 'Curriculum: ' + fields.curriculum + '\n';
    if (fields.educationalLevel) prompt += 'Educational level: ' + fields.educationalLevel + '\n';
    return prompt;
  },

  // Confirms the parsed JSON actually has the fields we asked for, with the
  // right types. Returns { ok: true } or { ok: false, error }.
  validate(content) {
    if (!content || typeof content !== 'object') {
      return { ok: false, error: 'Generated content was not a valid object.' };
    }
    const requiredArrayFields = ['learningObjectives', 'materials', 'teacherActivities', 'studentActivities', 'assessment'];
    for (const field of requiredArrayFields) {
      if (!Array.isArray(content[field]) || content[field].length === 0) {
        return { ok: false, error: 'Missing or empty field: ' + field };
      }
    }
    const requiredStringFields = ['title', 'previousKnowledge', 'introduction', 'conclusion', 'homework', 'teacherNotes'];
    for (const field of requiredStringFields) {
      if (typeof content[field] !== 'string' || !content[field].trim()) {
        return { ok: false, error: 'Missing or empty field: ' + field };
      }
    }
    return { ok: true };
  },

  // Turns the structured object into plain-text paragraphs for docx-builder.js,
  // which expects paragraphs separated by blank lines.
  toPlainTextParagraphs(content) {
    const lines = [];
    lines.push(content.title);
    lines.push('');
    lines.push('Learning Objectives');
    content.learningObjectives.forEach((o) => lines.push('- ' + o));
    lines.push('');
    lines.push('Previous Knowledge');
    lines.push(content.previousKnowledge);
    lines.push('');
    lines.push('Materials');
    content.materials.forEach((m) => lines.push('- ' + m));
    lines.push('');
    lines.push('Introduction');
    lines.push(content.introduction);
    lines.push('');
    lines.push('Teacher Activities');
    content.teacherActivities.forEach((a) => lines.push('- ' + a));
    lines.push('');
    lines.push('Student Activities');
    content.studentActivities.forEach((a) => lines.push('- ' + a));
    lines.push('');
    lines.push('Assessment');
    content.assessment.forEach((a) => lines.push('- ' + a));
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
