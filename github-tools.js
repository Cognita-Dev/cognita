// github-tools.js
// Tool schemas + executors for the GitHub connector, scoped to the
// `repo` OAuth scope (see connector-providers.js): full read/write
// access to both public and private repositories the user can access.
//
// Actions exposed:
//   Read-only (safe to run immediately, no confirmation):
//     - github_list_repos          — list the user's repos
//     - github_list_branches       — list branches on a repo
//     - github_get_file_contents   — read a file's content/sha, or list a directory
//   Write (always require explicit user confirmation before execute()
//   is called; see REQUIRES_CONFIRMATION and the confirmToolCall flow
//   in chat-endpoint.js):
//     - github_create_issue            — open an issue
//     - github_create_branch           — create a new branch from a base ref
//     - github_create_or_update_file   — commit a single file (create or update)
//     - github_create_pull_request     — open a pull request
//
// None of these can delete or force-push anything, and none rewrite
// history — every write here is a normal, revertible GitHub operation
// (new ref, new/updated file via a normal commit, new PR). Widen
// REQUIRES_CONFIRMATION and this comment together if that changes.
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

// Soft ceiling on committed file content, well under GitHub's own Contents
// API limit (~1MB base64-encoded). This isn't a file-upload feature, it's
// for the model to write out source files, configs, docs, etc. — so a
// generous but bounded cap keeps requests fast and catches "pasted an
// entire dataset by mistake" before it hits the network.
const MAX_FILE_CONTENT_CHARS = 300_000;

export const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'github_list_repos',
      description: "Lists the user's most recently updated GitHub repositories (name, description, visibility, URL), including private repositories now that the connection uses the 'repo' scope. Use this to find a repo before opening an issue, branching, committing, or opening a PR.",
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
      name: 'github_list_branches',
      description: 'Lists branches on a repository, including which one is the default branch. Use this before creating a branch or a pull request so you know what base to branch from or target.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: "The repo owner's username or org, e.g. 'gbemigaakinde'." },
          repo: { type: 'string', description: "The repo name, e.g. 'cognita'." },
          limit: { type: 'integer', description: 'Max branches to return (default 30, max 100).' },
        },
        required: ['owner', 'repo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_get_file_contents',
      description: "Reads a file's content (decoded, not base64) and its sha, or lists a directory's entries if the path is a folder. Use this to see a file before proposing an update to it, or to explore a repo's structure before committing something new.",
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: "The repo owner's username or org." },
          repo: { type: 'string', description: 'The repo name.' },
          path: { type: 'string', description: "File or directory path, e.g. 'src/index.js'. Empty or '/' for repo root." },
          ref: { type: 'string', description: 'Branch, tag, or commit SHA to read from. Defaults to the repo\'s default branch.' },
        },
        required: ['owner', 'repo', 'path'],
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
  {
    type: 'function',
    function: {
      name: 'github_create_branch',
      description: "Creates a new branch on a repository, from a base branch (defaults to the repo's default branch if not given). This changes the repo, so it always requires the user's explicit confirmation first.",
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: "The repo owner's username or org." },
          repo: { type: 'string', description: 'The repo name.' },
          branch: { type: 'string', description: "Name of the new branch to create, e.g. 'feature/add-write-tools'." },
          from: { type: 'string', description: "Base branch to branch from. Defaults to the repo's default branch if omitted." },
        },
        required: ['owner', 'repo', 'branch'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_create_or_update_file',
      description: 'Commits a single file to a branch — creates it if it does not exist yet, or updates it (using its current sha automatically) if it does. This changes the repo, so it always requires the user\'s explicit confirmation first. Prefer checking github_get_file_contents first when updating an existing file, so the proposed change is based on its real current content.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: "The repo owner's username or org." },
          repo: { type: 'string', description: 'The repo name.' },
          path: { type: 'string', description: "File path to create or update, e.g. 'docs/notes.md'." },
          content: { type: 'string', description: 'The full new content of the file, as plain text (not base64).' },
          message: { type: 'string', description: 'Commit message.' },
          branch: { type: 'string', description: "Branch to commit to. Defaults to the repo's default branch if omitted." },
        },
        required: ['owner', 'repo', 'path', 'content', 'message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_create_pull_request',
      description: "Opens a pull request from one branch into another on the same repository. This creates something visible in the user's repo, so it always requires the user's explicit confirmation first.",
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: "The repo owner's username or org." },
          repo: { type: 'string', description: 'The repo name.' },
          title: { type: 'string', description: 'Pull request title.' },
          head: { type: 'string', description: "The branch with the changes, e.g. 'feature/add-write-tools'." },
          base: { type: 'string', description: "The branch to merge into. Defaults to the repo's default branch if omitted." },
          body: { type: 'string', description: 'Pull request description (markdown supported). Optional.' },
        },
        required: ['owner', 'repo', 'title', 'head'],
      },
    },
  },
];

