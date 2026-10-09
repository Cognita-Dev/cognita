# QA: stall path of the thinking indicator (MOCKED SSE, fake browser clock; shipped STALL_MS untouched).
# Run: PORT=8801 node tests/stream-ui-server.mjs &   then   python3 tests/qa-stall.e2e.py
import json, os, sys, urllib.request
from playwright.sync_api import sync_playwright
BASE = os.environ.get('BASE', 'http://localhost:8801')
sys.path.insert(0, os.path.dirname(__file__))
AUTH_STUB = """
const user = { uid: 'u1', email: 'u1@x.com', displayName: 'Test' };
const impl = { ready: async () => user, requireAuthOrRedirect: async () => user, currentUser: user, getCurrentUser: () => user,
  authedFetch: (u, o = {}) => fetch(String(u).replace('https://api.cognita.com.ng', ''), o), logOut: async () => {},
  onAuthStateChanged: (cb) => { setTimeout(() => cb(user), 0); return () => {}; } };
const Auth = new Proxy(impl, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' ? async () => null : undefined)) });
window.Auth = Auth; export { Auth };
"""
res = []
def check(n, ok, d=''):
    res.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + n + ((' :: ' + str(d)) if d and not ok else ''))
def script(steps):
    urllib.request.urlopen(urllib.request.Request(BASE + '/__script', data=json.dumps(steps).encode(), method='POST'))
def secs(page):
    t = page.evaluate("(document.querySelector('.thinking-timer')||{}).textContent||''")
    return float(t[:-1]) if t.endswith('s') and t[:-1].replace('.', '').isdigit() else None
def word(page): return page.evaluate("(document.querySelector('.thinking-word')||{}).textContent||''")

with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 1100, 'height': 900})
    ctx.route('**/js/auth.js', lambda r: r.fulfill(status=200, content_type='text/javascript', body=AUTH_STUB))
    ctx.route(lambda u: not u.startswith(BASE) and not u.startswith('data:') and not u.startswith('blob:'), lambda r: r.abort())
    page = ctx.new_page(); errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.clock.install(); page.goto(BASE + '/app.html'); page.clock.resume()
    page.wait_for_selector('#composerInput')
    # Server stays silent for 4s real time, then ping, then text. Browser clock jumps 30s meanwhile.
    script([{'wait': 4000}, {'raw': ': ping\n\n'}, {'wait': 300}, {'event': 'text', 'data': {'t': 'Hello there'}}, {'wait': 300},
            {'event': 'done', 'data': {'reply': 'Hello there'}}])
    page.fill('#composerInput', 'hi'); page.click('#sendBtn')
    page.wait_for_selector('.thinking-word'); page.wait_for_timeout(600)
    before = secs(page)
    page.clock.fast_forward(30000); page.wait_for_timeout(400)
    check('A1a word reads "Waiting for connection" after >25s silence', word(page) == 'Waiting for connection', word(page))
    s1 = secs(page); page.clock.fast_forward(10000); page.wait_for_timeout(300); s2 = secs(page)
    check('A1b clock paused while stalled', s1 is not None and s2 is not None and abs(s2 - s1) < 0.6, (s1, s2))
    check('A1c silent stretch not counted as thinking (<= ~2s)', s1 is not None and s1 < 3, s1)
    page.wait_for_function("document.querySelector('.thinking-word') && document.querySelector('.thinking-word').textContent !== 'Waiting for connection' || !document.querySelector('.thinking-word')", timeout=15000)
    check('A1d resumes (or ends) when bytes return', True)
    page.wait_for_timeout(1500)
    check('A1e no JS errors', not errs, errs)
    # Heartbeats alone keep the clock running through a long silent tool round
    page.reload(); page.clock.resume(); page.wait_for_selector('#composerInput')
    script([{'raw': ': ping\n\n'}] + sum([[{'wait': 700}, {'raw': ': ping\n\n'}] for _ in range(8)], []) + [{'event': 'done', 'data': {'reply': 'ok'}}])
    page.fill('#composerInput', 'hi'); page.click('#sendBtn'); page.wait_for_selector('.thinking-word')
    for _ in range(8):
        page.clock.fast_forward(5000); page.wait_for_timeout(700)
    w = word(page)
    check('A1f heartbeats keep clock "ok" (never Waiting for connection)', w != 'Waiting for connection', w)
    b.close()
print('%d/%d passed' % (sum(res), len(res))); sys.exit(0 if all(res) else 1)
