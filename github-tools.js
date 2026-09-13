// github-tools.js
// Tool schemas + executors for the GitHub connector, scoped to the
// `repo` OAuth scope (see connector-providers.js): full read/write
// access to both public and private repositories the user can access.
// Currently only two actions are exposed: listing repos and opening an
// issue. No destructive actions (no delete/close, no force-push,
// nothing that can't be undone by hand) — widen REQUIRES_CONFIRMATION
// and TOOLS together if that changes.
//
// Every file in this "*-tools.js" family follows the same shape, on
// purpose, so connector-tools.js can treat all four identically:
//   - TOOLS: OpenAI-compatible tool schemas (what the model sees)
//   - REQUIRES_CONFIRMATION: names of tools that write/change something —
//     the chat loop must get explicit user confirmation before calling
//     execute() for these (see chat-endpoint.js)
//   - describe(name, args): one human-readable line shown in the
//     confirmation prompt, e.g. "Open an issue titled '...' on owner/repo"
//   - execute(name, args, uid, env): does the actual GitHub API call and
//     returns a plain string/object result for the model to read back.
//     Throws 'NOT_CONNECTED' or 'NEEDS_RECONNECT' verbatim (from
//     getValidToken) — connector-tools.js is what turns those into a
//     message the model can relay to the user; this file never catches
//     them itself.

import { getValidToken } from './connectors.js';

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'github_list_repos',
      description: "Lists the user's most recently updated GitHub repositories (name, description, visibility, URL), including private repositories now that the connection uses the 'repo' scope. Use this to find a repo before opening an issue on it, or to answer questions about what repos the user has.",
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'Max repos to return (default 10, max 30).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_create_issue',
      description: "Opens a new issue on one of the user's GitHub repositories. This creates something visible in their repo, so it always requires the user's explicit confirmation first.",
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: "The repo owner's username or org, e.g. 'gbemigaakinde'." },
          repo: { type: 'string', description: "The repo name, e.g. 'cognita'." },
          title: { type: 'string', description: 'Issue title.' },
          body: { type: 'string', description: 'Issue body/description (markdown supported). Optional.' },
        },
        required: ['owner', 'repo', 'title'],
      },
    },
  },
];

export const REQUIRES_CONFIRMATION = ['github_create_issue'];

export function describe(name, args) {
  if (name === 'github_list_repos') return 'List your GitHub repositories.';
  if (name === 'github_create_issue') {
    return 'Open a GitHub issue titled "' + (args.title || '') + '" on ' + (args.owner || '?') + '/' + (args.repo || '?') + '.';
  }
  return 'Perform a GitHub action.';
}

async function _githubFetch(token, path, options = {}) {
  const res = await fetch('https://api.github.com' + path, {
    ...options,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Cognita-App',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 401) throw new Error('NEEDS_RECONNECT');
    throw new Error('GitHub API error (' + res.status + '): ' + text.slice(0, 300));
  }
  return res.json();
}

async function _listRepos(uid, args, env) {
  const token = await getValidToken(uid, 'github', env);
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 30);
  const repos = await _githubFetch(token, '/user/repos?sort=updated&per_page=' + limit, { method: 'GET' });
  const list = repos.map((r) => ({
    name: r.full_name,
    description: r.description || null,
    private: !!r.private,
    url: r.html_url,
    updatedAt: r.updated_at,
  }));
  if (list.length === 0) {
    return {
      repos: [],
      note: 'GitHub returned zero repositories for this account. This means either the account genuinely has none, or — if the user expects to see repos here — the connection is stale: reconnecting GitHub from Account Settings > Connections will fix it. Tell the user which of these is more likely given the context, and suggest reconnecting if they expected results.',
    };
  }
  return { repos: list };
}

async function _createIssue(uid, args, env) {
  if (!args.owner || !args.repo || !args.title) {
    throw new Error('owner, repo, and title are all required to open an issue.');
  }
  const token = await getValidToken(uid, 'github', env);
  const issue = await _githubFetch(token, '/repos/' + args.owner + '/' + args.repo + '/issues', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: args.title, body: args.body || '' }),
  });
  return { number: issue.number, url: issue.html_url, title: issue.title };
}

export async function execute(name, args, uid, env) {
  if (name === 'github_list_repos') return _listRepos(uid, args, env);
  if (name === 'github_create_issue') return _createIssue(uid, args, env);
  throw new Error('Unknown GitHub tool: ' + name);
}
