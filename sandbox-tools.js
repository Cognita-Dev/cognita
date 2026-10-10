// sandbox-tools.js
// The agent sandbox tool layer, shaped like github-tools.js / google-tools.js
// so connector-tools.js can treat it the same way: TOOLS (what the model
// sees), REQUIRES_CONFIRMATION, describe(), approvalScope(), execute().
//
// What is different from a connected-app tool: a sandbox tool does not
// call an external API. Where the code runs depends on the provider
// (sandbox-provider.js):
//
//   Tier 1  Browser   site = 'client'. The Worker cannot, and must not,
//                     run model-written code. It hands the call to the
//                     person's own browser (an isolated, network-less
//                     iframe + Web Worker, see js/sandbox-client.js) and
//                     the loop continues when the browser sends the real
//                     result back. See "Client round trip" below.
//   Tier 3  Remote    site = 'server'. A paid Linux sandbox reached over
//                     HTTPS. execute() below forwards the call and the loop
//                     continues in the same request, like a normal tool.
//
// The model sees ONE tool surface either way. Tools are offered only if
// the active provider reports the capability (toolsForCapabilities), so
// the model is never told it can run git on a provider that cannot.
//
// Security notes (the full list is in the README section):
//   - No Worker secret, binding, token or connector credential is ever
//     put in a tool argument, a client call, or a remote request.
//   - The remote workspace id is a hash of uid + conversation id. The raw
//     uid never leaves the Worker.
//   - Everything the browser sends back is treated as untrusted DATA. It is
//     size-capped here and only ever shown to the model as a tool result.

import { CAPS } from './sandbox-provider.js';
import { checkPublicUrl, MODES as BROWSER_MODES } from './browser-rendering.js';

export const WORKSPACE_ROOT = '/workspace';

// ── Limits that protect the Worker and the model's context ──────────────
const MAX_PATH_CHARS = 300;
const MAX_CODE_CHARS = 60_000;          // one run_python / run_javascript / write_file body
const MAX_COMMAND_CHARS = 4_000;
const MAX_TEXT_FIELD = 12_000;          // stdout / stderr kept per field in a result
const MAX_FILES_LISTED = 60;
export const MAX_IMPORT_CHARS = 300_000; // mirrors MAX_CONTENT_CHARS in google-tools.js / github-tools.js
const MAX_TRACE_ENTRIES = 40;
const MAX_TRACE_FILES = 20;
const MAX_TRACE_RESULT_CHARS = 60_000;  // model-visible result text kept per trace entry
const MAX_TRACE_BLOB_CHARS = MAX_IMPORT_CHARS;
const MAX_TRACE_TOTAL_CHARS = 1_200_000;
export const MAX_SANDBOX_CALLS_PER_TURN = 12;

// ── Tool schemas ────────────────────────────────────────────────────────
// Each entry: { cap, tool }. `cap` is the capability a provider must report
// before the tool is offered to the model.

function _fn(name, description, properties, required) {
  return {
    type: 'function',
    function: { name, description, parameters: { type: 'object', properties, required: required || [] } },
  };
}

