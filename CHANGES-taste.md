# Taste: Cognita now judges how a file looks

Problem: the quality check only caught broken files (overflow, placeholders, empty slides). A deck could pass and still look tired: tall half-empty cards, walls of text, the same layout on every slide, filler wording.

Changes
- `sandbox-frame.html` (docs helper, `check()`): every docx, pdf, pptx, xlsx and png/jpg is also scored out of 100 for design. Below 78 the report says NEEDS FIXES, lists the costliest problems first and says how to fix each.
  - Slides: title size against body, titles in one spot, margins, shared left edges, empty or crammed slides, lopsided balance, number of colours, same layout on every slide, words per slide, stretched pictures, filler wording.
  - Word: missing or skipped headings, walls of text, too many fonts, one text size, tight margins, stretched pictures.
  - PDF: very long lines, margin, no size hierarchy, a heading stranded at the bottom of a page, walls of text.
  - Excel: unstyled header row, numbers with no format, header not frozen on long sheets.
  - Pictures: small size, extreme shape, mostly empty, off-centre.
- Slide builder: bullet cards are sized to their content and sit slightly above centre (they used to be tall and half empty).
- Page drawing: `check()` draws slides, Word pages and PDF pages into one small JPEG (`/workspace/.cognita-taste/preview.jpg`). The frame picks it up after the run, removes it, and attaches it to the result as `tastePicture`.
- `js/app.js`: `withoutPreviewFields()` now forwards only small JPEGs (the taste picture and the page-test screenshot) as `reviewImages`.
- `sandbox-tools.js`: `normalizeResult()` validates `reviewImages`.
- `vision-review.js` (new) + `chat-endpoint.js`: the pictures are shown to the Workers AI vision model (one call per picture, counted against the plan's vision allowance, skipped without a vision plan). The reply is appended to the tool result as an advisory VISION REVIEW. It never fails a file; the measured score is the gate, because the vision model is weak.
- `browser-rendering.js`: new `screenshot` mode for Cloudflare Browser Run (small JPEG).
- `prompts.js`: the QA paragraph now mentions the taste score and the advisory review.
- Tests: `tests/taste.test.mjs`, `tests/taste-frame.e2e.py` (headless Chromium).

Cloud screenshots (second round)
- `chat-endpoint.js`: new `_applyVisionReview()` is the one place that shows pictures to the vision model (used on resume and for the cloud browser).
- When the local page test cannot run a page and the cloud browser takes over, the cloud browser now also takes a `screenshot` of the page, so the page still gets its visual review. It is a second cloud render, taken only when the first succeeded and the plan has vision.
- `sandbox_browser_fetch` accepts `mode: "screenshot"`; the model gets a written design review (it cannot see pictures), or a plain note when no review was available.
- `tests/page-screenshot.e2e.py`: real headless Chromium runs `sandbox_browser_test` in the frame, checks the JPEG screenshot, then pushes it through `app.js` forwarding, the server checks and the review.

Known limits
- Not run in Pyodide or the live chat flow (Pyodide is downloaded from your own host, which this sandbox cannot reach). The Python rules were run with CPython 3 and Pillow. Without Pillow in Pyodide the score still works but no page picture is drawn.
- Cloud screenshots were tested against a faked Browser Run reply, not the real Cloudflare service.
- `tests/qa-prompts.test.mjs` "token budget" was already failing before this work (4857 against a 4400 limit).
