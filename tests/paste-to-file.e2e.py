# Browser test: long pasted text becomes an attached, editable text file. Mock server, no real AI.
# Run: PORT=8801 node tests/stream-ui-server.mjs &   then   python3 tests/paste-to-file.e2e.py
import json, os, urllib.request
from playwright.sync_api import sync_playwright
BASE = os.environ.get('BASE', 'http://localhost:8801')
AUTH = open(os.path.join(os.path.dirname(__file__), 'stream-ui.e2e.py')).read().split('AUTH_STUB = \"\"\"')[1].split('\"\"\"')[0]
res = []
def check(n, ok, d=''):
    res.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + n + ('' if ok else ' :: ' + str(d)))
def script(steps): urllib.request.urlopen(urllib.request.Request(BASE + '/__script', data=json.dumps(steps).encode(), method='POST'))
PASTE = "(t) => { const dt = new DataTransfer(); dt.setData('text/plain', t); const e = new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true}); const ta = document.getElementById('composerInput'); ta.focus(); ta.dispatchEvent(e); return e.defaultPrevented; }"
LONG = ('This is a long pasted paragraph about quarterly planning. ' * 80)
with sync_playwright() as p:
    b = p.chromium.launch()
    for mobile in (False, True):
        M = 'mobile ' if mobile else 'desktop '
        ctx = b.new_context(viewport={'width': 375, 'height': 760} if mobile else {'width': 1100, 'height': 900}, has_touch=mobile, is_mobile=mobile)
        ctx.route('**/js/auth.js', lambda r: r.fulfill(status=200, content_type='text/javascript', body=AUTH))
        ctx.route(lambda u: not u.startswith(BASE) and not u.startswith('data:') and not u.startswith('blob:'), lambda r: r.abort())
        page = ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.goto(BASE + '/app.html'); page.wait_for_selector('#composerInput'); page.wait_for_timeout(400)

        prevented = page.evaluate(PASTE, 'short text')
        check(M + 'short paste stays in the box', not prevented and page.locator('.attachment-chip-pasted').count() == 0)

        prevented = page.evaluate(PASTE, LONG)
        page.wait_for_selector('.attachment-chip-pasted', timeout=5000)
        check(M + 'long paste becomes a file chip', prevented and page.locator('.attachment-chip-pasted').count() == 1)
        check(M + 'text box stays empty', page.input_value('#composerInput') == '')
        check(M + 'chip is named Pasted text.txt', 'Pasted text.txt' in page.locator('.attachment-chip-pasted').inner_text())
        check(M + 'send is enabled with only the file', not page.is_disabled('#sendBtn'))

        page.evaluate(PASTE, LONG + ' second')
        page.wait_for_function("document.querySelectorAll('.attachment-chip-pasted').length === 2", timeout=5000)
        check(M + 'second paste gets its own name', 'Pasted text 2.txt' in page.locator('#composerAttachments').inner_text())
        page.locator('[data-remove-attachment]').nth(1).click()
        check(M + 'remove works', page.locator('.attachment-chip-pasted').count() == 1)

        page.locator('.attachment-chip-edit').first.click()
        page.wait_for_selector('.paste-editor-text')
        check(M + 'editor opens with the full text', page.input_value('.paste-editor-text').startswith('This is a long pasted paragraph') and len(page.input_value('.paste-editor-text')) == len(LONG))
        page.fill('.paste-editor-text', 'EDITED ' + LONG)
        page.click('.paste-editor-save')
        page.wait_for_function("!document.querySelector('.paste-editor')", timeout=5000)
        page.locator('.attachment-chip-edit').first.click()
        page.wait_for_selector('.paste-editor-text')
        check(M + 'edit was kept', page.input_value('.paste-editor-text').startswith('EDITED '))
        page.keyboard.press('Escape')
        check(M + 'Escape closes editor', page.locator('.paste-editor').count() == 0)
        check(M + 'still one chip after edit', page.locator('.attachment-chip-pasted').count() == 1)

        script([{'event': 'done', 'data': {'reply': 'got it ' + M.strip()}}])
        page.fill('#composerInput', 'Summarise this')
        page.click('#sendBtn')
        page.wait_for_function("document.querySelector('#messageList').innerText.includes('got it')", timeout=20000)
        user = page.locator('#messageList .message.is-user').last.inner_text()
        check(M + 'prompt and file both sent', 'Summarise this' in user and 'Pasted text' in user, user[:120])
        check(M + 'composer cleared after send', page.locator('.attachment-chip-pasted').count() == 0)

        # file alone, no prompt
        page.evaluate(PASTE, LONG)
        page.wait_for_selector('.attachment-chip-pasted')
        script([{'event': 'done', 'data': {'reply': 'got file only ' + M.strip()}}])
        page.click('#sendBtn')
        page.wait_for_function("document.querySelector('#messageList').innerText.includes('got file only')", timeout=20000)
        check(M + 'file can be sent with no prompt', True)
        check(M + 'no JS errors', not errs, errs[:2])
        ctx.close()
    b.close()
print('%d/%d passed' % (sum(res), len(res)))
raise SystemExit(0 if all(res) else 1)