const CATALOG = [
  { cap: CAPS.FILES, tool: _fn('sandbox_create_workspace',
    'Start or confirm this conversation\'s workspace. reset=true wipes it.',
    { reset: { type: 'boolean' } }, []) },

  { cap: CAPS.PYTHON, tool: _fn('sandbox_run_python',
    'Run Python; returns stdout, stderr, exit code. Has numpy, pandas, matplotlib, scipy, scikit-learn, sympy, openpyxl. Files written are kept.',
    {
      code: { type: 'string' },
      filename: { type: 'string', description: 'Optional. Save the code here first, then run it.' },
    }, ['code']) },

  { cap: CAPS.JS, tool: _fn('sandbox_run_javascript',
    'Run JavaScript; returns console output and exit code. Files: workspace.readText(p), workspace.writeText(p, t), workspace.list(). No DOM.',
    { code: { type: 'string' } }, ['code']) },

  { cap: CAPS.SHELL_LITE, tool: _fn('sandbox_run_command',
    'Run a shell command; the working directory persists. Has pwd cd ls tree cat head tail wc grep find mkdir touch cp mv rm echo sort uniq diff python node, pipes, redirects, && and ;. No git, npm or sudo.',
    { command: { type: 'string' } }, ['command']) },

  { cap: CAPS.TESTS_PY, tool: _fn('sandbox_run_tests',
    'Run project tests.',
    {
      runner: { type: 'string', description: '"unittest" (default) or "pytest".' },
      path: { type: 'string', description: 'Optional file or folder.' },
    }, []) },

  { cap: CAPS.FILES, tool: _fn('sandbox_write_file',
    'Create or overwrite a text file. Parent folders are made.',
    { path: { type: 'string' }, content: { type: 'string' } }, ['path', 'content']) },

  { cap: CAPS.FILES, tool: _fn('sandbox_read_file',
    'Read a text file.',
    { path: { type: 'string' }, maxChars: { type: 'integer', description: 'Default 8000, max 20000.' } }, ['path']) },

  { cap: CAPS.FILES, tool: _fn('sandbox_list_files',
    'List files and sizes.',
    { path: { type: 'string', description: 'Default: working directory.' }, recursive: { type: 'boolean' } }, []) },

  { cap: CAPS.FILES, tool: _fn('sandbox_make_directory',
    'Create a folder and any missing parents.',
    { path: { type: 'string' } }, ['path']) },

  { cap: CAPS.FILES, tool: _fn('sandbox_move_file',
    'Move or rename a file or folder.',
    { from: { type: 'string' }, to: { type: 'string' } }, ['from', 'to']) },

  { cap: CAPS.FILES, tool: _fn('sandbox_delete_file',
    'Delete a file or folder. Cannot be undone.',
    { path: { type: 'string' } }, ['path']) },

  { cap: CAPS.FILES, tool: _fn('sandbox_get_working_directory',
    'Return the current working directory.', {}, []) },

  { cap: CAPS.FILES, tool: _fn('sandbox_import_from_tool',
    'Put the full text from an earlier connected-app tool result (Drive file, Sheet as CSV, Doc, GitHub file) into a workspace file.',
    {
      path: { type: 'string', description: 'File to create, e.g. data/sales.csv.' },
      source_step: { type: 'integer', description: 'Step number of that earlier result.' },
    }, ['path', 'source_step']) },

  { cap: CAPS.FILES, tool: _fn('sandbox_offer_file',
    'Give the user a download button for a workspace file (report, chart, CSV, script). Call it for every file they asked for; unoffered files are scratch.',
    { path: { type: 'string' }, title: { type: 'string', description: 'Short title, e.g. "Sales summary".' } }, ['path']) },

  // Local browser test (Tier 1). Runs in the person's own browser, free on every plan.
  { cap: CAPS.BROWSER_TEST, tool: _fn('sandbox_browser_test',
    'Open an HTML page in a real browser and report console errors, failed loads, page text and layout measurements. The user is also shown a screenshot and a live preview of the page (you only get the text report). Give path (an .html file in the workspace; linked local .css and .js files are included) or html. No internet: outside files are blocked. Use it to check a page you wrote, then fix what it reports.',
    {
      path: { type: 'string', description: 'HTML file in /workspace.' },
      html: { type: 'string', description: 'Or the HTML itself.' },
      width: { type: 'integer', description: 'Viewport width, 200 to 2000. Default 1024. Use 375 to check a phone.' },
      height: { type: 'integer', description: 'Viewport height, 200 to 3000. Default 768.' },
      wait_ms: { type: 'integer', description: 'Extra wait after load for scripts, 0 to 5000. Default 300.' },
      selectors: { type: 'array', items: { type: 'string' }, description: 'Up to 10 CSS selectors to measure (count, visible, size, position).' },
      touch: { type: 'boolean', description: 'Also flag tap targets smaller than 44 px.' },
      full_page: { type: 'boolean', description: 'Screenshot the whole page (up to 3000 px tall) instead of just the first screen.' },
      screenshot: { type: 'boolean', description: 'Set false to skip the screenshot the user sees. Default true.' },
    }, []) },

  // Cloud browser (Studio and Admin only). Offered per request by chat-endpoint.js, never by a provider.
  { cap: CAPS.BROWSER_REMOTE, tool: _fn('sandbox_browser_fetch',
    'Cloud browser. Render a public https web page (or html you give) in real Chrome and return the rendered text, html, links, or measurements of elements. Use it for live sites, or when sandbox_browser_test cannot run. It cannot report console errors.',
    {
      url: { type: 'string', description: 'Public https address. Give url or html, not both.' },
      html: { type: 'string' },
      mode: { type: 'string', description: '"text" (default), "html", "links" or "elements".' },
      selectors: { type: 'array', items: { type: 'string' }, description: 'For mode "elements": up to 10 CSS selectors.' },
    }, []) },

  // Only offered by providers that report real processes (Tier 3).
  { cap: CAPS.PROCESSES, tool: _fn('sandbox_start_process',
    'Start a long-running background command; returns a process id.',
    { command: { type: 'string' } }, ['command']) },

  { cap: CAPS.PROCESSES, tool: _fn('sandbox_get_process_output',
    'Return output so far and whether the process is still running.',
    { process_id: { type: 'string' } }, ['process_id']) },

  { cap: CAPS.PROCESSES, tool: _fn('sandbox_stop_process',
    'Stop a background process.',
    { process_id: { type: 'string' } }, ['process_id']) },
];

