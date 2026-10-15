# Designed slides and PDFs
- sandbox-frame.html: `pptx()` rewritten. Designed 16:9 slides: cover, section dividers, cards, numbered steps, rows, real tables, pictures (PNG/JPEG), quotes, page numbers, 6 colour themes, auto-continuation of long lists/tables. `pdf()` restyled (accent strip, headings, table headers, page numbers).
- file-preview.html / js/file-viewer.js: slides now preview visually (not a text outline).
- prompts.js: model guidance for designing slides and editing/re-making decks on follow-ups.

# Quality check before any file is offered
- sandbox-frame.html: new `check(path)` in cognita_docs. Inspects pptx, docx, pdf, xlsx and png/jpg for text overflow, text too small, too many words, low contrast, raw markdown symbols, placeholder text, missing or failed pictures, tables running into the footer, a nearly empty last page, blank or cropped images. `docx()`, `pdf()` and `pptx()` print a "QA REPORT" automatically after every build. Palettes made contrast-safe. Fixed a bug where a list plus a table on one slide overlapped.
- sandbox-tools.js: `qaGate()`. chat-endpoint.js: `sandbox_offer_file` for slides, Word, PDF, Excel and pictures is held back until the file's latest report says PASS (it must be re-checked after any change; after 3 failed fix rounds it is let through so nobody is trapped).
- prompts.js: model must read the report, fix, rebuild and re-check until PASS, and must do the same for follow-up edits.
- tests/qa-gate.test.mjs, tests/qa-helper-negative.py: tests.
