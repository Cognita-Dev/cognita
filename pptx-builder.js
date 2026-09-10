// pptx-builder.js
// Builds a minimal, valid .pptx from a slide array (title + bullet points
// per slide). Same hand-written-ZIP approach as docx-builder.js — no
// external library, stored/uncompressed entries. This produces the minimal
// OOXML part set PowerPoint requires: content types, root relationships,
// one slide master, one slide layout, one theme, and one slide part per
// slide. Speaker notes and custom design are intentionally out of scope
// for this first version — flagging that honestly rather than faking it.

const ENCODER = new TextEncoder();

/* ── ZIP writer — identical approach to docx-builder.js, duplicated here
   so this file has no dependency on that one. ── */
let _crcTable = null;
function _getCrcTable() {
  if (_crcTable) return _crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  _crcTable = table;
  return table;
}
function _crc32(bytes) {
  const table = _getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
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
function _assembleZip(files) {
  const time = 0, date = 0x21;
  const localBlobs = [], centralBlobs = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = ENCODER.encode(file.name);
    const crc = _crc32(file.data);
    const size = file.data.length;

    const localHeader = _concat([
      _u32(0x04034b50), _u16(20), _u16(0), _u16(0), _u16(time), _u16(date),
      _u32(crc), _u32(size), _u32(size), _u16(nameBytes.length), _u16(0),
    ]);
    const localEntry = _concat([localHeader, nameBytes, file.data]);
    localBlobs.push(localEntry);

    const centralHeader = _concat([
      _u32(0x02014b50), _u16(20), _u16(20), _u16(0), _u16(0), _u16(time), _u16(date),
      _u32(crc), _u32(size), _u32(size), _u16(nameBytes.length), _u16(0), _u16(0),
      _u16(0), _u16(0), _u32(0), _u32(offset),
    ]);
    centralBlobs.push(_concat([centralHeader, nameBytes]));
    offset += localEntry.length;
  }

  const centralDir = _concat(centralBlobs);
  const centralDirStart = offset;
  const eocd = _concat([
    _u32(0x06054b50), _u16(0), _u16(0), _u16(files.length), _u16(files.length),
    _u32(centralDir.length), _u32(centralDirStart), _u16(0),
  ]);

  return _concat([_concat(localBlobs), centralDir, eocd]);
}

function _xmlEscape(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/* ── Static OOXML parts that don't vary per-deck ── */

function _contentTypesXml(slideCount) {
  const slideOverrides = Array.from({ length: slideCount }, (_, i) =>
    '<Override PartName="/ppt/slides/slide' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
  ).join('');

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
    '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
    '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
    slideOverrides +
    '</Types>';
}

function _rootRelsXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
    '</Relationships>';
}

function _presentationXml(slideCount) {
  const sldIds = Array.from({ length: slideCount }, (_, i) =>
    '<p:sldId id="' + (256 + i) + '" r:id="rId' + (i + 2) + '"/>'
  ).join('');

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    '<p:sldIdLst>' + sldIds + '</p:sldIdLst>' +
    '<p:sldSz cx="12192000" cy="6858000"/>' +
    '<p:notesSz cx="6858000" cy="9144000"/>' +
    '</p:presentation>';
}

function _presentationRelsXml(slideCount) {
  const slideRels = Array.from({ length: slideCount }, (_, i) =>
    '<Relationship Id="rId' + (i + 2) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide' + (i + 1) + '.xml"/>'
  ).join('');

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>' +
    slideRels +
    '</Relationships>';
}

function _slideMasterXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<p:cSld><p:spTree>' +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr/>' +
    '</p:spTree></p:cSld>' +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ' +
    'accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
    '</p:sldMaster>';
}

function _slideMasterRelsXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>' +
    '</Relationships>';
}

function _slideLayoutXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="title">' +
    '<p:cSld><p:spTree>' +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr/>' +
    '</p:spTree></p:cSld>' +
    '</p:sldLayout>';
}

function _slideLayoutRelsXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>' +
    '</Relationships>';
}

