// github-tools.js
// Tool schemas + executors for the GitHub connector, scoped to the
// `repo` OAuth scope (see connector-providers.js): full read/write
// access to both public and private repositories the user can access.
//
// Actions exposed:
//   Read-only (safe to run immediately, no confirmation):
//     Discover : github_list_repos, github_get_repo, github_search_repositories
//     Read     : github_get_file_contents (also lists directories),
//                github_search_code, github_list_branches,
//                github_list_commits, github_get_commit
//     Issues   : github_list_issues, github_get_issue
//     PRs      : github_list_pull_requests, github_get_pull_request,
//                github_get_pull_request_diff
//     Compare  : github_compare_refs
//     CI/CD    : github_list_workflows, github_list_workflow_runs,
//                github_get_workflow_run, github_get_workflow_run_logs
//   Write (always require explicit user confirmation before execute()
//   is called; see REQUIRES_CONFIRMATION and the confirmToolCall flow
//   in chat-endpoint.js):
//     - github_create_issue             — open an issue
//     - github_update_issue             — edit title/body/state/labels
//     - github_add_issue_comment        — comment on an issue or PR
//     - github_create_branch            — create a new branch from a base ref
//     - github_create_or_update_file    — commit a single file (create or update)
//     - github_create_or_update_files   — commit multiple files atomically in one commit
//     - github_create_pull_request      — open a pull request
//     - github_create_pull_request_review — approve/request changes/comment on a PR
//
// Two deliberate deviations from the raw tool wishlist this file was
// built from:
//   - No separate github_list_directory tool: github_get_file_contents
//     already returns a directory listing when `path` is a folder, so a
//     second tool doing the same underlying GitHub call would just be a
//     duplicate the model has to choose between.
//   - github_get_workflow_run_logs returns the signed download URL for
//     the logs .zip, not inlined log text — the GitHub API only offers
//     this as a binary archive, and pretending to paste it as text would
//     either fail or silently truncate. The user/model can follow the URL.
//
// None of the writes here can delete or force-push anything, and none
// rewrite history — every write is a normal, revertible GitHub operation
// (new ref, new/updated file(s) via a normal commit, new issue/comment/PR,
// new review). Widen REQUIRES_CONFIRMATION and this comment together if
// that changes.
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

