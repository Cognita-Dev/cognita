# Web search: sources in the Activity list (15 Oct 2026)

## What people see now
- A finished search reads "Searched the web for "…"" (past tense) with a globe icon and the "Web" label. It opens into the sites it found: site picture, title, site name, link (new tab).
- Two or more searches in a row become ONE row: "Searched the web" / "3 searches". Opening it shows each question with its own sites. (Before: "Read 3 items · Web".)
- A failed search is unchanged: red "Failed" row with the reason, nothing to open.
- Under the answer, the existing "Sources" list now fills in (up to 8 sites, no repeats). `[1]`, `[2]` in the answer become links to those sites.

## Files
- `web-search.js`: new `sourcesForClient()` (title + address only, no excerpts). `resultForModel()` numbers each result with `r.n` when the Worker gave it one.
- `chat-endpoint.js`: each search gets numbers that run across the whole turn (1, 2, 3 ... over all searches; the same address keeps its first number, so `[2]` always means the same site). The `web_search` step now carries `query` and `sources`; the `done` payload carries `sources` (max 8).
- `js/app.js`: "Web" has a globe in `LABEL_GLYPHS`; new helpers (`webSourcesHtml`, `webSearchQuery`, `isWebSearchStep`, `sourcesFromSteps`, `FAVICON_URL`); `renderStepItemHtml` and the grouping loop in `renderActivityHtml` handle searches; `meta.sources` falls back to the sites in the search steps if the server sent none.
- `css/activity.css`: `.act-sources`, `.act-src*`, `.act-search*`.

## Good to know
- Older saved chats (no `query`/`sources` on their steps) still work: they group, and the question is read back from the saved sentence. They simply have no sites to open.
- Site pictures load from Google's favicon service (`FAVICON_URL` in `js/app.js`), which is told only the site name, never the question. To avoid a third party, make `FAVICON_URL` return `''` and only the globe shows. A picture that fails to load is removed and the globe underneath shows. If you keep it, mention it in privacy.html.
- The page CSP already allows `img-src https:` (vercel.json), so no header change is needed.
- Searches still stored as steps: sources add roughly 1 to 1.5 KB per search to a saved chat.

## Tests
- `node tests/web-search-chat.test.mjs`: the REAL chat handler with a fake model and fake Tavily (needs the git-ignored tests/*.pem).
- `PORT=8801 node tests/stream-ui-server.mjs &` then `python3 tests/web-search-ui.e2e.py`: real Chromium, 24 checks. Optional `PHOSPHOR_DIR` serves the icon font locally when unpkg is not reachable.
- Existing suites still pass: web-search, chat-title, qa-prompts, web-fetch, tool-leak, qa-ui-*, steps-ui (11), stream-ui (21), qa-flat-ui (6), qa-ui-interactions (60).

## Not verified
Live Tavily/Firecrawl/model calls, and Google's real favicon service (blocked in this sandbox: the test serves a stand-in picture and proves the fallback). The CSP was checked by reading vercel.json, not by running the deployed headers.

## Deploy
Worker: chat-endpoint.js, web-search.js. Site: js/app.js, css/activity.css.
