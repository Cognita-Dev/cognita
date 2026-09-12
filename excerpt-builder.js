// excerpt-builder.js
//
// Builds a plain-text excerpt from a resource's structuredContent —
// used anywhere a resource is listed rather than opened, so a card or
// row can show what's actually inside instead of just a title.
//
// Isomorphic on purpose: no DOM APIs, no Node APIs, just plain JS, so
// the exact same file is imported two ways:
//   - By the Worker backend (library-cache.js / library-endpoint.js),
//     for admin/library content — a browsing user's list request
//     never carries full content, so the excerpt has to be computed
//     once, server-side, and cached alongside the rest of the index
//     entry.
//   - By the browser frontend (js/resources.js), for a user's own
//     resources — those already arrive with full structuredContent on
//     every /api/resources/list response, so the excerpt is just
//     computed client-side from what's already there. No extra
//     fetch, no backend change needed for that path.
//
// Sizing: rather than one fixed length, the excerpt grows to fit
// what's actually there, between a floor and a ceiling:
//   - MIN_EXCERPT_CHARS is a soft floor. Once the accumulated text
//     passes it, no more content is pulled in — a short flashcard
//     deck or a long scheme of work both stop at a natural block
//     boundary, not a hard character cutoff.
//   - MAX_EXCERPT_CHARS is a hard ceiling. Content longer than this
//     (a full lesson note, a long exam) is cut at a word boundary and
//     marked with an ellipsis, so cards and rows stay a bounded size
//     no matter how much content the resource has.
// A resource with less content than the floor (e.g. a 6-card
// flashcard deck) just returns everything it has — the floor is a
// target to stop early at, never something padded out artificially.

const MIN_EXCERPT_CHARS = 1000;
const MAX_EXCERPT_CHARS = 3000;

// title is surfaced separately by every caller (card heading, row
// title, panel title) so it's left out of the excerpt body itself.
const SKIP_KEYS = new Set(['title']);

function _isWellFormedSections(value) {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((s) => s && typeof s === 'object' && typeof s.heading === 'string')
  );
}

// Recursively turns any value — string, number, array, or nested
// object — into a single readable line/block of text. Mirrors the
// same generic flattening already used by the on-page preview
// renderers (resources.js/library.js's renderStructuredPreview and
// resources-endpoint.js's _structuredContentToSections), just
// collapsed to plain text instead of {heading,type,content} objects
// or HTML, since an excerpt only needs to read naturally.
function _flattenValue(value) {
  if (value === null || typeof value === 'undefined') return '';
  if (Array.isArray(value)) {
    return value.map(_flattenValue).filter(Boolean).join('\n');
  }
  if (typeof value === 'object') {
    return Object.values(value)
      .map((v) => (typeof v === 'string' || typeof v === 'number' ? String(v) : _flattenValue(v)))
      .filter(Boolean)
      .join(' — ');
  }
  return String(value).trim();
}

// Walks structuredContent into an ordered list of plain-text blocks —
// introduction first, then either well-formed sections or a generic
// key-by-key flattening, then summary last.
function _contentToBlocks(content) {
  if (!content || typeof content !== 'object') return [];
  const blocks = [];

  if (typeof content.introduction === 'string' && content.introduction.trim()) {
    blocks.push(content.introduction.trim());
  }

  if (_isWellFormedSections(content.sections)) {
    content.sections.forEach((s) => {
      const body = _flattenValue(s.content);
      if (body) blocks.push(body);
    });
  } else {
    for (const key in content) {
      if (SKIP_KEYS.has(key) || key === 'introduction' || key === 'summary') continue;
      const body = _flattenValue(content[key]);
      if (body) blocks.push(body);
    }
  }

  if (typeof content.summary === 'string' && content.summary.trim()) {
    blocks.push(content.summary.trim());
  }

  return blocks;
}

// Cuts text to at most `limit` chars, breaking on a word boundary
// rather than mid-word, and marks the cut with a trailing ellipsis.
function _truncateAtWord(text, limit) {
  if (text.length <= limit) return text;
  const slice = text.slice(0, limit);
  const lastSpace = slice.lastIndexOf(' ');
  // Only back off to the last space if that doesn't throw away most
  // of the slice (e.g. one very long unbroken block) — otherwise a
  // hard cut is closer to the requested limit than a huge trim would be.
  const cut = lastSpace > limit * 0.6 ? slice.slice(0, lastSpace) : slice;
  return cut.trim() + '…';
}

// Builds a plain-text excerpt from a resource's structuredContent.
// Returns '' if there's nothing to show yet (e.g. content is still
// null while a resource is generating).
export function buildExcerpt(structuredContent, options) {
  const opts = options || {};
  const min = opts.minChars || MIN_EXCERPT_CHARS;
  const max = opts.maxChars || MAX_EXCERPT_CHARS;

  const blocks = _contentToBlocks(structuredContent);
  if (blocks.length === 0) return '';

  let out = '';
  for (const block of blocks) {
    if (out.length >= min) break;
    out = out ? out + '\n\n' + block : block;
  }

  return _truncateAtWord(out, max);
}