// Same cap, applied per-file, for the multi-file commit tool — plus a cap
// on file COUNT, since the multi-file path builds one blob per file before
// it ever touches the tree/commit endpoints, and an unbounded file list
// would mean an unbounded number of upstream requests per tool call.
const MAX_FILES_PER_COMMIT = 20;

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
      name: 'github_get_repo',
      description: 'Gets details about a single repository: description, default branch, visibility, star/fork counts, primary language, and URLs. Use this to confirm a repo exists and check its default branch before other operations.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: "The repo owner's username or org." },
          repo: { type: 'string', description: 'The repo name.' },
        },
        required: ['owner', 'repo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_search_repositories',
      description: "Searches GitHub for repositories by name/description/topic, across all of GitHub (not just the user's own repos). Use this to find a repository when the user doesn't know the exact owner/name.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: "Search query, e.g. 'react state management' or 'user:someone topic:cli'." },
          limit: { type: 'integer', description: 'Max results to return (default 10, max 30).' },
        },
        required: ['query'],
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
      name: 'github_search_code',
      description: "Searches source code across GitHub (or scoped to one repo) for a text/regex-free query using GitHub's code search syntax, e.g. 'useEffect repo:owner/repo' or 'TODO extension:js'. Use this to find where something is defined or referenced without downloading whole files.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: "GitHub code search query. Scope to one repo with 'repo:owner/name' inside the query for better results." },
          limit: { type: 'integer', description: 'Max results to return (default 10, max 30).' },
        },
        required: ['query'],
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
      name: 'github_list_commits',
      description: 'Lists recent commits on a branch (or the default branch), with SHA, author, date, and message. Use this to see recent history before comparing refs or looking at a specific commit.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: "The repo owner's username or org." },
          repo: { type: 'string', description: 'The repo name.' },
          branch: { type: 'string', description: "Branch, tag, or SHA to list from. Defaults to the repo's default branch." },
          path: { type: 'string', description: 'Optional: only list commits that touched this file or folder.' },
          limit: { type: 'integer', description: 'Max commits to return (default 10, max 30).' },
        },
        required: ['owner', 'repo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_get_commit',
      description: 'Gets full detail on a single commit: message, author, parent(s), and the list of files it changed with per-file addition/deletion counts.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: "The repo owner's username or org." },
          repo: { type: 'string', description: 'The repo name.' },
          sha: { type: 'string', description: 'The commit SHA (full or short).' },
        },
        required: ['owner', 'repo', 'sha'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_list_issues',
      description: "Lists issues on a repository (open by default). Note: GitHub's API returns pull requests as issues too — this tool filters PRs out, so results are actual issues only. Use github_list_pull_requests for PRs.",
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: "The repo owner's username or org." },
          repo: { type: 'string', description: 'The repo name.' },
          state: { type: 'string', enum: ['open', 'closed', 'all'], description: "Defaults to 'open'." },
          limit: { type: 'integer', description: 'Max issues to return (default 10, max 30).' },
        },
        required: ['owner', 'repo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_get_issue',
      description: 'Gets full detail on a single issue: title, body, state, labels, assignees, and comment count.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: "The repo owner's username or org." },
          repo: { type: 'string', description: 'The repo name.' },
          number: { type: 'integer', description: 'The issue number.' },
        },
        required: ['owner', 'repo', 'number'],
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
      name: 'github_update_issue',
      description: "Edits an existing issue's title, body, state (open/closed), or labels. Only the fields provided are changed. This changes the repo, so it always requires the user's explicit confirmation first.",
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: "The repo owner's username or org." },
          repo: { type: 'string', description: 'The repo name.' },
          number: { type: 'integer', description: 'The issue number to edit.' },
          title: { type: 'string', description: 'New title. Optional.' },
          body: { type: 'string', description: 'New body. Optional.' },
          state: { type: 'string', enum: ['open', 'closed'], description: 'New state. Optional.' },
          labels: { type: 'array', items: { type: 'string' }, description: 'Full replacement list of labels. Optional.' },
        },
        required: ['owner', 'repo', 'number'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_add_issue_comment',
      description: "Adds a comment to an issue or pull request (PRs are numbered the same as issues on GitHub, so this works on both). This posts something visible, so it always requires the user's explicit confirmation first.",
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: "The repo owner's username or org." },
          repo: { type: 'string', description: 'The repo name.' },
          number: { type: 'integer', description: 'The issue or PR number.' },
          body: { type: 'string', description: 'Comment text (markdown supported).' },
        },
        required: ['owner', 'repo', 'number', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_list_pull_requests',
      description: 'Lists pull requests on a repository (open by default).',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: "The repo owner's username or org." },
          repo: { type: 'string', description: 'The repo name.' },
          state: { type: 'string', enum: ['open', 'closed', 'all'], description: "Defaults to 'open'." },
          limit: { type: 'integer', description: 'Max PRs to return (default 10, max 30).' },
        },
        required: ['owner', 'repo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_get_pull_request',
      description: 'Gets full detail on a single pull request: title, body, state, head/base branches, mergeable status, and change stats.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: "The repo owner's username or org." },
          repo: { type: 'string', description: 'The repo name.' },
          number: { type: 'integer', description: 'The pull request number.' },
        },
        required: ['owner', 'repo', 'number'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_get_pull_request_diff',
      description: "Gets the unified diff for a pull request — the actual line-by-line code changes. Use this before reviewing a PR or summarizing what it changes. Large diffs are truncated with a note; use github_get_file_contents for the full current state of a specific file if needed.",
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: "The repo owner's username or org." },
          repo: { type: 'string', description: 'The repo name.' },
          number: { type: 'integer', description: 'The pull request number.' },
        },
        required: ['owner', 'repo', 'number'],
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
  {
    type: 'function',
    function: {
      name: 'github_create_pull_request_review',
      description: "Submits a review on a pull request: approve, request changes, or leave a general comment. This posts something visible on the PR, so it always requires the user's explicit confirmation first.",
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: "The repo owner's username or org." },
          repo: { type: 'string', description: 'The repo name.' },
          number: { type: 'integer', description: 'The pull request number.' },
          event: { type: 'string', enum: ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'], description: 'The review verdict.' },
          body: { type: 'string', description: 'Review summary text. Required for REQUEST_CHANGES and COMMENT; optional for APPROVE.' },
        },
        required: ['owner', 'repo', 'number', 'event'],
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
      description: 'Commits a single file to a branch — creates it if it does not exist yet, or updates it (using its current sha automatically) if it does. This changes the repo, so it always requires the user\'s explicit confirmation first. Prefer checking github_get_file_contents first when updating an existing file, so the proposed change is based on its real current content. For more than one file, prefer github_create_or_update_files so all changes land in a single atomic commit.',
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
      name: 'github_create_or_update_files',
      description: "Commits multiple files to a branch in a single atomic commit (all-or-nothing), using the Git Data API (blob -> tree -> commit -> ref update) rather than one commit per file. Use this whenever a change spans more than one file, so the repo never sits in a half-updated state. This changes the repo, so it always requires the user's explicit confirmation first.",
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: "The repo owner's username or org." },
          repo: { type: 'string', description: 'The repo name.' },
          files: {
            type: 'array',
            description: 'Files to create/update, all landing in one commit.',
            items: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'File path, e.g. src/index.js.' },
                content: { type: 'string', description: 'Full new content, as plain text (not base64).' },
              },
              required: ['path', 'content'],
            },
          },
          message: { type: 'string', description: 'Commit message for the combined commit.' },
          branch: { type: 'string', description: "Branch to commit to. Defaults to the repo's default branch if omitted." },
        },
        required: ['owner', 'repo', 'files', 'message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_compare_refs',
      description: 'Compares two branches/tags/commits and reports how many commits ahead/behind they are, plus the list of changed files between them. Use this before opening a PR to preview what it would contain, or to check if a branch is out of date.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: "The repo owner's username or org." },
          repo: { type: 'string', description: 'The repo name.' },
          base: { type: 'string', description: 'The base ref (branch, tag, or SHA).' },
          head: { type: 'string', description: 'The head ref (branch, tag, or SHA) to compare against base.' },
        },
        required: ['owner', 'repo', 'base', 'head'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_list_workflows',
      description: 'Lists GitHub Actions workflows configured on a repository (name, state, file path).',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: "The repo owner's username or org." },
          repo: { type: 'string', description: 'The repo name.' },
        },
        required: ['owner', 'repo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_list_workflow_runs',
      description: 'Lists recent runs of GitHub Actions workflows on a repository, optionally filtered to one workflow or branch, with status/conclusion for each.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: "The repo owner's username or org." },
          repo: { type: 'string', description: 'The repo name.' },
          workflow_id: { type: 'string', description: 'Optional: workflow file name (e.g. ci.yml) or numeric ID to filter to one workflow.' },
          branch: { type: 'string', description: 'Optional: only runs triggered on this branch.' },
          limit: { type: 'integer', description: 'Max runs to return (default 10, max 30).' },
        },
        required: ['owner', 'repo'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_get_workflow_run',
      description: 'Gets detail on a single GitHub Actions workflow run: status, conclusion, triggering event/branch/commit, and timing.',
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: "The repo owner's username or org." },
          repo: { type: 'string', description: 'The repo name.' },
          run_id: { type: 'integer', description: 'The workflow run ID (from github_list_workflow_runs).' },
        },
        required: ['owner', 'repo', 'run_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'github_get_workflow_run_logs',
      description: "Gets a time-limited signed download URL for a workflow run's full logs archive (a .zip of plain-text log files — GitHub does not offer these as inline text). Share the URL with the user or fetch it separately if the log contents themselves are needed.",
      parameters: {
        type: 'object',
        properties: {
          owner: { type: 'string', description: "The repo owner's username or org." },
          repo: { type: 'string', description: 'The repo name.' },
          run_id: { type: 'integer', description: 'The workflow run ID.' },
        },
        required: ['owner', 'repo', 'run_id'],
      },
    },
  },
];

