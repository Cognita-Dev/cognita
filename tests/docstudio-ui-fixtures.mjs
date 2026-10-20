// Makes real doc-studio output (a document, a deck, a poster) as JSON the browser test can replay.
//   cd doc-studio && npm install && cd .. && node tests/docstudio-ui-fixtures.mjs <out.json>
// Set CHROMIUM_PATH to use a Chromium that is already installed.
import fs from 'node:fs';
import { renderBundle } from '../doc-studio/src/export.js';
import { closeBrowser } from '../doc-studio/src/export.js';
import { sanitizeSpec } from '../doc-studio/src/sanitize.js';

const out = process.argv[2] || 'docstudio-fixtures.json';
const read = (n) => JSON.parse(fs.readFileSync(new URL('../doc-studio/examples/' + n + '.json', import.meta.url), 'utf8'));
const media = (b, title) => ({ kind: 'docfile', title, alt: title, docKind: b.kind, design: b.design.name, preview: b.preview, files: b.files });
const fx = {
  document: media(await renderBundle(sanitizeSpec(read('document')), ['pdf', 'docx']), 'The Quiet Year Ahead'),
  slides: media(await renderBundle(sanitizeSpec(read('slides')), ['pptx', 'pdf']), 'Founders deck'),
  poster: media(await renderBundle(sanitizeSpec(read('poster')), ['png', 'pdf']), 'Open workshop'),
  sheet: media(await renderBundle(sanitizeSpec(read('sheet')), ['xlsx']), 'Budget'),
};
fs.writeFileSync(out, JSON.stringify(fx));
console.log('wrote', out, Object.entries(fx).map(([k, v]) => k + ':' + v.files.map((f) => f.format + '=' + f.size).join(',')).join('  '));
await closeBrowser();
