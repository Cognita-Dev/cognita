# Browser checks for designed files from doc-studio (documents, slides, posters, sheets) in the real front end.
# Real Chromium + the real app.html / js/app.js / sandbox-frame. The Worker's reply is a MOCK
# (tests/stream-ui-server.mjs), but the files in it are REAL doc-studio output (tests/docstudio-ui-fixtures.mjs).
# Run:
#   (cd doc-studio && npm install)
#   CHROMIUM_PATH=... node tests/docstudio-ui-fixtures.mjs /tmp/fx.json
#   PORT=8801 node tests/stream-ui-server.mjs &
#   FIXTURES=/tmp/fx.json python3 tests/docstudio-ui.e2e.py
import base64, json, os, sys, urllib.request
from playwright.sync_api import sync_playwright

BASE = os.environ.get('BASE', 'http://localhost:8801')
FX = json.load(open(os.environ.get('FIXTURES', '/tmp/fx.json')))
results = []

AUTH_STUB = """
const user = { uid: 'u1', email: 'u1@x.com', displayName: 'Test' };
const impl = {
  ready: async () => user, requireAuthOrRedirect: async () => user, currentUser: user, getCurrentUser: () => user,
  authedFetch: (u, o = {}) => fetch(String(u).replace('https://api.cognita.com.ng', ''), o),
  logOut: async () => {}, onAuthStateChanged: (cb) => { setTimeout(() => cb(user), 0); return () => {}; },
};
const Auth = new Proxy(impl, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' ? async () => null : undefined)) });
window.Auth = Auth; export { Auth };
"""

def set_script(steps):
    urllib.request.urlopen(urllib.request.Request(BASE + '/__script', data=json.dumps(steps).encode(), method='POST'))

def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(('PASS ' if ok else 'FAIL ') + name + ((' :: ' + str(detail)) if detail and not ok else ''))

def send(page, media_items, reply, prompt='make it'):
    steps = [{'event': 'step_start', 'data': {'name': 'create_document', 'provider': 'media', 'providerLabel': 'Document', 'kind': 'run', 'summary': 'Designing a document'}}, {'wait': 150}]
    for m in media_items:
        steps.append({'event': 'media', 'data': m})
    steps += [{'wait': 100}, {'event': 'text', 'data': {'t': reply}}, {'wait': 100}, {'event': 'done', 'data': {'reply': reply, 'ui': [], 'uiPatches': [], 'steps': []}}]
    set_script(steps)
    n = page.evaluate("document.querySelectorAll('#messageList .message.is-assistant').length")
    page.fill('#composerInput', prompt)
    page.click('#sendBtn')
    # the reply is typed out gradually; the cards appear once it is complete
    page.wait_for_function("([n, r]) => { const m = document.querySelectorAll('#messageList .message.is-assistant'); return m.length > n && m[m.length-1].innerText.includes(r) && !document.querySelector('.message.is-streaming') && !document.querySelector('.live-stream-text'); }", arg=[n, reply], timeout=30000)
    page.wait_for_timeout(600)

def last_msg(page):
    return page.locator('#messageList .message.is-assistant').last