export const REQUIRES_CONFIRMATION = [
  'github_create_issue',
  'github_update_issue',
  'github_add_issue_comment',
  'github_create_branch',
  'github_create_or_update_file',
  'github_create_or_update_files',
  'github_create_pull_request',
  'github_create_pull_request_review',
];

// describe() renders BOTH the confirm-card summary and the Action Trace
// line (see connector-tools.js / chat-endpoint.js), i.e. this is what the
// user actually reads. It must describe the outcome for the user's
// project, never the underlying mechanism — no "commit," "branch,"
// "repo," no raw owner/repo slugs (use just the repo name unless the user
// themselves typed the full slug), no tool names, no HTTP/API verbs. A
// call missing the args it needs to describe itself cleanly (e.g. no path
// yet) should never reach here at all — see validateToolArgs() in
// connector-tools.js, which the agent loop runs first.
function _repoLabel(args) {
  return (args && args.repo) ? args.repo : 'that repository';
}

export function describe(name, args) {
  args = args || {};
  const repo = _repoLabel(args);
  if (name === 'github_list_repos') return 'Looking at your GitHub repositories.';
  if (name === 'github_get_repo') return 'Checking ' + repo + "'s details.";
  if (name === 'github_search_repositories') return 'Searching GitHub for "' + (args.query || '') + '".';
  if (name === 'github_get_file_contents') return 'Looking at ' + (args.path || 'a file') + ' in ' + repo + '.';
  if (name === 'github_search_code') return 'Searching ' + repo + "'s code for \"" + (args.query || '') + '".';
  if (name === 'github_list_branches') return 'Looking at ' + repo + "'s branches.";
  if (name === 'github_list_commits') return 'Looking at ' + repo + "'s recent history.";
  if (name === 'github_get_commit') return 'Looking at a recent change in ' + repo + '.';
  if (name === 'github_list_issues') return 'Checking open issues on ' + repo + '.';
  if (name === 'github_get_issue') return 'Looking at issue #' + (args.number || '?') + ' on ' + repo + '.';
  if (name === 'github_create_issue') return 'Opening an issue on ' + repo + ': "' + (args.title || '') + '".';
  if (name === 'github_update_issue') return 'Updating issue #' + (args.number || '?') + ' on ' + repo + '.';
  if (name === 'github_add_issue_comment') return 'Adding a comment on ' + repo + '.';
  if (name === 'github_list_pull_requests') return 'Checking pull requests on ' + repo + '.';
  if (name === 'github_get_pull_request') return 'Looking at pull request #' + (args.number || '?') + ' on ' + repo + '.';
  if (name === 'github_get_pull_request_diff') return 'Looking at the changes in pull request #' + (args.number || '?') + ' on ' + repo + '.';
  if (name === 'github_create_pull_request') return 'Opening a pull request on ' + repo + ': "' + (args.title || '') + '".';
  if (name === 'github_create_pull_request_review') {
    const verb = args.event === 'APPROVE' ? 'Approving' : args.event === 'REQUEST_CHANGES' ? 'Requesting changes on' : 'Commenting on';
    return verb + ' pull request #' + (args.number || '?') + ' on ' + repo + '.';
  }
  if (name === 'github_create_branch') return 'Setting up a new line of work ("' + (args.branch || '') + '") in ' + repo + '.';
  if (name === 'github_create_or_update_file') return 'Updating ' + (args.path || 'a file') + ' in ' + repo + '.';
  if (name === 'github_create_or_update_files') {
    const n = Array.isArray(args.files) ? args.files.length : 0;
    return 'Updating ' + n + ' file' + (n === 1 ? '' : 's') + ' in ' + repo + '.';
  }
  if (name === 'github_compare_refs') return 'Comparing two versions of ' + repo + '.';
  if (name === 'github_list_workflows') return 'Checking ' + repo + "'s automated workflows.";
  if (name === 'github_list_workflow_runs') return 'Checking recent workflow runs on ' + repo + '.';
  if (name === 'github_get_workflow_run') return 'Looking at a workflow run on ' + repo + '.';
  if (name === 'github_get_workflow_run_logs') return 'Getting the logs for a workflow run on ' + repo + '.';
  return 'Working in ' + repo + '.';
}

