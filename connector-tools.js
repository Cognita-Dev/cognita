// connector-tools.js
// The single seam between chat-endpoint.js and the four *-tools.js
// executor files. Nothing in chat-endpoint.js should ever import
// github-tools.js/google-tools.js/etc. directly — it only talks to the
// three functions exported here.
//
// Responsibilities:
//   1. getAvailableTools(uid, env) — only offer the model tools for
//      providers this specific user has actually connected. A user with
//      no connectors gets an empty array, and chat-endpoint.js skips the
//      whole tool-calling path in that case.
//   2. toolRequiresConfirmation(name) / describeTool(name, args) — used by
//      chat-endpoint.js to implement the write-action confirmation flow
//      without needing to know which provider a tool belongs to.
//   3. executeConnectorTool(name, args, uid, env) — runs the tool and
//      normalizes the two "you need to (re)connect" errors every
//      executor can throw (via connectors.js's getValidToken) into a
//      structured result the model can read and relay to the user,
//      instead of letting them bubble up as raw exceptions.

import { CONNECTOR_PROVIDERS, listConnectedProviders } from './connectors.js';
import * as githubTools from './github-tools.js';
import * as googleTools from './google-tools.js';
import * as figmaTools from './figma-tools.js';
import * as canvaTools from './canva-tools.js';

// Keyed by the same provider names as CONNECTOR_PROVIDERS (connectors.js)
// — kept as one object literal, rather than a naming convention, so a
// mismatched key fails loudly (undefined) instead of silently.
// Slack and Dropbox were removed (2026) — slack-tools.js/dropbox-tools.js
// no longer exist; do not re-add entries here without also restoring
// those files and their connector-providers.js OAuth config.
const REGISTRY = {
  github: githubTools,
  google: googleTools,
  figma: figmaTools,
  canva: canvaTools,
};

// Sanity check at module load, not per-request: every provider in
// CONNECTOR_PROVIDERS must have a registry entry with the expected shape.
// A typo here should break loudly at deploy time, not silently drop a
// provider's tools in production.
for (const provider of CONNECTOR_PROVIDERS) {
  const mod = REGISTRY[provider];
  if (!mod || !Array.isArray(mod.TOOLS) || typeof mod.execute !== 'function') {
    throw new Error('[connector-tools] Registry entry for "' + provider + '" is missing or malformed.');
  }
}

// name -> provider, built once at module load for O(1) lookup instead of
// scanning every provider's TOOLS array on every tool call.
const TOOL_NAME_TO_PROVIDER = {};
// name -> required argument names, read straight off each tool's own
// OpenAI-compatible schema (parameters.required) rather than duplicated
// as a second hand-maintained list — the schema the model is given and
// the list used to validate its calls must never be able to drift apart.
const TOOL_NAME_TO_REQUIRED = {};
for (const provider of CONNECTOR_PROVIDERS) {
  for (const tool of REGISTRY[provider].TOOLS) {
    TOOL_NAME_TO_PROVIDER[tool.function.name] = provider;
    TOOL_NAME_TO_REQUIRED[tool.function.name] =
      (tool.function.parameters && Array.isArray(tool.function.parameters.required))
        ? tool.function.parameters.required
        : [];
  }
}

/**
 * Returns the OpenAI-compatible tool schemas the model should be offered
 * for this user right now — i.e. only tools belonging to providers they
 * have actually connected. Empty array if they have none connected.
 */
export async function getAvailableTools(uid, env) {
  const connected = await listConnectedProviders(uid, env);
  const tools = [];
  for (const provider of CONNECTOR_PROVIDERS) {
    if (connected[provider]) {
      tools.push(...REGISTRY[provider].TOOLS);
    }
  }
  return tools;
}

/** Which provider owns a given tool name, or null if unrecognized. */
export function providerForTool(name) {
  return TOOL_NAME_TO_PROVIDER[name] || null;
}

/** Does this tool write/change something, and therefore need user confirmation first? */
export function toolRequiresConfirmation(name) {
  const provider = providerForTool(name);
  if (!provider) return true; // unknown tool — treat as requiring confirmation, safest default
  return REGISTRY[provider].REQUIRES_CONFIRMATION.includes(name);
}

/** One human-readable line describing what a tool call will do, for the confirmation prompt. */
export function describeTool(name, args) {
  const provider = providerForTool(name);
  if (!provider) return 'Perform an action in a connected app.';
  return REGISTRY[provider].describe(name, args || {});
}

