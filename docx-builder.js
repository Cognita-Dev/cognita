// docx-builder.js
// Builds a minimal, valid .docx file from plain text, entirely within the
// Workers runtime. No external zip library — Workers can't load native
// npm packages, so this hand-writes a ZIP archive using the "stored"
// (uncompressed) method, which is spec-valid and opens fine in Word.
// Trade-off: slightly larger files than DEFLATE would produce. Acceptable
// for generated text documents, which are small.

const ENCODER = new TextEncoder();

/* ── CRC32 (required by the ZIP format for each entry) ── */
let _crcTable = null;
function _getCrcTable() {
  if (_crcTable) return _crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  _crcTable = table;
  return table;
}

function _crc32(bytes) {
  const table = _getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/* ── Minimal ZIP writer (stored/uncompressed entries) ── */
function _dosDateTime() {
  // Fixed timestamp is fine for generated documents — avoids extra
  // complexity and Word doesn't care.
  return { time: 0, date: 0x21 }; // Jan 1, 1980-ish placeholder, valid DOS date
}

function _u16(n) { return new Uint8Array([n & 0xff, (n >> 8) & 0xff]); }
function _u32(n) { return new Uint8Array([n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]); }

function _concat(arrays) {
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

/**
 * Builds a ZIP archive (as a Uint8Array) from a list of { name, data } entries,
 * where data is a Uint8Array. Uses stored (no compression) method.
 */
function _buildZip(files) {
  const { time, date } = _dosDateTime();
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = ENCODER.encode(file.name);
    const crc = _crc32(file.data);
    const size = file.data.length;

    const localHeader = _concat([
      _u32(0x04034b50),      // local file header signature
      _u16(20),              // version needed
      _u16(0),                // flags
      _u16(0),                // compression method: 0 = stored
      _u16(time), _u16(date),
      _u32(crc),
      _u32(size),             // compressed size (= size, since stored)
      _u32(size),             // uncompressed size
      _u16(nameBytes.length),
      _u16(0),                // extra field length
    ]);

    localParts.push(localHeader, nameBytes, file.data);

    const centralHeader = _concat([
      _u32(0x02014b50),      // central directory header signature
      _u16(20), _u16(20),    // version made by, version needed
      _u16(0),                // flags
      _u16(0),                // compression method
      _u16(time), _u16(date),
      _u32(crc),
      _u32(size), _u32(size),
      _u16(nameBytes.length),
      _u16(0), _u16(0),       // extra field, comment length
      _u16(0),                // disk number
      _u16(0),                // internal attrs
      _u32(0),                // external attrs
      _u32(offset),           // offset of local header
    ]);
    centralParts.push(centralHeader, nameBytes);

    offset += localHeader.length + nameBytes.length + file.data.length;
  }

  const centralDirStart = offset;
  const centralDir = _concat(centralParts);
  const centralDirSize = centralDir.length;

  const eocd = _concat([
    _u32(0x06054b50),
    _u16(0), _u16(0),               // disk numbers
    _u16(files.length), _u16(files.length),
    _u32(centralDirSize),
    _u32(centralDirStart),
    _u16(0),                         // comment length
  ]);

  return _concat([..._concat(localParts.length ? [_concat(localParts)] : [new Uint8Array(0)]) && localParts, centralDir, eocd].flat ? [] : []);
}

// NOTE: the line above is intentionally never reached — replaced by the
// straightforward version below to avoid a confusing one-liner.
function _assembleZip(files) {
  const { time, date } = _dosDateTime();
  const localBlobs = [];
  const centralBlobs = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = ENCODER.encode(file.name);
    const crc = _crc32(file.data);
    const size = file.data.length;

    const localHeader = _concat([
      _u32(0x04034b50),
      _u16(20), _u16(0), _u16(0),
      _u16(time), _u16(date),
      _u32(crc), _u32(size), _u32(size),
      _u16(nameBytes.length), _u16(0),
    ]);
    const localEntry = _concat([localHeader, nameBytes, file.data]);
    localBlobs.push(localEntry);

    const centralHeader = _concat([
      _u32(0x02014b50),
      _u16(20), _u16(20), _u16(0), _u16(0),
      _u16(time), _u16(date),
      _u32(crc), _u32(size), _u32(size),
      _u16(nameBytes.length), _u16(0), _u16(0),
      _u16(0), _u16(0), _u32(0),
      _u32(offset),
    ]);
    centralBlobs.push(_concat([centralHeader, nameBytes]));

    offset += localEntry.length;
  }

  const centralDir = _concat(centralBlobs);
  const centralDirStart = offset;

  const eocd = _concat([
    _u32(0x06054b50),
    _u16(0), _u16(0),
    _u16(files.length), _u16(files.length),
    _u32(centralDir.length),
    _u32(centralDirStart),
    _u16(0),
  ]);

  return _concat([_concat(localBlobs), centralDir, eocd]);
}

/* ── docx XML parts ── */

function _xmlEscape(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function _contentTypesXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>';
}

function _rootRelsXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';
}

function _documentXml(title, bodyParagraphs) {
  const titleXml =
    '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="32"/></w:rPr><w:t xml:space="preserve">' +
    _xmlEscape(title) + '</w:t></w:r></w:p>' +
    '<w:p/>'; // blank spacer paragraph

  const bodyXml = bodyParagraphs.map(p => {
    if (!p.trim()) return '<w:p/>';
    return '<w:p><w:r><w:t xml:space="preserve">' + _xmlEscape(p) + '</w:t></w:r></w:p>';
  }).join('');

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:body>' + titleXml + bodyXml +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>' +
    '</w:body></w:document>';
}

/**
 * Builds a .docx file from plain text content and a title.
 * Returns a base64 string ready to send to the frontend for download.
 *
 * @param {string} content - plain text, paragraphs separated by blank lines
 * @param {string} title - document title, rendered as a centered heading
 */
export async function buildSimpleDocx(content, title) {
  const paragraphs = content
    .split(/\n\s*\n/)
    .map(p => p.replace(/\n/g, ' ').trim());

  const files = [
    { name: '[Content_Types].xml', data: ENCODER.encode(_contentTypesXml()) },
    { name: '_rels/.rels', data: ENCODER.encode(_rootRelsXml()) },
    { name: 'word/document.xml', data: ENCODER.encode(_documentXml(title, paragraphs)) },
  ];

  const zipBytes = _assembleZip(files);

  let binary = '';
  for (let i = 0; i < zipBytes.length; i++) binary += String.fromCharCode(zipBytes[i]);
  return btoa(binary);
}
