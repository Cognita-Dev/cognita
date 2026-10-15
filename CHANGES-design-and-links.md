# Apple-style HTML default and no raw workspace links
- prompts.js: HTML pages/apps default to Apple-style minimalist premium design (system fonts, white space, neutral palette + one quiet accent, soft shadows, rounded corners, subtle motion); no purple/rainbow gradients, neon or glow unless the user asks for a style. The model must never write a download link or /workspace path; the file card appears after sandbox_offer_file.
- js/app.js: [label](sandbox:/workspace/...) style links (sandbox:, file:, workspace/, /mnt/) are removed when a message is drawn, including streaming and saved chats. Normal https links are untouched.
- tests/qa-prompts.test.mjs: token caps 4700 (sandbox) / 5700 (all).
- tests/workspace-links-and-design.test.mjs, tests/workspace-link.e2e.py: new.
