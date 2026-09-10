// pptx-builder.js
// Builds a minimal, valid, and *designed* .pptx from a slide array
// (heading + bullet points per slide). Same hand-written-ZIP approach as
// docx-builder.js — no external library, stored/uncompressed entries.
//
// Design: driven by a design-templates.js template (palette + a theme
// typeface name — PowerPoint substitutes fonts it doesn't have installed,
// so no embedding is needed), selected per-resource by
// resources-endpoint.js and passed in as a templateId. Falls back to the
// 'classic' template if none is given, so document-endpoint.js's existing
// calls keep working unchanged. The chosen typeface is set once in the
// theme's font scheme (major/minor font) rather than per text run, so it
// applies automatically to every placeholder.
//
// A slide with no bullet points (used for a document's title page — see
// document-endpoint.js's _structuredToSlides) renders as a distinct
// centered title slide instead of an empty content slide.
//
// Speaker notes and custom design beyond this are intentionally out of
// scope — flagging that honestly rather than faking it.

import { getTemplate, getDefaultTemplate } from './design-templates.js';

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
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/* ── Template resolution ── */
function _resolveTheme(templateId) {
  const template = getTemplate(templateId) || getDefaultTemplate();
  return { colors: template.colors, font: template.pptxFont };
}

/* ── Static OOXML parts that don't vary per-deck (except theme, which
   now takes the resolved colors + font) ── */

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

