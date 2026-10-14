# Web fetch tool + package list (14 Oct 2026)
- NEW web-fetch.js: Worker-side reader for public pages (see SANDBOX.md, "Reading the web").
- sandbox-provider.js: CAPS.WEB_FETCH. sandbox-tools.js: `sandbox_web_fetch` tool, argument check, step wording; Python tool description now lists every bundled package.
- chat-endpoint.js: offers the tool with the sandbox, runs it on the Worker, keeps the full text so sandbox_import_from_tool can save it; 6 pages per request; counts as a run, refunded on failure.
- prompts.js: one rule for it (trimmed other wording to stay inside the token budget).
- scripts/build-pyodide-bundle.mjs: + beautifulsoup4, networkx, statsmodels, xlrd, lxml. sandbox-frame.html: error message lists the same packages.
- tests/web-fetch.test.mjs.
## Deploy
Worker: chat-endpoint.js, sandbox-tools.js, sandbox-provider.js, prompts.js, web-fetch.js (it imports browser-rendering.js). Site: sandbox-frame.html. Then rebuild the Pyodide bundle.
## Not verified
Live fetches from your Worker, the real bundle build (this environment cannot download Pyodide, so the five new packages and their dependencies are checked only against Pyodide's published package list, not by a build), and bundle size.

## Cache-busting path (so everyone gets the new packages)
Bundle files are cached for a year, so the folder is now `v0.29.5-r2/` (build script `BUNDLE_REV`). Changed everywhere it appears: build script, `pyodide-host/_headers`, `sandbox-frame.html` (both places), `sandbox-check.html`, README, SANDBOX.md and two tests. `sandbox-frame.html` is served with `no-cache`, so browsers pick up the new frame and therefore the new path on their next visit. Next time the package list changes, bump `BUNDLE_REV` (r3...) AND the frame/check/_headers/test strings.

## Code written in the reply instead of run
chat-endpoint.js: if the sandbox is offered, the reply contains a ```python / ```javascript block, nothing was run this turn, and the person did not ask to see code, the Worker sends the model back once with "run it with the tool". Log line: `[chat][sandbox] code written in the reply instead of run`. If the model still ignores tools after that, the reply is shown as is. Not tested against a live model.

## Why Cognita pasted code (found from the Worker log)
Log: `groq_skipped_too_large: prompt is about 6976 tokens, over the 8000 per-minute cap` then `tool providers exhausted, answering without tools`. The sandbox WAS offered (17 tools) but the tool-capable Groq model was skipped because the size estimate was too cautious (3 chars/token for everything), so the reply came from a model with no tools and it pasted code.
- providers.js `_estimateTokens`: prose 3.8 chars/token, tool schemas 3.2 (was 3 for all). Same request now estimates about 5,600, leaving about 2,100 tokens for the answer.
- chat-endpoint.js: `sandbox_browser_test` (largest tool description) is only offered when the chat mentions a web page.
- If you are on a paid Groq plan, set the Worker variable GROQ_TPM_LIMIT to your real limit (default 8000) and the skip will not happen at all.

## Review fixes
- `web-fetch.js`: the read cap is now 300,000 bytes (was 450,000). `sandbox_import_from_tool` keeps only 300,000 characters, so pages between 300k and 450k were saved to the workspace cut off with no warning. Now the cut is at the read, and the model is told the page was truncated.
- `web-fetch.js`: pages that declare their encoding inside the HTML (`<meta charset>` or an XML header) instead of the HTTP header are now decoded correctly instead of showing garbled accents.
- `tests/web-fetch.test.mjs`: added checks for the cap, the in-page encoding, an unknown encoding label, and a redirect to a blocked address.
