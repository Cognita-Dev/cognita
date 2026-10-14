# Sandbox follow-up / code-leak fix (14 Oct 2026)
- sandbox-intent.js: new `finished-file` pattern ("produce a proper finished file with organogram"); short follow-ups ("Go on", "Where's it?") now look at the last 3 user messages (`recent`).
- chat-endpoint.js: passes `recent` user messages to the gate.
- tool-leak.js: fenced code that mentions cognita_docs / sandbox_* is stripped from replies (incl. unfinished fence while streaming).
- prompts.js: never claim a file exists or give /workspace links before sandbox_offer_file succeeds; never answer with code.
- NOT changed: requests with an attached image still skip the sandbox (hasImages) - needs a vision+tools decision.