/**
 * Validates a proposed tool call's arguments against that tool's own
 * schema (its `required` list) BEFORE the call is ever shown to the user
 * (describeTool) or executed. This exists so a malformed call — e.g. the
 * model calling github_get_file_contents with no `path` — never surfaces
 * as a broken-looking trace/confirm line (previously: `Read "?" from
 * owner/repo.`). Instead the caller (chat-endpoint.js's agent loop) can
 * catch this before rendering anything and ask the model to retry with
 * the missing fields, silently, as part of the same turn.
 *
 * Returns { ok: true } or { ok: false, missing: string[] }.
 */
export function validateToolArgs(name, args) {
  const required = TOOL_NAME_TO_REQUIRED[name];
  if (!required) return { ok: true }; // unrecognized tool — let execute() surface UNKNOWN_TOOL
  const a = args || {};
  const missing = required.filter((n) => a[n] === undefined || a[n] === null || a[n] === '');
  return missing.length > 0 ? { ok: false, missing } : { ok: true };
}

/**
 * A stable key identifying "what this write is scoped to" for a given
 * tool call — e.g. an "owner/repo" string for GitHub tools, so approving
 * writes to one repo never silently approves writes to a different one.
 * Providers with no meaningful sub-scope (Google's single primary
 * calendar, Canva's single account) return a constant scope key. Falls
 * back to 'unscoped' for a write call missing the args it needs to
 * compute a real scope (e.g. no owner/repo yet) — 'unscoped' never
 * matches a real approval record, so it always falls through to asking.
 */
export function approvalScopeForTool(name, args) {
  const provider = providerForTool(name);
  if (!provider || typeof REGISTRY[provider].approvalScope !== 'function') return 'unscoped';
  return REGISTRY[provider].approvalScope(name, args || {}) || 'unscoped';
}

/**
 * Checks a list of session-scoped (really: conversation-scoped — see
 * chat-endpoint.js) approval records for one that already covers this
 * exact tool, on this exact provider+scope. Approval records are supplied
 * by the client (persisted per-conversation, never shared across
 * conversations or accounts) in the shape:
 *   { provider, scope, approvedActionClasses: string[] }
 * This function is defensive about malformed input since it reads
 * client-supplied data — anything that doesn't look like a valid record
 * is simply ignored rather than trusted.
 */
export function isToolApproved(approvals, name, args) {
  if (!Array.isArray(approvals)) return false;
  const provider = providerForTool(name);
  if (!provider) return false;
  const scope = approvalScopeForTool(name, args);
  if (scope === 'unscoped') return false;
  return approvals.some((a) =>
    a && typeof a === 'object' &&
    a.provider === provider &&
    a.scope === scope &&
    Array.isArray(a.approvedActionClasses) &&
    a.approvedActionClasses.includes(name)
  );
}

/**
 * Executes a tool call. Never throws NOT_CONNECTED/NEEDS_RECONNECT —
 * those are caught here and turned into a structured { error: true, ... }
 * result that gets fed back to the model as the tool's output, so the
 * model can tell the user in natural language to (re)connect that app in
 * Account Settings, rather than the request failing outright.
 *
 * Any other error (bad args, provider API error, etc.) is also caught and
 * normalized the same way, since it's still just "the tool failed" from
 * the model's point of view, not a server error.
 */
export async function executeConnectorTool(name, args, uid, env) {
  const provider = providerForTool(name);
  if (!provider) {
    return { error: true, code: 'UNKNOWN_TOOL', message: 'Unknown tool: ' + name };
  }

  try {
    const result = await REGISTRY[provider].execute(name, args || {}, uid, env);
    return { error: false, provider, result };
  } catch (e) {
    if (e.message === 'NOT_CONNECTED') {
      return {
        error: true,
        code: 'NOT_CONNECTED',
        provider,
        message: 'The user has not connected ' + provider + ' yet. Tell them to go to Account Settings > Connections and connect ' + provider + ', then try again.',
      };
    }
    if (e.message === 'NEEDS_RECONNECT') {
      return {
        error: true,
        code: 'NEEDS_RECONNECT',
        provider,
        message: 'The user\'s ' + provider + ' connection has expired or was revoked. Tell them to reconnect ' + provider + ' in Account Settings > Connections, then try again.',
      };
    }
    console.warn('[connector-tools] execution failed for', name, ':', e.message);
    return {
      error: true,
      code: 'TOOL_ERROR',
      provider,
      message: 'That action could not be completed: ' + e.message,
    };
  }
}