export const REQUIRES_CONFIRMATION = [
  'github_create_issue',
  'github_create_branch',
  'github_create_or_update_file',
  'github_create_pull_request',
];

export function describe(name, args) {
  args = args || {};
  if (name === 'github_list_repos') return 'List your GitHub repositories.';
  if (name === 'github_list_branches') return 'List branches on ' + (args.owner || '?') + '/' + (args.repo || '?') + '.';
  if (name === 'github_get_file_contents') {
    return 'Read "' + (args.path || '?') + '" from ' + (args.owner || '?') + '/' + (args.repo || '?') + '.';
  }
  if (name === 'github_create_issue') {
    return 'Open a GitHub issue titled "' + (args.title || '') + '" on ' + (args.owner || '?') + '/' + (args.repo || '?') + '.';
  }
  if (name === 'github_create_branch') {
    return 'Create branch "' + (args.branch || '?') + '" from "' + (args.from || 'the default branch') + '" on ' +
      (args.owner || '?') + '/' + (args.repo || '?') + '.';
  }
  if (name === 'github_create_or_update_file') {
    return 'Commit "' + (args.path || '?') + '" on ' + (args.owner || '?') + '/' + (args.repo || '?') +
      ' (branch "' + (args.branch || 'default') + '"): ' + (args.message || 'no commit message given') + '.';
  }
  if (name === 'github_create_pull_request') {
    return 'Open a pull request "' + (args.title || '') + '" from "' + (args.head || '?') + '" into "' +
      (args.base || 'the default branch') + '" on ' + (args.owner || '?') + '/' + (args.repo || '?') + '.';
  }
  return 'Perform a GitHub action.';
}

async function _githubFetch(token, path, options = {}, fetchOpts = {}) {
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
  if (res.status === 404 && fetchOpts.allow404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 401) throw new Error('NEEDS_RECONNECT');
    throw new Error('GitHub API error (' + res.status + '): ' + text.slice(0, 300));
  }
  if (res.status === 204) return null; // no-content responses (rare here, kept for safety)
  return res.json();
}

// UTF-8-safe base64 helpers — plain btoa()/atob() only handle Latin1 and
// will throw or corrupt data on non-ASCII content (accented names, emoji,
// non-English text in a file, etc.), which is common enough in real repo
// content that it's worth doing properly rather than assuming ASCII.
function _utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function _base64ToUtf8(b64) {
  const binary = atob((b64 || '').replace(/\n/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function _defaultBranch(token, owner, repo) {
  const info = await _githubFetch(token, '/repos/' + owner + '/' + repo, { method: 'GET' });
  return info.default_branch;
}

function _requireArgs(args, names) {
  const missing = names.filter((n) => !args[n]);
  if (missing.length > 0) {
    throw new Error('Missing required field(s): ' + missing.join(', ') + '.');
  }
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

async function _listBranches(uid, args, env) {
  _requireArgs(args, ['owner', 'repo']);
  const token = await getValidToken(uid, 'github', env);
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 30, 1), 100);
  const [defaultBranch, branches] = await Promise.all([
    _defaultBranch(token, args.owner, args.repo),
    _githubFetch(token, '/repos/' + args.owner + '/' + args.repo + '/branches?per_page=' + limit, { method: 'GET' }),
  ]);
  return {
    defaultBranch,
    branches: branches.map((b) => ({ name: b.name, protected: !!b.protected, isDefault: b.name === defaultBranch })),
  };
}

async function _getFileContents(uid, args, env) {
  _requireArgs(args, ['owner', 'repo', 'path']);
  const token = await getValidToken(uid, 'github', env);
  const cleanPath = String(args.path).replace(/^\/+/, '');
  const qs = args.ref ? '?ref=' + encodeURIComponent(args.ref) : '';
  const data = await _githubFetch(
    token,
    '/repos/' + args.owner + '/' + args.repo + '/contents/' + cleanPath.split('/').map(encodeURIComponent).join('/') + qs,
    { method: 'GET' },
    { allow404: true }
  );

  if (data === null) {
    return {
      found: false,
      note: 'No file or directory exists at "' + cleanPath + '" on the requested ref. If the goal is to create it, use github_create_or_update_file — no existing sha is needed for a new file.',
    };
  }

  if (Array.isArray(data)) {
    return {
      found: true,
      type: 'directory',
      path: cleanPath || '/',
      entries: data.map((e) => ({ name: e.name, path: e.path, type: e.type, size: e.size })),
    };
  }

  if (data.type !== 'file' || typeof data.content !== 'string') {
    return {
      found: true,
      type: data.type || 'unknown',
      path: data.path,
      note: 'This path exists but is not a plain readable file (e.g. a symlink or submodule) — no text content to show.',
    };
  }

  let decoded;
  try {
    decoded = _base64ToUtf8(data.content);
  } catch (e) {
    return {
      found: true,
      type: 'file',
      path: data.path,
      sha: data.sha,
      size: data.size,
      note: 'This file could not be decoded as text (likely a binary file) — content is not shown.',
    };
  }

  return {
    found: true,
    type: 'file',
    path: data.path,
    sha: data.sha,
    size: data.size,
    content: decoded,
  };
}

async function _createIssue(uid, args, env) {
  _requireArgs(args, ['owner', 'repo', 'title']);
  const token = await getValidToken(uid, 'github', env);
  const issue = await _githubFetch(token, '/repos/' + args.owner + '/' + args.repo + '/issues', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: args.title, body: args.body || '' }),
  });
  return { number: issue.number, url: issue.html_url, title: issue.title };
}