export const TOOLS = CATALOG.map((c) => c.tool);
const TOOL_CAP = {};
for (const c of CATALOG) TOOL_CAP[c.tool.function.name] = c.cap;
export const SANDBOX_TOOL_NAMES = new Set(Object.keys(TOOL_CAP));

/** The tool schemas a provider with these capabilities can really serve. */
export function toolsForCapabilities(capabilities) {
  const caps = capabilities instanceof Set ? capabilities : new Set(capabilities || []);
  return CATALOG.filter((c) => caps.has(c.cap)).map((c) => c.tool);
}

export function isSandboxTool(name) {
  return SANDBOX_TOOL_NAMES.has(name);
}

// Sandbox tools only change the person's private scratch workspace, never an
// external service, so none of them needs the connected-app confirmation.
// Anything that leaves the sandbox (a Drive upload, a GitHub commit) goes
// through the connector tools, which keep their own confirmation rules.
export const REQUIRES_CONFIRMATION = [];

export function approvalScope() {
  return 'workspace';
}

// The gate that decides whether a message gets the sandbox tools lives in
// sandbox-intent.js, because the browser uses the same patterns to decide
// when to warm up Python. One copy means the two can never disagree.
export { SANDBOX_INTENT_PATTERNS, shouldOfferSandbox } from './sandbox-intent.js';

// ── Paths ───────────────────────────────────────────────────────────────

/** Returns a clean absolute path inside /workspace, or null if it escapes or is malformed. */
export function cleanWorkspacePath(raw, cwd) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PATH_CHARS) return null;
  if (raw.indexOf('\0') !== -1) return null;
  const base = typeof cwd === 'string' && cwd.startsWith(WORKSPACE_ROOT) ? cwd : WORKSPACE_ROOT;
  const joined = raw.startsWith('/') ? raw : base + '/' + raw;
  const out = [];
  for (const part of joined.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (out.length === 0) return null; out.pop(); continue; }
    out.push(part);
  }
  const full = '/' + out.join('/');
  if (full !== WORKSPACE_ROOT && !full.startsWith(WORKSPACE_ROOT + '/')) return null;
  return full;
}

// ── describe(): one plain line for the activity trace ───────────────────

function _short(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '\u2026' : t;
}

export function describe(name, args) {
  const a = args || {};
  switch (name) {
    case 'sandbox_create_workspace': return a.reset ? 'Starting a fresh workspace.' : 'Setting up the workspace.';
    case 'sandbox_run_python': return a.filename ? 'Running ' + _short(a.filename, 60) + ' with Python.' : 'Running Python.';
    case 'sandbox_run_javascript': return 'Running JavaScript.';
    case 'sandbox_run_command': return 'Running: ' + _short(a.command, 100);
    case 'sandbox_run_tests': return 'Running the tests.';
    case 'sandbox_write_file': return 'Writing ' + _short(a.path, 80) + '.';
    case 'sandbox_read_file': return 'Reading ' + _short(a.path, 80) + '.';
    case 'sandbox_list_files': return 'Listing files' + (a.path ? ' in ' + _short(a.path, 60) : '') + '.';
    case 'sandbox_make_directory': return 'Creating folder ' + _short(a.path, 80) + '.';
    case 'sandbox_move_file': return 'Moving ' + _short(a.from, 50) + ' to ' + _short(a.to, 50) + '.';
    case 'sandbox_delete_file': return 'Deleting ' + _short(a.path, 80) + '.';
    case 'sandbox_get_working_directory': return 'Checking the working directory.';
    case 'sandbox_import_from_tool': return 'Placing the fetched data in ' + _short(a.path, 80) + '.';
    case 'sandbox_offer_file': return 'Preparing ' + _short(a.title || a.path, 80) + ' for download.';
    case 'sandbox_browser_test': return a.path ? 'Testing ' + _short(a.path, 70) + ' in a browser.' : 'Testing the page in a browser.';
    case 'sandbox_browser_fetch': return a.url ? 'Opening ' + _short(a.url, 80) + ' in the cloud browser.' : 'Rendering the page in the cloud browser.';
    case 'sandbox_start_process': return 'Starting: ' + _short(a.command, 100);
    case 'sandbox_get_process_output': return 'Reading process output.';
    case 'sandbox_stop_process': return 'Stopping the process.';
    default: return 'Working in the sandbox.';
  }
}

