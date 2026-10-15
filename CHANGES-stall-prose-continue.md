# Unfinished turns, bullet-only documents, Continue button

- chat-endpoint.js: the stall check now catches a reply that ends by announcing more work ("...Let me improve the layout") after tools ran, or reports a problem it has not fixed. Up to 3 retries, then the reply gets a visible "Reply continue" line instead of looking finished.
- js/app.js: the last reply shows a Continue button when it asks for "continue"; it sends "continue".
- prompts.js: new WRITING STYLE rule for Word/PDF/slides: paragraphs for explanations, bullets only for real lists, exact page count, no title-only cover page.
- sandbox-frame.html: QA check now also flags bullet-heavy documents (PDF and Word) and almost-empty pages (PDF), so the model must fix them before the file is offered.
- tests/stall-continue.test.mjs: new.