/**
 * What a write to this tool is scoped to, for the session/conversation-
 * scoped approval check (Bug 4 fix — see isToolApproved in
 * connector-tools.js). GitHub writes are always scoped to one repo, so
 * approving commits on one repo never silently approves anything on a
 * different one.
 */
export function approvalScope(name, args) {
  args = args || {};
  if (!args.owner || !args.repo) return 'unscoped';
  return args.owner + '/' + args.repo;
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
    redirect: fetchOpts.manualRedirect ? 'manual' : 'follow',
  });
  if (res.status === 404 && fetchOpts.allow404) return null;
  if (fetchOpts.manualRedirect && (res.status === 302 || res.status === 301)) {
    return { redirectUrl: res.headers.get('location') };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    if (res.status === 401) throw new Error('NEEDS_RECONNECT');
    throw new Error('GitHub API error (' + res.status + '): ' + text.slice(0, 300));
  }
  if (res.status === 204) return null; // no-content responses (rare here, kept for safety)
  if (fetchOpts.raw) return res.text();
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

async function _getRepo(uid, args, env) {
  _requireArgs(args, ['owner', 'repo']);
  const token = await getValidToken(uid, 'github', env);
  const r = await _githubFetch(token, '/repos/' + args.owner + '/' + args.repo, { method: 'GET' });
  return {
    name: r.full_name,
    description: r.description || null,
    private: !!r.private,
    defaultBranch: r.default_branch,
    language: r.language || null,
    stars: r.stargazers_count,
    forks: r.forks_count,
    openIssues: r.open_issues_count,
    url: r.html_url,
    updatedAt: r.updated_at,
  };
}