// ── Argument checks beyond "required fields present" ────────────────────

/** Returns { ok: true } or { ok: false, error } for a proposed sandbox call. */
export function validateSandboxArgs(name, args) {
  const a = args || {};
  const pathFields = {
    sandbox_write_file: ['path'], sandbox_read_file: ['path'], sandbox_make_directory: ['path'],
    sandbox_delete_file: ['path'], sandbox_move_file: ['from', 'to'], sandbox_import_from_tool: ['path'],
    sandbox_offer_file: ['path'],
  }[name] || [];
  for (const f of pathFields) {
    if (!cleanWorkspacePath(a[f], WORKSPACE_ROOT)) {
      return { ok: false, error: '"' + f + '" must be a path inside /workspace (no ".." that leaves it).' };
    }
  }
  for (const f of ['path', 'filename']) {
    if (a[f] !== undefined && a[f] !== '' && !pathFields.includes(f) && typeof a[f] === 'string' && !cleanWorkspacePath(a[f], WORKSPACE_ROOT)) {
      return { ok: false, error: '"' + f + '" must stay inside /workspace.' };
    }
  }
  if ((name === 'sandbox_run_python' || name === 'sandbox_run_javascript' || name === 'sandbox_write_file')) {
    const body = name === 'sandbox_write_file' ? a.content : a.code;
    if (typeof body !== 'string') return { ok: false, error: 'The code/content must be a string.' };
    if (body.length > MAX_CODE_CHARS) return { ok: false, error: 'That is too long to send in one call (max ' + MAX_CODE_CHARS + ' characters). Split it into smaller files.' };
  }
  if ((name === 'sandbox_run_command' || name === 'sandbox_start_process')) {
    if (typeof a.command !== 'string') return { ok: false, error: '"command" must be a string.' };
    if (a.command.length > MAX_COMMAND_CHARS) return { ok: false, error: 'The command is too long (max ' + MAX_COMMAND_CHARS + ' characters).' };
  }
  if (name === 'sandbox_browser_test') {
    const hasPath = typeof a.path === 'string' && a.path.trim() !== '';
    const hasHtml = typeof a.html === 'string' && a.html.trim() !== '';
    if (hasPath === hasHtml) return { ok: false, error: 'Give either "path" or "html", not both and not neither.' };
    if (hasHtml && a.html.length > MAX_CODE_CHARS) return { ok: false, error: 'That HTML is too long (max ' + MAX_CODE_CHARS + ' characters). Save it as a file and pass "path".' };
    for (const f of ['width', 'height', 'wait_ms']) {
      if (a[f] !== undefined && !Number.isFinite(a[f])) return { ok: false, error: '"' + f + '" must be a number.' };
    }
    if (a.selectors !== undefined && (!Array.isArray(a.selectors) || a.selectors.some((s) => typeof s !== 'string' || s.length > 200))) {
      return { ok: false, error: '"selectors" must be a list of short CSS selector strings.' };
    }
  }
  if (name === 'sandbox_browser_fetch') {
    const hasUrl = typeof a.url === 'string' && a.url.trim() !== '';
    const hasHtml = typeof a.html === 'string' && a.html !== '';
    if (hasUrl === hasHtml) return { ok: false, error: 'Give either "url" or "html", not both and not neither.' };
    if (hasUrl) { const c = checkPublicUrl(a.url); if (!c.ok) return { ok: false, error: c.error }; }
    if (a.mode !== undefined && !BROWSER_MODES.includes(a.mode)) return { ok: false, error: '"mode" must be one of: ' + BROWSER_MODES.join(', ') + '.' };
    if (a.mode === 'elements' && (!Array.isArray(a.selectors) || !a.selectors.length)) return { ok: false, error: 'mode "elements" needs "selectors".' };
  }
  if (name === 'sandbox_import_from_tool' && !Number.isInteger(a.source_step)) {
    return { ok: false, error: '"source_step" must be a whole number taken from an earlier tool result.' };
  }
  return { ok: true };
}

