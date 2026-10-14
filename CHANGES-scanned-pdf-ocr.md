# Scanned PDF reading (OCR)

Scanned PDFs are pictures of text, so pdf.js finds no text in them. Pages with fewer than 20 characters of text now go through OCR in the browser.

- `vendor/tesseract/` holds self-hosted Tesseract.js 5.1.1 (worker, WASM core with SIMD fallback, English `eng.traineddata.gz`). No CDN and nothing is uploaded; OCR runs on the user's device.
- `js/app.js`: `extractPdfText` renders scanned pages to a canvas (pdf.js, 2x) and reads them with a shared Tesseract worker. No page limit on paid plans (free plan: 30 pages, 15 OCR'd); progress box with Cancel; the text is saved to the `.txt` sidecar like any other PDF text.
- `app.html`: loads `/vendor/tesseract/tesseract.min.js`.
- `vercel.json`: main page CSP gets `'wasm-unsafe-eval'` (WASM needs it; worker-src and connect-src already allow 'self'). Long-cache header for `/vendor/tesseract/*`.
- `tests/ocr-scanned-pdf.e2e.py`: headless Chromium test under the app's CSP. Run: `python3 tests/ocr-scanned-pdf.e2e.py scan.pdf path/to/pdfjs-dist`.

Add more languages by dropping `<lang>.traineddata.gz` into `vendor/tesseract/lang/` and changing `'eng'` in `getOcrWorker`.
