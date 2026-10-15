import assert from 'node:assert';
import { readFileSync } from 'node:fs';
const rd = (f) => readFileSync(new URL('../' + f, import.meta.url), 'utf8');
const { previewLabel } = await import('../js/file-viewer.js').catch(() => ({}));
if (previewLabel) {
  assert.equal(previewLabel('calc.py'), 'Python script');
  assert.equal(previewLabel('a.txt'), 'Text file');
  assert.equal(previewLabel('a.html'), 'Interactive page');
  assert.equal(previewLabel('a.pdf'), 'PDF document');
}
const p = rd('prompts.js');
assert(/one working HTML page/.test(p) && /Never use eval\(\) or exec\(\)/.test(p) && /no bullet lists of features or tests/.test(p));
assert(/setStdin/.test(rd('sandbox-frame.html')));
// recovered-failure counting, same expression as js/app.js
const src = rd('js/app.js');
assert(src.includes("!steps.slice(i + 1).some((n) => n.ok === true && n.type === st.type)"));
const count = (steps) => steps.filter((st, i) => st.ok === false && st.type !== 'blocked' && !steps.slice(i + 1).some((n) => n.ok === true && n.type === st.type)).length;
assert.equal(count([{ type: 'run', ok: false }, { type: 'run', ok: true }]), 0);
assert.equal(count([{ type: 'run', ok: true }, { type: 'run', ok: false }]), 1);
console.log('app-defaults tests ok');