function _themeXml() {
  // Minimal valid theme — a real design theme would define fonts/colors in
  // depth, but PowerPoint accepts this abbreviated form without error.
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Cognita">' +
    '<a:themeElements>' +
    '<a:clrScheme name="Cognita">' +
    '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
    '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
    '<a:dk2><a:srgbClr val="171717"/></a:dk2>' +
    '<a:lt2><a:srgbClr val="F7F7F5"/></a:lt2>' +
    '<a:accent1><a:srgbClr val="3F6B5B"/></a:accent1>' +
    '<a:accent2><a:srgbClr val="8DB7A5"/></a:accent2>' +
    '<a:accent3><a:srgbClr val="6F6F6A"/></a:accent3>' +
    '<a:accent4><a:srgbClr val="8C8C86"/></a:accent4>' +
    '<a:accent5><a:srgbClr val="B4B4AE"/></a:accent5>' +
    '<a:accent6><a:srgbClr val="365D4F"/></a:accent6>' +
    '<a:hlink><a:srgbClr val="3F6B5B"/></a:hlink>' +
    '<a:folHlink><a:srgbClr val="365D4F"/></a:folHlink>' +
    '</a:clrScheme>' +
    '<a:fontScheme name="Cognita">' +
    '<a:majorFont><a:latin typeface="Calibri"/></a:majorFont>' +
    '<a:minorFont><a:latin typeface="Calibri"/></a:minorFont>' +
    '</a:fontScheme>' +
    '<a:fmtScheme name="Cognita">' +
    '<a:fillStyleLst><a:solidFill><a:schemeClr val="accent1"/></a:solidFill>' +
    '<a:solidFill><a:schemeClr val="accent1"/></a:solidFill>' +
    '<a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:fillStyleLst>' +
    '<a:lnStyleLst><a:ln><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:ln>' +
    '<a:ln><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:ln>' +
    '<a:ln><a:solidFill><a:schemeClr val="accent1"/></a:solidFill></a:ln></a:lnStyleLst>' +
    '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle>' +
    '<a:effectStyle><a:effectLst/></a:effectStyle>' +
    '<a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>' +
    '<a:bgFillStyleLst><a:solidFill><a:schemeClr val="lt1"/></a:solidFill>' +
    '<a:solidFill><a:schemeClr val="lt1"/></a:solidFill>' +
    '<a:solidFill><a:schemeClr val="lt1"/></a:solidFill></a:bgFillStyleLst>' +
    '</a:fmtScheme>' +
    '</a:themeElements>' +
    '</a:theme>';
}

function _slideXml(slide) {
  const titleRun = '<a:r><a:rPr lang="en-US" dirty="0"/><a:t>' + _xmlEscape(slide.heading || '') + '</a:t></a:r>';

  const bulletParagraphs = (slide.bulletPoints || []).map((point) =>
    '<a:p><a:pPr marL="285750" indent="-285750"><a:buFont typeface="Arial"/><a:buChar char="&#8226;"/></a:pPr>' +
    '<a:r><a:rPr lang="en-US" dirty="0"/><a:t>' + _xmlEscape(point) + '</a:t></a:r></a:p>'
  ).join('');

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:cSld><p:spTree>' +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr/>' +

    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' +
    '<p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="685800" y="365125"/><a:ext cx="10820400" cy="1122363"/></a:xfrm></p:spPr>' +
    '<p:txBody><a:bodyPr/><a:lstStyle/><a:p>' + titleRun + '</a:p></p:txBody></p:sp>' +

    '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Body"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' +
    '<p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="685800" y="1687600"/><a:ext cx="10820400" cy="4351338"/></a:xfrm></p:spPr>' +
    '<p:txBody><a:bodyPr/><a:lstStyle/>' + bulletParagraphs + '</p:txBody></p:sp>' +

    '</p:spTree></p:cSld>' +
    '</p:sld>';
}

function _slideRelsXml() {
  // Slides in this minimal build reference no images/media, so an empty
  // relationships file is valid — PowerPoint expects the part to exist.
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
}

/**
 * Builds a .pptx file from a slide array.
 * Returns a base64 string ready to send to the frontend for download.
 *
 * @param {Array<{heading: string, bulletPoints: string[]}>} slides
 * @param {string} title - used only for the file's internal naming; not
 *   rendered as its own slide (the caller's first slide should carry the title).
 */
export async function buildSimplePptx(slides, title) {
  const slideCount = slides.length;

  const files = [
    { name: '[Content_Types].xml', data: ENCODER.encode(_contentTypesXml(slideCount)) },
    { name: '_rels/.rels', data: ENCODER.encode(_rootRelsXml()) },
    { name: 'ppt/presentation.xml', data: ENCODER.encode(_presentationXml(slideCount)) },
    { name: 'ppt/_rels/presentation.xml.rels', data: ENCODER.encode(_presentationRelsXml(slideCount)) },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: ENCODER.encode(_slideMasterXml()) },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: ENCODER.encode(_slideMasterRelsXml()) },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: ENCODER.encode(_slideLayoutXml()) },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: ENCODER.encode(_slideLayoutRelsXml()) },
    { name: 'ppt/theme/theme1.xml', data: ENCODER.encode(_themeXml()) },
  ];

  slides.forEach((slide, i) => {
    files.push({ name: 'ppt/slides/slide' + (i + 1) + '.xml', data: ENCODER.encode(_slideXml(slide)) });
    files.push({ name: 'ppt/slides/_rels/slide' + (i + 1) + '.xml.rels', data: ENCODER.encode(_slideRelsXml()) });
  });

  const zipBytes = _assembleZip(files);

  let binary = '';
  for (let i = 0; i < zipBytes.length; i++) binary += String.fromCharCode(zipBytes[i]);
  return btoa(binary);
}
