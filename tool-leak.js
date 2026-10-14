// tool-leak.js
//
// Some models, instead of making a real tool call, write the call into their
// answer as text, for example:
//
//   [sandbox_offer_file](path="/workspace/graph.png", title="Graph")
//   sandbox_run_python(code="print(1)")
//   <tool_call>{"name": "sandbox_offer_file", "arguments": {...}}</tool_call>
//
// That text is machinery, never an answer, so it must not reach the person.
// This module finds those pseudo calls and does two things with them:
//
//   findLeaks / stripToolLeaks   remove them from text (used on the live
//                                stream and on the final reply)
//   recoverLeakedCall            turns the first one back into a real call
//                                { name, args } so the agent loop can run it
//                                through the normal validation and approval
//                                path, exactly like a native tool call
//
// Only names in the `names` set are ever treated as tool calls, so ordinary
// prose and code that merely look similar are left alone. Fenced code blocks
// are skipped, except fences that are themselves a tool-call payload.

const MAX_SCAN = 200000;

// Wrapper tags some models use for tool calls. The whole element is removed.
const TAG_BLOCKS = [
  ['<tool_call>', '</tool_call>'],
  ['<tool_calls>', '</tool_calls>'],
  ['<function_call>', '</function_call>'],
  ['<function_calls>', '</function_calls>'],
  ['<tool_use>', '</tool_use>'],
  ['<invoke', '</invoke>'],
  ['<|tool_call_begin|>', '<|tool_call_end|>'],
  ['<|tool_calls_section_begin|>', '<|tool_calls_section_end|>'],
  ['[TOOL_CALLS]', null], // runs to the end of the text
];

// Lines that echo the format the Worker uses when it feeds a tool result back
// to the model. They are never part of an answer.
const ECHO_LINE = /^[ \t]*(?:Tool call:[^\n]*|Result \(step \d+\):[^\n]*)\n?/gm;

