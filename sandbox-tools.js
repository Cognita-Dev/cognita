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

export const WORKSPACE_ROOT = '/workspace';

// ── Limits that protect the Worker and the model's context ──────────────
const MAX_PATH_CHARS = 300;
const MAX_CODE_CHARS = 60_000;          // one run_python / run_javascript / write_file body
const MAX_COMMAND_CHARS = 4_000;
const MAX_TEXT_FIELD = 12_000;          // stdout / stderr kept per field in a result
const MAX_FILES_LISTED = 60;
export const MAX_IMPORT_CHARS = 300_000; // mirrors MAX_CONTENT_CHARS in google-tools.js / github-tools.js
const MAX_TRACE_ENTRIES = 40;
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

const PATH_NOTE = ' Paths are inside the workspace (/workspace). A relative path is resolved from the current working directory.';

const CATALOG = [
  { cap: CAPS.FILES, tool: _fn('sandbox_create_workspace',
    'Starts a fresh, empty workspace for this conversation (or confirms the existing one). Set reset=true to wipe all files first. Returns the working directory.',
    { reset: { type: 'boolean', description: 'Delete every file and start empty. Default false.' } }, []) },

  { cap: CAPS.PYTHON, tool: _fn('sandbox_run_python',
    'Runs Python code for real in the workspace and returns stdout, stderr and the exit code. Use it for calculations, data analysis (pandas, numpy), charts (matplotlib, save them to a file), parsing and converting files. Files in the workspace are visible to the code; files it writes are kept. There is no internet access.',
    {
      code: { type: 'string', description: 'The Python source to run.' },
      filename: { type: 'string', description: 'Optional. Save the code to this workspace file first, then run it (useful for scripts you will run again).' },
    }, ['code']) },

  { cap: CAPS.JS, tool: _fn('sandbox_run_javascript',
    'Runs JavaScript for real in the workspace and returns console output and the exit code. The code can read and write workspace files with workspace.readText(path), workspace.writeText(path, text) and workspace.list(). There is no DOM and no internet access.',
    { code: { type: 'string', description: 'The JavaScript source to run. Top-level await is allowed.' } }, ['code']) },

  { cap: CAPS.SHELL_LITE, tool: _fn('sandbox_run_command',
    'Runs a command in the workspace shell and returns stdout, stderr, the exit code and the working directory afterwards. The working directory is remembered between calls, so "cd project" affects later calls. Supported: pwd, cd, ls, tree, cat, head, tail, wc, grep, find, mkdir, touch, cp, mv, rm, echo, sort, uniq, diff, python, node, and "pip install <package>" for packages bundled with the browser Python. Pipes (|), redirects (> >>), && and ; work. This is a built-in shell, not full Bash: no git, npm, sudo or background jobs unless the tool result says otherwise.',
    { command: { type: 'string', description: 'The command line to run.' } }, ['command']) },

  { cap: CAPS.TESTS_PY, tool: _fn('sandbox_run_tests',
    'Runs the project tests in the workspace and returns the results. runner is "unittest" (default) or "pytest".',
    {
      runner: { type: 'string', description: '"unittest" or "pytest". Default "unittest".' },
      path: { type: 'string', description: 'Optional file or folder to test, relative to the working directory.' },
    }, []) },

  { cap: CAPS.FILES, tool: _fn('sandbox_write_file',
    'Creates or overwrites a text file in the workspace. Parent folders are created automatically.' + PATH_NOTE,
    {
      path: { type: 'string', description: 'File path.' },
      content: { type: 'string', description: 'Full text content of the file.' },
    }, ['path', 'content']) },

  { cap: CAPS.FILES, tool: _fn('sandbox_read_file',
    'Reads a text file from the workspace.' + PATH_NOTE,
    {
      path: { type: 'string', description: 'File path.' },
      maxChars: { type: 'integer', description: 'Most characters to return (default 8000, max 20000).' },
    }, ['path']) },

  { cap: CAPS.FILES, tool: _fn('sandbox_list_files',
    'Lists files and folders in the workspace with their sizes.' + PATH_NOTE,
    {
      path: { type: 'string', description: 'Folder to list. Defaults to the working directory.' },
      recursive: { type: 'boolean', description: 'Include everything below the folder. Default false.' },
    }, []) },

  { cap: CAPS.FILES, tool: _fn('sandbox_make_directory',
    'Creates a folder (and any missing parents) in the workspace.' + PATH_NOTE,
    { path: { type: 'string', description: 'Folder path.' } }, ['path']) },

  { cap: CAPS.FILES, tool: _fn('sandbox_move_file',
    'Moves or renames a file or folder in the workspace.' + PATH_NOTE,
    {
      from: { type: 'string', description: 'Existing path.' },
      to: { type: 'string', description: 'New path.' },
    }, ['from', 'to']) },

  { cap: CAPS.FILES, tool: _fn('sandbox_delete_file',
    'Deletes a file or folder from the workspace. This cannot be undone.' + PATH_NOTE,
    { path: { type: 'string', description: 'Path to delete.' } }, ['path']) },

  { cap: CAPS.FILES, tool: _fn('sandbox_get_working_directory',
    'Returns the current working directory of the workspace shell.', {}, []) },

  { cap: CAPS.FILES, tool: _fn('sandbox_import_from_tool',
    'Places the full text returned by an EARLIER connected-app tool call in this task (for example a Google Drive file, a Google Sheet exported as CSV, a Google Doc, or a GitHub file) into the workspace as a file, without you retyping it. source_step is the step number shown in that tool result.',
    {
      path: { type: 'string', description: 'Workspace file to create, for example data/sales.csv.' },
      source_step: { type: 'integer', description: 'Step number of the earlier tool result that holds the content.' },
    }, ['path', 'source_step']) },

  { cap: CAPS.FILES, tool: _fn('sandbox_offer_file',
    'Marks a workspace file as a deliverable for the user (a report, chart, CSV, script) so they get a download button. Files you do not offer stay temporary scratch files and are not kept.',
    {
      path: { type: 'string', description: 'Workspace file to offer.' },
      title: { type: 'string', description: 'Short human title, for example "Sales summary".' },
    }, ['path']) },

  // Only offered by providers that report real processes (Tier 3).
  { cap: CAPS.PROCESSES, tool: _fn('sandbox_start_process',
    'Starts a long-running command in the background (for example a dev server or a build) and returns a process id. Read its output with sandbox_get_process_output.',
    { command: { type: 'string', description: 'The command to start.' } }, ['command']) },

  { cap: CAPS.PROCESSES, tool: _fn('sandbox_get_process_output',
    'Returns the output so far, and whether it is still running, for a background process.',
    { process_id: { type: 'string', description: 'The id returned by sandbox_start_process.' } }, ['process_id']) },

  { cap: CAPS.PROCESSES, tool: _fn('sandbox_stop_process',
    'Stops a background process.',
    { process_id: { type: 'string', description: 'The id returned by sandbox_start_process.' } }, ['process_id']) },
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
  return out;
}

/** What the model reads for a finished sandbox call. */
export function resultForModel(normalized) {
  const r = normalized;
  const head = r.ok ? 'The command succeeded (exit code 0).' : 'The command FAILED (exit code ' + r.exitCode + '). Read stderr, fix the cause and try again.';
  return head + '\n' + JSON.stringify(r);
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

/** One finished tool exchange: connector or sandbox. */
export function makeTraceEntry({ n, kind, assistantText, description, resultText, blob }) {
  let r = String(resultText == null ? '' : resultText);
  let shortened = false;
  if (r.length > MAX_TRACE_RESULT_CHARS) { r = r.slice(0, MAX_TRACE_RESULT_CHARS); shortened = true; }
  const entry = { n, k: kind, a: assistantText ? String(assistantText).slice(0, 4000) : '', d: String(description || '').slice(0, 400), r };
  if (typeof blob === 'string' && blob.length > 0) {
    entry.b = blob.length > MAX_TRACE_BLOB_CHARS ? blob.slice(0, MAX_TRACE_BLOB_CHARS) : blob;
  }
  if (shortened || entry.b) entry.s = true; // model should be told the full text is importable
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
