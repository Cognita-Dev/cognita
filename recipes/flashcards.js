// recipes/flashcards.js

export const FLASHCARDS_RECIPE = {
  resourceType: 'flashcards',

  requiredFields: ['subject', 'classLevel', 'topic'],

  optionalFields: [
    'cardCount',
    'difficulty',
    'cardStyle',
    'curriculum',
    'educationalLevel',
  ],

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
    '      "difficulty": "easy" | "medium" | "hard"\\n' +
    '    }\\n' +
    '  ]\\n' +
    '}\\n' +
    'Cards must be numbered sequentially starting at 1. Each card must test one ' +
    'useful idea. Fronts should be concise. Backs should be accurate and concise. ' +
    'Avoid duplicate or nearly duplicate cards. Match the requested difficulty and ' +
    'card style. Do not wrap the JSON in code fences.',

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
