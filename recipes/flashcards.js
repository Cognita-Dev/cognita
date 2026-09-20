// recipes/flashcards.js

export const FLASHCARDS_RECIPE = {
  resourceType: 'flashcards',

  // Lets resources-endpoint.js know this recipe can carry AI-generated
  // images on its cards (gated by plan + quota, see entitlements.js),
  // without hardcoding `resourceType === 'flashcards'` checks in the
  // generic generation pipeline. Other recipes simply omit this flag.
  supportsCardImages: true,

  requiredFields: ['subject', 'classLevel', 'topic'],

  optionalFields: [
    'cardCount',
    'difficulty',
    'cardStyle',
    'curriculum',
    'educationalLevel',
    // When true, the AI also writes a short visual description per card
    // (imagePrompt) and resources-endpoint.js turns each one into a real
    // generated image via Cloudflare Workers AI. Gated server-side by
    // plan + daily quota (see entitlements.js flashcardImagePerDay) —
    // this flag alone never grants image generation, it only asks for
    // the prompts to exist so images CAN be attached when entitled.
    'includeImages',
  ],

  // Pedagogical note (see recipes/README-ish comment pattern used across
  // this file): pairing a picture with a term/definition is a
  // well-documented technique — "dual coding" (Paivio) — where verbal
  // and visual encoding of the same idea reinforces recall better than
  // text alone. That's the whole point of `includeImages`: it's not
  // decoration, it's a second retrieval cue, so imagePrompt should
  // describe something concrete and visualizable (the object, scene, or
  // process the card is about), not a restatement of the answer text.
  systemPrompt:
    'You are an expert teacher creating a high-quality study flashcard deck. ' +
    'Generate a single JSON object and nothing else — no markdown fences and no commentary. ' +
    'Use exactly this structure:\\n' +
    '{\\n' +
    '  "title": string,\\n' +
    '  "cards": [\\n' +
    '    {\\n' +
    '      "number": number,\\n' +
    '      "front": string,\\n' +
    '      "back": string,\\n' +
    '      "difficulty": "easy" | "medium" | "hard",\\n' +
    '      "imagePrompt": string (optional — only include this key at all if asked)\\n' +
    '    }\\n' +
    '  ]\\n' +
    '}\\n' +
    'Cards must be numbered sequentially starting at 1. Each card must test one ' +
    'useful idea. Fronts should be concise. Backs should be accurate and concise. ' +
    'Avoid duplicate or nearly duplicate cards. Match the requested difficulty and ' +
    'card style. Do not wrap the JSON in code fences. Only include "imagePrompt" ' +
    'on a card if the user prompt explicitly asks for image prompts — otherwise ' +
    'omit that key entirely rather than sending an empty string.',

  buildUserPrompt(fields) {
    const count = Number(fields.cardCount) || 15;
    const difficulty = fields.difficulty || 'medium';
    const cardStyle = fields.cardStyle || 'concept_definition';

    let prompt = 'Create a flashcard deck.\\n';
    prompt += 'Subject: ' + fields.subject + '\\n';
    prompt += 'Class: ' + fields.classLevel + '\\n';
    prompt += 'Topic: ' + fields.topic + '\\n';
    prompt += 'Number of cards: ' + count + '\\n';
    prompt += 'Difficulty: ' + difficulty + '\\n';
    prompt += 'Card style: ' + cardStyle + '\\n';

    if (fields.curriculum) {
      prompt += 'Curriculum: ' + fields.curriculum + '\\n';
    }

    if (fields.educationalLevel) {
      prompt += 'Educational level: ' + fields.educationalLevel + '\\n';
    }

    if (fields.includeImages) {
      prompt +=
        'For every card, also write "imagePrompt": a short (under 20 words), ' +
        'concrete, visualizable description of a real-world object, scene, ' +
        'diagram subject, or process related to the card — something a text-to-image ' +
        'model could draw. Avoid describing text, labels, or the answer itself; ' +
        'describe what should be SEEN, not what should be READ.\\n';
    }

    return prompt;
  },

  validate(content, fields = {}) {
    if (!content || typeof content !== 'object') {
      return { ok: false, error: 'Generated content was not a valid object.' };
    }

    if (typeof content.title !== 'string' || !content.title.trim()) {
      return { ok: false, error: 'Missing title.' };
    }

    if (!Array.isArray(content.cards) || content.cards.length === 0) {
      return { ok: false, error: 'Missing cards.' };
    }

    const requestedCount = Number(fields.cardCount) || 15;

    if (content.cards.length !== requestedCount) {
      return {
        ok: false,
        error:
          'Expected ' +
          requestedCount +
          ' cards but received ' +
          content.cards.length +
          '.',
      };
    }

    for (let i = 0; i < content.cards.length; i++) {
      const card = content.cards[i];

      if (card.number !== i + 1) {
        return {
          ok: false,
          error: 'Card numbering must be sequential starting at 1.',
        };
      }

      if (
        typeof card.front !== 'string' ||
        !card.front.trim() ||
        typeof card.back !== 'string' ||
        !card.back.trim()
      ) {
        return {
          ok: false,
          error: 'A card is missing its front or back.',
        };
      }

      if (!['easy', 'medium', 'hard'].includes(card.difficulty)) {
        return {
          ok: false,
          error: 'A card has an invalid difficulty.',
        };
      }
    }

    return { ok: true };
  },

  toPlainTextParagraphs(content) {
    const lines = [content.title, ''];

    content.cards.forEach((card) => {
      lines.push(
        card.number +
          '. ' +
          card.front +
          '  →  ' +
          card.back +
          ' [' +
          card.difficulty +
          ']'
      );
    });

    return lines.join('\n\n');
  },
};
