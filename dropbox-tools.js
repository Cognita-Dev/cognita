// dropbox-tools.js
// Tool schemas + executors for the Dropbox connector, scoped to exactly
// `files.metadata.read files.content.read files.content.write` (see
// connector-providers.js). Upload is plain-text only and capped in size —
// this is a chat-assistant convenience tool, not a general file manager.
// Same TOOLS/REQUIRES_CONFIRMATION/describe/execute shape as
// github-tools.js — see that file's header comment for the contract.

import { getValidToken } from './connectors.js';

const MAX_UPLOAD_CHARS = 200_000; // ~200KB of text — plenty for notes/exports, not a bulk file mover

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'dropbox_list_folder',
      description: "Lists files and folders inside a Dropbox path. Use an empty string for the root folder.",
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: "Folder path, e.g. '' for root or '/Notes'." },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dropbox_upload_text_file',
      description: 'Creates a new plain-text file in Dropbox at the given path with the given content. This writes a file into the user\'s Dropbox, so it always requires the user\'s explicit confirmation first.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: "Full destination path including filename, e.g. '/Notes/meeting-summary.txt'." },
          content: { type: 'string', description: 'The text content to write into the file.' },
        },
        required: ['path', 'content'],
      },
    },
  },
];

export const REQUIRES_CONFIRMATION = ['dropbox_upload_text_file'];

export function describe(name, args) {
  if (name === 'dropbox_list_folder') return 'List Dropbox contents at "' + (args.path || '/') + '".';
  if (name === 'dropbox_upload_text_file') return 'Create the file "' + (args.path || '?') + '" in your Dropbox.';
  return 'Perform a Dropbox action.';
}

async function _dropboxFetch(token, endpoint, apiArgs) {
  const res = await fetch('https://api.dropboxapi.com/2/' + endpoint, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(apiArgs),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 401) throw new Error('NEEDS_RECONNECT');
    throw new Error('Dropbox API error (' + res.status + '): ' + text.slice(0, 300));
  }
  return res.json();
}

async function _listFolder(uid, args, env) {
  const token = await getValidToken(uid, 'dropbox', env);
  const data = await _dropboxFetch(token, 'files/list_folder', { path: args.path || '' });
  return (data.entries || []).map((e) => ({
    name: e.name,
    path: e.path_display,
    type: e['.tag'], // 'file' or 'folder'
    size: e.size ?? null,
  }));
}

async function _uploadTextFile(uid, args, env) {
  if (!args.path || typeof args.content !== 'string') {
    throw new Error('path and content are both required to create a file.');
  }
  if (args.content.length > MAX_UPLOAD_CHARS) {
    throw new Error('That file is too large for this tool (limit ~' + MAX_UPLOAD_CHARS + ' characters).');
  }
  const token = await getValidToken(uid, 'dropbox', env);
  const res = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({ path: args.path, mode: 'add', autorename: true, mute: false }),
    },
    body: args.content,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 401) throw new Error('NEEDS_RECONNECT');
    throw new Error('Dropbox API error (' + res.status + '): ' + text.slice(0, 300));
  }
  const data = await res.json();
  return { path: data.path_display, size: data.size };
}

export async function execute(name, args, uid, env) {
  if (name === 'dropbox_list_folder') return _listFolder(uid, args, env);
  if (name === 'dropbox_upload_text_file') return _uploadTextFile(uid, args, env);
  throw new Error('Unknown Dropbox tool: ' + name);
}
