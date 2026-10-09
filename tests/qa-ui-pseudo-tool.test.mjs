// QA: the model calling the component format as a "tool" must become a UI block, not an approval card.
// Tests the conversion helper directly (MOCKED call objects taken from a real failing chat). The full
// worker path (connected-app tools + streaming provider) is NOT exercised here.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { _uiBlockFromPseudoCall } from '../chat-endpoint.js';
import { extractUiBlocks, validateUi } from '../ui-schema.js';

const real = (n) => n === 'google_drive_create_file';

test('cognita-ui "tool call" (card + pie_chart child) becomes a validated block', () => {
  const call = { name: 'cognita-ui', args: { type: 'card', props: { title: 'Monthly Budget Breakdown', description: 'Typical expenses' },
    children: [{ type: 'pie_chart', props: { title: 'Expense Distribution', labels: ['Ingredients', 'Packaging'], values: [40, 20] } }] } };
  const blocks = _uiBlockFromPseudoCall(call, real);
  assert.ok(blocks && blocks.length === 1);
  const ex = extractUiBlocks('Here you go.\n\n```cognita-ui\n' + JSON.stringify(blocks) + '\n```');
  assert.equal(ex.ui.length, 1);
  assert.equal(ex.ui[0].type, 'card');
  assert.equal(ex.ui[0].children[0].type, 'pie_chart');
  assert.equal(ex.text.trim(), 'Here you go.');
});

test('other shapes: component name as tool, blocks array, underscore name', () => {
  assert.equal(_uiBlockFromPseudoCall({ name: 'pie_chart', args: { title: 'T', labels: ['a'], values: [1] } }, real)[0].type, 'pie_chart');
  assert.equal(_uiBlockFromPseudoCall({ name: 'cognita_ui', args: { blocks: [{ type: 'callout', props: { title: 'x', content: 'y' } }] } }, real).length, 1);
  assert.equal(_uiBlockFromPseudoCall({ name: 'Cognita-UI', args: [{ type: 'table', props: { columns: ['a'], rows: [['1']] } }] }, real).length, 1);
});

test('real tools and unknown junk are left alone', () => {
  assert.equal(_uiBlockFromPseudoCall({ name: 'google_drive_create_file', args: { type: 'card' } }, real), null);
  assert.equal(_uiBlockFromPseudoCall({ name: 'delete_everything', args: { a: 1 } }, real), null);
  assert.equal(_uiBlockFromPseudoCall({ name: 'cognita-ui', args: null }, real), null);
  assert.equal(_uiBlockFromPseudoCall(null, real), null);
  // a component name that is ALSO a real tool name must stay a tool
  assert.equal(_uiBlockFromPseudoCall({ name: 'table', args: { a: 1 } }, (n) => n === 'table'), null);
  assert.deepEqual(validateUi(_uiBlockFromPseudoCall({ name: 'cognita-ui', args: { type: 'nope', props: {} } }, real)), []);
});
