// Guards the Cloudflare Pages _headers file for the Python server.
// Pages joins a header set by two matching rules with a comma ("*, *"), which browsers reject as invalid CORS.
// Run: node tests/pyodide-headers.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';

const text = fs.readFileSync(new URL('../pyodide-host/_headers', import.meta.url), 'utf8');
const blocks = []; let cur = null;
for (const raw of text.split('\n')) {
  if (!raw.trim() || raw.trim().startsWith('#')) continue;
  if (/^\S/.test(raw)) { cur = { pattern: raw.trim(), headers: [] }; blocks.push(cur); }
  else { const i = raw.indexOf(':'); cur.headers.push(raw.slice(0, i).trim().toLowerCase()); }
}
const sample = ['/v0.29.5/pyodide.js', '/v0.29.5/pyodide.asm.wasm', '/v0.29.5/pyodide-lock.json', '/v0.29.5/numpy-2.0.2.zip', '/index.html'];
const matches = (pat, path) => new RegExp('^' + pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(path);
let n = 0;
for (const path of sample) {
  const seen = {};
  for (const b of blocks) if (matches(b.pattern, path)) for (const h of b.headers) seen[h] = (seen[h] || 0) + 1;
  for (const [h, c] of Object.entries(seen)) { assert.equal(c, 1, `${path}: header "${h}" is set by ${c} rules (it would be sent as "v, v")`); n++; }
  assert.ok(seen['access-control-allow-origin'], `${path}: no Access-Control-Allow-Origin`);
}
console.log(`pyodide headers ok (${n} checks)`);
