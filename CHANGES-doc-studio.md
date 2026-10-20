# doc-studio now makes Cognita's documents and graphic designs

Before: Word/PDF/PowerPoint files came from a generic helper (`cognita_docs` in sandbox-frame.html) and flyers/posters from a
built-in SVG composer. Now, when the doc-studio service is switched on, both use doc-studio's 8 design systems, real fonts
and composed layouts. When it is off or down, everything works exactly as before.

## What changed
- `doc-studio/` (the service): tested and fixed (Markdown specs now reach the Word export; the title comes from the first `#`),
  plus `src/sanitize.js` (AI-written specs are cleaned), `POST /api/render` (files + preview in one call),
  token protection (`DOCSTUDIO_TOKEN`), a render queue and timeout, no outgoing requests from the renderer, poster `image` + `logo`,
  `playwright` pinned to 1.64.1 to match the Docker image, `package-lock.json`, `.dockerignore`, `.gitignore`, `test-api.js`, new README.
- `docstudio-client.js` (new, Worker): calls the service, validates what comes back.
- `media-tools.js`: new tool `create_document` (Word/PDF, PowerPoint, Excel); `create_design` renders through doc-studio (PNG + PDF), with
  your logo/photo, brand colours and a new optional `style`; falls back to the old SVG designer if the service fails.
  Document requests ("report", "CV", "slides", "pdf" ...) switch the tools on only when the service is configured.
- `prompts.js`: new `DOC_RULES`; when `create_document` is on, the long Word/PDF/PowerPoint helper text is left out of the sandbox rules (about 750 tokens saved). Unchanged when the service is off. `PROMPT_VERSION` 2026-10-19.1.
- `sandbox-intent.js` + `chat-endpoint.js`: with the service on, a plain "make a Word document" no longer switches the code tools on
  (this also keeps the request under the 8,000-token per-minute limit on Groq). Data and code requests still do.
- `js/app.js`, `css/activity.css`: new "designed file" card (preview picture, Preview, one button per file, design name). Files are written to the chat's
  workspace, so they survive reloads, open in the preview sheet and can be saved to Cognita. The saved chat keeps only the preview picture and file paths.
- `.vercelignore`: `doc-studio/` and `docstudio-client.js` are not deployed to Vercel.
- Tests: `tests/docstudio.test.mjs`, `tests/docstudio-chat.test.mjs`, `tests/docstudio-ui.e2e.py` (+ `tests/docstudio-ui-fixtures.mjs`), `doc-studio/test-api.js`;
  `tests/qa-prompts.test.mjs` updated for the new prompt version.

## Switch it on
1. Deploy `doc-studio/` as a container (see `doc-studio/README.md`), with `DOCSTUDIO_TOKEN` set.
2. `npx wrangler secret put DOCSTUDIO_URL` and `npx wrangler secret put DOCSTUDIO_TOKEN`.
3. Deploy the Worker and the site. Ask Cognita: "Make a 5-slide pitch deck for a bakery".
Document exports count against the plan's existing `documentGenPerDay` (shown as "Documents" on the Account page); a failed render gives the unit back.

## Known limits
- Free plan: a file bigger than the plan's workspace file limit (2 MB) is not kept in the workspace; it can still be downloaded during that visit.
  The 16:9 slide PDF is about 1.5 MB.
- Editing an existing .docx/.pptx the person attached still uses the old helper path (doc-studio makes new files).
- Not tested here: the real Cloudflare Worker runtime, a deployed doc-studio host, a real phone, real AI-model behaviour (tests use a fake model).
- `tests/billing.test.mjs` already failed before these changes.
