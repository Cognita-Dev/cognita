# QA: a reply whose UI blocks use flat props + "$1,000-$1,300" in the text, at phone width (MOCKED SSE).
# Run: PORT=8801 node tests/stream-ui-server.mjs &   then   python3 tests/qa-flat-ui.e2e.py
import json, os, sys, urllib.request
from playwright.sync_api import sync_playwright
BASE = os.environ.get('BASE', 'http://localhost:8801')
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
flat = [
  {'id': 'c1', 'type': 'callout', 'variant': 'warning', 'title': 'Legal', 'content': 'Check local rules.'},
  {'id': 't1', 'type': 'table', 'title': 'Budget', 'columns': ['Item', 'Cost'], 'rows': [['Flour', '$200'], ['Boxes', '$150']]},
  {'id': 'b1', 'type': 'bar_chart', 'title': 'Spend', 'labels': ['Flour', 'Boxes'], 'values': [200, 150]},
  {'id': 'f1', 'type': 'form', 'title': 'Orders', 'fields': [{'name': 'name', 'label': 'Name', 'type': 'text', 'required': True}], 'submitLabel': 'Send'},
]
reply = "I'll plan it.\n\nBudget is roughly $1,000-$1,300 monthly, or maybe $5 and $10 per box."
steps = [{'event': 'text', 'data': {'t': "I'll plan it."}}, {'event': 'ui', 'data': {'ui': [], 'patches': [], 'pending': ['callout', 'table', 'bar_chart']}}, {'wait': 400},
         {'event': 'text', 'data': {'t': '\n\nBudget is roughly $1,000-$1,300 monthly, or maybe $5 and $10 per box.'}}, {'wait': 300},
         {'event': 'done', 'data': {'reply': reply, 'ui': flat, 'uiPatches': []}}]
with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 375, 'height': 800})
    ctx.route('**/js/auth.js', lambda r: r.fulfill(status=200, content_type='text/javascript', body=AUTH_STUB))
    ctx.route(lambda u: not u.startswith(BASE) and not u.startswith('data:') and not u.startswith('blob:'), lambda r: r.abort())
    page = ctx.new_page(); errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.goto(BASE + '/app.html'); page.wait_for_selector('#composerInput')
    urllib.request.urlopen(urllib.request.Request(BASE + '/__script', data=json.dumps(steps).encode(), method='POST'))
    page.fill('#composerInput', 'bakery'); page.click('#sendBtn')
    page.wait_for_function("!document.querySelector('.message.is-streaming') && !document.querySelector('.live-stream-text')", timeout=30000)
    page.wait_for_timeout(1500)
    n = page.evaluate("document.querySelectorAll('#messageList [data-cui-root] .cui-node').length")
    check('final UI shows all 4 flat-prop components', n == 4, n)
    check('no skeleton left behind', page.evaluate("document.querySelectorAll('.cui-skel').length") == 0)
    txt = page.evaluate("(() => { const m = document.querySelectorAll('#messageList .message.is-assistant'); return m[m.length-1].querySelector('.message-content').innerText; })()")
    check('money text is plain text, intact', '$1,000-$1,300' in txt and '$5 and $10' in txt, txt)
    check('no math element made from currency', page.evaluate("document.querySelectorAll('#messageList .katex').length") == 0)
    check('no horizontal overflow at 375px', page.evaluate("document.documentElement.scrollWidth <= 376"), page.evaluate("document.documentElement.scrollWidth"))
    page.screenshot(path=os.path.join(os.environ.get('SHOTS', '/tmp'), 'qa-flat-ui.png'), full_page=True)
    check('no JS errors', not errs, errs)
    b.close()
print('%d/%d passed' % (sum(res), len(res))); sys.exit(0 if all(res) else 1)
