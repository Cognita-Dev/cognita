# Cognita Studio

Everything for the video studio lives in this folder.

- `studio.js`, `studio.css`  the page (mounted by `js/router.js` as `?view=studio`)
- `engine.js`  frame renderer, layouts, transitions, audio scheduling. A frame is a pure function of (project, time)
- `export.js`  WebCodecs exporter (fast, frame exact) with a MediaRecorder fallback
- `media.js`  footage decoding, AI pictures (existing `/api/image`)
- `narration.js`, `server/`  spoken narration (Studio plan and admin only)
- `storyboard.js`  prompts and validation for `/api/chat`
- `store.js`  IndexedDB for drafts and assets
- `vendor/`  Mediabunny 1.61.3 (MPL-2.0), self-hosted so the CSP needs no change

## Narration
`POST /api/studio/tts` uses the Learna Edge voice engine first (Nigerian English, $0), then Workers AI MeloTTS
(`@cf/myshell-ai/melotts`, about 19 neurons per audio minute) as backup. Each line is cached in B2.
Limit: `studioTtsCharsPerDay` in `entitlements.js` (Studio 40,000, Admin unlimited, others 0).
Kill switches (Worker variables, set to "1"): `STUDIO_TTS_DISABLED`, `STUDIO_EDGE_TTS_DISABLED`, `STUDIO_MELO_TTS_DISABLED`.