function _themeXml(theme) {
  const c = theme.colors;
  const font = _xmlEscape(theme.font);
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Cognita">' +
    '<a:themeElements>' +
    '<a:clrScheme name="Cognita">' +
    '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
    '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
    '<a:dk2><a:srgbClr val="' + c.ink + '"/></a:dk2>' +
    '<a:lt2><a:srgbClr val="F7F7F5"/></a:lt2>' +
    '<a:accent1><a:srgbClr val="' + c.accent + '"/></a:accent1>' +
    '<a:accent2><a:srgbClr val="' + c.accentSoft + '"/></a:accent2>' +
    '<a:accent3><a:srgbClr val="' + c.muted + '"/></a:accent3>' +
    '<a:accent4><a:srgbClr val="' + c.muted + '"/></a:accent4>' +
    '<a:accent5><a:srgbClr val="' + c.rule + '"/></a:accent5>' +
    '<a:accent6><a:srgbClr val="' + c.accent + '"/></a:accent6>' +
    '<a:hlink><a:srgbClr val="' + c.accent + '"/></a:hlink>' +
    '<a:folHlink><a:srgbClr val="' + c.accent + '"/></a:folHlink>' +
    '</a:clrScheme>' +
    '<a:fontScheme name="Cognita">' +
    '<a:majorFont><a:latin typeface="' + font + '"/></a:majorFont>' +
    '<a:minorFont><a:latin typeface="' + font + '"/></a:minorFont>' +
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

/* ── Slide rendering ── */

// A slide with no bullet points is treated as a title/section slide (used
// by document-endpoint.js's _structuredToSlides for a document's opening
// slide) and gets the centered title treatment instead of an empty
// content layout.
function _isTitleSlide(slide) {
  return !slide.bulletPoints || slide.bulletPoints.length === 0;
}

function _rectShapeXml(id, name, x, y, cx, cy, fillHex) {
  return '<p:sp><p:nvSpPr><p:cNvPr id="' + id + '" name="' + name + '"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="' + x + '" y="' + y + '"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>' +
    '<a:solidFill><a:srgbClr val="' + fillHex + '"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr>' +
    '<p:txBody><a:bodyPr/><a:lstStyle/><a:p/></p:txBody></p:sp>';
}

function _titleSlideXml(slide, colors) {
  const titleRun =
    '<a:r><a:rPr lang="en-US" b="1" sz="4000" dirty="0"><a:solidFill><a:srgbClr val="' + colors.ink + '"/></a:solidFill></a:rPr>' +
    '<a:t>' + _xmlEscape(slide.heading || '') + '</a:t></a:r>';

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:cSld><p:spTree>' +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr/>' +

    // Centered title, vertically anchored toward the lower half so the
    // accent rule beneath it has room to breathe.
    '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' +
    '<p:nvPr><p:ph type="ctrTitle"/></p:nvPr></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="857250" y="2514600"/><a:ext cx="10477500" cy="1143000"/></a:xfrm></p:spPr>' +
    '<p:txBody><a:bodyPr anchor="b"/><a:lstStyle/><a:p><a:pPr algn="ctr"/>' + titleRun + '</a:p></p:txBody></p:sp>' +

    _rectShapeXml(3, 'Rule', 5486400, 3886200, 1219200, 38100, colors.accent) +

    '</p:spTree></p:cSld>' +
    '</p:sld>';
}

function _contentSlideXml(slide, slideIndex, slideCount, colors) {
  const titleRun =
    '<a:r><a:rPr lang="en-US" b="1" sz="2800" dirty="0"><a:solidFill><a:srgbClr val="' + colors.ink + '"/></a:solidFill></a:rPr>' +
    '<a:t>' + _xmlEscape(slide.heading || '') + '</a:t></a:r>';

  const bulletParagraphs = (slide.bulletPoints || []).map((point) =>
    '<a:p><a:pPr marL="342900" indent="-342900">' +
    '<a:buFont typeface="Arial"/><a:buClr><a:srgbClr val="' + colors.accentSoft + '"/></a:buClr><a:buChar char="&#8226;"/>' +
    '</a:pPr>' +
    '<a:r><a:rPr lang="en-US" sz="1800" dirty="0"><a:solidFill><a:srgbClr val="' + colors.ink + '"/></a:solidFill></a:rPr>' +
    '<a:t>' + _xmlEscape(point) + '</a:t></a:r></a:p>'
  ).join('');

  const pageLabel = (slideIndex + 1) + ' / ' + slideCount;

  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
    'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:cSld><p:spTree>' +
    '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr/>' +

    // Thin accent bar along the top edge — the deck's one recurring
    // design accent, kept deliberately minimal.
    _rectShapeXml(2, 'AccentBar', 0, 0, 12192000, 91440, colors.accent) +

    // Title.
    '<p:sp><p:nvSpPr><p:cNvPr id="3" name="Title"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' +
    '<p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="685800" y="365125"/><a:ext cx="10820400" cy="859536"/></a:xfrm></p:spPr>' +
    '<p:txBody><a:bodyPr/><a:lstStyle/><a:p>' + titleRun + '</a:p></p:txBody></p:sp>' +

    // Rule under the title.
    _rectShapeXml(4, 'Rule', 685800, 1287780, 762000, 28575, colors.accent) +

    // Body — bullet list, auto-shrinks via PowerPoint's own normAutofit
    // if a slide runs longer than the box, instead of overflowing.
    '<p:sp><p:nvSpPr><p:cNvPr id="5" name="Body"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>' +
    '<p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="685800" y="1500188"/><a:ext cx="10820400" cy="4538662"/></a:xfrm></p:spPr>' +
    '<p:txBody><a:bodyPr><a:normAutofit/></a:bodyPr><a:lstStyle/>' + bulletParagraphs + '</p:txBody></p:sp>' +

    // Slide number footer.
    '<p:sp><p:nvSpPr><p:cNvPr id="6" name="PageNumber"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>' +
    '<p:spPr><a:xfrm><a:off x="11125200" y="6400800"/><a:ext cx="800100" cy="365760"/></a:xfrm></p:spPr>' +
    '<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr algn="r"/>' +
    '<a:r><a:rPr lang="en-US" sz="1000" dirty="0"><a:solidFill><a:srgbClr val="' + colors.muted + '"/></a:solidFill></a:rPr>' +
    '<a:t>' + _xmlEscape(pageLabel) + '</a:t></a:r></a:p></p:txBody></p:sp>' +

    '</p:spTree></p:cSld>' +
    '</p:sld>';
}

function _slideXml(slide, slideIndex, slideCount, colors) {
  return _isTitleSlide(slide) ? _titleSlideXml(slide, colors) : _contentSlideXml(slide, slideIndex, slideCount, colors);
}

function _slideRelsXml() {
  // Slides in this minimal build reference no images/media, so an empty
  // relationships file is valid — PowerPoint expects the part to exist.
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
}

/**
 * Builds a designed .pptx file from a slide array, in the given design
 * template's palette and typeface.
 * Returns a base64 string ready to send to the frontend for download.
 *
 * @param {Array<{heading: string, bulletPoints: string[]}>} slides - a
 *   slide with an empty/missing bulletPoints array renders as a centered
 *   title slide; any other slide renders as a standard content slide
 *   (accent top bar, title, rule, bulleted body, slide number).
 * @param {string} title - used only for the file's internal naming; not
 *   rendered as its own slide (the caller's first slide should carry the title).
 * @param {string} [templateId] - a design-templates.js id; defaults to
 *   'classic' if omitted or unrecognized. Callers are responsible for
 *   entitlement-checking the id before passing it in.
 */
export async function buildSimplePptx(slides, title, templateId) {
  const theme = _resolveTheme(templateId);
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
    { name: 'ppt/theme/theme1.xml', data: ENCODER.encode(_themeXml(theme)) },
  ];

  slides.forEach((slide, i) => {
    files.push({ name: 'ppt/slides/slide' + (i + 1) + '.xml', data: ENCODER.encode(_slideXml(slide, i, slideCount, theme.colors)) });
    files.push({ name: 'ppt/slides/_rels/slide' + (i + 1) + '.xml.rels', data: ENCODER.encode(_slideRelsXml()) });
  });

  const zipBytes = _assembleZip(files);

  let binary = '';
  for (let i = 0; i < zipBytes.length; i++) binary += String.fromCharCode(zipBytes[i]);
  return btoa(binary);
}
