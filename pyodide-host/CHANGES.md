# Cognita changes: files, charts, sandbox, new steps display

## What was wrong
The assistant said "file created" but the file never reached the person. Now the Worker sends a `deliverables` list and the app shows a download chip (plus Save to Cognita) under the answer.

## What changed, by file
- `sandbox-intent.js` (new, shared): decides if code tools are offered. Must NOT be in `.vercelignore` (the browser imports it).
- `sandbox-tools.js`, `chat-endpoint.js`, `prompts.js`: gate, deliverables, shorter rules (honest connector wording), `step_start` events, richer steps, approval data.
- `confirmation.js` (new, Worker only): plain-English approval text, no secrets, capped lengths.
- `connector-tools.js`: `describeConfirmation`, `stepMeta`.
- `files-endpoint.js`, `worker.js`, `entitlements.js`, `account-endpoint.js`: `POST /api/files/:id` save route, limits, `sandboxArtifacts` usage, `limits` in `/api/usage`.
- `sandbox-frame.html`, `vercel.json`, `js/sandbox-client.js`: self-hosted Pyodide, uploads into the workspace, figures, clear-all.
- `js/app.js`, `app.html`, `css/activity.css` (new), `css/app.css`: uploads to workspace, inline charts, deliverables, usage bar, new Activity timeline and approval card. Old step/thought/confirm styles removed.
- `js/auth.js`, `js/router.js`, `js/account.js`: workspaces cleared on sign-out/account switch; "Code runs" usage.
- `scripts/build-pyodide-bundle.mjs`, `pyodide-host/` (new), `.vercelignore`, `.gitignore`.
- `sandbox.md`: rewritten (includes the "binary Drive files not built, and why" note; the file is `sandbox.md`, not SANDBOX.md).
- `tests/sandbox.test.mjs`, `tests/sandbox-chat.test.mjs` (new).

## What you must do (phone steps)
1. Upload every file to GitHub at the same path (GitHub app/web: Add file, Upload files; keep folder names).
2. Cloudflare dashboard: Workers & Pages, Create, Pages, Connect to Git, pick the repo. Build command `node scripts/build-pyodide-bundle.mjs`, output directory `pyodide-host/dist`, variable `NODE_VERSION` = `20`. Deploy. Then Custom domains, add `pyodide.cognita.com.ng`.
3. Redeploy the Worker (`wrangler deploy` or your usual way) and let Vercel redeploy the site.
4. Test: ask "What is the average of 4, 8, 15, 16, 23, 42? Make me a CSV file of the numbers." You should get a download chip.
**Until step 2 is live, Python in the sandbox will not load.** Rollback: see `sandbox.md`, "Self-hosted Pyodide".

## Verified
- `node --check` on every changed JS file and the frame's inline scripts.
- Tests: `sandbox.test.mjs` 47/47, `sandbox-chat.test.mjs` 7/7. `billing.test.mjs` is 42/47 both before and after my changes (receipt emails; not mine).
- Pyodide bundle in headless Chromium inside a sandboxed iframe: numpy, pandas, matplotlib PNG, openpyxl, scipy, sklearn, sympy.
- New Activity timeline and approval card (finished, failed, pending, long text, declined, approved, legacy chat, running) in light and dark at 375px and 1280px: no sideways scroll, tap targets 44px or more, buttons and toggles work. Screenshots were viewed (mobile light, desktop dark) and fixed.

## Not verified
- Real Cloudflare Pages headers, the live Vercel header merge, a real iPhone.
- Icons in the screenshots: Phosphor icons did not load in my test page, so node icons/tiles were blank there.
- Full end-to-end in the live app with sign-in (upload into workspace, sign-out clearing the database, Save to Cognita against real storage). The code paths and the route checks are tested, the live flow is not.
- The save route's success path (needs real storage).

## Notes
- Small secondary text uses `--text-2`, not `--text-3`, because `--text-3` is too faint on light backgrounds.
- The 20-file cap per chat counts all generated files, not only sandbox files.
- `tests/*.pem` are throwaway keys, git-ignored. Do not upload them.
