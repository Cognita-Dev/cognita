# Python server fix: repeated CORS header (October 2026)

## What was wrong
`pyodide-host/_headers` set `Access-Control-Allow-Origin: *` in two blocks (`/*` and `/v0.29.5/*`). Cloudflare Pages joins
repeated headers with a comma, so the live server sent `Access-Control-Allow-Origin: *, *`. Browsers reject that, so every
`fetch()` to pyodide.cognita.com.ng failed at once ("Load failed" in Safari). Plain downloads and `curl` ignore CORS, so the
server looked healthy. jsDelivr sends one clean header, which is why the backup worked at that time. The frame then lost about 45 seconds
before switching, because it kept going after the first refused request.

## What changed
- `pyodide-host/_headers`: each header is now set by one block only. The cache rule stays in the versioned block; the
  Content-Type rules were removed (Cloudflare already serves .js, .json, .wasm and .zip with the right types, and a second
  Content-Type could be joined the same way).
- `sandbox-frame.html` (Python worker): a failed request for the loader or core file now stops at once, so the page moves to
  the backup in about a second instead of waiting for the 45 second watchdog.
- `sandbox-check.html`: when a download fails quickly it now says whether the server answered but the browser refused it
  (CORS) or could not be reached at all.
- `pyodide-host/README.md`: warning about repeated headers.
- `tests/pyodide-headers.test.mjs` (new): fails if any header is set by two matching rules.

## Second round: only your own server (jsDelivr removed from the sandbox)
Once your own server worked, the public backup (cdn.jsdelivr.net) was removed from everything the sandbox touches:
- `vercel.json`: the `/sandbox-frame` policy now allows scripts and connections to `https://pyodide.cognita.com.ng` only.
  The `/sandbox-check` policy likewise (an extra script permission added in an earlier step was removed again).
  Why: anything the frame's policy allows is a place model-written code can talk to. jsDelivr serves other people's
  files and its logs are not yours, so it was a wider door than needed. The backup also lacked openpyxl.
- `sandbox-frame.html`: `PY_BASES` lists your host only; failures are reported clearly instead of switching servers.
- `sandbox-check.html`: tests your host only. After a failure it tries a fresh address to spot an old cached copy.
- `SANDBOX.md`, `tests/sandbox-fixes.test.mjs`: updated; new tests fail if jsDelivr or any other host comes back.
- Left alone on purpose: the main app's own policy still lists jsDelivr (the KaTeX maths library in `app.html`).
Trade-off: if Cloudflare Pages for the Python server is ever down, Python in the sandbox is unavailable until it is back.

## Deploy
1. Upload the files to GitHub at the same paths.
2. Cloudflare Pages rebuilds the Python server by itself (the `_headers` file is copied during the build).
3. Vercel redeploys the site (the frame and check page).
4. Open https://app.cognita.com.ng/sandbox-check and run it. Expect "OK Cognita Python server" and Python starting in a few seconds.
   If your phone cached the old answer, close the tab and open it again.

## Verified
- Cloudflare docs: repeated headers are joined with a comma.
- New guard test fails on the old `_headers` and passes on the new one.
- `node --check` on the frame and check page scripts; `sandbox` 47/47, `sandbox-chat` 7/7, `sandbox-fixes` 23/23.

## Not verified
- The live server (my workspace cannot reach your domains), so the fix is confirmed from the code, the report and the docs,
  not by loading the live site. The check page after deploy is the real proof.
