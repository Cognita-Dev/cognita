import assert from 'node:assert';
import { shouldConvertPaste, pastedFileName, PASTE_MIN_CHARS } from '../js/pasted-text.js';
assert(!shouldConvertPaste('')); assert(!shouldConvertPaste('hello'));
assert(!shouldConvertPaste('x'.repeat(PASTE_MIN_CHARS - 1)));
assert(shouldConvertPaste('x'.repeat(PASTE_MIN_CHARS)));
assert(shouldConvertPaste(Array(50).fill('log line number here').join('\n')));   // many lines
assert(!shouldConvertPaste(Array(50).fill('a').join('\n')));                      // many tiny lines, under 600 chars
assert.equal(pastedFileName([]), 'Pasted text.txt');
assert.equal(pastedFileName(['Pasted text.txt']), 'Pasted text 2.txt');
assert.equal(pastedFileName(['pasted text.txt', 'Pasted text 2.txt']), 'Pasted text 3.txt');
console.log('pasted-text tests ok');
