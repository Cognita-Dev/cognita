# Cognita agent sandbox

Gives the model a real place to run code: compute, analyse data, convert
files, and test scripts, then read the true output and keep going. It is
built into the existing tool loop in `chat-endpoint.js`. There is no second
agent framework.

## What ships now ($0)

**Tier 1, browser sandbox.** Code runs on the person's own device, so it costs
Cognita nothing.

- Python through Pyodide (Python 3.13, pinned to 0.29.5 in `sandbox-frame.html`).
  numpy, pandas, matplotlib, scipy and other bundled packages load only when
  the code imports them.
- JavaScript in a throwaway Web Worker.
- A built-in shell written for this project (`js/sandbox-shell.js`): pwd, cd,
  ls, tree, cat, head, tail, wc, grep, find, mkdir, touch, cp, mv, rm, echo,
  sort, uniq, python, node, pip (bundled packages only), pipes, redirects,
  `&&`, `||`, `;`. The working directory is tracked by the sandbox session,
  so `cd project` affects later calls.
- It is honest about what it is not. `git`, `npm`, `curl`, `sudo` and
  background jobs return exit code 127 with a plain message. It is not Bash.
- Workspace `/workspace` belongs to one conversation. It is kept in the
  browser (IndexedDB, last 5 workspaces, 14 days). Nothing is uploaded unless
  the person downloads a file or the model reads a file back as a tool result.

**Tier 2, GitHub.** Reserved slot only (`GitHubSandboxProvider`), reports
"not available". Running model code through a person's Actions or Codespaces
spends their quota, needs wider OAuth scopes than the connector asks for,
adds tens of seconds of delay, and Actions is built for CI. The GitHub
connector keeps doing what it does well: read code, logs, commits, PRs.

**Tier 3, remote Linux (optional, paid).** `RemoteLinuxSandboxProvider`
speaks one small HTTPS contract (documented in `sandbox-provider.js`), so any
vendor can sit behind it. It stays off until a plan has `features.sandboxRemote`
AND the Worker has `SANDBOX_REMOTE_URL` and `SANDBOX_REMOTE_TOKEN`. When on,
the model also gets start/get-output/stop process tools, and git, npm and
real Bash become available. The model's tools do not change.

## Why not the alternatives (as of my research in October 2026; check prices before relying on any figure)

- **Cloudflare Sandbox / Containers:** needs the Workers Paid plan. Not $0.
- **E2B:** free credits for new accounts, not a standing free tier. Credits
  run out. Good as the first Tier 3 provider if you later get a budget.
- **GitHub Codespaces:** a monthly allowance for personal development
  (core-hours and storage). It is a dev environment, not a backend an app can
  start per request.
- **GitHub Actions:** minutes per month, but queue delay, CI-oriented, and
  uses the user's repo and quota.
- **WebContainers (Node in the browser):** needs cross-origin isolation
  (SharedArrayBuffer) and is unreliable or unsupported on iPhone and iPad
  Safari. Cognita is mostly used on phones, so it was rejected for Tier 1.
- **Pyodide on iOS:** earlier releases crashed on some iOS versions. The fix
  landed in the 0.27/0.29 line, which is why 0.29.5 is pinned. I could not
  test on a real iPhone, so treat iOS as "expected to work, verify it".

## How a run flows

1. The model calls a `sandbox_*` tool. `chat-endpoint.js` validates it and
   sees the provider is browser-side.
2. The Worker pauses the turn and sends `sandbox_call` plus
   `pendingSandboxCall` and `turnTrace` in the `done` event. Nothing secret is in it.
3. `js/app.js` runs it through `js/sandbox-client.js` in the iframe, streaming
   output into a live terminal card with a Stop button.
4. The browser calls `/api/chat` again with `sandboxResume` (the real result
   and the trace). The Worker counts ONE run in `sandboxRuns`, rebuilds the
   model's messages, and the model continues. Up to 12 sandbox calls per
   request; a higher round ceiling (14) applies only when sandbox tools are offered.