// ── Result normalising (everything from the browser is untrusted data) ──

function _str(v, max) {
  if (typeof v !== 'string') return '';
  return v.length > max ? v.slice(0, max) + '\n[output cut: ' + (v.length - max) + ' more characters]' : v;
}

/**
 * Turns whatever the browser or a remote provider returned into the one shape
 * the model sees. Unknown fields are dropped; every string is capped.
 *   { ok, command, cwd, stdout, stderr, exitCode, durationMs, running,
 *     truncated, cancelled, files:[{path,size,change}], offered:[{path,title}], note }
 */
export function normalizeResult(raw, fallbackCommand) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const exitCode = Number.isInteger(r.exitCode) ? r.exitCode : (r.ok === false ? 1 : 0);
  const files = Array.isArray(r.files) ? r.files.slice(0, MAX_FILES_LISTED).map((f) => ({
    path: _str(f && f.path, MAX_PATH_CHARS),
    size: Number.isFinite(f && f.size) ? Math.max(0, Math.floor(f.size)) : 0,
    change: ['created', 'modified', 'deleted'].includes(f && f.change) ? f.change : undefined,
  })).filter((f) => f.path) : [];
  const offered = Array.isArray(r.offered) ? r.offered.slice(0, 10).map((f) => ({
    path: _str(f && f.path, MAX_PATH_CHARS), title: _str(f && f.title, 120),
  })).filter((f) => f.path) : [];
  const out = {
    ok: exitCode === 0 && r.error !== true,
    command: _str(r.command || fallbackCommand || '', 500),
    cwd: _str(r.cwd || WORKSPACE_ROOT, MAX_PATH_CHARS),
    stdout: _str(r.stdout, MAX_TEXT_FIELD),
    stderr: _str(r.stderr, MAX_TEXT_FIELD),
    exitCode,
    durationMs: Number.isFinite(r.durationMs) ? Math.max(0, Math.round(r.durationMs)) : 0,
    running: false,
    truncated: !!r.truncated,
  };
  if (files.length) out.files = files;
  if (offered.length) out.offered = offered;
  if (r.cancelled) out.cancelled = true;
  if (typeof r.note === 'string' && r.note) out.note = _str(r.note, 600);
  // Set by the browser test only when the test page could not be run here at all
  // (never for a page that ran and failed). chat-endpoint.js may retry it in the
  // cloud browser for Studio and Admin, then drops the field.
  if (r.fallback && typeof r.fallback === 'object' && typeof r.fallback.html === 'string' && r.fallback.html) {
    out.fallback = {
      html: r.fallback.html.slice(0, 200000),
      selectors: Array.isArray(r.fallback.selectors) ? r.fallback.selectors.filter((s) => typeof s === 'string').slice(0, 10) : [],
      reason: _str(r.fallback.reason, 200),
    };
  }
  return out;
}

/**
 * What the model reads for a finished sandbox call.
 * `offerHint` is true when the person asked for a file, the run just made
 * one, and nothing has been offered yet: the model gets a plain nudge to
 * offer it, because a file the person cannot download is not delivered.
 */
