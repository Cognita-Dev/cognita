// sandbox-provider.js
// The one interface the agent/tool layer talks to. It does not know, or care,
// where code actually runs. To add or swap an execution backend later, add a
// class here and list it in PROVIDERS; sandbox-tools.js, chat-endpoint.js and
// the model's tools do not change.
//
//   Tier 1  BrowserSandboxProvider      free. Runs on the person's own device.
//   Tier 2  GitHubSandboxProvider       reserved. Reports "not available" for now.
//   Tier 3  RemoteLinuxSandboxProvider  optional and paid. Off until configured.
//
// A provider declares:
//   id            short name used in logs
//   tier          1, 2 or 3
//   site          'client' = the browser runs the call and sends the result back
//                 'server' = the Worker forwards the call and waits for the result
//   capabilities a Set of CAPS the provider really supports. The model is only
//                 offered tools whose capability is in this set, so a provider
//                 can never be asked for something it cannot do.
//   availability(env)           { ok, reason }
//   execute(call, ctx)          server-site providers only

import { planHasRemoteSandbox } from './entitlements.js';

export const CAPS = {
  FILES: 'files',
  SHELL_LITE: 'shell_lite',     // the small built-in shell (pwd, cd, ls, cat, grep, ...)
  PYTHON: 'python',
  JS: 'javascript',
  TESTS_PY: 'tests_python',
  PROCESSES: 'processes',       // background processes, start / read / stop
  GIT: 'git',
  NODE: 'node',
  NPM: 'npm',
  PIP: 'pip',                   // real pip with network access to a package index
  BASH: 'bash',                 // a real Bash
  NETWORK: 'network',
  BROWSER_TEST: 'browser_test',      // render a page in the person's own browser and report what happened
  BROWSER_REMOTE: 'browser_remote', // Cloudflare cloud browser (Studio and Admin only, added per request by chat-endpoint.js)
};

class SandboxProvider {
  get id() { return 'base'; }
  get tier() { return 0; }
  get site() { return 'client'; }
  get capabilities() { return new Set(); }
  async availability(_env) { return { ok: false, reason: 'not implemented' }; }
  async execute(_call, _ctx) { throw new Error('This provider does not run calls on the server.'); }
}

// ── Tier 1: browser ─────────────────────────────────────────────────────
// Python (Pyodide), JavaScript and a small built-in shell, all inside a
// sandboxed iframe with no network except the CDN that serves Pyodide
// itself. Free for everyone, including iPhone and iPad (see README for what
// that does and does not include).
export class BrowserSandboxProvider extends SandboxProvider {
  get id() { return 'browser'; }
  get tier() { return 1; }
  get site() { return 'client'; }
  get capabilities() {
    return new Set([CAPS.FILES, CAPS.SHELL_LITE, CAPS.PYTHON, CAPS.JS, CAPS.TESTS_PY, CAPS.BROWSER_TEST]);
  }
  async availability(_env) { return { ok: true }; }
}

// ── Tier 2: GitHub ──────────────────────────────────────────────────────
// Reserved on purpose. Running arbitrary model-written code through a
// person's GitHub Actions or Codespaces would spend THEIR quota, needs a
// wider OAuth scope than the connector asks for today, adds a delay of tens
// of seconds, and Actions is meant for CI, not as a general compute
// service. Cognita keeps using the GitHub connector for what it is good at
// (reading code, logs, commits, PRs). This slot exists so a narrowly scoped
// "run this workflow and read the result" provider can be added later
// without touching the tool layer.
export class GitHubSandboxProvider extends SandboxProvider {
  get id() { return 'github'; }
  get tier() { return 2; }
  get site() { return 'server'; }
  get capabilities() { return new Set(); }
  async availability(_env) {
    return { ok: false, reason: 'GitHub-hosted execution is not enabled. Use the GitHub connector to read code and logs.' };
  }
}