async function _searchRepositories(uid, args, env) {
  _requireArgs(args, ['query']);
  const token = await getValidToken(uid, 'github', env);
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 30);
  const data = await _githubFetch(
    token,
    '/search/repositories?q=' + encodeURIComponent(args.query) + '&per_page=' + limit,
    { method: 'GET' }
  );
  return {
    totalCount: data.total_count,
    repos: (data.items || []).map((r) => ({
      name: r.full_name,
      description: r.description || null,
      private: !!r.private,
      stars: r.stargazers_count,
      url: r.html_url,
    })),
  };
}

async function _searchCode(uid, args, env) {
  _requireArgs(args, ['query']);
  const token = await getValidToken(uid, 'github', env);
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 30);
  const data = await _githubFetch(
    token,
    '/search/code?q=' + encodeURIComponent(args.query) + '&per_page=' + limit,
    { method: 'GET' }
  );
  return {
    totalCount: data.total_count,
    results: (data.items || []).map((it) => ({
      path: it.path,
      repo: it.repository && it.repository.full_name,
      url: it.html_url,
    })),
  };
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

async function _listCommits(uid, args, env) {
  _requireArgs(args, ['owner', 'repo']);
  const token = await getValidToken(uid, 'github', env);
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 30);
  let qs = '?per_page=' + limit;
  if (args.branch) qs += '&sha=' + encodeURIComponent(args.branch);
  if (args.path) qs += '&path=' + encodeURIComponent(args.path);
  const commits = await _githubFetch(token, '/repos/' + args.owner + '/' + args.repo + '/commits' + qs, { method: 'GET' });
  return {
    commits: commits.map((c) => ({
      sha: c.sha,
      message: (c.commit && c.commit.message || '').split('\n')[0],
      author: c.commit && c.commit.author && c.commit.author.name,
      date: c.commit && c.commit.author && c.commit.author.date,
      url: c.html_url,
    })),
  };
}

