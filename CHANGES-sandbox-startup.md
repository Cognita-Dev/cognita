# Sandbox start-up fix (October 2026)

## What was wrong
- On some phones Python sat on "Starting Python (2/3 core)" until the page's 45 second watchdog gave up with
  "nothing happened for 45 seconds". The Python server (`pyodide.cognita.com.ng`) was up and serving every
  file; the download of the 1 MB core file simply never produced data on that device, and nothing noticed.
- JavaScript runs on iPhone showed only a list of "anonymous@" lines. Safari's `error.stack` has no message line
  (Chrome's does), so the real error was thrown away and the assistant wrongly concluded the sandbox was broken.
- The Cloudflare Pages "Metrics" tab showing no data is normal: it only counts Pages Functions, and this site
  is static files.

## What changed
- `sandbox-frame.html`
  - Python downloads are watched by a guard inside the worker: "waiting for pyodide.asm.js (12 s)" every 2 s,
    and a clean failure after 30 s without data, even if the browser ignores fetch's abort.
  - If the Cognita server fails, the page starts a fresh worker on a backup (jsDelivr) and carries on.
    The server that worked is remembered for the session.
  - JavaScript errors always show "Name: message" first (readable on iPhone), with blob addresses trimmed;
    forgotten promises that fail are reported too.
- `vercel.json`: the sandbox frame may also load from `https://cdn.jsdelivr.net` (backup only); new rule for
  the check page; the check page is excluded from the global rule.
- `sandbox-tools.js` (Worker): "Python could not start" now also tells the model to stop retrying Python; a
  JavaScript error such as "document is not defined" / "Can't find variable: require" now tells the model it is a
  mistake in the code (no require, process, window, document in the sandbox), not a broken device.
- `sandbox-check.html` (new): open `/sandbox-check` on any device, tap "Run check", copy the report.
- `SANDBOX.md`, `tests/sandbox-fixes.test.mjs` (new, 23 tests).

## Deploy
1. Upload the files to GitHub at the same paths. Vercel redeploys the site by itself.
2. `sandbox-tools.js` runs in the Worker: redeploy the Worker (`wrangler deploy`, or let your GitHub connection
   do it).
3. Pushing to GitHub also makes the Cloudflare Pages project rebuild the Python bundle. That is expected.
4. Open `https://app.cognita.com.ng/sandbox-check` on the phone and run the check.

## Verified
- Real headless Chromium, sandboxed iframe, the exact `vercel.json` policy: normal start; primary server
  refusing connections; primary stalling on the core file; both servers stalling (clear combined error after
  about 60 s); a browser that ignores fetch abort (guard still fires); JavaScript error text.
- `node tests/sandbox.test.mjs` 47/47, `node tests/sandbox-chat.test.mjs` 7/7, `node tests/sandbox-fixes.test.mjs` 23/23.

## Not verified
- A real iPhone on a mobile network (this environment has no WebKit and cannot reach your hosts), the live
  Vercel header merge, and why the core file stalled on that phone in the first place. The check page is there
  to find out.
