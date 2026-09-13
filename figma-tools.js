// figma-tools.js
// Tool schemas + executors for the Figma connector, scoped to exactly
// `file_read` (see connector-providers.js) — read-only by design. There is
// no write tool here and there never should be one unless the granted
// scope changes; REQUIRES_CONFIRMATION is empty on purpose.
// Same TOOLS/describe/execute shape as github-tools.js — see that file's
// header comment for the contract.

import { getValidToken } from './connectors.js';

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'figma_get_file_summary',
      description: "Reads a Figma file's structure — its name, pages, and top-level frame/component names — given its file key (the id in the file's URL: figma.com/file/<KEY>/...). Use this to answer questions about what's in a design file.",
      parameters: {
        type: 'object',
        properties: {
          fileKey: { type: 'string', description: "The Figma file key, taken from the file's URL." },
        },
        required: ['fileKey'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'figma_list_comments',
      description: 'Lists comments left on a Figma file, given its file key.',
      parameters: {
        type: 'object',
        properties: {
          fileKey: { type: 'string', description: "The Figma file key, taken from the file's URL." },
        },
        required: ['fileKey'],
      },
    },
  },
];

// Read-only scope — nothing here ever needs confirmation.
export const REQUIRES_CONFIRMATION = [];

export function describe(name, args) {
  if (name === 'figma_get_file_summary') return 'Looking at your design file.';
  if (name === 'figma_list_comments') return 'Checking comments on your design file.';
  return 'Working in Figma.';
}

// Read-only connector — REQUIRES_CONFIRMATION is empty, so approvalScope
// is never consulted, but exported for shape-consistency with the other
// three *-tools.js files.
export function approvalScope(_name, _args) {
  return 'global';
}

async function _figmaFetch(token, path) {
  const res = await fetch('https://api.figma.com/v1' + path, {
    // OAuth access tokens (as opposed to personal access tokens, which use
    // the X-Figma-Token header) go in a standard Authorization header.
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) throw new Error('NEEDS_RECONNECT');
    throw new Error('Figma API error (' + res.status + '): ' + text.slice(0, 300));
  }
  return res.json();
}

async function _getFileSummary(uid, args, env) {
  if (!args.fileKey) throw new Error('fileKey is required.');
  const token = await getValidToken(uid, 'figma', env);
  const data = await _figmaFetch(token, '/files/' + encodeURIComponent(args.fileKey) + '?depth=2');
  const topLevelNodes = (data.document?.children || []).flatMap((page) =>
    (page.children || []).map((node) => node.name)
  );
  return {
    name: data.name,
    lastModified: data.lastModified,
    pages: (data.document?.children || []).map((p) => p.name),
    topLevelFrames: topLevelNodes.slice(0, 50),
  };
}

async function _listComments(uid, args, env) {
  if (!args.fileKey) throw new Error('fileKey is required.');
  const token = await getValidToken(uid, 'figma', env);
  const data = await _figmaFetch(token, '/files/' + encodeURIComponent(args.fileKey) + '/comments');
  return (data.comments || []).map((c) => ({
    message: c.message,
    author: c.user?.handle || 'unknown',
    createdAt: c.created_at,
    resolved: !!c.resolved_at,
  }));
}

export async function execute(name, args, uid, env) {
  if (name === 'figma_get_file_summary') return _getFileSummary(uid, args, env);
  if (name === 'figma_list_comments') return _listComments(uid, args, env);
  throw new Error('Unknown Figma tool: ' + name);
}
