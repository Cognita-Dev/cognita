// codespaces-tools.js
// GitHub Codespaces for the user's OWN GitHub account, including a cloud terminal
// Cognita can run commands in on the user's behalf.
//
// Cost model: every call here is made with the user's own GitHub OAuth token
// (the same 'github' connector as github-tools.js), so every codespace is
// created in, and billed to, the USER's account and the user's included
// Codespaces allowance. Cognita never creates a codespace under its own
// account and never pays for one. As a hard guarantee, a codespace Cognita just
// created is deleted again if GitHub reports that anyone other than the user
// would be billed (see _assertBilledToUser). If the user has no allowance left,
// GitHub refuses the request and that message is relayed.
//
// How commands get run: GitHub has no REST endpoint for running a command in a
// codespace, and a Cloudflare Worker cannot hold an SSH session open. So the
// terminal is a codespace created from a small public template repository
// (see /terminal-agent) whose devcontainer starts a tiny helper
// (cognita-agent.py) listening on port 8787. Cognita sends commands to that
// port over HTTPS at https://<codespace>-8787.app.github.dev, with the user's
// own token. The port is private by default (GitHub checks the caller), and the
// helper independently asks GitHub whether the token owns that codespace.
// Cognita's only cost is the ordinary web requests.
//
// Scope: needs the OAuth scope `codespace`, requested when the user connects
// GitHub (connector-providers.js). Users who connected GitHub before that scope
// existed keep working for every other GitHub tool; only these tools ask them
// to reconnect (see _token below). hasSufficientScope() is intentionally NOT
// tightened for this reason.
//
// Same TOOLS/REQUIRES_CONFIRMATION/describe/approvalScope/execute contract as
// github-tools.js, which delegates to this module (see the bottom of that file).

import { getValidToken, getConnectorToken } from './connectors.js';

const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/;

// The public template repo the terminal is created from. Override with the
// Worker variable TERMINAL_TEMPLATE_REPO ("owner/repo").
const DEFAULT_TEMPLATE_REPO = 'Cognita-Dev/cognita-terminal';
const AGENT_PORT = 8787; // must match terminal-agent/.devcontainer

// GitHub accepts 5-240 minutes. A short default protects the user's own quota
// from a forgotten, still-running codespace.
const DEFAULT_IDLE_MINUTES = 30;
const MIN_IDLE_MINUTES = 5;
const MAX_IDLE_MINUTES = 240;

// Stopped codespaces count against the user's storage allowance until deleted,
// so a terminal is removed after a few unused days unless the user asks otherwise.
const DEFAULT_RETENTION_DAYS = 3;
const MAX_RETENTION_DAYS = 30;

const DEFAULT_COMMAND_SECONDS = 60;
const MAX_COMMAND_SECONDS = 120; // keep in step with cognita-agent.py
const MAX_COMMAND_CHARS = 20000;

