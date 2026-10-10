# Cognita agent sandbox

Gives the model a real place to run code: compute, analyse data, convert
files, and test scripts, then read the true output and keep going. It is
built into the existing tool loop in `chat-endpoint.js`. There is no second
agent framework.

## What ships now ($0)

**Tier 1, browser sandbox.** Code runs on the person's own device, so it costs
Cognita nothing.

- Python through Pyodide (Python 3.13, pinned to 0.29.5), now **self-hosted** at
  `https://pyodide.cognita.com.ng/v0.29.5/` (see "Self-hosted Pyodide" below).
  numpy, pandas, matplotlib, scipy, openpyxl and other bundled packages load
  only when the code imports them.
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
300,000 characters like the connectors themselves).

**Honest wording (W0).** Sandbox code cannot reach connectors, and the model is told so.
It never claims it "can't access Google/GitHub" when a connector is linked. It uses the
connector tool for that app, and the sandbox only for computing.

### Not built, and why: binary Drive files (W9)
Reading a `.xlsx`, `.pdf` or image from Google Drive into the workspace is **not built**.
The connector tools return text only. Moving real bytes would need a new Worker route that
downloads the file with the person's Google token and streams it to the browser, plus new
size limits and a new consent surface, because it moves a person's private file through our
server. That is a separate piece of work with its own security review. Today: Drive text
files, Docs and Sheets (as CSV) work; for an Excel file, ask the person to download it and
attach it to the chat, which now goes straight into the workspace.

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
- The frame's CSP allows scripts and connections only to `https://pyodide.cognita.com.ng` (your own host).
  There is no public backup, so code run in the sandbox can reach no third-party server. Code could still send tiny
  amounts of data to your own host as URL text; you can see that in its logs.
- Known gap: browser limits are enforced inside the same page the person controls. A person who tampers with their own browser can only affect their own sandbox, and the Worker's run counter still applies.

## Plans (entitlements.js)

| Plan | Runs/day | Timeout | Max file | Workspace |
|---|---|---|---|---|
| Free | 10 | 20 s | 2 MB | 10 MB |
| Plus | 60 | 45 s | 5 MB | 25 MB |
| Studio | 250 | 90 s | 10 MB | 50 MB |
| Admin | 999999 | 120 s | 10 MB | 50 MB |

Shown in `/api/usage` as `sandboxRuns`, with a `limits` object. The app shows it as a "Code runs" bar
in the sidebar (only while a chat that used code is open) and on the Account page.
Change the numbers in one place.

Saving a file to Cognita storage (the "Save to Cognita" button) has its own limits:

| Plan | Max saved file | Saves/day | Files per chat |
|---|---|---|---|
| Free | 2 MB | 5 | 20 |
| Plus | 5 MB | 30 | 20 |
| Studio | 10 MB | 100 | 20 |
| Admin | 10 MB | unlimited | 20 |

The 20-file cap counts every generated file in that chat (documents too), not only sandbox files.
Allowed types: csv, tsv, txt, md, json, xlsx, png, jpg, svg, pdf, html, py, js (exact list: `ARTIFACT_MIME` in `files-endpoint.js`).

## What the person sees

- **Offered only when needed.** `sandbox-intent.js` decides per message whether the code tools are
  sent to the model at all. When skipped, the model sees zero extra tokens. Log line: `[chat][sandbox] gate=offered|skipped reason=...`.
- **Files.** A file the assistant made appears as a download chip under the answer (`deliverables`), with Save to Cognita.
- **Charts.** matplotlib PNGs show inline under the answer, tap to enlarge.
- **Uploads.** CSV, TSV, JSON, MD, XLSX or large text files attached in chat go straight into the
  workspace (`/workspace/uploads`), not into the prompt. The model gets a short stub.
- **Sign-out** deletes every workspace on that device (also on account switch and account deletion).
- **Steps display.** One "Activity" timeline per message, and a redesigned approval card (`confirmation.js`).

## Self-hosted Pyodide

Built by `scripts/build-pyodide-bundle.mjs` (55 MB, 37 files, hash-checked, openpyxl vendored) and served by Cloudflare Pages.
See `pyodide-host/README.md`. **Until the Pages site is live, Python in the sandbox will not load.**
There is deliberately no public CDN fallback. Python depends on this one host being up (Cloudflare Pages).

### Start-up

The page (`sandbox-frame.html`) starts one Python worker on the host in `PY_BASES` (your own Cloudflare Pages host).
If that host cannot be reached (connection refused, a browser-rejected answer such as wrong CORS headers, an HTTP
error, or no data for 30 seconds) the worker stops at once and the person sees a clear message; the model is told
not to keep retrying Python. A failure that is not a connection problem (for example the browser cannot run
WebAssembly) is reported as it is.

While a download is silent the worker reports "waiting for pyodide.asm.js (12 s)" every 2 seconds. A download
that gets no data for 30 seconds is failed by a watchdog inside the worker, which does not rely on the
browser honouring `fetch`'s abort signal (some mobile browsers do not deliver it while a response is still
open). The page's own 45 second watchdog is only a last resort for a frozen worker.

