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
