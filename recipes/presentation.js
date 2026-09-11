// recipes/presentation.js

export const PRESENTATION_RECIPE = {
  resourceType: 'presentation',

  requiredFields: [
    'subject',
    'classLevel',
    'topic',
  ],

  optionalFields: [
    'slideCount',
    'curriculum',
    'educationalLevel',
  ],

  systemPrompt:
    'You are an expert teacher creating a slide-by-slide presentation outline. ' +
    'Generate it as a single JSON object and nothing else — no markdown ' +
    'fences, no commentary. Shape:\n' +
    '{\n' +
    '  "title": string,\n' +
    '  "slides": [ { "slideNumber": number, "heading": string, "bulletPoints": string[], "speakerNotes": string } ]\n' +
    '}\n' +
    'slideNumber sequential starting at 1. Each slide should have 3-5 bullet ' +
    'points, short enough to fit on a slide. The number of slides must exactly ' +
    'match the requested slide count. Do not wrap in code fences.',

  buildUserPrompt(fields) {
    let p =
      'Create a presentation outline.\n' +
      'Subject: ' +
      fields.subject +
      '\n' +
      'Class: ' +
      fields.classLevel +
      '\n' +
      'Topic: ' +
      fields.topic +
      '\n';

    p +=
      'Number of slides: ' +
      (fields.slideCount || 8) +
      '\n';

    if (fields.curriculum) {
      p += 'Curriculum: ' + fields.curriculum + '\n';
    }

    if (fields.educationalLevel) {
      p +=
        'Educational level: ' +
        fields.educationalLevel +
        '\n';
    }

    return p;
  },

  validate(content, fields) {
    if (!content || typeof content !== 'object') {
      return {
        ok: false,
        error: 'Invalid object.',
      };
    }

    if (
      typeof content.title !== 'string' ||
      !content.title.trim()
    ) {
      return {
        ok: false,
        error: 'Missing title.',
      };
    }

    if (
      !Array.isArray(content.slides) ||
      content.slides.length === 0
    ) {
      return {
        ok: false,
        error: 'Missing slides.',
      };
    }

    const requestedSlideCount =
      fields && fields.slideCount
        ? Number(fields.slideCount)
        : 8;

    if (
      Number.isFinite(requestedSlideCount) &&
      content.slides.length !==
        requestedSlideCount
    ) {
      return {
        ok: false,
        error:
          'Generated ' +
          content.slides.length +
          ' slides but ' +
          requestedSlideCount +
          ' were requested.',
      };
    }

    const nums = content.slides
      .map((s) => s && s.slideNumber)
      .sort((a, b) => a - b);

    for (let i = 0; i < nums.length; i++) {
      if (nums[i] !== i + 1) {
        return {
          ok: false,
          error:
            'Slides not sequential from 1.',
        };
      }
    }

    for (const slide of content.slides) {
      if (
        typeof slide.heading !== 'string' ||
        !slide.heading.trim()
      ) {
        return {
          ok: false,
          error:
            'A slide is missing its heading.',
        };
      }

      if (
        !Array.isArray(slide.bulletPoints) ||
        slide.bulletPoints.length < 3 ||
        slide.bulletPoints.length > 5
      ) {
        return {
          ok: false,
          error:
            'Each slide must contain between 3 and 5 bullet points.',
        };
      }

      for (const bullet of slide.bulletPoints) {
        if (
          typeof bullet !== 'string' ||
          !bullet.trim()
        ) {
          return {
            ok: false,
            error:
              'A slide contains an empty bullet point.',
          };
        }
      }

      if (
        slide.speakerNotes !== undefined &&
        typeof slide.speakerNotes !== 'string'
      ) {
        return {
          ok: false,
          error:
            'A slide has invalid speaker notes.',
        };
      }
    }

    return { ok: true };
  },

  toPlainTextParagraphs(content) {
    const lines = [
      content.title,
      '',
    ];

    content.slides.forEach((slide) => {
      lines.push(
        'Slide ' +
          slide.slideNumber +
          ': ' +
          slide.heading
      );

      slide.bulletPoints.forEach((bullet) => {
        lines.push('- ' + bullet);
      });

      if (slide.speakerNotes) {
        lines.push(
          'Notes: ' +
            slide.speakerNotes
        );
      }

      lines.push('');
    });

    return lines.join('\n\n');
  },
};