### Checking a device that has trouble

Open `https://app.cognita.com.ng/sandbox-check` on that device and tap "Run check". It times the download of
the two core files from the Python server, starts Python inside the real sandbox frame, and runs a JavaScript
snippet that fails on purpose. "Copy report" copies the result. (`sandbox-check.html`, with its own rule in
`vercel.json`.)

### Cloudflare dashboard notes

- The Pages "Metrics" tab only counts Pages Functions. This project is static files, so "No data" there is
  normal and does not mean the site is unused or broken. Check "Deployments" (latest production deployment
  says Success) and "Custom domains" (pyodide.cognita.com.ng says Active) instead.
- Quick manual test: open `https://pyodide.cognita.com.ng/v0.29.5/pyodide-lock.json` in a browser. Readable
  JSON means the host is up.

## Deploying

1. Replace the files in the same paths. New files (latest change): `sandbox-check.html`, `tests/sandbox-fixes.test.mjs`. Earlier new files: `sandbox-tools.js`, `sandbox-intent.js`,
   `confirmation.js`, `sandbox-provider.js`, `sandbox-frame.html`, `css/activity.css`,
   `js/sandbox-client.js`, `js/sandbox-shell.js`, `scripts/`, `pyodide-host/`, `tests/*.test.mjs`.
1b. In vercel.json the main page's `frame-src` must include `'self'`, otherwise the browser refuses to load the sandbox iframe (already done in the shipped file).
2. Deploy the Worker (`wrangler deploy`) and the site (Vercel).
3. After deploy open `https://app.cognita.com.ng/sandbox-frame` and check the
   response headers: the `Content-Security-Policy` must be the one from the
   sandbox rule and it must not also include `default-src 'self'` from the
   global rule. If both appear, tell me and I will split the rules differently.
4. Ask Cognita: "What is the mean of 4, 8, 15, 16, 23, 42? Use code." The first
   Python run takes a few seconds while Pyodide downloads, later runs are fast.

## Tests

`node tests/sandbox-fixes.test.mjs` (start-up logic, error wording, security headers) and
`node tests/sandbox.test.mjs` (gate table of 40 phrases, confirmation card text, tool results) and
`node tests/sandbox-chat.test.mjs` (the file-save route and usage keys through the real Worker).
The chat test needs throwaway key files (`tests/key.pem`, `cert.pem`, `sa.pem`, never committed):
`openssl req -x509 -newkey rsa:2048 -nodes -keyout tests/key.pem -out tests/cert.pem -subj /CN=t -days 2 && openssl genrsa -out tests/sa.pem 2048`.
The frame was also run in headless Chromium against the self-hosted bundle (numpy, pandas, matplotlib, openpyxl).
Not tested: a real iPhone, the live Cloudflare Pages site, the live Vercel header merge.

## Not built

Binary Drive files (above), shell-level git/npm (Tier 3), a GitHub Actions provider.

## Browser testing (local first, cloud as backup)

**Local, free, every plan: `sandbox_browser_test`.** Renders an HTML page (a workspace file, or HTML the
model passes in) inside a nested iframe in the existing sandbox frame, in the person's own browser. Linked local
`.css` and `.js` files from the workspace are inlined. The nested frame has its own opaque origin and a meta CSP
that blocks all network. It reports console output, script errors, failed or blocked loads, missing local files,
broken images, sideways scrolling, elements that overflow the viewport, small tap targets (`touch: true`), page
text, and size/position of up to 10 selectors. Use `width: 375` to check a phone layout.
Limits: it is whatever browser the person uses (Safari on iPhone, Chrome on Android), not a fixed Chromium. No
screenshots. Error line numbers are offset by about 50 lines because a small collector script is injected first.
A page with an endless loop can freeze the frame until the existing watchdog replaces it.

**Cloud, Studio and Admin only: `sandbox_browser_fetch`.** Cloudflare Browser Rendering REST API (`browser-rendering.js`).
Renders a public https page, or HTML, and returns rendered text, html, links or element measurements. It cannot
report console errors and the model cannot see screenshots, so there is no screenshot mode.
It is also an automatic backup: if the local test could not start at all (not when the page itself failed),
`chat-endpoint.js` retries once in the cloud for Studio and Admin.

Safeguards: plan is checked on the server from the verified uid (`planHasRemoteBrowser`); the tool is only offered when
secrets exist and the person has allowance left; per-person cap `limits.browserRemotePerDay` (Studio 30, Admin unlimited)
plus an account-wide cap `CF_BROWSER_GLOBAL_PER_DAY` (default 60) because Cloudflare's free allowance is shared by everyone;
failures on our side or Cloudflare's refund the allowance; only public https URLs on port 443 with a domain name
(no IPs, localhost, `.local`, credentials).

Setup: `npx wrangler secret put CF_BROWSER_ACCOUNT_ID` and `npx wrangler secret put CF_BROWSER_API_TOKEN`
(API token with the "Browser Run (or Browser Rendering) - Edit" permission). Optional var `CF_BROWSER_GLOBAL_PER_DAY`.
Check the current free-plan allowance in the Cloudflare dashboard before relying on it.