async function _getCommit(uid, args, env) {
  _requireArgs(args, ['owner', 'repo', 'sha']);
  const token = await getValidToken(uid, 'github', env);
  const c = await _githubFetch(token, '/repos/' + args.owner + '/' + args.repo + '/commits/' + encodeURIComponent(args.sha), { method: 'GET' });
  return {
    sha: c.sha,
    message: c.commit && c.commit.message,
    author: c.commit && c.commit.author && c.commit.author.name,
    date: c.commit && c.commit.author && c.commit.author.date,
    parents: (c.parents || []).map((p) => p.sha),
    stats: c.stats,
    files: (c.files || []).map((f) => ({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })),
    url: c.html_url,
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
      note: 'No file or directory exists at "' + cleanPath + '" on the requested ref. If the goal is to create it, use github_create_or_update_file (or github_create_or_update_files for several) — no existing sha is needed for a new file.',
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

async function _listIssues(uid, args, env) {
  _requireArgs(args, ['owner', 'repo']);
  const token = await getValidToken(uid, 'github', env);
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 30);
  const state = args.state || 'open';
  // Over-fetch a bit before filtering out PRs, since GitHub's /issues
  // endpoint mixes them in and we want `limit` real issues back, not
  // `limit` minus however many PRs happened to be in that page.
  const raw = await _githubFetch(
    token,
    '/repos/' + args.owner + '/' + args.repo + '/issues?state=' + encodeURIComponent(state) + '&per_page=' + Math.min(limit * 2, 100),
    { method: 'GET' }
  );
  const issuesOnly = raw.filter((it) => !it.pull_request).slice(0, limit);
  return {
    issues: issuesOnly.map((it) => ({
      number: it.number,
      title: it.title,
      state: it.state,
      labels: (it.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
      comments: it.comments,
      url: it.html_url,
    })),
  };
}

async function _getIssue(uid, args, env) {
  _requireArgs(args, ['owner', 'repo', 'number']);
  const token = await getValidToken(uid, 'github', env);
  const it = await _githubFetch(token, '/repos/' + args.owner + '/' + args.repo + '/issues/' + args.number, { method: 'GET' });
  return {
    number: it.number,
    title: it.title,
    body: it.body || '',
    state: it.state,
    labels: (it.labels || []).map((l) => (typeof l === 'string' ? l : l.name)),
    assignees: (it.assignees || []).map((a) => a.login),
    comments: it.comments,
    url: it.html_url,
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

async function _updateIssue(uid, args, env) {
  _requireArgs(args, ['owner', 'repo', 'number']);
  const payload = {};
  if (args.title !== undefined) payload.title = args.title;
  if (args.body !== undefined) payload.body = args.body;
  if (args.state !== undefined) payload.state = args.state;
  if (args.labels !== undefined) payload.labels = args.labels;

  // No-op guard: if the model calls this with only owner/repo/number and
  // nothing to actually change, don't spend a write call and a GitHub
  // request round-trip on an edit that changes nothing — tell the model
  // so it can ask for what it actually wants changed.
  if (Object.keys(payload).length === 0) {
    return {
      updated: false,
      note: 'No fields to change were provided (title/body/state/labels were all omitted) — nothing was sent to GitHub.',
    };
  }

  const token = await getValidToken(uid, 'github', env);
  const issue = await _githubFetch(token, '/repos/' + args.owner + '/' + args.repo + '/issues/' + args.number, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { updated: true, number: issue.number, url: issue.html_url, state: issue.state };
}

async function _addIssueComment(uid, args, env) {
  _requireArgs(args, ['owner', 'repo', 'number', 'body']);
  const token = await getValidToken(uid, 'github', env);
  const comment = await _githubFetch(token, '/repos/' + args.owner + '/' + args.repo + '/issues/' + args.number + '/comments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body: args.body }),
  });
  return { url: comment.html_url, number: args.number };
}

async function _listPullRequests(uid, args, env) {
  _requireArgs(args, ['owner', 'repo']);
  const token = await getValidToken(uid, 'github', env);
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 30);
  const state = args.state || 'open';
  const prs = await _githubFetch(
    token,
    '/repos/' + args.owner + '/' + args.repo + '/pulls?state=' + encodeURIComponent(state) + '&per_page=' + limit,
    { method: 'GET' }
  );
  return {
    pullRequests: prs.map((pr) => ({
      number: pr.number,
      title: pr.title,
      state: pr.state,
      head: pr.head && pr.head.ref,
      base: pr.base && pr.base.ref,
      draft: !!pr.draft,
      url: pr.html_url,
    })),
  };
}

async function _getPullRequest(uid, args, env) {
  _requireArgs(args, ['owner', 'repo', 'number']);
  const token = await getValidToken(uid, 'github', env);
  const pr = await _githubFetch(token, '/repos/' + args.owner + '/' + args.repo + '/pulls/' + args.number, { method: 'GET' });
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body || '',
    state: pr.state,
    draft: !!pr.draft,
    head: pr.head && pr.head.ref,
    base: pr.base && pr.base.ref,
    mergeable: pr.mergeable,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changed_files,
    url: pr.html_url,
  };
}

async function _getPullRequestDiff(uid, args, env) {
  _requireArgs(args, ['owner', 'repo', 'number']);
  const token = await getValidToken(uid, 'github', env);
  const diff = await _githubFetch(
    token,
    '/repos/' + args.owner + '/' + args.repo + '/pulls/' + args.number,
    { method: 'GET', headers: { Accept: 'application/vnd.github.v3.diff' } },
    { raw: true }
  );
  const MAX_DIFF_CHARS = 60_000;
  if (diff.length > MAX_DIFF_CHARS) {
    return {
      diff: diff.slice(0, MAX_DIFF_CHARS),
      truncated: true,
      note: 'Diff was truncated at ' + MAX_DIFF_CHARS + ' characters for a very large PR. Use github_get_file_contents on specific files for their full current content.',
    };
  }
  return { diff, truncated: false };
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

async function _createPullRequestReview(uid, args, env) {
  _requireArgs(args, ['owner', 'repo', 'number', 'event']);
  if ((args.event === 'REQUEST_CHANGES' || args.event === 'COMMENT') && !args.body) {
    throw new Error('A review body is required for ' + args.event + ' reviews.');
  }
  const token = await getValidToken(uid, 'github', env);
  const review = await _githubFetch(token, '/repos/' + args.owner + '/' + args.repo + '/pulls/' + args.number + '/reviews', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: args.event, body: args.body || '' }),
  });
  return { id: review.id, state: review.state, url: review.html_url, number: args.number };
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

// Multi-file atomic commit via the Git Data API: one blob per file, one
// tree built on top of the branch's current tree, one commit pointing at
// that tree, then the branch ref fast-forwarded to the new commit. If any
// step fails, the branch ref is never updated, so the repo never ends up
// half-changed — this is what makes it "atomic" compared to calling
// github_create_or_update_file once per file.
async function _createOrUpdateFiles(uid, args, env) {
  _requireArgs(args, ['owner', 'repo', 'files', 'message']);
  if (!Array.isArray(args.files) || args.files.length === 0) {
    throw new Error('"files" must be a non-empty array of { path, content }.');
  }
  if (args.files.length > MAX_FILES_PER_COMMIT) {
    throw new Error('Too many files in one commit (' + args.files.length + ', max ' + MAX_FILES_PER_COMMIT + '). Split into multiple commits.');
  }
  for (const f of args.files) {
    if (!f || typeof f.path !== 'string' || typeof f.content !== 'string') {
      throw new Error('Each file needs a string "path" and string "content".');
    }
    if (f.content.length > MAX_FILE_CONTENT_CHARS) {
      throw new Error('File "' + f.path + '" is too large (' + f.content.length + ' chars, max ' + MAX_FILE_CONTENT_CHARS + ').');
    }
  }

  const token = await getValidToken(uid, 'github', env);
  const branch = args.branch || await _defaultBranch(token, args.owner, args.repo);
  const repoPath = '/repos/' + args.owner + '/' + args.repo;

  const branchRef = await _githubFetch(repoPath === '' ? token : token, repoPath + '/git/ref/heads/' + encodeURIComponent(branch), { method: 'GET' }, { allow404: true });
  if (!branchRef) {
    throw new Error('Branch "' + branch + '" was not found on ' + args.owner + '/' + args.repo + '.');
  }
  const baseCommitSha = branchRef.object.sha;

  const baseCommit = await _githubFetch(token, repoPath + '/git/commits/' + baseCommitSha, { method: 'GET' });
  const baseTreeSha = baseCommit.tree.sha;

  // 1. One blob per file.
  const blobs = [];
  for (const f of args.files) {
    const blob = await _githubFetch(token, repoPath + '/git/blobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: _utf8ToBase64(f.content), encoding: 'base64' }),
    });
    blobs.push({ path: String(f.path).replace(/^\/+/, ''), mode: '100644', type: 'blob', sha: blob.sha });
  }

  // 2. One tree, layered on the branch's current tree.
  const newTree = await _githubFetch(token, repoPath + '/git/trees', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base_tree: baseTreeSha, tree: blobs }),
  });

  // 3. One commit pointing at that tree.
  const newCommit = await _githubFetch(token, repoPath + '/git/commits', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: args.message, tree: newTree.sha, parents: [baseCommitSha] }),
  });

  // 4. Fast-forward the branch ref — only step that actually makes the
  // commit "land"; nothing above this point is visible on the branch yet.
  await _githubFetch(token, repoPath + '/git/refs/heads/' + encodeURIComponent(branch), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha: newCommit.sha }),
  });

  return {
    branch,
    filesCommitted: args.files.map((f) => f.path),
    commitSha: newCommit.sha,
    commitUrl: 'https://github.com/' + args.owner + '/' + args.repo + '/commit/' + newCommit.sha,
  };
}

