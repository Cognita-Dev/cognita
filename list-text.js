// list-text.js
// Shared clean-up for text that a model hands to a document or design builder.
//
// Models sometimes pass a list where text is expected (or a list written out as
// text, like "['a', 'b']" or '["a","b"]'). Without this, the file shows the raw
// brackets and quotes, or "a,b" joined with commas. These helpers turn all of
// those shapes into real lists and plain text. Pure functions, no I/O.

const LIST_LITERAL = /^\s*\[[\s\S]*\]\s*$/;

function _strip(s) {
  return String(s).replace(/^\s*```[\w]*\s*|\s*```\s*$/g, '').trim();
}

function _flat(x) {
  if (x == null) return '';
  if (Array.isArray(x)) return x.map(_flat).filter(Boolean).join(', ');
  if (typeof x === 'object') return Object.values(x).map(_flat).filter(Boolean).join(': ');
  return String(x).trim();
}

// Parses "['a', 'b']" (Python style) or '["a", "b"]' (JSON). Returns an array or null.
export function parseListLiteral(str) {
  const s = _strip(str);
  if (!LIST_LITERAL.test(s)) return null;
  try {
    const v = JSON.parse(s);
    if (Array.isArray(v)) return v;
  } catch (e) { /* not JSON, try the Python style */ }
  const inner = s.slice(1, -1).trim();
  if (!inner) return [];
  const m = inner.match(/^(['"])([\s\S]*)\1$/);
  if (!m) return null;
  const q = m[1];
  const parts = inner.slice(1, -1).split(new RegExp(q + '\\s*,\\s*' + q));
  return parts.map((p) => p.replace(/\\(['"])/g, '$1').trim());
}

// Anything list-like -> array of clean one-line strings.
export function toList(v) {
  if (v == null) return [];
  if (typeof v === 'string') {
    const parsed = parseListLiteral(v);
    if (parsed) return toList(parsed);
    return v.split(/\r?\n/).map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim()).filter(Boolean);
  }
  if (Array.isArray(v)) return v.map(_flat).filter(Boolean);
  if (typeof v === 'object') return Object.values(v).map(_flat).filter(Boolean);
  return [String(v)];
}

// Anything text-like -> one plain string. A list becomes "a, b, c".
export function toText(v) {
  if (v == null) return '';
  if (typeof v === 'string') {
    const parsed = parseListLiteral(v);
    return parsed ? parsed.map(_flat).filter(Boolean).join(', ') : v;
  }
  return _flat(v);
}

// True when a value is a list, or text that is really a written-out list.
export function isListLike(v) {
  return Array.isArray(v) || (typeof v === 'string' && !!parseListLiteral(v));
}
