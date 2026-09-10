// pdf-builder.js
// Builds a minimal, valid PDF from plain text — same "hand-write the format
// directly" approach as docx-builder.js, since Workers can't load native
// PDF libraries. Uses the standard Helvetica font (no embedding needed —
// it's one of the 14 fonts every PDF reader is required to support), plain
// left-aligned text, automatic word-wrap and pagination. No images, tables,
// or styling — this covers the "readable, downloadable PDF of the
// resource" case, not a designed layout.

const ENCODER = new TextEncoder();

const PAGE_WIDTH = 595;   // A4 in points
const PAGE_HEIGHT = 842;
const MARGIN = 72;
const FONT_SIZE = 11;
const LINE_HEIGHT = 15;
const USABLE_WIDTH = PAGE_WIDTH - MARGIN * 2;
const USABLE_HEIGHT = PAGE_HEIGHT - MARGIN * 2;
const LINES_PER_PAGE = Math.floor(USABLE_HEIGHT / LINE_HEIGHT);
// Rough average glyph width for Helvetica at FONT_SIZE, used only to decide
// wrap points — not exact per-character metrics, but close enough that
// text doesn't visibly overflow the page margin in practice.
const AVG_CHAR_WIDTH = FONT_SIZE * 0.5;
const MAX_CHARS_PER_LINE = Math.floor(USABLE_WIDTH / AVG_CHAR_WIDTH);

function _escapePdfText(str) {
  return String(str)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/[\r\n]+/g, ' ');
}

function _wrapLine(text, maxChars) {
  if (!text) return [''];
  const words = text.split(/\s+/);
  const lines = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? current + ' ' + word : word;
    if (candidate.length > maxChars && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

function _buildLines(paragraphs) {
  const lines = [];
  paragraphs.forEach((p, i) => {
    if (!p.trim()) {
      lines.push('');
      return;
    }
    _wrapLine(p, MAX_CHARS_PER_LINE).forEach((l) => lines.push(l));
    if (i < paragraphs.length - 1) lines.push('');
  });
  return lines;
}

function _chunkIntoPages(lines) {
  const pages = [];
  for (let i = 0; i < lines.length; i += LINES_PER_PAGE) {
    pages.push(lines.slice(i, i + LINES_PER_PAGE));
  }
  return pages.length ? pages : [[]];
}

function _buildContentStream(pageLines) {
  let stream = 'BT\n/F1 ' + FONT_SIZE + ' Tf\n' + LINE_HEIGHT + ' TL\n' +
    MARGIN + ' ' + (PAGE_HEIGHT - MARGIN) + ' Td\n';

  pageLines.forEach((line, i) => {
    if (i > 0) stream += 'T*\n';
    stream += '(' + _escapePdfText(line) + ') Tj\n';
  });

  stream += 'ET';
  return stream;
}

/**
 * Builds a .pdf file from plain text content and a title.
 * Returns a base64 string ready to send to the frontend for download.
 *
 * @param {string} content - plain text, paragraphs separated by blank lines
 * @param {string} title - rendered as the first line of page 1
 */
export async function buildSimplePdf(content, title) {
  const paragraphs = [title, '', ...content.split(/\n\s*\n/).map((p) => p.replace(/\n/g, ' ').trim())];
  const lines = _buildLines(paragraphs);
  const pages = _chunkIntoPages(lines);

  // Object numbering: 1 = Catalog, 2 = Pages, 3 = Font.
  // For page i (0-indexed): content stream = 4 + 2*i, page object = 5 + 2*i.
  const pageObjectIds = pages.map((_, i) => 5 + 2 * i);
  const contentObjectIds = pages.map((_, i) => 4 + 2 * i);
  const maxId = 5 + 2 * (pages.length - 1);

  const objects = new Map(); // id -> body string (without "N 0 obj"/"endobj" wrapper)

  objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>');

  const kids = pageObjectIds.map((id) => id + ' 0 R').join(' ');
  objects.set(2, '<< /Type /Pages /Kids [ ' + kids + ' ] /Count ' + pages.length + ' >>');

  objects.set(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

  pages.forEach((pageLines, i) => {
    const stream = _buildContentStream(pageLines);
    const streamBytes = ENCODER.encode(stream);
    objects.set(contentObjectIds[i], '<< /Length ' + streamBytes.length + ' >>\nstream\n' + stream + '\nendstream');
    objects.set(pageObjectIds[i],
      '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 3 0 R >> >> ' +
      '/MediaBox [0 0 ' + PAGE_WIDTH + ' ' + PAGE_HEIGHT + '] /Contents ' + contentObjectIds[i] + ' 0 R >>'
    );
  });

  // Serialize sequentially, tracking byte offsets for the xref table.
  let out = '%PDF-1.4\n';
  const offsets = new Map();

  for (let id = 1; id <= maxId; id++) {
    if (!objects.has(id)) continue;
    offsets.set(id, ENCODER.encode(out).length);
    out += id + ' 0 obj\n' + objects.get(id) + '\nendobj\n';
  }

  const xrefOffset = ENCODER.encode(out).length;
  const sortedIds = [...offsets.keys()].sort((a, b) => a - b);
  const highestId = sortedIds[sortedIds.length - 1];

  let xref = 'xref\n0 ' + (highestId + 1) + '\n0000000000 65535 f \n';
  for (let id = 1; id <= highestId; id++) {
    const offset = offsets.get(id);
    if (offset === undefined) {
      xref += '0000000000 00000 f \n';
    } else {
      xref += String(offset).padStart(10, '0') + ' 00000 n \n';
    }
  }

  out += xref;
  out += 'trailer\n<< /Size ' + (highestId + 1) + ' /Root 1 0 R >>\n';
  out += 'startxref\n' + xrefOffset + '\n%%EOF';

  const bytes = ENCODER.encode(out);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}