export function resultForModel(normalized, offerHint) {
  const r = Object.assign({}, normalized);
  delete r.fallback;
  const head = r.ok ? 'The command succeeded (exit code 0).' : 'The command FAILED (exit code ' + r.exitCode + '). Read stderr, fix the cause and try again.';
  let tail = offerHint
    ? '\nThe user asked for a file. Call sandbox_offer_file for it now so they get a download button, then tell them it is ready by its name only.'
    : '';
  // Python could not even start on this device (a connection problem, not a mistake in the code). Trying
  // again in this conversation fails the same way and wastes the person's time, so say so plainly.
  if (!r.ok && /Python did not finish starting|could not reach the Python server|Python stopped downloading|could not download Python|Python could not start/i.test(String(r.stderr || ''))) {
    tail += '\nPython is NOT available on this device right now (it could not be downloaded), and retrying will fail the same way. Do not call any Python or test tool again in this conversation. Use sandbox_run_javascript or plain SVG/HTML files instead, or answer without running code, and tell the user briefly that Python was unavailable.';
  }
  // JavaScript runs in a bare Web Worker. Code written for Node.js or for a web page fails with a plain
  // "X is not defined". That is a mistake in the code, not a broken sandbox, so say so: otherwise the model
  // concludes "the sandbox is unavailable on this device" and gives up on a working tool.
  if (!r.ok && /(?:ReferenceError|TypeError)[^\n]*\b(?:require|process|module|exports|window|document|Buffer|__dirname|localStorage|XMLHttpRequest)\b[^\n]*(?:not defined|undefined|not a function)|Can't find variable: (?:require|process|module|exports|window|document|Buffer|__dirname|localStorage)\b/i.test(String(r.stderr || ''))) {
    tail += '\nThis is an error in the code, not a problem with the device. The JavaScript sandbox is a plain Web Worker: there is no require(), import, process, window, document or Buffer. Use console.log for output and workspace.readText / writeText / exists / list for files, or run the work with sandbox_run_python instead. Fix the code and try again.';
  }
  return head + '\n' + JSON.stringify(r) + tail;
}

// ── Getting files to the person ─────────────────────────────────────────
// The workspace lives inside the browser, so a file the model writes there
// is invisible to the person until it is offered for download. Models forget
// that step, which is how a chat can say "the file has been created" while
// the person has nothing to open. These helpers let the Worker catch that.

// Words that mean the person wants something they can keep, open or send on.
const FILE_REQUEST_PATTERNS = [
  /\b(?:file|files|download|downloadable|attachment)\b/i,
  /\b(?:export|save|store)\b.{0,40}\b(?:as|to|into|in)\b/i,
  /\b(?:csv|tsv|xlsx|excel|spreadsheet|pdf|docx|word document|json|txt|markdown|png|svg)\b/i,
  /\b(?:report|summary)\b.{0,30}\b(?:file|document|sheet)\b/i,
];

export function userWantsFile(text) {
  const t = String(text || '');
  return FILE_REQUEST_PATTERNS.some((re) => re.test(t));
}

// Kinds of file that are normally the point of the request. Scripts are
// only offered on their own when the person asked for code.
const DELIVERABLE_EXT = new Set(['txt', 'md', 'csv', 'tsv', 'json', 'xlsx', 'png', 'jpg', 'jpeg', 'webp', 'svg', 'pdf', 'docx', 'html']);
const CODE_EXT = new Set(['py', 'js']);
const MAX_AUTO_OFFERS = 4;

function _isScratch(path) {
  const name = path.split('/').pop() || '';
  return name.startsWith('.') || name.startsWith('_') || /^tmp[-_.]/i.test(name) || path.includes('/__pycache__/') || path.includes('/uploads/');
}

/**
 * Works out which files to hand the person for this turn.
 *   offered  files the model explicitly offered during this turn
 *   auto     files it made but forgot to offer, only when the person asked
 *            for a file (never for ordinary scratch work)
 * Returns [{ path, title, auto? }], at most MAX_AUTO_OFFERS + offered.
 */
export function collectDeliverables(trace, userText) {
  const entries = Array.isArray(trace) ? trace : [];
  const out = [];
  const seen = new Set();
  for (const e of entries) {
    if (e && e.o && !seen.has(e.o.path)) { seen.add(e.o.path); out.push({ path: e.o.path, title: e.o.title || '' }); }
  }
  if (out.length > 0 || !userWantsFile(userText)) return out;

  const wantsCode = /\b(?:script|code|program|python|py|javascript|\.js)\b/i.test(String(userText || ''));
  // A file changed twice is listed once, with its latest size.
  const latest = new Map();
  for (const e of entries) {
    if (!e || !Array.isArray(e.c)) continue;
    for (const f of e.c) latest.set(f.p, f.s);
  }
  for (const [p, size] of latest) {
    const ext = (p.split('.').pop() || '').toLowerCase();
    const okExt = DELIVERABLE_EXT.has(ext) || (wantsCode && CODE_EXT.has(ext));
    if (!okExt || _isScratch(p)) continue;
    if (out.length >= MAX_AUTO_OFFERS) break;
    out.push({ path: p, title: '', auto: true, size });
  }
  return out;
}

