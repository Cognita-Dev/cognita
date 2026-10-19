# doc-studio

Free, self-hosted design engine for **PDF, Word, PowerPoint, Excel, posters and slides** that don't look templated.

## Why your output looked the same
Fixed templates = one colour + one font swapped on the same layout. doc-studio instead uses
8 complete design systems (type, structure, shapes, rules, poster composition), real embedded
open fonts, per-slide variation, and an AI prompt that makes the content spec varied.

## Stack (all open source, free)
Chromium via Playwright (layout/PDF/PNG) · docx · pptxgenjs · exceljs · Fontsource (OFL fonts) · Express

## Run
```
npm install
npx playwright install chromium
npm start        # http://localhost:3333
npm test         # renders all examples into ./out
```
Self-host: any VPS/Docker/Render/Fly/Railway with Node 18+. (Vercel serverless can't run Chromium well.)

## Use
Browser UI: paste JSON/Markdown → pick design → Preview → download.
API: `POST /api/export {spec, format}` with format = pdf|png|docx|pptx|pptx-image|xlsx|html.
Give `AI-PROMPT.md` to any AI so it outputs the JSON spec.

## Notes
- PDF/PNG/HTML/pptx-image use the real fonts (pixel-perfect). Editable DOCX/PPTX use safe Office fonts.
- Add a design: copy a block in `src/designs.js`.
