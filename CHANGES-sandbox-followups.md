# Sandbox follow-up / code-leak fix (14 Oct 2026)
- sandbox-intent.js: new `finished-file` pattern ("produce a proper finished file with organogram"); short follow-ups ("Go on", "Where's it?") now look at the last 3 user messages (`recent`).
- chat-endpoint.js: passes `recent` user messages to the gate.
- tool-leak.js: fenced code that mentions cognita_docs / sandbox_* is stripped from replies (incl. unfinished fence while streaming).
- prompts.js: never claim a file exists or give /workspace links before sandbox_offer_file succeeds; never answer with code.
- NOT changed: requests with an attached image still skip the sandbox (hasImages) - needs a vision+tools decision.

# Photo requests + pictures in files (second round)
- chat-endpoint.js: when a photo comes with a request for a file ("put these in a neat document"), the vision model first copies ALL the text of EVERY photo (not just the first), that text is added to the user's message, and the normal sandbox flow builds the file. If reading fails, the old vision-only reply is used. Pure questions about a photo ("what is this?") are unchanged. Note: the sandbox itself cannot read pixels (no OCR engine is bundled), so the vision model does the reading.
- providers.js: callVisionModel accepts { maxTokens } (up to 4096).
- sandbox-intent.js: wantsFileFromImage().
- sandbox-frame.html: cognita_docs now supports ("image", path, {"width", "caption"}) for Word and PDF (PNG incl. transparent, JPEG); a bad picture gives a short note instead of crashing. Organograms are drawn with matplotlib.
- prompts.js: how to draw organograms and place them; never say a picture cannot be read.
- tests/image-to-file.test.mjs, tests/docs-helper-demo.py (builds a demo docx/pdf/pptx with an organogram).
- Verified: real Python builds; docx opens in python-docx and LibreOffice; PDF renders with poppler; existing suites pass (sandbox 47, chat 7, fixes 24, tool-leak, prompts). The sandbox test suites need tests/key.pem, cert.pem, sa.pem (not in the repo); I made throwaway ones locally and removed them.
- NOT verified: a real phone, the live Worker/vision model, Pyodide speed on large PNGs (PNG unfiltering is pure Python, ~seconds for a 1000px chart).