// ── Client round trip ───────────────────────────────────────────────────

/**
 * The descriptor the Worker sends to the browser for a Tier 1 call. It carries
 * only the tool name, its (already validated) arguments and the per-run
 * limits from the person's plan. Nothing secret is ever in here.
 */
export function buildClientCall(name, args, plan, extra) {
  const limits = (plan && plan.limits) || {};
  const call = {
    id: 'sbx_' + Math.random().toString(36).slice(2, 10),
    name,
    args: args || {},
    summary: describe(name, args),
    limits: {
      timeoutMs: Math.max(5, Number(limits.sandboxTimeoutSec) || 20) * 1000,
      maxFileBytes: Math.max(1, Number(limits.sandboxMaxFileMB) || 2) * 1024 * 1024,
      maxWorkspaceBytes: Math.max(1, Number(limits.sandboxMaxWorkspaceMB) || 10) * 1024 * 1024,
      maxOutputChars: MAX_TEXT_FIELD,
      maxProcesses: 1,
      network: false,
    },
  };
  if (extra && typeof extra === 'object') Object.assign(call, extra);
  return call;
}

// ── The turn trace ──────────────────────────────────────────────────────
// The Worker is stateless between requests. When a Tier 1 call pauses the
// stream, everything the model already did this turn is sent to the browser
// as `turnTrace` and echoed back on resume. The browser can edit it, so it
// is only ever used as data for the model, never to decide what is allowed.

/**
 * One finished tool exchange: connector or sandbox.
 * Sandbox entries can also carry two small extras the Worker needs later in
 * the same turn, because it keeps no state between requests:
 *   t  the tool name (so we know which exchange was a file offer)
 *   c  the files this run created or changed, [{p: path, s: size}]
 *   o  the file the model offered for download, {path, title}
 */
export function makeTraceEntry({ n, kind, assistantText, description, resultText, blob, tool, files, offered }) {
  let r = String(resultText == null ? '' : resultText);
  let shortened = false;
  if (r.length > MAX_TRACE_RESULT_CHARS) { r = r.slice(0, MAX_TRACE_RESULT_CHARS); shortened = true; }
  const entry = { n, k: kind, a: assistantText ? String(assistantText).slice(0, 4000) : '', d: String(description || '').slice(0, 400), r };
  if (typeof blob === 'string' && blob.length > 0) {
    entry.b = blob.length > MAX_TRACE_BLOB_CHARS ? blob.slice(0, MAX_TRACE_BLOB_CHARS) : blob;
  }
  if (shortened || entry.b) entry.s = true; // model should be told the full text is importable
  if (typeof tool === 'string' && /^sandbox_[a-z_]{1,50}$/.test(tool)) entry.t = tool;
  if (Array.isArray(files) && files.length) {
    const c = files
      .filter((f) => f && f.change !== 'deleted' && cleanWorkspacePath(f.path, WORKSPACE_ROOT))
      .slice(0, MAX_TRACE_FILES)
      .map((f) => ({ p: cleanWorkspacePath(f.path, WORKSPACE_ROOT), s: Number.isFinite(f.size) ? Math.max(0, Math.floor(f.size)) : 0 }));
    if (c.length) entry.c = c;
  }
  if (offered && typeof offered.path === 'string' && cleanWorkspacePath(offered.path, WORKSPACE_ROOT)) {
    entry.o = { path: cleanWorkspacePath(offered.path, WORKSPACE_ROOT), title: _short(offered.title || '', 120) };
  }
  return entry;
}

/** The text that follows a tool exchange in the model's message list. Same wording the live loop uses. */
function _exchangeText(entry, userDecided) {
  const note = entry.s && entry.b
    ? '\n[Shortened here. The full text is kept: use sandbox_import_from_tool with source_step=' + entry.n + ' to put it in the workspace.]'
    : '';
  return (entry.a ? '' : 'Tool call: ' + entry.d + (userDecided ? ' (just approved and run by the user)' : '') + '\n') +
    'Result (step ' + entry.n + '): ' + entry.r + note +
    '\n\nContinue the task if it is not fully finished yet \u2014 call another tool if one is needed. ' +
    'If it is fully finished, say so plainly. Do not ask the user anything you can find out yourself.';
}

