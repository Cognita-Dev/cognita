// Renders every example in every format into ./out so you can eyeball the results.
import fs from 'fs';
import path from 'path';
import { exportAs, closeBrowser } from './src/export.js';
import { DESIGN_IDS } from './src/designs.js';

fs.mkdirSync('out', { recursive: true });
const ex = (n) => JSON.parse(fs.readFileSync(`examples/${n}.json`, 'utf8'));
const jobs = [
  ['document', ['pdf', 'png', 'docx', 'html']],
  ['slides', ['pdf', 'png', 'pptx', 'pptx-image']],
  ['poster', ['pdf', 'png']],
  ['sheet', ['xlsx']],
];
for (const [name, formats] of jobs) {
  for (const f of formats) {
    const buf = await exportAs(ex(name), f);
    const file = path.join('out', `${name}.${f === 'pptx-image' ? 'image.pptx' : f}`);
    fs.writeFileSync(file, buf);
    console.log('ok', file, buf.length);
  }
}
// all 8 designs on the same document → proves they really differ
if (process.argv.includes('--all')) {
  for (const id of DESIGN_IDS) {
    for (const n of ['document', 'slides', 'poster']) {
      fs.writeFileSync(`out/design-${id}-${n}.png`, await exportAs({ ...ex(n), design: id }, 'png'));
    }
    console.log('design', id);
  }
}
await closeBrowser();