async function _compareRefs(uid, args, env) {
  _requireArgs(args, ['owner', 'repo', 'base', 'head']);
  const token = await getValidToken(uid, 'github', env);
  const cmp = await _githubFetch(
    token,
    '/repos/' + args.owner + '/' + args.repo + '/compare/' + encodeURIComponent(args.base) + '...' + encodeURIComponent(args.head),
    { method: 'GET' }
  );
  return {
    status: cmp.status,
    aheadBy: cmp.ahead_by,
    behindBy: cmp.behind_by,
    totalCommits: cmp.total_commits,
    files: (cmp.files || []).map((f) => ({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })),
    url: cmp.html_url,
  };
}

async function _listWorkflows(uid, args, env) {
  _requireArgs(args, ['owner', 'repo']);
  const token = await getValidToken(uid, 'github', env);
  const data = await _githubFetch(token, '/repos/' + args.owner + '/' + args.repo + '/actions/workflows', { method: 'GET' });
  return {
    workflows: (data.workflows || []).map((w) => ({ id: w.id, name: w.name, path: w.path, state: w.state })),
  };
}

async function _listWorkflowRuns(uid, args, env) {
  _requireArgs(args, ['owner', 'repo']);
  const token = await getValidToken(uid, 'github', env);
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 10, 1), 30);
  let base = '/repos/' + args.owner + '/' + args.repo;
  base += args.workflow_id ? '/actions/workflows/' + encodeURIComponent(args.workflow_id) + '/runs' : '/actions/runs';
  let qs = '?per_page=' + limit;
  if (args.branch) qs += '&branch=' + encodeURIComponent(args.branch);
  const data = await _githubFetch(token, base + qs, { method: 'GET' });
  return {
    runs: (data.workflow_runs || []).map((r) => ({
      id: r.id,
      name: r.name,
      status: r.status,
      conclusion: r.conclusion,
      branch: r.head_branch,
      event: r.event,
      createdAt: r.created_at,
      url: r.html_url,
    })),
  };
}

