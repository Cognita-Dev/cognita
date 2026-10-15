# Cover pages decided by document type
- prompts.js: replaced the blanket "no title-only cover page" rule. The model now adds a front (and back) cover for formal reports, proposals, theses, ebooks, brochures, portfolios, and skips it for letters, memos, resumes, one-pagers, invoices, essays and tight page limits. A cover counts toward the page count.
- sandbox-frame.html: a short page 1 / last page with large type is reported as a cover note (no penalty) to confirm, not a fault. Other near-empty pages are still penalised.
- tests/cover-intelligence.test.mjs
