import assert from 'node:assert';
import { readFileSync } from 'node:fs';
const p = readFileSync(new URL('../prompts.js', import.meta.url), 'utf8');
assert(!/no title-only cover page/.test(p), 'old blanket rule removed');
assert(/formal report, proposal/.test(p) && /skip for letters, memos, resumes/.test(p));
const f = readFileSync(new URL('../sandbox-frame.html', import.meta.url), 'utf8');
assert(/looks like a %s\. Keep it only if/.test(f) && /\(0, "Page %d looks like a/.test(f));
assert(/Page %d is almost empty\. Fill it/.test(f));
console.log('cover tests ok');
