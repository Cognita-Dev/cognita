// canva-tools.js
// Tool schemas + executors for the Canva connector (Canva Connect API),
// scoped to the design/asset/folder/profile scopes granted in
// connector-providers.js. Creating a design is a lightweight, reversible
// action (the user can delete it in Canva), but it still shows up in their
// account, so it requires confirmation like any other write.
// Same TOOLS/REQUIRES_CONFIRMATION/describe/execute shape as
// github-tools.js — see that file's header comment for the contract.

import { getValidToken } from './connectors.js';

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'canva_list_designs',
      description: "Lists the user's recent Canva designs (title, type, edit URL).",
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'Max designs to return (default 10, max 25).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'canva_create_design',
      description: "Creates a new, blank Canva design of a given type (e.g. a presentation or a social post), returning a link to open and edit it. This adds a new design to the user's Canva account, so it always requires the user's explicit confirmation first.",
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Title for the new design.' },
          designType: {
            type: 'string',
            description: "Canva design type preset, e.g. 'presentation', 'doc', 'whiteboard', 'instagram-post'.",
          },
        },
        required: ['title'],
      },
    },
  },
];

export const REQUIRES_CONFIRMATION = ['canva_create_design'];

export function describe(name, args) {
  if (name === 'canva_list_designs') return 'List your recent Canva designs.';
  if (name === 'canva_create_design') {
    return 'Create a new Canva design titled "' + (args.title || '') + '"' + (args.designType ? ' (' + args.designType + ')' : '') + '.';
  }
  return 'Perform a Canva action.';
}

async function _canvaFetch(token, path, options = {}) {
  const res = await fetch('https://api.canva.com/rest/v1' + path, {
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
    throw new Error('Canva API error (' + res.status + '): ' + text.slice(0, 300));
  }
  return res.json();
}

async function _listDesigns(uid, args, env) {
  const token = await getValidToken(uid, 'canva', env);
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 25);
  const data = await _canvaFetch(token, '/designs?limit=' + limit, { method: 'GET' });
  return (data.items || []).map((d) => ({
    id: d.id,
    title: d.title || '(untitled)',
    editUrl: d.urls?.edit_url || null,
    viewUrl: d.urls?.view_url || null,
  }));
}

async function _createDesign(uid, args, env) {
  if (!args.title) throw new Error('title is required to create a design.');
  const token = await getValidToken(uid, 'canva', env);
  const body = { title: args.title };
  if (args.designType) {
    body.design_type = { type: 'preset', name: args.designType };
  }
  const data = await _canvaFetch(token, '/designs', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return {
    id: data.design?.id,
    title: data.design?.title,
    editUrl: data.design?.urls?.edit_url || null,
  };
}

export async function execute(name, args, uid, env) {
  if (name === 'canva_list_designs') return _listDesigns(uid, args, env);
  if (name === 'canva_create_design') return _createDesign(uid, args, env);
  throw new Error('Unknown Canva tool: ' + name);
}
