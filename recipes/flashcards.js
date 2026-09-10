export const FLASHCARDS_RECIPE = {
  resourceType: 'flashcards',
  requiredFields: ['subject', 'classLevel', 'topic'],
  optionalFields: ['cardCount', 'curriculum', 'educationalLevel'],

  systemPrompt:
    'You are an expert teacher creating study flashcards. Generate them as a ' +
    'single JSON object and nothing else — no markdown fences, no commentary. ' +
    'Shape:\n' +
    '{\n' +
    '  "title": string,\n' +
    '  "cards": [ { "front": string, "back": string } ]\n' +
    '}\n' +
    '"front" should be a short term or question, "back" a concise answer or ' +
    'definition. Do not wrap in code fences.',

  buildUserPrompt(fields) {
    let p = 'Create flashcards.\nSubject: ' + fields.subject + '\nClass: ' + fields.classLevel + '\nTopic: ' + fields.topic + '\n';
    p += 'Number of cards: ' + (fields.cardCount || 15) + '\n';
    if (fields.curriculum) p += 'Curriculum: ' + fields.curriculum + '\n';
    return p;
  },

  validate(c) {
    if (!c || typeof c !== 'object') return { ok: false, error: 'Invalid object.' };
    if (!c.title) return { ok: false, error: 'Missing title.' };
    if (!Array.isArray(c.cards) || c.cards.length === 0) return { ok: false, error: 'Missing cards.' };
    for (const card of c.cards) {
      if (!card.front || !card.back) return { ok: false, error: 'A card is missing its front or back.' };
    }
    return { ok: true };
  },

  toPlainTextParagraphs(c) {
    const lines = [c.title, ''];
    c.cards.forEach((card, i) => lines.push((i + 1) + '. ' + card.front + '  →  ' + card.back));
    return lines.join('\n\n');
  },
};