async function _createBranch(uid, args, env) {
  _requireArgs(args, ['owner', 'repo', 'branch']);
  const token = await getValidToken(uid, 'github', env);
  const base = args.from || await _defaultBranch(token, args.owner, args.repo);

  const baseRef = await _githubFetch(
    token,
    '/repos/' + args.owner + '/' + args.repo + '/git/ref/heads/' + encodeURIComponent(base),
    { method: 'GET' },
    { allow404: true }
  );
  if (!baseRef) {
    throw new Error('Base branch "' + base + '" was not found on ' + args.owner + '/' + args.repo + '.');
  }

  try {
    await _githubFetch(token, '/repos/' + args.owner + '/' + args.repo + '/git/refs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'refs/heads/' + args.branch, sha: baseRef.object.sha }),
    });
  } catch (e) {
    if (String(e.message).includes('422')) {
      throw new Error('Branch "' + args.branch + '" already exists on ' + args.owner + '/' + args.repo + '.');
    }
    throw e;
  }

  return { branch: args.branch, from: base, repo: args.owner + '/' + args.repo };
}

async function _createOrUpdateFile(uid, args, env) {
  _requireArgs(args, ['owner', 'repo', 'path', 'content', 'message']);
  if (args.content.length > MAX_FILE_CONTENT_CHARS) {
    throw new Error('File content is too large (' + args.content.length + ' chars, max ' + MAX_FILE_CONTENT_CHARS + ').');
  }

  const token = await getValidToken(uid, 'github', env);
  const cleanPath = String(args.path).replace(/^\/+/, '');
  const branch = args.branch || await _defaultBranch(token, args.owner, args.repo);

  const existing = await _githubFetch(
    token,
    '/repos/' + args.owner + '/' + args.repo + '/contents/' + cleanPath.split('/').map(encodeURIComponent).join('/') +
      '?ref=' + encodeURIComponent(branch),
    { method: 'GET' },
    { allow404: true }
  );
  const existingSha = existing && !Array.isArray(existing) && existing.type === 'file' ? existing.sha : undefined;

  const payload = {
    message: args.message,
    content: _utf8ToBase64(args.content),
    branch,
  };
  if (existingSha) payload.sha = existingSha;

  const result = await _githubFetch(
    token,
    '/repos/' + args.owner + '/' + args.repo + '/contents/' + cleanPath.split('/').map(encodeURIComponent).join('/'),
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }
  );

  return {
    action: existingSha ? 'updated' : 'created',
    path: cleanPath,
    branch,
    commitSha: result.commit && result.commit.sha,
    commitUrl: result.commit && result.commit.html_url,
    contentUrl: result.content && result.content.html_url,
  };
}

async function _createPullRequest(uid, args, env) {
  _requireArgs(args, ['owner', 'repo', 'title', 'head']);
  const token = await getValidToken(uid, 'github', env);
  const base = args.base || await _defaultBranch(token, args.owner, args.repo);

  if (args.head === base) {
    throw new Error('The head branch ("' + args.head + '") and base branch ("' + base + '") are the same — nothing to compare.');
  }

  const pr = await _githubFetch(token, '/repos/' + args.owner + '/' + args.repo + '/pulls', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: args.title, head: args.head, base, body: args.body || '' }),
  });

  return { number: pr.number, url: pr.html_url, title: pr.title, head: args.head, base };
}

export async function execute(name, args, uid, env) {
  if (name === 'github_list_repos') return _listRepos(uid, args, env);
  if (name === 'github_list_branches') return _listBranches(uid, args, env);
  if (name === 'github_get_file_contents') return _getFileContents(uid, args, env);
  if (name === 'github_create_issue') return _createIssue(uid, args, env);
  if (name === 'github_create_branch') return _createBranch(uid, args, env);
  if (name === 'github_create_or_update_file') return _createOrUpdateFile(uid, args, env);
  if (name === 'github_create_pull_request') return _createPullRequest(uid, args, env);
  throw new Error('Unknown GitHub tool: ' + name);
}