async function _getWorkflowRun(uid, args, env) {
  _requireArgs(args, ['owner', 'repo', 'run_id']);
  const token = await getValidToken(uid, 'github', env);
  const r = await _githubFetch(token, '/repos/' + args.owner + '/' + args.repo + '/actions/runs/' + args.run_id, { method: 'GET' });
  return {
    id: r.id,
    name: r.name,
    status: r.status,
    conclusion: r.conclusion,
    branch: r.head_branch,
    commitSha: r.head_sha,
    event: r.event,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    url: r.html_url,
  };
}

async function _getWorkflowRunLogs(uid, args, env) {
  _requireArgs(args, ['owner', 'repo', 'run_id']);
  const token = await getValidToken(uid, 'github', env);
  // GitHub responds to this endpoint with a 302 to a time-limited signed
  // URL for a .zip of log files — there is no inline-text form of this
  // API. We capture the redirect target instead of following it, since
  // following it would download a binary archive server-side for no
  // reason (the model can't read a zip either).
  const result = await _githubFetch(
    token,
    '/repos/' + args.owner + '/' + args.repo + '/actions/runs/' + args.run_id + '/logs',
    { method: 'GET' },
    { manualRedirect: true }
  );
  if (!result || !result.redirectUrl) {
    throw new Error('GitHub did not return a logs download link for this run (it may still be in progress, or too old — logs expire after 90 days).');
  }
  return {
    downloadUrl: result.redirectUrl,
    note: 'This link is a time-limited signed URL to a .zip archive of the run\'s logs (plain-text files inside). It is not inlined here because it is a binary download, not text.',
  };
}

export async function execute(name, args, uid, env) {
  if (name === 'github_list_repos') return _listRepos(uid, args, env);
  if (name === 'github_get_repo') return _getRepo(uid, args, env);
  if (name === 'github_search_repositories') return _searchRepositories(uid, args, env);
  if (name === 'github_get_file_contents') return _getFileContents(uid, args, env);
  if (name === 'github_search_code') return _searchCode(uid, args, env);
  if (name === 'github_list_branches') return _listBranches(uid, args, env);
  if (name === 'github_list_commits') return _listCommits(uid, args, env);
  if (name === 'github_get_commit') return _getCommit(uid, args, env);
  if (name === 'github_list_issues') return _listIssues(uid, args, env);
  if (name === 'github_get_issue') return _getIssue(uid, args, env);
  if (name === 'github_create_issue') return _createIssue(uid, args, env);
  if (name === 'github_update_issue') return _updateIssue(uid, args, env);
  if (name === 'github_add_issue_comment') return _addIssueComment(uid, args, env);
  if (name === 'github_list_pull_requests') return _listPullRequests(uid, args, env);
  if (name === 'github_get_pull_request') return _getPullRequest(uid, args, env);
  if (name === 'github_get_pull_request_diff') return _getPullRequestDiff(uid, args, env);
  if (name === 'github_create_pull_request') return _createPullRequest(uid, args, env);
  if (name === 'github_create_pull_request_review') return _createPullRequestReview(uid, args, env);
  if (name === 'github_create_branch') return _createBranch(uid, args, env);
  if (name === 'github_create_or_update_file') return _createOrUpdateFile(uid, args, env);
  if (name === 'github_create_or_update_files') return _createOrUpdateFiles(uid, args, env);
  if (name === 'github_compare_refs') return _compareRefs(uid, args, env);
  if (name === 'github_list_workflows') return _listWorkflows(uid, args, env);
  if (name === 'github_list_workflow_runs') return _listWorkflowRuns(uid, args, env);
  if (name === 'github_get_workflow_run') return _getWorkflowRun(uid, args, env);
  if (name === 'github_get_workflow_run_logs') return _getWorkflowRunLogs(uid, args, env);
  throw new Error('Unknown GitHub tool: ' + name);
}
