"""Headless-Chromium test: a scanned (image-only) PDF is read through self-hosted Tesseract.js.
Run: python3 tests/ocr-scanned-pdf.e2e.py <scan.pdf> <pdfjs-dist-dir>
Serves the repo with a CSP equal to the main app's (script-src 'self' 'wasm-unsafe-eval', worker-src 'self' blob:)."""
import sys, re, threading, http.server, functools, os
from playwright.sync_api import sync_playwright
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PDF, PDFJS = sys.argv[1], sys.argv[2]
CANCEL = len(sys.argv) > 3 and sys.argv[3] == 'cancel'
EXPECT = sys.argv[4:] or ['invoice', '4821', '1250']
CSP = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'; worker-src 'self' blob:; connect-src 'self'; img-src 'self' data: blob:"
src = open(os.path.join(ROOT, 'js/app.js')).read()
a = src.index('const PDF_SCAN_MIN_CHARS'); b = src.index('async function extractDocxText')
fn = src[a:b]
PLAN = os.environ.get('PLAN')  # simulate the account plan, e.g. PLAN=plus
fn = 'var currentAccountPlanId = ' + ('"%s"' % PLAN if PLAN else 'null') + ';\n' + fn.replace('const FREE_', 'var FREE_')
class H(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Content-Security-Policy', CSP); super().end_headers()
    def log_message(self, *a): pass
    def translate_path(self, p):
        if p.startswith('/__pdfjs/'): return os.path.join(PDFJS, p[len('/__pdfjs/'):])
        if p == '/__scan.pdf': return PDF
        return super().translate_path(p)
srv = http.server.ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(H, directory=ROOT))
threading.Thread(target=srv.serve_forever, daemon=True).start()
port = srv.server_address[1]
with sync_playwright() as p:
    br = p.chromium.launch(); pg = br.new_page(); errs = []
    pg.on('console', lambda m: errs.append(m.text) if m.type == 'error' else None)
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(f'http://127.0.0.1:{port}/tests/fixtures/ocr-harness.html')
    pg.add_script_tag(url='/__pdfjs/build/pdf.min.js')
    pg.add_script_tag(url='/vendor/tesseract/tesseract.min.js')
    pg.wait_for_function('window.pdfjsLib && window.Tesseract')
    pg.evaluate("window.pdfjsLib.GlobalWorkerOptions.workerSrc='/__pdfjs/build/pdf.worker.min.js'")
    pg.evaluate("window.showToast=()=>{}")
    pg.add_script_tag(content=fn)
    seen = pg.evaluate("""async(cancel)=>{const b=await (await fetch('/__scan.pdf')).blob();
      let sawBox=false;
      const t=setInterval(()=>{const bx=document.querySelector('[role=status]'); if(bx){sawBox=true; if(cancel){bx.querySelector('button').click();}}},100);
      const out=await extractPdfText(new File([b],'scan.pdf',{type:'application/pdf'}));
      clearInterval(t);
      return {out, sawBox, boxGone: !document.querySelector('[role=status]')};}""", CANCEL)
    out = seen['out']; print('progress box shown:', seen['sawBox'], '| removed after:', seen['boxGone'])
    print('OCR OUTPUT:', repr(out)); print('console errors:', errs)
    low = out.lower()
    ok = seen['sawBox'] and seen['boxGone'] and (('cancelled at page' in low) if CANCEL else all(e in low for e in EXPECT))
    br.close()
print('PASS' if ok else 'FAIL'); sys.exit(0 if ok else 1)