// Test seam only: lets the test suite swap the token source and network.
const _deps = {
  getValidToken,
  getConnectorToken,
  fetch: (...a) => fetch(...a),
};
export const __test = { setDeps(o) { Object.assign(_deps, o); } };

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'codespaces_list',
      description: "Lists the user's own GitHub Codespaces (cloud development environments with a terminal): name, repository, state (Available, Shutdown, etc.) and link.",
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'Max codespaces to return (default 10, max 30).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'codespaces_create_terminal',
      description: "Creates the user's own cloud terminal: a fresh Linux GitHub Codespace in the USER's GitHub account that commands can then be run in with codespaces_run_command. It uses the user's own Codespaces allowance, never Cognita's, and stops itself when idle. Use this when the user wants Cognita to run commands for them and has no terminal yet. Always requires the user's explicit confirmation first. It can take a minute or two to be ready; check with codespaces_terminal_status.",
      parameters: {
        type: 'object',
        properties: {
          machine: { type: 'string', description: "Optional machine type name (for example 'basicLinux32gb'). Leave out to let GitHub pick the default." },
          idleTimeoutMinutes: { type: 'integer', description: 'Minutes of inactivity before it stops by itself (default 30, min 5, max 240).' },
          retentionDays: { type: 'integer', description: 'Days it is kept while unused before GitHub deletes it (default 3, max 30).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'codespaces_terminal_status',
      description: "Checks whether the user's cloud terminal is ready to run commands: whether it is running and answering. Use it after creating or starting one, or when a command could not be run.",
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: "The codespace's name. Leave out to use the user's most recent cloud terminal." },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'codespaces_run_command',
      description: "Runs ONE shell (bash) command in the user's own cloud terminal (a GitHub Codespace made by codespaces_create_terminal) and returns its output and exit code. It never runs on the user's computer or on Cognita's servers. Each call is a fresh shell, but the working folder carries over between calls. Programs that wait for typed input do not work; a background job must redirect its output (cmd > /dev/null 2>&1 &) or the call waits for it. The GitHub token is not available to commands. Always requires the user's confirmation. Only report what the output actually shows.",
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The bash command to run (a single command or a short script).' },
          name: { type: 'string', description: "The codespace's name. Leave out to use the user's most recent cloud terminal." },
          cwd: { type: 'string', description: 'Folder to run in. Leave out to continue in the folder the last command ended in.' },
          timeoutSeconds: { type: 'integer', description: 'Time limit in seconds (default 60, max 120).' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'codespaces_create',
      description: "Creates a new GitHub Codespace for one of the user's repositories in the USER's own GitHub account. It uses the user's own Codespaces allowance, never Cognita's. It stops itself after a period of inactivity. Commands cannot be run in it by Cognita (use codespaces_create_terminal for that); it is opened by the user through its link. Always requires the user's explicit confirmation first.",
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: 'Repository owner (user or organization).' },
          repo: { type: 'string', description: 'Repository name.' },
          ref: { type: 'string', description: 'Branch or commit to open. Defaults to the default branch.' },
          machine: { type: 'string', description: "Optional machine type name (for example 'basicLinux32gb'). Leave out to let GitHub pick the default." },
          idleTimeoutMinutes: { type: 'integer', description: 'Minutes of inactivity before it stops by itself (default 30, min 5, max 240).' },
        },
        required: ['owner', 'repo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'codespaces_start',
      description: "Starts one of the user's stopped GitHub Codespaces. Runs on the user's own allowance. Requires the user's confirmation.",
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: "The codespace's name, as returned by codespaces_list." } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'codespaces_stop',
      description: "Stops one of the user's running GitHub Codespaces so it stops using their allowance. Anything still running inside it is interrupted, so it requires the user's confirmation.",
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: "The codespace's name, as returned by codespaces_list." } },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'codespaces_open_terminal',
      description: "Gives the user the link that opens a codespace (with its terminal) in their own browser, plus the command for opening it from their own computer. Use this when the user wants to type in the terminal themselves.",
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: "The codespace's name, as returned by codespaces_list." } },
        required: ['name'],
      },
    },
  },
];

export const REQUIRES_CONFIRMATION = [
  'codespaces_create',
  'codespaces_create_terminal',
  'codespaces_run_command',
  'codespaces_start',
  'codespaces_stop',
];

export function describe(name, args) {
  args = args || {};
  if (name === 'codespaces_list') return 'Checking your Codespaces.';
  if (name === 'codespaces_create') return 'Setting up a new cloud terminal for ' + (args.repo || 'that repository') + ' on your GitHub account.';
  if (name === 'codespaces_create_terminal') return 'Setting up your own cloud terminal on your GitHub account.';
  if (name === 'codespaces_terminal_status') return 'Checking whether your cloud terminal is ready.';
  if (name === 'codespaces_run_command') return 'Running a command in your cloud terminal.';
  if (name === 'codespaces_start') return 'Starting your cloud terminal.';
  if (name === 'codespaces_stop') return 'Stopping your cloud terminal.';
  if (name === 'codespaces_open_terminal') return 'Getting the link to your cloud terminal.';
  return 'Working with your Codespaces.';
}

export function approvalScope(name, args) {
  args = args || {};
  if (name === 'codespaces_create') return args.owner && args.repo ? args.owner + '/' + args.repo : 'unscoped';
  if (name === 'codespaces_create_terminal') return 'terminal';
  return args.name ? String(args.name) : 'terminal';
}

function _templateRepo(env) {
  const v = env && typeof env.TERMINAL_TEMPLATE_REPO === 'string' ? env.TERMINAL_TEMPLATE_REPO.trim() : '';
  return REPO_RE.test(v) ? v : DEFAULT_TEMPLATE_REPO;
}

