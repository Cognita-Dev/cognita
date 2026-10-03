// js/code-highlight.js
// Small, dependency-free syntax highlighter and code-block markup builder.
//
// Why this exists: the chat renders replies through renderMarkdownLite(),
// which streams into the live DOM. A highlighter that loads a library, or
// that rebuilds nodes on every frame, would flicker. This one is:
//   - synchronous and linear, so it is safe to call on every stream frame
//   - memoised, so finished blocks cost nothing on later frames
//   - output as one <span class="cl"> per line, so the line-number gutter
//     is pure CSS (counters), never part of the copied text
//
// Public API:
//   buildCodeBlockHtml({ lang, code, id })  -> HTML string for one block
//   codeTextOf(codeEl)                      -> exact source text of a block
//   codeBlockKey(lang, code)                -> cheap hash used to skip finished blocks

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s) { return s.replace(/[&<>"']/g, (c) => ESC[c]); }

// renderMarkdownLite escapes the whole reply first, so code arrives as
// entities. Undo that here, tokenise the real characters, escape per token.
function unesc(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

/* ── Languages ───────────────────────────────────────────────────── */

const words = (s) => new Set(s.split(/\s+/).filter(Boolean));

const KW = {
  js: words('async await break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static super switch this throw try typeof var void while with yield as type interface enum implements private public protected readonly abstract namespace declare keyof satisfies'),
  python: words('and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case self cls'),
  swift: words('actor as associatedtype async await break case catch class continue default defer deinit do else enum extension fallthrough fileprivate final for func guard if import in indirect init inout internal is lazy let mutating nonmutating open operator override private protocol public repeat required rethrows return self Self static struct subscript super switch throw throws try typealias var weak where while willSet didSet get set some any'),
  kotlin: words('abstract as break by catch class companion const constructor continue data do else enum final finally for fun if import in init inline inner interface internal is lateinit object open operator out override package private protected public return sealed super suspend this throw try typealias val var vararg when where while'),
  java: words('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try var void volatile while record sealed permits'),
  c: words('auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while class namespace template typename public private protected virtual override final new delete using this operator try catch throw constexpr noexcept nullptr bool'),
  csharp: words('abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new object operator out override params private protected public readonly ref return sbyte sealed short sizeof static string struct switch this throw try typeof uint ulong unchecked unsafe ushort using var virtual void volatile while async await record init get set yield'),
  go: words('break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var'),
  rust: words('as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait type unsafe use where while'),
  php: words('abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield'),
  ruby: words('alias and begin break case class def defined do else elsif end ensure for if in module next not or redo rescue retry return self super then undef unless until when while yield'),
  bash: words('if then else elif fi for while until do done case esac in function select time return exit break continue export local readonly declare unset shift source alias cd echo printf test'),
  sql: words('add all alter and as asc between by case check column constraint create cross database default delete desc distinct drop else end exists foreign from full group having if in index inner insert into is join key left like limit not null offset on or order outer primary references right select set table then top union unique update values view when where with'),
  yaml: words('true false null yes no on off'),
  css: words('important'),
};

const LITERALS = words('true false null nil None True False undefined NaN Infinity self this super');

// Aliases: whatever the model writes after the opening fence.
const ALIASES = {
  js: 'js', javascript: 'js', jsx: 'js', mjs: 'js', cjs: 'js', ts: 'js', typescript: 'js', tsx: 'js', node: 'js',
  py: 'python', python: 'python', python3: 'python',
  swift: 'swift', kotlin: 'kotlin', kt: 'kotlin',
  java: 'java',
  c: 'c', h: 'c', cpp: 'c', 'c++': 'c', cc: 'c', hpp: 'c', objc: 'c', 'objective-c': 'c',
  cs: 'csharp', csharp: 'csharp', 'c#': 'csharp',
  go: 'go', golang: 'go', rust: 'rust', rs: 'rust',
  php: 'php', rb: 'ruby', ruby: 'ruby',
  sh: 'bash', bash: 'bash', zsh: 'bash', shell: 'bash', console: 'bash', terminal: 'bash',
  sql: 'sql', mysql: 'sql', postgres: 'sql', postgresql: 'sql', sqlite: 'sql',
  json: 'json', jsonc: 'json', json5: 'json',
  html: 'html', xml: 'html', svg: 'html', vue: 'html',
  css: 'css', scss: 'css', sass: 'css', less: 'css',
  yaml: 'yaml', yml: 'yaml', toml: 'yaml', ini: 'yaml', env: 'yaml',
  diff: 'diff', patch: 'diff',
};

const LABELS = {
  js: 'JavaScript', python: 'Python', swift: 'Swift', kotlin: 'Kotlin', java: 'Java', c: 'C / C++',
  csharp: 'C#', go: 'Go', rust: 'Rust', php: 'PHP', ruby: 'Ruby', bash: 'Shell', sql: 'SQL',
  json: 'JSON', html: 'HTML', css: 'CSS', yaml: 'YAML', diff: 'Diff',
};
// A few raw tags read better than their family label.
const RAW_LABELS = {
  ts: 'TypeScript', typescript: 'TypeScript', tsx: 'TSX', jsx: 'JSX', cpp: 'C++', 'c++': 'C++',
  scss: 'SCSS', sass: 'Sass', less: 'Less', xml: 'XML', svg: 'SVG', vue: 'Vue', toml: 'TOML',
  zsh: 'Zsh', console: 'Shell', terminal: 'Shell', objc: 'Objective-C', 'objective-c': 'Objective-C',
  mysql: 'MySQL', postgres: 'PostgreSQL', postgresql: 'PostgreSQL', sqlite: 'SQLite', md: 'Markdown',
  markdown: 'Markdown', text: 'Text', txt: 'Text', plaintext: 'Text',
};
const EXT = {
  js: 'js', ts: 'ts', typescript: 'ts', tsx: 'tsx', jsx: 'jsx', python: 'py', swift: 'swift', kotlin: 'kt',
  java: 'java', c: 'c', cpp: 'cpp', 'c++': 'cpp', csharp: 'cs', go: 'go', rust: 'rs', php: 'php', ruby: 'rb',
  bash: 'sh', sql: 'sql', json: 'json', html: 'html', css: 'css', scss: 'scss', yaml: 'yaml', yml: 'yml',
  xml: 'xml', diff: 'diff', markdown: 'md', md: 'md',
};

function familyOf(lang) { return ALIASES[(lang || '').toLowerCase()] || ''; }
function labelOf(lang) {
  const raw = (lang || '').toLowerCase();
  if (!raw) return 'Code';
  return RAW_LABELS[raw] || LABELS[ALIASES[raw]] || (raw.charAt(0).toUpperCase() + raw.slice(1));
}
function extOf(lang) {
  const raw = (lang || '').toLowerCase();
  return EXT[raw] || EXT[ALIASES[raw]] || (/^[a-z0-9+#-]{1,8}$/.test(raw) ? raw.replace(/[+#]/g, '') : 'txt');
}

/* ── Tokeniser ───────────────────────────────────────────────────── */
// One sticky regex per family. Order matters: comments and strings first,
// so a keyword inside either is never coloured as a keyword.

const NUM = '0[xX][0-9a-fA-F_]+|0[bB][01_]+|\\d[\\d_]*\\.?\\d*(?:[eE][+-]?\\d+)?[fFlLuU]*';
const IDENT = '[A-Za-z_$][\\w$]*';

const RULES = {
  js: [
    ['c', '//[^\\n]*|/\\*[\\s\\S]*?(?:\\*/|(?![\\s\\S]))'],
    ['s', '`(?:\\\\[\\s\\S]|[^`\\\\])*(?:`|(?![\\s\\S]))|"(?:\\\\.|[^"\\\\\\n])*"?|\'(?:\\\\.|[^\'\\\\\\n])*\'?'],
    ['n', NUM],
    ['i', IDENT],
  ],
  c: [
    ['c', '//[^\\n]*|/\\*[\\s\\S]*?(?:\\*/|(?![\\s\\S]))'],
    ['m', '^[ \\t]*#[ \\t]*\\w+[^\\n]*'],
    ['s', '"(?:\\\\.|[^"\\\\\\n])*"?|\'(?:\\\\.|[^\'\\\\\\n])*\'?'],
    ['n', NUM],
    ['i', IDENT],
  ],
  python: [
    ['c', '#[^\\n]*'],
    ['s', '[rRbBfFuU]{0,2}(?:"""[\\s\\S]*?(?:"""|(?![\\s\\S]))|\'\'\'[\\s\\S]*?(?:\'\'\'|(?![\\s\\S]))|"(?:\\\\.|[^"\\\\\\n])*"?|\'(?:\\\\.|[^\'\\\\\\n])*\'?)'],
    ['m', '@[A-Za-z_][\\w.]*'],
    ['n', NUM],
    ['i', '[A-Za-z_]\\w*'],
  ],
  ruby: [
    ['c', '#[^\\n]*|=begin[\\s\\S]*?(?:=end|(?![\\s\\S]))'],
    ['s', '"(?:\\\\.|[^"\\\\\\n])*"?|\'(?:\\\\.|[^\'\\\\\\n])*\'?'],
    ['m', ':[A-Za-z_]\\w*|@{1,2}[A-Za-z_]\\w*'],
    ['n', NUM],
    ['i', '[A-Za-z_]\\w*[?!]?'],
  ],
  bash: [
    ['c', '#[^\\n]*'],
    ['s', '"(?:\\\\[\\s\\S]|[^"\\\\])*"?|\'[^\']*\'?'],
    ['m', '\\$(?:\\{[^}\\n]*\\}?|\\([^)\\n]*\\)?|[A-Za-z_]\\w*|[0-9@#?*!$-])'],
    ['a', '(?<=^|[\\s;|&(])--?[A-Za-z][\\w-]*'],
    ['n', '\\b\\d+\\b'],
    ['i', '[A-Za-z_][\\w.-]*'],
  ],
  sql: [
    ['c', '--[^\\n]*|/\\*[\\s\\S]*?(?:\\*/|(?![\\s\\S]))'],
    ['s', '\'(?:\'\'|[^\'])*\'?|"(?:[^"])*"?'],
    ['n', NUM],
    ['i', '[A-Za-z_]\\w*'],
  ],
  json: [
    ['p', '"(?:\\\\.|[^"\\\\\\n])*"(?=\\s*:)'],
    ['s', '"(?:\\\\.|[^"\\\\\\n])*"?'],
    ['c', '//[^\\n]*|/\\*[\\s\\S]*?(?:\\*/|(?![\\s\\S]))'],
    ['n', '-?\\d[\\d.]*(?:[eE][+-]?\\d+)?'],
    ['i', '[A-Za-z_]\\w*'],
  ],
  yaml: [
    ['c', '#[^\\n]*'],
    ['p', '^[ \\t-]*[\\w.\\-/"\']+(?=[ \\t]*:(?:\\s|(?![\\s\\S])))'],
    ['s', '"(?:\\\\.|[^"\\\\\\n])*"?|\'[^\'\\n]*\'?'],
    ['m', '[&*][\\w-]+'],
    ['n', '-?\\b\\d[\\d._]*\\b'],
    ['i', '[A-Za-z_]\\w*'],
  ],
  html: [
    ['c', '<!--[\\s\\S]*?(?:-->|(?![\\s\\S]))'],
    ['t', '</?[A-Za-z][\\w:.-]*|/?>'],
    ['a', '(?<=\\s)[A-Za-z_:@][\\w:.@-]*(?=\\s*=)'],
    ['s', '"[^"]*"?|\'[^\']*\'?'],
  ],
  css: [
    ['c', '/\\*[\\s\\S]*?(?:\\*/|(?![\\s\\S]))|//[^\\n]*'],
    ['s', '"(?:\\\\.|[^"\\\\\\n])*"?|\'(?:\\\\.|[^\'\\\\\\n])*\'?'],
    ['m', '@[\\w-]+'],
    ['a', '--[\\w-]+|(?<=[{;\\s^])[a-z-]+(?=\\s*:(?!:))'],
    ['n', '#[0-9a-fA-F]{3,8}\\b|-?\\d*\\.?\\d+(?:px|em|rem|%|vh|vw|s|ms|deg|fr|ch)?'],
    ['i', '[A-Za-z_-][\\w-]*'],
  ],
  diff: [
    ['ins', '^\\+[^\\n]*'],
    ['del', '^-[^\\n]*'],
    ['m', '^@@[^\\n]*'],
    ['c', '^(?:diff|index|---|\\+\\+\\+)[^\\n]*'],
  ],
};
// Languages that share a rule set with small differences.
RULES.swift = [
  ['c', '//[^\\n]*|/\\*[\\s\\S]*?(?:\\*/|(?![\\s\\S]))'],
  ['s', '"""[\\s\\S]*?(?:"""|(?![\\s\\S]))|"(?:\\\\.|[^"\\\\\\n])*"?'],
  ['m', '@\\w+|#\\w+'],
  ['n', NUM],
  ['i', IDENT],
];
RULES.php = [
  ['c', '//[^\\n]*|#[^\\n]*|/\\*[\\s\\S]*?(?:\\*/|(?![\\s\\S]))'],
  ['s', '"(?:\\\\.|[^"\\\\])*"?|\'(?:\\\\.|[^\'\\\\])*\'?'],
  ['m', '\\$[A-Za-z_]\\w*'],
  ['n', NUM],
  ['i', '[A-Za-z_]\\w*'],
];
RULES.rust = [
  ['c', '//[^\\n]*|/\\*[\\s\\S]*?(?:\\*/|(?![\\s\\S]))'],
  ['s', '"(?:\\\\[\\s\\S]|[^"\\\\])*"?|\'(?:\\\\.|[^\'\\\\\\n])\'|b\'(?:\\\\.|[^\'\\\\])\''],
  ['m', '#!?\\[[^\\]\\n]*\\]?|\'[a-z_]\\w*(?!\')'],
  ['n', NUM],
  ['i', '[A-Za-z_]\\w*!?'],
];
RULES.go = [
  ['c', '//[^\\n]*|/\\*[\\s\\S]*?(?:\\*/|(?![\\s\\S]))'],
  ['s', '`[^`]*`?|"(?:\\\\.|[^"\\\\\\n])*"?|\'(?:\\\\.|[^\'\\\\\\n])*\'?'],
  ['n', NUM],
  ['i', '[A-Za-z_]\\w*'],
];
RULES.kotlin = RULES.java = RULES.csharp = [
  ['c', '//[^\\n]*|/\\*[\\s\\S]*?(?:\\*/|(?![\\s\\S]))'],
  ['s', '"""[\\s\\S]*?(?:"""|(?![\\s\\S]))|@?"(?:\\\\.|[^"\\\\\\n])*"?|\'(?:\\\\.|[^\'\\\\\\n])*\'?'],
  ['m', '@[A-Za-z_]\\w*'],
  ['n', NUM],
  ['i', IDENT],
];

const compiled = {};
function compile(family) {
  if (compiled[family]) return compiled[family];
  const rules = RULES[family];
  if (!rules) return (compiled[family] = null);
  const src = rules.map((r) => '(' + r[1] + ')').join('|');
  let re;
  try { re = new RegExp(src, 'gm'); } catch (e) { re = null; } // lookbehind unsupported: fall back to plain text
  return (compiled[family] = re ? { re, kinds: rules.map((r) => r[0]) } : null);
}

// Operators and punctuation are left as plain text on purpose: colouring
// every bracket makes code noisier, not clearer.
function tokenise(code, family) {
  const c = compile(family);
  if (!c) return esc(code);
  const kwSet = KW[family] || KW.js;
  const { re, kinds } = c;
  re.lastIndex = 0;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(code)) !== null) {
    if (m[0] === '') { re.lastIndex++; continue; }
    out += esc(code.slice(last, m.index));
    last = m.index + m[0].length;

    let kind = '';
    for (let g = 1; g <= kinds.length; g++) {
      if (m[g] !== undefined) { kind = kinds[g - 1]; break; }
    }
    const text = m[0];

    if (kind === 'i') {
      const next = code.slice(last).match(/^\s*(\()/);
      if (kwSet.has(text)) kind = 'k';
      else if (LITERALS.has(text)) kind = 'l';
      else if (family !== 'sql' && next) kind = 'f';
      else if (/^[A-Z][A-Za-z0-9_]*$/.test(text) && text.length > 1 && family !== 'sql' && family !== 'css') kind = 't';
      else if (family === 'sql' && kwSet.has(text.toLowerCase())) kind = 'k';
      else kind = '';
    }
    if (family === 'sql' && kind === '' && kwSet.has(text.toLowerCase())) kind = 'k';

    out += kind ? '<span class="tk-' + kind + '">' + esc(text) + '</span>' : esc(text);
  }
  out += esc(code.slice(last));
  return out;
}

/* ── Per-line output ─────────────────────────────────────────────── */
// A token (block comment, template string) can span lines. Split the
// highlighted HTML at newlines, closing and reopening open spans, so every
// line is self-contained markup. That is what lets the gutter be CSS-only.

function splitLines(html) {
  const lines = [];
  const open = [];       // stack of currently open <span ...> tags
  let cur = '';
  const re = /(<span class="[^"]*">)|(<\/span>)|(\n)|([^<\n]+|<)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1]) { open.push(m[1]); cur += m[1]; }
    else if (m[2]) { open.pop(); cur += m[2]; }
    else if (m[3]) {
      cur += '</span>'.repeat(open.length);
      lines.push(cur);
      cur = open.join('');
    } else cur += m[4];
  }
  lines.push(cur);
  return lines;
}

/* ── Memo ────────────────────────────────────────────────────────── */
const MEMO_MAX = 80;
const memo = new Map();

function highlightLines(lang, code) {
  const key = lang + '\u0001' + code;
  const hit = memo.get(key);
  if (hit) return hit;
  const family = familyOf(lang);
  let lines;
  if (code.length > 200000) {
    // Absurdly large block: skip colouring so the chat stays responsive.
    lines = esc(code).split('\n');
  } else {
    lines = splitLines(family ? tokenise(code, family) : esc(code));
  }
  if (memo.size >= MEMO_MAX) memo.delete(memo.keys().next().value);
  memo.set(key, lines);
  return lines;
}

/** Cheap, stable hash. Equal key means identical block, so the streaming
 *  morph can skip it without touching the DOM. */
function codeBlockKey(lang, code) {
  let h = 5381;
  const s = lang + '\u0001' + code;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + '.' + s.length;
}

/**
 * Builds the markup for one fenced code block.
 * `code` is still HTML-escaped (renderMarkdownLite escapes before it
 * extracts blocks); `id` is the stable element id used by the Copy button.
 */
function buildCodeBlockHtml({ lang, code, id }) {
  const source = unesc(code).replace(/\r\n?/g, '\n');
  const rows = highlightLines((lang || '').toLowerCase(), source);
  const count = rows.length;
  const digits = String(count).length < 2 ? 2 : String(count).length;
  const body = rows.map((r) => '<span class="cl">' + r + '\n</span>').join('');
  const isLong = count >= 5; // Download only appears once a block is big enough to be a file

  return '<div class="code-block-wrap" data-lang="' + esc((lang || '').toLowerCase()) + '"' +
      ' data-ext="' + esc(extOf(lang)) + '"' + (isLong ? ' data-long="1"' : '') + ' data-code-key="' + codeBlockKey(lang || '', source) + '"' +
      ' style="--gd:' + digits + '">' +
    '<div class="code-head">' +
      '<span class="code-lang">' + esc(labelOf(lang)) + '</span>' +
      '<span class="code-actions">' +
        '<button type="button" class="code-dl-btn" data-copy-target="' + id + '" aria-label="Download code"><i class="ph ph-download-simple"></i><span>Download</span></button>' +
        '<button type="button" class="code-copy-btn" data-copy-target="' + id + '" aria-label="Copy code"><i class="ph ph-copy"></i><span>Copy</span></button>' +
      '</span>' +
    '</div>' +
    '<div class="code-scroll" tabindex="0" role="region" aria-label="' + esc(labelOf(lang)) + ' code">' +
      '<pre><code id="' + id + '" class="code-lines">' + body + '</code></pre>' +
    '</div>' +
  '</div>';
}

/** The exact source of a block: lines joined, final newline removed. Never
 *  includes line numbers, because those are CSS counters, not text. */
function codeTextOf(codeEl) {
  if (!codeEl) return '';
  const t = codeEl.textContent || '';
  return t.endsWith('\n') ? t.slice(0, -1) : t;
}

export { buildCodeBlockHtml, codeTextOf, codeBlockKey, extOf };
