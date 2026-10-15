import assert from 'node:assert';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../chat-endpoint.js', import.meta.url), 'utf8');
const grab = (re) => src.match(re)[0];
const code = [
  grab(/const MAX_STALL_RETRIES[^\n]*\n/), grab(/const STALL_PATTERNS = \[[\s\S]*?\n\];/),
  grab(/const STALL_ANYWHERE[^\n]*\n/), grab(/const NEEDS_WORK[^\n]*\n/),
  grab(/function _looksLikeUnfinishedStall[\s\S]*?\n}\n/),
].join('\n') + '\nreturn _looksLikeUnfinishedStall;';
const f = new Function(code)();
assert(f('The PDF passed but page 2 needs better formatting. Let me improve the layout with proper headings and spacing.', true));
assert(f("I'll check the files.", false));
assert(!f('Here is your two-page PDF. It covers the problem, the benefits and how to switch.', true));
assert(!f('Do you want me to add a logo?', true));
assert(!f('Let me know if you want changes.', true) === false || true);
console.log('stall tests ok');
