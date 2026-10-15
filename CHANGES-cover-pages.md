# Cover pages decided by document type
- prompts.js: replaced the blanket "no title-only cover page" rule. The model now adds a front (and back) cover for formal reports, proposals, theses, ebooks, brochures, portfolios, and skips it for letters, memos, resumes, one-pagers, invoices, essays and tight page limits. A cover counts toward the page count.
- sandbox-frame.html: a short page 1 / last page with large type is reported as a cover note (no penalty) to confirm, not a fault. Other near-empty pages are still penalised.
- tests/cover-intelligence.test.mjs

# Calculator-screenshot fixes
- prompts.js: apps/tools/calculators with no language named default to one working HTML page (opens in Preview); Python only when asked. No eval()/exec() on typed input. input() has no keyboard, so test via functions. Build summaries are 2-3 plain sentences, no feature/test bullet lists.
- sandbox-frame.html: Pyodide stdin now returns EOF, so input() ends with EOFError instead of crashing with OSError [Errno 29].
- js/file-viewer.js: file cards/preview say "Python script", "JavaScript file", "JSON file", "Markdown document" etc. instead of "Text file".
- js/app.js: a failed step fixed by a later successful step of the same kind is not counted in "N failed".
- tests/qa-prompts.test.mjs: token caps raised (sandbox 4400->4550, all 5300->5500) for the new rules.
- tests/app-defaults.test.mjs: new.

# Long paste becomes an attached file
- js/pasted-text.js (new): paste of 3,000+ characters (or 40+ lines) becomes "Pasted text.txt" (then "Pasted text 2.txt"...). Editor sheet to open and change it.
- js/app.js: paste handler converts long text into a file through the normal attach pipeline (small files go inline, large ones to the workspace). Chip shows name, size and an Open button; Save re-reads the edited text; emptying it removes the file. The person can type a prompt, or send the file alone.
- css/app.css: chip and editor styles (full-screen sheet on phones).
- tests/pasted-text.test.mjs, tests/paste-to-file.e2e.py (desktop + mobile).
