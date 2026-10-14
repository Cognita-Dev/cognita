// cloudshell-tools.js
// Google Cloud Shell for the user's OWN Google account.
//
// Cost model: every call is made with the user's own Google OAuth token (the
// separate 'cloudshell' connector, see connector-providers.js), so the Cloud
// Shell environment is the user's own, running inside the user's own Google
// allowance. Cognita never owns or pays for an environment.
//
// What this does NOT do: Cloud Shell's only way to run commands is SSH or the
// browser terminal, and a Cloudflare Worker cannot hold an SSH session open.
// So Cognita checks and starts the user's environment, and hands them a link
// that opens the real terminal in their own browser.
//
// This is deliberately a separate connector from 'google' (Gmail/Calendar/
// Drive). The scope needed here (cloud-platform) is much broader, and nobody
// who only wants Gmail should be asked to grant it.
//
// We never pass an accessToken to environments.start: that would copy the
// user's token into their shell, and nothing here needs it.
//
// Same TOOLS/REQUIRES_CONFIRMATION/describe/approvalScope/execute contract as
// the other *-tools.js files.

import { getValidToken } from './connectors.js';

const API = 'https://cloudshell.googleapis.com/v1';
const ENV_NAME = 'users/me/environments/default';
const TERMINAL_URL = 'https://shell.cloud.google.com/?show=terminal';

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'cloudshell_get_environment',
      description: "Checks the state of the user's own Google Cloud Shell environment (running, suspended, starting).",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cloudshell_start',
      description: "Starts the user's own Google Cloud Shell environment if it is suspended. It uses the user's own Google Cloud Shell allowance, never Cognita's. Requires the user's confirmation.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cloudshell_open_terminal',
      description: "Gives the user the link that opens their Google Cloud Shell terminal in their own browser. Use this whenever the user wants to actually type commands in a terminal.",
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

export const REQUIRES_CONFIRMATION = ['cloudshell_start'];

export function describe(name) {
  if (name === 'cloudshell_get_environment') return 'Checking your Cloud Shell.';
  if (name === 'cloudshell_start') return 'Starting your Cloud Shell.';
  if (name === 'cloudshell_open_terminal') return 'Getting the link to your Cloud Shell terminal.';
  return 'Working with your Cloud Shell.';
}

// One environment per user, so a single approval scope.
export function approvalScope() {
  return 'account';
}

async function _cs(token, path, options = {}) {
  const res = await fetch(API + path, {
    ...options,
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 401) throw new Error('NEEDS_RECONNECT');
    // 403 "API not enabled" is a Cognita-side setup issue, 403/other otherwise
    // usually means the user has not accepted Cloud Shell's terms yet.
    throw new Error('Cloud Shell error (' + res.status + '): ' + text.slice(0, 300));
  }
  return res.json().catch(() => ({}));
}

function _summary(e) {
  return {
    state: e.state || 'UNKNOWN',
    webHost: e.webHost || null,
    sshHost: e.sshHost || null,
    sshPort: e.sshPort || null,
    sshUsername: e.sshUsername || null,
  };
}

async function _get(uid, env) {
  const token = await getValidToken(uid, 'cloudshell', env);
  return _summary(await _cs(token, '/' + ENV_NAME, { method: 'GET' }));
}

async function _start(uid, env) {
  const token = await getValidToken(uid, 'cloudshell', env);
  const current = await _cs(token, '/' + ENV_NAME, { method: 'GET' });
  if (current.state === 'RUNNING') return { ..._summary(current), note: 'Already running.' };

  await _cs(token, '/' + ENV_NAME + ':start', { method: 'POST', body: JSON.stringify({}) });

  // Poll briefly. If it is not ready yet, say so instead of waiting on it.
  let latest = current;
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    latest = await _cs(token, '/' + ENV_NAME, { method: 'GET' });
    if (latest.state === 'RUNNING') break;
  }
  return {
    ..._summary(latest),
    note: latest.state === 'RUNNING'
      ? 'Your Cloud Shell is running.'
      : 'Your Cloud Shell is still starting; it should be ready in a moment.',
  };
}

async function _openTerminal(uid, env) {
  const s = await _get(uid, env);
  return {
    state: s.state,
    openUrl: TERMINAL_URL,
    note: 'Open the link in your browser; Google starts your Cloud Shell if it is suspended. The first time ever, Google asks you to accept its Cloud Shell terms there.',
  };
}

export async function execute(name, _args, uid, env) {
  if (name === 'cloudshell_get_environment') return _get(uid, env);
  if (name === 'cloudshell_start') return _start(uid, env);
  if (name === 'cloudshell_open_terminal') return _openTerminal(uid, env);
  throw new Error('Unknown Cloud Shell tool: ' + name);
}
