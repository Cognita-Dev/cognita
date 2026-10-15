# Browser test: a raw [Download X](sandbox:/workspace/x.html) link never shows as text in the chat.
import json, os, urllib.request
from playwright.sync_api import sync_playwright
BASE = os.environ.get('BASE', 'http://localhost:8801')
AUTH = open(os.path.join(os.path.dirname(__file__), 'stream-ui.e2e.py')).read().split('AUTH_STUB = \"\"\"')[1].split('\"\"\"')[0]
res = []
def check(n, ok, d=''):
    res.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + n + ('' if ok else ' :: ' + str(d)))
def script(steps): urllib.request.urlopen(urllib.request.Request(BASE + '/__script', data=json.dumps(steps).encode(), method='POST'))
with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 390, 'height': 800})
    ctx.route('**/js/auth.js', lambda r: r.fulfill(status=200, content_type='text/javascript', body=AUTH))
    ctx.route(lambda u: not u.startswith(BASE) and not u.startswith('data:') and not u.startswith('blob:'), lambda r: r.abort())
    page = ctx.new_page(); errs = []; page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(BASE + '/app.html'); page.wait_for_selector('#composerInput'); page.wait_for_timeout(400)
    reply = 'Your calculator is ready.\n\n[Download Scientific Calculator](sandbox:/workspace/scientific_calculator.html)\n\nSee [the docs](https://example.com) too.'
    script([{'event': 'done', 'data': {'reply': reply}}])
    page.fill('#composerInput', 'build it'); page.click('#sendBtn')
    page.wait_for_function("document.querySelector('#messageList').innerText.includes('too.')", timeout=20000); page.wait_for_timeout(800)
    txt = page.locator('#messageList .message.is-assistant').last.inner_text()
    check('raw sandbox link is not shown', 'sandbox:' not in txt and '/workspace/' not in txt and 'Download Scientific' not in txt, txt)
    check('normal https link still works', page.locator('#messageList .message.is-assistant').last.locator('a[href="https://example.com"]').count() == 1)
    check('no JS errors', not errs, errs[:2])
    b.close()
print('%d/%d passed' % (sum(res), len(res))); raise SystemExit(0 if all(res) else 1)