function _escape(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function _nameRe(names) {
  const list = [...names].filter((n) => typeof n === 'string' && /^[a-z][a-z0-9_]{2,80}$/i.test(n)).sort((a, b) => b.length - a.length);
  if (!list.length) return null;
  const alt = list.map(_escape).join('|');
  // optional backtick or "[" before, optional namespace prefix, then the name,
  // optional "]", then "(" or "{" opening the arguments.
  return new RegExp('(`?)(\\[\\s*)?(?:(?:functions|tools?|default_api|api)\\.)?\\b(' + alt + ')\\b(\\s*\\])?[ \\t]*([({])', 'g');
}

/** Index just after the bracket that closes the one opening at `open`, or -1 if the text ends first. */
function _closeIndex(text, open) {
  const pairs = { '(': ')', '{': '}', '[': ']' };
  const stack = [pairs[text[open]]];
  let quote = null;
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(' || c === '{' || c === '[') stack.push(pairs[c]);
    else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return i + 1;
    }
  }
  return -1;
}

function _parseValue(raw) {
  const v = raw.trim();
  if (!v) return '';
  try { return JSON.parse(v); } catch (_) { /* fall through */ }
  if (/^'(?:[^'\\]|\\.)*'$/.test(v)) {
    try { return JSON.parse('"' + v.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"') + '"'); } catch (_) { return v.slice(1, -1); }
  }
  if (/^(true|True)$/.test(v)) return true;
  if (/^(false|False)$/.test(v)) return false;
  if (/^(null|None)$/.test(v)) return null;
  return v;
}

/** Parses `key="value", key2=3, key3=[..]` into an object, or returns null when it does not look like that. */
function _parseKeyValues(body) {
  const out = {};
  let i = 0;
  const n = body.length;
  let seen = 0;
  while (i < n) {
    while (i < n && /[\s,]/.test(body[i])) i++;
    if (i >= n) break;
    const m = /^["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*[=:]\s*/.exec(body.slice(i));
    if (!m) return null;
    i += m[0].length;
    let j = i;
    if (body[j] === '"' || body[j] === "'") {
      const q = body[j];
      j++;
      while (j < n && body[j] !== q) { if (body[j] === '\\') j++; j++; }
      j++;
    } else if (body[j] === '{' || body[j] === '[') {
      const end = _closeIndex(body, j);
      j = end === -1 ? n : end;
    } else {
      while (j < n && body[j] !== ',') j++;
    }
    out[m[1]] = _parseValue(body.slice(i, j));
    seen++;
    i = j;
  }
  return seen ? out : {};
}

/** Parses the text between a call's brackets. Returns { args } or null when it is not call syntax. */
function _parseArgs(inner, opener) {
  const t = inner.trim();
  if (opener === '{') {
    const obj = _parseValue('{' + inner + '}');
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? { args: obj } : { args: null };
  }
  if (!t) return { args: {}, empty: true };
  if (t[0] === '{') {
    const obj = _parseValue(t);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return { args: obj };
  }
  const kv = _parseKeyValues(t);
  if (kv) return { args: kv };
  return null;
}

/** Ranges of fenced code blocks that are ordinary code (not a tool-call payload). */
function _plainFences(text, names) {
  const out = [];
  const re = /```([^\n`]*)\n([\s\S]*?)(?:```|$)/g;
  let m;
  while ((m = re.exec(text))) {
    const lang = (m[1] || '').trim().toLowerCase();
    const body = m[2] || '';
    const payload = /^(?:tool_code|tool_call|tool|function_call|function)$/.test(lang) ||
      (/^(?:json|)$/.test(lang) && /"(?:name|tool|function)"\s*:\s*"/.test(body) && /"(?:arguments|parameters|args|input)"\s*:/.test(body) &&
        [...names].some((n) => body.includes('"' + n + '"')));
    if (!payload) out.push([m.index, m.index + m[0].length]);
  }
  return out;
}

function _inRanges(i, ranges) { return ranges.some(([a, b]) => i >= a && i < b); }

/**
 * Finds tool calls written as text.
 * Returns [{ start, end, name, args, complete }] in order, non overlapping.
 * `complete` is false for a call that is still being typed at the end of the text.
 */
export function findLeaks(text, names) {
  const src = typeof text === 'string' ? text.slice(0, MAX_SCAN) : '';
  if (!src || !names || !names.size) return [];
  const out = [];
  const fences = _plainFences(src, names);

  // 1. Wrapper tags and tool-call fences.
  const take = (start, end, complete, name, args) => {
    if (out.some((o) => start < o.end && end > o.start)) return;
    out.push({ start, end, name: name || null, args: args || null, complete });
  };
  for (const [open, close] of TAG_BLOCKS) {
    let from = 0;
    for (;;) {
      const s = src.indexOf(open, from);
      if (s === -1) break;
      const e = close ? src.indexOf(close, s + open.length) : -1;
      const end = close ? (e === -1 ? src.length : e + close.length) : src.length;
      const body = src.slice(s, end);
      let name = null; let args = null;
      const nm = /"(?:name|tool|function)"\s*:\s*"([A-Za-z0-9_.]+)"/.exec(body) || /(?:name|invoke name)\s*=\s*"([A-Za-z0-9_.]+)"/.exec(body);
      if (nm) name = nm[1].replace(/^(?:functions|tools?|default_api|api)\./, '');
      const am = /"(?:arguments|parameters|args|input)"\s*:\s*(\{[\s\S]*\})/.exec(body);
      if (am) { try { args = JSON.parse(am[1]); } catch (_) { args = null; } }
      take(s, end, close ? e !== -1 : false, name, args);
      from = end;
      if (end >= src.length) break;
    }
  }
  const fenceRe = /```([^\n`]*)\n([\s\S]*?)(```|$)/g;
  let fm;
  while ((fm = fenceRe.exec(src))) {
    if (_inRanges(fm.index, fences)) continue; // ordinary code
    const body = fm[2] || '';
    const nm = /"(?:name|tool|function)"\s*:\s*"([A-Za-z0-9_.]+)"/.exec(body) || /\b([a-z][a-z0-9_]+)\s*\(/.exec(body);
    const name = nm ? nm[1].replace(/^(?:functions|tools?|default_api|api)\./, '') : null;
    if (!name || !names.has(name)) continue;
    let args = null;
    const am = /"(?:arguments|parameters|args|input)"\s*:\s*(\{[\s\S]*\})/.exec(body);
    if (am) { try { args = JSON.parse(am[1]); } catch (_) { args = null; } }
    take(fm.index, fm.index + fm[0].length, fm[3] === '```', name, args);
  }

  // 2. Inline calls: [name](...), name(...), name{...}
  const re = _nameRe(names);
  if (re) {
    let m;
    while ((m = re.exec(src))) {
      const start = m.index;
      if (_inRanges(start, fences)) continue;
      const bracketForm = !!(m[2] && m[4]);
      const opener = m[5];
      const openAt = start + m[0].length - 1;
      const close = _closeIndex(src, openAt);
      const complete = close !== -1;
      const innerEnd = complete ? close - 1 : src.length;
      const parsed = _parseArgs(src.slice(openAt + 1, innerEnd), opener);
      // Plain prose such as "generate_image(prompt)" is left alone unless it is
      // clearly call syntax: the [name](...) form, or key=value / JSON arguments.
      if (!bracketForm && (!parsed || (parsed.empty && !/^sandbox_/.test(m[3])))) continue;
      if (!bracketForm && opener === '{' && (!parsed || !parsed.args)) continue;
      let end = complete ? close : src.length;
      if (complete && m[1] && src[end] === '`') end++; // closing backtick of `name(...)`
      if (!complete) {
        // Unfinished call: take the rest of the line, so a cut off call never shows.
        const nl = src.indexOf('\n', openAt);
        end = nl === -1 ? src.length : nl;
      }
      take(start, end, complete, m[3], parsed ? parsed.args : null);
      re.lastIndex = Math.max(re.lastIndex, end);
    }
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

/**
 * Removes pseudo calls from text.
 * With `streaming` true the text may stop in the middle of a call, so anything
 * that could still turn into one is held back (the caller sends it later, once
 * it is clear what it is). The result is always a prefix of the final result,
 * which is what a stream needs.
 */
export function stripToolLeaks(text, names, streaming) {
  let s = typeof text === 'string' ? text : '';
  if (!s) return '';
  // Code written for the private document helper is never an answer for the person.
  // Complete fences are removed; while streaming, an unfinished fence is cut off too.
  s = s.replace(/```[a-z]*\n(?:(?!```)[\s\S])*?(?:cognita_docs|sandbox_\w+)(?:(?!```)[\s\S])*?```\n?/gi, '');
  const _open = streaming ? /```[a-z]*\n(?:(?!```)[\s\S])*?(?:cognita_docs|sandbox_\w+)(?:(?!```)[\s\S])*$/i.exec(s) : null;
  if (_open) s = s.slice(0, _open.index);
  if (names && names.size) {
    const leaks = findLeaks(s, names);
    if (leaks.length) {
      let out = '';
      let at = 0;
      for (const l of leaks) {
        let start = l.start;
        while (start > at && (s[start - 1] === ' ' || s[start - 1] === '\t')) start--;
        let end = l.end;
        if ((start === 0 || s[start - 1] === '\n') && s[end] === '\n') end++; // a call on its own line takes the line with it
        out += s.slice(at, start);
        at = end;
      }
      out += s.slice(at);
      s = out;
    }
  }
  s = s.replace(ECHO_LINE, '');
  if (streaming) s = _holdBackPartial(s, names);
  return s;
}

// Cuts off the end of `s` when it could still turn into a pseudo call.
function _holdBackPartial(s, names) {
  const starts = ['[', '`', '<tool', '<function', '<invoke', '<|', '[TOOL_CALLS]'];
  for (const n of names || []) starts.push(n, '[' + n, '[ ' + n, '`' + n, 'functions.' + n, 'tools.' + n);
  let cut = s.length;
  const tailStart = Math.max(0, s.length - 120);
  for (let i = s.length - 1; i >= tailStart; i--) {
    const tail = s.slice(i);
    const waiting = starts.some((p) => p.startsWith(tail) ||
      // a full name that is not yet followed by "(" or "{"
      (tail.startsWith(p) && /[A-Za-z_]$/.test(p) && /^[ \t\]]*$/.test(tail.slice(p.length))));
    if (waiting) cut = i;
  }
  // A tag opener that has not reached its ">" yet.
  for (let i = s.length - 1; i >= tailStart; i--) {
    const tail = s.slice(i);
    if (['<tool', '<function', '<invoke', '<|'].some((p) => tail.startsWith(p)) && !tail.includes('>')) cut = Math.min(cut, i);
  }
  // A call whose name and opening bracket are typed but whose closing bracket is not: wait for it.
  const re = _nameRe(names || new Set());
  if (re) {
    const fences = _plainFences(s, names);
    let m;
    while ((m = re.exec(s))) {
      if (_inRanges(m.index, fences)) continue;
      if (_closeIndex(s, m.index + m[0].length - 1) === -1) { cut = Math.min(cut, m.index); break; }
    }
  }
  // A line that starts like an echoed tool exchange is held until the line ends.
  const lineStart = s.lastIndexOf('\n') + 1;
  const line = s.slice(lineStart).replace(/^[ \t]+/, '');
  if (line && ['Tool call:', 'Result (step'].some((p) => p.startsWith(line) || line.startsWith(p))) cut = Math.min(cut, lineStart);
  // Spaces just before a held back start go too: if it is a call, they are removed with it.
  if (cut < s.length) while (cut > 0 && (s[cut - 1] === ' ' || s[cut - 1] === '\t')) cut--;
  return s.slice(0, cut);
}

/**
 * The first pseudo call in `text` that names an offered tool and has readable
 * arguments, as { name, args }, plus the text with every pseudo call removed.
 * Returns { call: null, text } when there is nothing to recover.
 */
export function recoverLeakedCall(text, offeredNames, allNames) {
  const names = allNames && allNames.size ? allNames : offeredNames;
  const clean = stripToolLeaks(text, names, false).trim();
  const leaks = findLeaks(text, names).filter((l) => l.complete && l.name && l.args && offeredNames.has(l.name));
  return { call: leaks.length ? { id: 'leak_' + Math.random().toString(36).slice(2, 10), name: leaks[0].name, args: leaks[0].args } : null, text: clean };
}

export function hasToolLeak(text, names) {
  if (typeof text !== 'string' || !text) return false;
  if (/^[ \t]*(?:Tool call:|Result \(step \d+\):)/m.test(text)) return true;
  return !!names && names.size > 0 && findLeaks(text, names).length > 0;
}