/** Appends one exchange to a message list, in the same shape the live agent loop produces. */
export function appendExchange(messages, entry, userDecided) {
  const add = [];
  if (entry.a) add.push({ role: 'assistant', content: entry.a });
  add.push({ role: 'user', content: _exchangeText(entry, !!userDecided) });
  return messages.concat(add);
}

/** Cleans a trace the browser sent back. Anything that does not look right is dropped. */
export function sanitizeTrace(raw) {
  if (!Array.isArray(raw)) return [];
  let total = 0;
  const out = [];
  for (const e of raw.slice(0, MAX_TRACE_ENTRIES)) {
    if (!e || typeof e !== 'object') continue;
    if (!Number.isInteger(e.n) || e.n < 1 || e.n > 1000) continue;
    if (e.k !== 'tool' && e.k !== 'sbx') continue;
    const entry = {
      n: e.n, k: e.k,
      a: typeof e.a === 'string' ? e.a.slice(0, 4000) : '',
      d: typeof e.d === 'string' ? e.d.slice(0, 400) : '',
      r: typeof e.r === 'string' ? e.r.slice(0, MAX_TRACE_RESULT_CHARS) : '',
    };
    if (typeof e.b === 'string' && e.b) entry.b = e.b.slice(0, MAX_TRACE_BLOB_CHARS);
    if (e.s) entry.s = true;
    // Small extras (see makeTraceEntry). Re-shaped here because the browser can edit them.
    if (typeof e.t === 'string' && /^sandbox_[a-z_]{1,50}$/.test(e.t)) entry.t = e.t;
    if (Array.isArray(e.c)) {
      const c = e.c.slice(0, MAX_TRACE_FILES)
        .filter((f) => f && typeof f.p === 'string' && cleanWorkspacePath(f.p, WORKSPACE_ROOT))
        .map((f) => ({ p: cleanWorkspacePath(f.p, WORKSPACE_ROOT), s: Number.isFinite(f.s) ? Math.max(0, Math.floor(f.s)) : 0 }));
      if (c.length) entry.c = c;
    }
    if (e.o && typeof e.o === 'object' && typeof e.o.path === 'string' && cleanWorkspacePath(e.o.path, WORKSPACE_ROOT)) {
      entry.o = { path: cleanWorkspacePath(e.o.path, WORKSPACE_ROOT), title: _short(e.o.title || '', 120) };
    }
    total += entry.a.length + entry.d.length + entry.r.length + (entry.b ? entry.b.length : 0);
    if (total > MAX_TRACE_TOTAL_CHARS) break;
    out.push(entry);
  }
  return out;
}

/** The full text a connector result carries, if it has one worth importing. */
export function extractImportableText(result) {
  if (result && typeof result === 'object' && typeof result.content === 'string' && result.content.length > 0) {
    return result.content;
  }
  return null;
}

/**
 * sandbox_import_from_tool: finds the earlier result and returns the
 * arguments for a plain write into the workspace. The browser receives the
 * content in a normal write_file call, so the sandbox never needs, sees or
 * asks for any credential.
 */
export function resolveImport(args, trace) {
  const entry = (trace || []).find((e) => e.n === args.source_step);
  if (!entry) return { ok: false, error: 'There is no step ' + args.source_step + ' in this task. Use the step number shown in the earlier tool result.' };
  if (typeof entry.b !== 'string' || entry.b.length === 0) {
    return { ok: false, error: 'Step ' + args.source_step + ' did not return text content that can be placed in the workspace. Fetch the file with the connected-app tool that returns its content first.' };
  }
  return { ok: true, content: entry.b };
}

// ── Server-run execution (Tier 3 only) ──────────────────────────────────

/**
 * Runs a call on a server-side provider and returns the normalized result.
 * Tier 1 never reaches this: chat-endpoint.js hands those calls to the
 * browser instead. Throws on transport failure; the caller turns that into a
 * structured tool error for the model.
 */
export async function execute(name, args, ctx) {
  const { provider, uid, conversationId, plan, env } = ctx;
  if (!provider || provider.site !== 'server') throw new Error('SANDBOX_NOT_SERVER_SIDE');
  const call = buildClientCall(name, args, plan);
  const raw = await provider.execute({ name, args: args || {}, limits: call.limits }, { uid, conversationId, env });
  return normalizeResult(raw, describe(name, args));
}