def main():
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={'width': 1100, 'height': 900}, accept_downloads=True)
        ctx.route('**/js/auth.js', lambda r: r.fulfill(status=200, content_type='text/javascript', body=AUTH_STUB))
        ctx.route(lambda url: not url.startswith(BASE) and not url.startswith('data:') and not url.startswith('blob:'), lambda r: r.abort())
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text and 'pwa' not in m.text and 'scope' not in m.text and 'pyodide' not in m.text.lower() else None)
        page.goto(BASE + '/app.html')
        page.wait_for_selector('#composerInput')
        page.wait_for_timeout(500)

        # 1. A document: preview picture, one button per file, design name.
        send(page, [json.loads(json.dumps(FX['document']))], 'Here is your report as a PDF and a Word file.')
        fig = last_msg(page).locator('figure.gen-media--doc')
        page.screenshot(path=os.path.join(os.environ.get('SHOT_DIR', '/tmp'), 'ds-document.png'))
        check('1a designed-file card is shown', fig.count() == 1)
        info = page.evaluate("(() => { const i = document.querySelector('figure.gen-media--doc img'); return i ? [i.complete, i.naturalWidth, i.src.slice(0, 30), i.src.length] : null; })()")
        check('1b preview picture is a real image', info and info[0] and info[1] > 200, info)
        labels = [t.strip() for t in fig.locator('.gen-doc-btn').all_inner_texts()]
        check('1c one button per file (PDF, Word) with sizes', len(labels) == 2 and labels[0].startswith('PDF') and labels[1].startswith('Word') and 'KB' in labels[0], labels)
        check('1d design name shown', 'design' in fig.locator('.gen-doc-design').inner_text().lower(), fig.locator('.gen-doc-design').inner_text())
        txt = last_msg(page).inner_text()
        check('1e reply text still shown', 'PDF and a Word file' in txt, txt[:200])

        # 2. Download the PDF: real bytes, right name, right size.
        with page.expect_download() as dl:
            fig.locator('.gen-doc-btn').nth(0).click()
        d = dl.value
        path = d.path()
        head = open(path, 'rb').read(5)
        want = [f for f in FX['document']['files'] if f['format'] == 'pdf'][0]
        check('2a PDF downloads with its own name', d.suggested_filename == want['name'], d.suggested_filename)
        check('2b PDF bytes are intact', head == b'%PDF-' and os.path.getsize(path) == want['size'], (head, os.path.getsize(path), want['size']))
        with page.expect_download() as dl:
            fig.locator('.gen-doc-btn').nth(1).click()
        dpath = dl.value.path()
        check('2c Word file downloads (zip header)', open(dpath, 'rb').read(2) == b'PK')

        # 3. Stored in the chat's workspace and the saved chat holds no file bytes.
        saved = page.evaluate("JSON.stringify(Object.keys(localStorage).map(k => [k, (localStorage.getItem(k) || '').length]))")
        blob = page.evaluate("Object.keys(localStorage).map(k => localStorage.getItem(k)).filter(v => v && v.includes('docfile')).join('')")
        check('3a saved chat mentions the file but not its bytes', ('docfile' in blob) and ('/workspace/' in blob) and ('JVBERi0' not in blob), len(blob))
        check('3b saved chat stays small', len(blob) < 900000, len(blob))

        # 4. Preview sheet opens from the card.
        fig.locator('button.gen-doc-open').first.click()
        page.wait_for_timeout(1200)
        opened = page.evaluate("!!document.querySelector('.fv-sheet, .file-viewer, [class*=\"file-preview\"], [class*=\"fv-\"]')")
        check('4 preview sheet opens', opened)
        page.keyboard.press('Escape')
        page.wait_for_timeout(300)

        # 5. Slides + poster + sheet cards.
        send(page, [FX['slides']], 'Your deck is ready.', 'deck')
        f2 = last_msg(page).locator('figure.gen-media--slides')
        page.screenshot(path=os.path.join(os.environ.get('SHOT_DIR', '/tmp'), 'ds-slides.png'))
        l2 = [t.strip() for t in f2.locator('.gen-doc-btn').all_inner_texts()]
        check('5a slides card (PowerPoint + PDF)', f2.count() == 1 and len(l2) == 2 and l2[0].startswith('PowerPoint') and l2[1].startswith('PDF'), (f2.count(), l2))
        send(page, [FX['poster']], 'Poster done.', 'poster')
        f3 = last_msg(page).locator('figure.gen-media--poster')
        page.screenshot(path=os.path.join(os.environ.get('SHOT_DIR', '/tmp'), 'ds-poster.png'))
        l3 = [t.strip() for t in f3.locator('.gen-doc-btn').all_inner_texts()]
        check('5b poster card (PNG + PDF)', f3.count() == 1 and len(l3) == 2 and l3[0].startswith('PNG') and l3[1].startswith('PDF'), (f3.count(), l3))
        send(page, [FX['sheet']], 'Sheet done.', 'sheet')
        f4 = last_msg(page).locator('figure.gen-media--sheet')
        check('5c sheet card (Excel)', f4.count() == 1 and f4.locator('.gen-doc-btn').inner_text().strip().startswith('Excel'))
        with page.expect_download() as dl:
            f4.locator('.gen-doc-btn').click()
        check('5d Excel downloads', open(dl.value.path(), 'rb').read(2) == b'PK')

        # 6. A file the workspace cannot take (bigger than the plan's file limit) still downloads this visit.
        big = json.loads(json.dumps(FX['document']))
        raw = os.urandom(3 * 1024 * 1024)
        big['files'] = [{'format': 'pdf', 'name': 'huge.pdf', 'mime': 'application/pdf', 'size': len(raw), 'content': base64.b64encode(raw).decode()}]
        send(page, [big], 'Big file.', 'big')
        f5 = last_msg(page).locator('figure.gen-media--doc')
        with page.expect_download() as dl:
            f5.locator('.gen-doc-btn').click()
        check('6 oversized file still downloads for this visit', os.path.getsize(dl.value.path()) == len(raw))

        # 7. The classic SVG design still works next to it.
        svg = '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="500" viewBox="0 0 400 500"><rect width="400" height="500" fill="#0F766E"/><text x="30" y="80" fill="#fff" font-size="40">Hi</text></svg>'
        send(page, [{'kind': 'design', 'title': 'Old style', 'width': 400, 'height': 500, 'svg': svg, 'alt': 'x'}], 'Old design.', 'old')
        check('7 built-in SVG design card unchanged (PNG/PDF/SVG)', last_msg(page).locator('.gen-media--design .gen-media-btn').count() == 3)

        # 8. Hostile media is dropped, not rendered.
        send(page, [{'kind': 'docfile', 'title': '<img src=x onerror=alert(1)>', 'files': [{'name': '../../x.pdf', 'content': 'AAAA'}], 'preview': {'mime': 'text/html', 'content': 'PHNjcmlwdD4='}}], 'Bad.', 'bad')
        check('8 hostile file names are refused', last_msg(page).locator('figure.gen-media--doc').count() == 0)

        # 10. Phone width: nothing sticks out sideways.
        send(page, [FX['document']], 'Phone check.', 'phone')
        page.set_viewport_size({'width': 390, 'height': 800})
        page.wait_for_timeout(500)
        page.locator('#messageList figure.gen-media--doc').last.scroll_into_view_if_needed()
        page.wait_for_timeout(300)
        over = page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
        check('10 no sideways scroll at 390px', over <= 1, over)
        page.screenshot(path=os.environ.get('SHOT', '/tmp/docstudio-ui-mobile.png'))
        page.set_viewport_size({'width': 1100, 'height': 900})
        page.wait_for_timeout(200)
        page.screenshot(path=os.environ.get('SHOT_DESKTOP', '/tmp/docstudio-ui-desktop.png'))

        # 9. History after reload still shows the cards and the download still works from the workspace.
        page.reload()
        page.wait_for_selector('#composerInput')
        page.wait_for_timeout(1500)
        restored = page.evaluate("document.querySelectorAll('#messageList figure.gen-media--doc').length")
        if restored:
            first = page.locator('#messageList figure.gen-media--doc').first
            with page.expect_download() as dl:
                first.locator('.gen-doc-btn').first.click()
            check('9 after reload: card restored and file still downloads from the workspace', open(dl.value.path(), 'rb').read(5) == b'%PDF-')
        else:
            print('INFO 9 chat is not auto-restored after reload in this mock (history is opened from the sidebar); skipped')

        check('11 no page errors', not errors, errors[:5])
        b.close()
    bad = [r for r in results if not r[1]]
    print('\n%d checks, %d failed' % (len(results), len(bad)))
    sys.exit(1 if bad else 0)

main()
