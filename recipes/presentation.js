export const PRESENTATION_RECIPE = {
  resourceType: 'presentation',
  requiredFields: ['subject', 'classLevel', 'topic'],
  optionalFields: ['slideCount', 'curriculum', 'educationalLevel'],

  systemPrompt:
    'You are an expert teacher creating a slide-by-slide presentation outline. ' +
    'Generate it as a single JSON object and nothing else — no markdown ' +
    'fences, no commentary. Shape:\n' +
    '{\n' +
    '  "title": string,\n' +
    '  "slides": [ { "slideNumber": number, "heading": string, "bulletPoints": string[], "speakerNotes": string } ]\n' +
    '}\n' +
    'slideNumber sequential starting at 1. Each slide should have 3-5 bullet ' +
    'points, short enough to fit on a slide. Do not wrap in code fences.',

  buildUserPrompt(fields) {
    let p = 'Create a presentation outline.\nSubject: ' + fields.subject + '\nClass: ' + fields.classLevel + '\nTopic: ' + fields.topic + '\n';
    p += 'Number of slides: ' + (fields.slideCount || 8) + '\n';
    if (fields.curriculum) p += 'Curriculum: ' + fields.curriculum + '\n';
    return p;
  },

  validate(c) {
    if (!c || typeof c !== 'object') return { ok: false, error: 'Invalid object.' };
    if (!c.title) return { ok: false, error: 'Missing title.' };
    if (!Array.isArray(c.slides) || c.slides.length === 0) return { ok: false, error: 'Missing slides.' };
    const nums = c.slides.map((s) => s.slideNumber).sort((a, b) => a - b);
    for (let i = 0; i < nums.length; i++) if (nums[i] !== i + 1) return { ok: false, error: 'Slides not sequential from 1.' };
    for (const s of c.slides) {
      if (!s.heading) return { ok: false, error: 'A slide is missing its heading.' };
      if (!Array.isArray(s.bulletPoints) || s.bulletPoints.length === 0) return { ok: false, error: 'A slide is missing bullet points.' };
    }
    return { ok: true };
  },

  toPlainTextParagraphs(c) {
    const lines = [c.title, ''];
    c.slides.forEach((s) => {
      lines.push('Slide ' + s.slideNumber + ': ' + s.heading);
      s.bulletPoints.forEach((b) => lines.push('- ' + b));
      if (s.speakerNotes) lines.push('Notes: ' + s.speakerNotes);
      lines.push('');
    });
    return lines.join('\n\n');
  },
};