// ── Tier 3: remote Linux sandbox (optional, paid) ───────────────────────
// A thin HTTPS adapter. It works with anything that implements the small
// contract below, so Cognita is not tied to one vendor.
//
//   POST {SANDBOX_REMOTE_URL}/v1/execute
//   Authorization: Bearer {SANDBOX_REMOTE_TOKEN}
//   { workspaceId, tool, args, limits }
//   -> { stdout, stderr, exitCode, cwd, durationMs, running, files?, command?, note? }
//
// workspaceId is a hash of uid + conversation id (never the raw uid), so
// every conversation gets its own isolated workspace and no user can name
// another user's. The token is a Worker secret that never leaves the Worker.
// Network access, CPU, memory, disk and process limits are enforced by the
// remote service; the per-call limits are sent so it can apply them.
export class RemoteLinuxSandboxProvider extends SandboxProvider {
  get id() { return 'remote'; }
  get tier() { return 3; }
  get site() { return 'server'; }
  get capabilities() {
    return new Set([
      CAPS.FILES, CAPS.SHELL_LITE, CAPS.PYTHON, CAPS.JS, CAPS.TESTS_PY,
      CAPS.PROCESSES, CAPS.GIT, CAPS.NODE, CAPS.NPM, CAPS.PIP, CAPS.BASH,
    ]);
  }
  async availability(env) {
    if (!env || !env.SANDBOX_REMOTE_URL || !env.SANDBOX_REMOTE_TOKEN) {
      return { ok: false, reason: 'No remote sandbox is configured.' };
    }
    if (!/^https:\/\//.test(env.SANDBOX_REMOTE_URL)) {
      return { ok: false, reason: 'SANDBOX_REMOTE_URL must start with https://.' };
    }
    return { ok: true };
  }

  async execute(call, ctx) {
    const { env, uid, conversationId } = ctx;
    const avail = await this.availability(env);
    if (!avail.ok) throw new Error('SANDBOX_UNAVAILABLE: ' + avail.reason);

    const workspaceId = await workspaceIdFor(uid, conversationId);
    const controller = new AbortController();
    // The remote call is capped a little above the per-run limit so the
    // service can report a clean timeout itself.
    const budgetMs = Math.min(((call.limits && call.limits.timeoutMs) || 20000) + 5000, 125000);
    const timer = setTimeout(() => controller.abort(), budgetMs);
    try {
      const res = await fetch(env.SANDBOX_REMOTE_URL.replace(/\/+$/, '') + '/v1/execute', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + env.SANDBOX_REMOTE_TOKEN,
        },
        body: JSON.stringify({ workspaceId, tool: call.name, args: call.args, limits: call.limits }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error('SANDBOX_REMOTE_HTTP_' + res.status);
      return await res.json();
    } catch (e) {
      if (e && e.name === 'AbortError') {
        return { exitCode: 124, stderr: 'The sandbox took too long and was stopped.', stdout: '', durationMs: budgetMs, error: true };
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** sha-256 of uid + conversation id, hex. The raw uid never leaves the Worker. */
export async function workspaceIdFor(uid, conversationId) {
  const data = new TextEncoder().encode('cognita-sandbox:' + uid + ':' + conversationId);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Keeps only a safe conversation id (the browser chooses it; never trust it as-is). */
export function cleanConversationId(raw) {
  return typeof raw === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(raw) ? raw : 'default';
}

const PROVIDERS = {
  browser: new BrowserSandboxProvider(),
  github: new GitHubSandboxProvider(),
  remote: new RemoteLinuxSandboxProvider(),
};

/**
 * Picks the provider for this request. The remote Linux tier is used only when
 * (1) the person's plan has features.sandboxRemote, and (2) the Worker has the
 * remote URL and token. Otherwise everything runs in the browser, for free.
 * One conversation uses one provider at a time so its files are never split
 * across two places.
 */
export async function selectSandboxProvider(env, planId) {
  if (planHasRemoteSandbox(planId)) {
    const avail = await PROVIDERS.remote.availability(env);
    if (avail.ok) return PROVIDERS.remote;
  }
  return PROVIDERS.browser;
}

export { PROVIDERS };
