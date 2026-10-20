# doc-studio

The design engine behind Cognita's documents, presentations, spreadsheets and graphic designs.
It turns a small JSON "content spec" into finished **PDF, Word, PowerPoint, Excel and PNG** files that do not look templated.

## Why the output does not look generic
Fixed templates are one colour and one font swapped onto the same layout. doc-studio uses
8 complete design systems (type, structure, shapes, rules, poster composition), real embedded open
fonts, per-slide variation, and an AI prompt that makes the content varied.

## Stack (all open source, free)
Chromium via Playwright (layout, PDF, PNG) · docx · pptxgenjs · exceljs · Fontsource (OFL fonts) · Express

## How Cognita uses it
```
 person asks for a report / deck / flyer
   → Cognita's Worker (chat-endpoint.js) offers the model create_document / create_design (media-tools.js)
   → docstudio-client.js  POST {DOCSTUDIO_URL}/api/render   (Bearer DOCSTUDIO_TOKEN)
   → doc-studio renders, returns files + a preview picture (base64 JSON)
   → the browser (js/app.js) stores the files in the chat's workspace and shows a card with Preview / PDF / Word ...
```
If `DOCSTUDIO_URL` is not set, or the service is down, flyers fall back to the built-in SVG designer and the
old Word/PDF/PowerPoint helper keeps working. Nothing breaks.

## Run locally
```
npm install
npx playwright install chromium
npm start          # http://localhost:3333  (browser studio + API)
npm test           # renders every example into ./out
npm run test:api   # API, safety and queue tests
```
Set `CHROMIUM_PATH` to use a Chromium you already have.

## Deploy for Cognita
doc-studio needs a real Chromium, so it cannot run on Vercel or inside a Cloudflare Worker. Run it as a container on
any host that takes a Dockerfile (Render, Fly.io, Railway, a VPS). Use the `doc-studio` folder as the root
and the included `Dockerfile` (it uses the official Playwright image, so Chromium is already there).
Give it at least 1 GB of memory.

Environment variables on the doc-studio host:

| Variable | Meaning |
|---|---|
| `DOCSTUDIO_TOKEN` | Shared secret. **Set it.** `/api/render` and `/api/export` answer 401 without it. |
| `DOCSTUDIO_UI` | `off` (the Dockerfile default) hides the browser studio and the example/prompt routes. |
| `MAX_CONCURRENT` | Renders at once (default 2). Others wait in a queue. |
| `RENDER_TIMEOUT_MS` | Give up on one render after this long (default 45000). |
| `PORT` | Default 3333. |

Then give the Worker the same two values (as secrets, not in the repo):
```
npx wrangler secret put DOCSTUDIO_URL     # https://your-doc-studio-host
npx wrangler secret put DOCSTUDIO_TOKEN   # the same token
```
Check `https://your-doc-studio-host/api/health`: it should answer `{"ok":true,...}`.

## API
- `POST /api/render` `{ spec, formats? }` → `{ kind, design:{id,name}, preview:{mime,content}, files:[{format,name,mime,size,content}] }` (content is base64).
  `formats` per kind — document: `pdf docx png html` · slides: `pptx pptx-image pdf png` · poster: `png pdf` · sheet: `xlsx pdf`.
  Left out, you get the sensible default (document pdf+docx, slides pptx+pdf, poster png+pdf, sheet xlsx).
- `POST /api/export` `{ spec, format, slide? }` → one file.
- `GET /api/health`, `GET /api/designs`.
- Spec format: see `AI-PROMPT.md`. A poster also takes `image` and `logo` (inline `data:image/...;base64,` pictures only).

## Safety
Specs come from an AI model, so they are cleaned first (`src/sanitize.js`): raw `css` is dropped, colours must be plain hex/rgb,
fonts must be one of the bundled families, pictures must be small inline images, sizes and counts are capped.
The renderer also blocks every network request, so a spec can never make the server fetch a URL.

## Notes
- PDF/PNG/HTML/pptx-image use the real fonts (pixel-perfect). Editable DOCX/PPTX use safe Office fonts.
- Add a design: copy a block in `src/designs.js` (and add its id to the lists in `media-tools.js` and `src/sanitize.js` if you want Cognita to offer it by name).