// The user's token, only if it carries the `codespace` scope. Anything else
// throws NEEDS_RECONNECT, which connector-tools.js already turns into a
// "please reconnect GitHub" message for the user.
async function _token(uid, env) {
  const token = await _deps.getValidToken(uid, 'github', env);
  const record = await _deps.getConnectorToken(uid, 'github', env);
  const granted = ((record && record.scope) || '').split(',').map((s) => s.trim());
  if (!granted.includes('codespace')) throw new Error('NEEDS_RECONNECT');
  return token;
}

async function _gh(token, path, options = {}) {
  const res = await _deps.fetch('https://api.github.com' + path, {
    ...options,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Cognita-App',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 401) throw new Error('NEEDS_RECONNECT');
    // 402/403 here is usually GitHub saying the user's own Codespaces
    // allowance, spending limit or organization policy blocks the request.
    // Relay GitHub's own wording so the user knows what to change.
    throw new Error('GitHub Codespaces error (' + res.status + '): ' + text.slice(0, 300));
  }
  if (res.status === 204) return null;
  return res.json().catch(() => null);
}

function _summary(c) {
  return {
    name: c.name,
    displayName: c.display_name || null,
    repository: c.repository && c.repository.full_name,
    state: c.state,
    machine: c.machine && (c.machine.display_name || c.machine.name),
    lastUsedAt: c.last_used_at || null,
    openUrl: c.web_url || null,
  };
}

function _needName(args) {
  if (!args.name || !NAME_RE.test(String(args.name))) throw new Error('A valid codespace name is required.');
  return encodeURIComponent(String(args.name));
}

function _clamp(value, fallback, min, max) {
  const n = parseInt(value, 10);
  return Math.min(Math.max(Number.isFinite(n) ? n : fallback, min), max);
}

async function _list(uid, args, env) {
  const token = await _token(uid, env);
  const limit = _clamp(args.limit, 10, 1, 30);
  const data = await _gh(token, '/user/codespaces?per_page=' + limit, { method: 'GET' });
  return ((data && data.codespaces) || []).map(_summary);
}

async function _create(uid, args, env) {
  if (!args.owner || !args.repo || !NAME_RE.test(args.owner) || !NAME_RE.test(args.repo)) {
    throw new Error('owner and repo are required to create a codespace.');
  }
  const token = await _token(uid, env);
  const idle = _clamp(args.idleTimeoutMinutes, DEFAULT_IDLE_MINUTES, MIN_IDLE_MINUTES, MAX_IDLE_MINUTES);
  const body = { idle_timeout_minutes: idle };
  if (args.ref) body.ref = String(args.ref).slice(0, 200);
  if (args.machine) body.machine = String(args.machine).slice(0, 100);
  const c = await _gh(token, '/repos/' + encodeURIComponent(args.owner) + '/' + encodeURIComponent(args.repo) + '/codespaces', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  await _assertBilledToUser(token, c);
  return { ..._summary(c || {}), idleTimeoutMinutes: idle, note: 'It can take a minute to be ready. It runs on your own GitHub Codespaces allowance.' };
}

// The "Cognita pays $0" guarantee, enforced rather than assumed. GitHub says in
// the creation response who will be billed. If that is anyone but the user (for
// example an organization that pays for its members' codespaces), the codespace
// is deleted again immediately and the user is told why.
async function _assertBilledToUser(token, c) {
  const owner = c && c.owner && c.owner.login;
  const billable = c && c.billable_owner && c.billable_owner.login;
  if (owner && billable && owner.toLowerCase() !== billable.toLowerCase()) {
    if (c.name && NAME_RE.test(c.name)) {
      await _gh(token, '/user/codespaces/' + encodeURIComponent(c.name), { method: 'DELETE' }).catch(() => {});
    }
    throw new Error('That codespace would have been billed to "' + billable + '" instead of your own GitHub account, so it was removed again. Nothing was charged.');
  }
}

async function _createTerminal(uid, args, env) {
  const token = await _token(uid, env);
  const [owner, repo] = _templateRepo(env).split('/');
  const idle = _clamp(args.idleTimeoutMinutes, DEFAULT_IDLE_MINUTES, MIN_IDLE_MINUTES, MAX_IDLE_MINUTES);
  const days = _clamp(args.retentionDays, DEFAULT_RETENTION_DAYS, 1, MAX_RETENTION_DAYS);
  const body = {
    idle_timeout_minutes: idle,
    retention_period_minutes: days * 24 * 60,
    display_name: 'Cognita terminal',
  };
  if (args.machine) body.machine = String(args.machine).slice(0, 100);
  const c = await _gh(token, '/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo) + '/codespaces', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  await _assertBilledToUser(token, c);
  return {
    ..._summary(c || {}),
    idleTimeoutMinutes: idle,
    retentionDays: days,
    note: 'Your cloud terminal is being set up in your own GitHub account. The first start can take a minute or two. Check codespaces_terminal_status before running commands. It stops by itself after ' + idle + ' idle minutes and is deleted after ' + days + ' unused days.',
  };
}

// Finds the user's cloud terminal: the named codespace, or their most recently
// used codespace made from the template. Only codespaces made from the template
// are accepted, because only those run the helper.
async function _findTerminal(token, args, env) {
  const template = _templateRepo(env).toLowerCase();
  let c;
  if (args.name) {
    if (!NAME_RE.test(String(args.name))) return { problem: 'That is not a valid codespace name.' };
    c = await _gh(token, '/user/codespaces/' + encodeURIComponent(String(args.name)), { method: 'GET' });
  } else {
    const data = await _gh(token, '/user/codespaces?per_page=100', { method: 'GET' });
    const mine = ((data && data.codespaces) || []).filter((x) => x.repository && String(x.repository.full_name).toLowerCase() === template);
    mine.sort((a, b) => String(b.last_used_at || '').localeCompare(String(a.last_used_at || '')));
    c = mine.find((x) => x.state === 'Available') || mine[0];
    if (!c) return { problem: 'There is no cloud terminal yet. Create one with codespaces_create_terminal.' };
  }
  if (!c || !c.name) return { problem: 'That codespace was not found.' };
  if (!c.repository || String(c.repository.full_name).toLowerCase() !== template) {
    return { problem: 'That codespace was not created as a Cognita cloud terminal, so commands cannot be run in it.' };
  }
  return { c };
}

// One request to the helper in the user's codespace. Never throws: every way it
// can fail comes back as { unreachable } so the model can explain it plainly.
async function _callAgent(token, name, path, options, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await _deps.fetch('https://' + name + '-' + AGENT_PORT + '.app.github.dev' + path, {
      ...options,
      signal: ctl.signal,
      redirect: 'manual', // a redirect means GitHub is asking for a browser sign-in
      headers: {
        'Content-Type': 'application/json',
        'X-Github-Token': token, // what GitHub's port forwarding checks
        'X-Cognita-Token': token, // what the helper checks (survives if the line above is stripped)
      },
    });
    if (res.status >= 300 && res.status < 400) return { unreachable: 'redirect' };
    const text = await res.text().catch(() => '');
    let json = null;
    try { json = JSON.parse(text); } catch (e) { json = null; }
    if (!json || typeof json !== 'object') return { unreachable: 'not-helper', status: res.status };
    if (res.status === 401) return { unreachable: 'unauthorized' };
    return { status: res.status, json };
  } catch (e) {
    return { unreachable: e && e.name === 'AbortError' ? 'timeout' : 'network' };
  } finally {
    clearTimeout(timer);
  }
}

function _unreachableHint(reason, c) {
  const open = c.web_url ? ' Open it once in your browser (' + c.web_url + ') so GitHub finishes starting it, then try again.' : '';
  if (reason === 'unauthorized') return 'The terminal did not accept your GitHub login. Reconnect GitHub in Cognita and try again.';
  if (reason === 'redirect') return 'GitHub did not let Cognita reach the terminal yet.' + open;
  if (reason === 'timeout') return 'The terminal did not answer in time. It may still be starting; wait a minute and check again.' + open;
  return 'The terminal is not answering yet. It may still be starting, or GitHub has not opened its connection.' + open;
}

async function _terminalStatus(uid, args, env) {
  const token = await _token(uid, env);
  const found = await _findTerminal(token, args, env);
  if (found.problem) return { ready: false, hint: found.problem };
  const c = found.c;
  const base = { name: c.name, state: c.state, openUrl: c.web_url || null };
  if (c.state !== 'Available') {
    return { ...base, ready: false, hint: c.state === 'Shutdown' ? 'It is stopped. Start it with codespaces_start (the user confirms), then check again.' : 'It is not running yet (' + c.state + '). Check again in a moment.' };
  }
  const r = await _callAgent(token, c.name, '/health', { method: 'GET' }, 15000);
  if (r.unreachable) return { ...base, ready: false, hint: _unreachableHint(r.unreachable, c) };
  return { ...base, ready: !!(r.json && r.json.ok), agentVersion: r.json && r.json.version };
}

async function _runCommand(uid, args, env) {
  const command = typeof args.command === 'string' ? args.command : '';
  if (!command.trim()) throw new Error('command is required.');
  if (command.length > MAX_COMMAND_CHARS) throw new Error('That command is too long (limit ' + MAX_COMMAND_CHARS + ' characters).');
  const seconds = _clamp(args.timeoutSeconds, DEFAULT_COMMAND_SECONDS, 1, MAX_COMMAND_SECONDS);

  const token = await _token(uid, env);
  const found = await _findTerminal(token, args, env);
  if (found.problem) return { ran: false, hint: found.problem };
  const c = found.c;
  if (c.state !== 'Available') {
    return { ran: false, state: c.state, hint: c.state === 'Shutdown' ? 'The terminal is stopped. Start it with codespaces_start (the user confirms), wait until codespaces_terminal_status says ready, then run the command.' : 'The terminal is not running yet (' + c.state + '). Check codespaces_terminal_status in a moment.' };
  }

  const body = { command, timeoutSeconds: seconds };
  if (args.cwd) body.cwd = String(args.cwd).slice(0, 500);
  const r = await _callAgent(token, c.name, '/exec', { method: 'POST', body: JSON.stringify(body) }, (seconds + 20) * 1000);
  if (r.unreachable) return { ran: false, hint: _unreachableHint(r.unreachable, c) };
  if (r.status === 409) return { ran: false, hint: 'Another command is still running in the terminal. Wait for it to finish.' };
  if (r.status !== 200) return { ran: false, hint: (r.json && r.json.error) ? String(r.json.error).slice(0, 300) : 'The terminal rejected the command.' };
  const j = r.json;
  return {
    ran: true,
    codespace: c.name,
    exitCode: j.exitCode,
    timedOut: !!j.timedOut,
    stdout: j.stdout || '',
    stderr: j.stderr || '',
    truncated: !!j.truncated,
    folder: j.cwd || null,
    durationMs: j.durationMs,
  };
}

async function _start(uid, args, env) {
  const token = await _token(uid, env);
  const c = await _gh(token, '/user/codespaces/' + _needName(args) + '/start', { method: 'POST' });
  return _summary(c || {});
}

async function _stop(uid, args, env) {
  const token = await _token(uid, env);
  const c = await _gh(token, '/user/codespaces/' + _needName(args) + '/stop', { method: 'POST' });
  return _summary(c || {});
}

async function _openTerminal(uid, args, env) {
  const token = await _token(uid, env);
  const c = await _gh(token, '/user/codespaces/' + _needName(args), { method: 'GET' });
  const s = _summary(c || {});
  return {
    ...s,
    note: 'Open the link in your browser; if the codespace is stopped, GitHub starts it for you (on your own allowance). Press Ctrl+` (backtick) to show the terminal. From your own computer with the GitHub CLI: gh codespace ssh -c ' + s.name,
  };
}

export async function execute(name, args, uid, env) {
  if (name === 'codespaces_list') return _list(uid, args, env);
  if (name === 'codespaces_create') return _create(uid, args, env);
  if (name === 'codespaces_create_terminal') return _createTerminal(uid, args, env);
  if (name === 'codespaces_terminal_status') return _terminalStatus(uid, args, env);
  if (name === 'codespaces_run_command') return _runCommand(uid, args, env);
  if (name === 'codespaces_start') return _start(uid, args, env);
  if (name === 'codespaces_stop') return _stop(uid, args, env);
  if (name === 'codespaces_open_terminal') return _openTerminal(uid, args, env);
  throw new Error('Unknown Codespaces tool: ' + name);
}