4b. On a remote provider the Worker runs the call itself and keeps looping in one request.

## Google, GitHub and other connectors

The sandbox never holds a credential. Flow: connector tool returns file text
(Drive file, Sheet as CSV, Doc, GitHub file) → the Worker keeps the full text
in the turn trace → `sandbox_import_from_tool(path, source_step)` turns it
into a plain file write → code runs → the model reads the result. Sending a
result back (Drive upload, Sheets write, GitHub commit) uses the existing
connector tool, which keeps its own confirmation card. Sandbox tools never
bypass it, and they cannot reach any connector.

Limit: the import only carries text the connector tool returns (capped at
300,000 characters like the connectors themselves). Binary Drive files are not importable.

## Security model

- Model-written code never runs in the Worker.
- The iframe is `sandbox="allow-scripts"` with no `allow-same-origin`: opaque
  origin, no cookies, no storage, no access to the Cognita page or Firebase session.
- `vercel.json` gives `/sandbox-frame` its own CSP: `connect-src` only the
  Pyodide CDN, so code cannot call other sites. The main-page CSP rule now
  excludes that path so the two policies do not merge.
- Limits per run, from the plan: timeout, max file size, max workspace size,
  max output (12,000 chars), one process at a time. A stuck run is stopped by
  terminating its worker, and a frame that stops answering is replaced.
- Usage is counted by the Worker only (`sandboxRuns`), never reported by the browser.
- Everything the browser sends back is treated as untrusted data: re-shaped,
  size-capped, and shown to the model only as a tool result.
- Known gap: the CDN is allowed for Pyodide, so code could in theory send tiny
  amounts of data to it as URL text. Self-hosting Pyodide on your own domain
  removes that and lets `connect-src` be `'self'`-only.
- Known gap: browser limits are enforced inside the same page the person controls. A person who tampers with their own browser can only affect their own sandbox, and the Worker's run counter still applies.

## Plans (entitlements.js)

| Plan | Runs/day | Timeout | Max file | Workspace |
|---|---|---|---|---|
| Free | 10 | 20 s | 2 MB | 10 MB |
| Plus | 60 | 45 s | 5 MB | 25 MB |
| Studio | 250 | 90 s | 10 MB | 50 MB |
| Admin | 999999 | 120 s | 10 MB | 50 MB |

Shown in `/api/usage` as `sandboxRuns`. Change the numbers in one place.

## Deploying

1. Replace the files in the same paths. New files: `sandbox-tools.js`,
   `sandbox-provider.js`, `sandbox-frame.html`, `js/sandbox-client.js`,
   `js/sandbox-shell.js`, `tests/sandbox*.test.mjs`.
2. Deploy the Worker (`wrangler deploy`) and the site (Vercel).
3. After deploy open `https://app.cognita.com.ng/sandbox-frame` and check the
   response headers: the `Content-Security-Policy` must be the one from the
   sandbox rule and it must not also include `default-src 'self'` from the
   global rule. If both appear, tell me and I will split the rules differently.
4. Ask Cognita: "What is the mean of 4, 8, 15, 16, 23, 42? Use code." The first
   Python run takes a few seconds while Pyodide downloads, later runs are fast.

## Tests

`node tests/sandbox.test.mjs` (14 checks, no setup) and
`node tests/sandbox-chat.test.mjs` (5 end-to-end checks through the real
chat endpoint; needs the same throwaway key files as `billing.test.mjs`).
The iframe, shell, JavaScript worker, timeouts, limits, reload persistence and
Python (unittest, exit codes, tracebacks, cd then python, killed infinite
loop, files surviving a restart) were also run in headless Chromium.
Not tested: real iPhone, pandas/matplotlib (the CDN was not reachable from my
environment), the live Vercel header merge, and the new CSS on a real phone.

## Not built yet

Saving a sandbox file into Cognita's permanent library (today files are
download-only, which keeps temporary files out of storage), shell-level git/npm
(Tier 3), a GitHub Actions provider, and self-hosted Pyodide.
