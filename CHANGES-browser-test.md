# Browser test: screenshots, live preview, daily limits

Copy every file in this zip over the same path in your repo, then deploy as usual. No new services, no cost.

| File | What changed |
|---|---|
| sandbox-frame.html | Screenshot capture (no library, no server). Page copy for live preview. Fix: local `<link href=x.css>` / `<script src=x.js>` with unquoted attributes were never inlined. |
| preview-frame.html (NEW) | Isolated page that runs the preview. Network blocked. |
| vercel.json | CSP and headers for /preview-frame, and it is excluded from the X-Frame-Options DENY rule. |
| js/app.js | Shows the screenshot and a "Live preview" button under the browser-test step. Screenshot is never sent to the server. |
| css/activity.css | Styles for the screenshot and preview. |
| entitlements.js | `browserTestPerDay`: Starter 100, Plus 500, Studio and Admin unlimited. |
| chat-endpoint.js | Counts each browser test (usage key `browserTests`), stops offering the tool when the allowance is used, and refuses tampered calls. |
| account-endpoint.js | /api/account usage now includes `browserTests`. |
| sandbox-tools.js | Tool description and the new `full_page` / `screenshot` options. |
| tests/sandbox-browser.test.mjs | 3 new tests. |

Limits of the screenshot: it is drawn by the browser from a copy of the page, so web fonts and
external images (blocked in the sandbox anyway) do not appear, and Safari may refuse to read it
back (then the report says no screenshot; the test still runs). The model only receives text
(tool results here are text), so it is told a screenshot exists and uses the measurements.
