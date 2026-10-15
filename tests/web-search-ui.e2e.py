# Browser checks for how web searches look in the Activity list: globe icon, a row that opens into the
# sites it found, several searches grouped into one row, a failed search, and the "Sources" list under the answer.
# Real Chromium + the real front end; the SSE stream is a MOCK (tests/stream-ui-server.mjs).
# Run:  PORT=8801 node tests/stream-ui-server.mjs &   then   python3 tests/web-search-ui.e2e.py
import json, os, sys, urllib.request
from playwright.sync_api import sync_playwright

BASE = os.environ.get('BASE', 'http://localhost:8801')
SHOTS = os.environ.get('SHOTS')
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

# 1x1 transparent PNG, served for the favicon of one site so we can tell a loaded picture from a failed one
import base64
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR4nGOQS7lDEmIY1TCqYfhqAABUaV4QwoaE+QAAAABJRU5ErkJggg==')

def set_script(steps):
    urllib.request.urlopen(urllib.request.Request(BASE + '/__script', data=json.dumps(steps).encode(), method='POST'))

def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(('PASS ' if ok else 'FAIL ') + name + ((' :: ' + str(detail)) if detail and not ok else ''))

def send(page, prompt):
    page.fill('#composerInput', prompt)
    page.click('#sendBtn')

def wait_done(page, n):
    page.wait_for_function("(n) => document.querySelectorAll('#messageList .message.is-assistant').length >= n && !document.querySelector('.act.is-live')", arg=n, timeout=20000)
    page.wait_for_timeout(1200)

SRC_A = [
    {'title': 'Naira hits new low against the dollar', 'url': 'https://www.reuters.com/markets/naira'},
    {'title': 'CBN exchange rate update', 'url': 'https://cbn.gov.ng/rates'},
    {'title': 'Naira rate today', 'url': 'https://example.org/naira'},
]
SRC_B = [{'title': 'Bitcoin price', 'url': 'https://www.coindesk.com/price/bitcoin'}, {'title': 'CBN exchange rate update', 'url': 'https://cbn.gov.ng/rates'}]

def search_step(q, sources, ok=True, ms=1400):
    st = {'type': 'executed', 'name': 'web_search', 'provider': 'web', 'providerLabel': 'Web', 'kind': 'read', 'ms': ms, 'ok': ok,
          'summary': 'Searching the web for "' + q + '".', 'query': q}
    if ok and sources: st['sources'] = sources
    if not ok: st['reason'] = 'The search did not work.'
    return st

def last_msg(page):
    return '#messageList .message.is-assistant:last-child'

def main():
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={'width': 420, 'height': 900})
        ctx.route('**/js/auth.js', lambda r: r.fulfill(status=200, content_type='text/javascript', body=AUTH_STUB))
        # reuters gets a real (tiny) picture; every other favicon request fails, to prove the globe fallback
        PH = os.environ.get('PHOSPHOR_DIR')
        MIMES = {'.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml'}
        def other(route):
            u = route.request.url
            if PH and 'unpkg.com/@phosphor-icons/web' in u:
                f = os.path.join(PH, u.split('/regular/')[-1].split('?')[0])
                if os.path.exists(f):
                    route.fulfill(status=200, content_type=MIMES.get(os.path.splitext(f)[1], 'application/octet-stream'), body=open(f, 'rb').read(), headers={'access-control-allow-origin': '*'})
                    return
            if 'google.com/s2/favicons' in u and 'reuters.com' in u:
                route.fulfill(status=200, content_type='image/png', body=PNG)
            else:
                route.abort()
        ctx.route(lambda url: not url.startswith(BASE) and not url.startswith('data:') and not url.startswith('blob:'), other)
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(BASE + '/app.html')
        page.wait_for_selector('#composerInput')
        page.wait_for_timeout(500)

        # 1. One search: running row has a globe, finished row is past tense and opens into the sites.
        q1 = 'naira exchange rate today'
        s1 = search_step(q1, SRC_A)
        set_script([
            {'event': 'round', 'data': {'round': 0}}, {'wait': 100},
            {'event': 'step_start', 'data': {'name': 'web_search', 'provider': 'web', 'providerLabel': 'Web', 'kind': 'read', 'summary': s1['summary']}},
            {'wait': 1500},
            {'event': 'step', 'data': s1},
            {'event': 'round', 'data': {'round': 1}}, {'wait': 200},
            {'event': 'done', 'data': {'reply': 'The naira is trading near 1,600 per dollar [1] and the CBN rate is similar [2].', 'ui': [], 'uiPatches': [], 'steps': [s1], 'sources': SRC_A}},
        ])
        send(page, 'what is the naira rate today')
        page.wait_for_timeout(700)
        live = page.evaluate("""() => { const li = document.querySelector('.act .act-item'); return li ? { state: li.dataset.state, title: li.querySelector('.act-title').textContent, icon: li.querySelector('.act-node i').className } : null; }""")
        check('1a running search row uses the globe icon', live and live['state'] == 'running' and 'ph-globe' in live['icon'], live)
        wait_done(page, 1)
        m = last_msg(page)
        row = page.evaluate("""(m) => { const li = document.querySelector(m + ' .act-item'); return li ? { title: li.querySelector('.act-title').textContent, sub: li.querySelector('.act-sub').textContent,
            icon: li.querySelector('.act-node i').className, toggle: !!li.querySelector('button.act-toggle'), detailHidden: li.querySelector('.act-detail') ? li.querySelector('.act-detail').hidden : null } : null; }""", m)
        check('1b finished row is past tense with the Web label', row and row['title'] == 'Searched the web for "' + q1 + '".' and row['sub'] == 'Web', row)
        check('1c finished row keeps the globe icon', row and 'ph-globe' in row['icon'], row)
        check('1d row can be opened and starts closed', row and row['toggle'] and row['detailHidden'] is True, row)
        # open the activity, then the row
        if not page.evaluate("document.querySelector('%s .act').classList.contains('is-open')" % m):
            page.click(m + ' .act-head')
        page.click(m + ' .act-item button.act-toggle')
        page.wait_for_timeout(300)
        srcs = page.evaluate("""(m) => [...document.querySelectorAll(m + ' .act-item .act-src')].map((a) => ({ href: a.href, title: a.querySelector('.act-src-title').textContent,
            host: a.querySelector('.act-src-host').textContent, target: a.target, rel: a.rel, img: !!a.querySelector('img') }))""", m)
        check('1e opened row lists all 3 sites with links', len(srcs) == 3 and srcs[0]['href'] == 'https://www.reuters.com/markets/naira' and srcs[0]['title'].startswith('Naira hits'), srcs)
        check('1f host shown without www', srcs and srcs[0]['host'] == 'reuters.com' and srcs[1]['host'] == 'cbn.gov.ng', srcs)
        check('1g links open in a new tab safely', srcs and all(s['target'] == '_blank' and 'noopener' in s['rel'] for s in srcs), srcs)
        imgs = page.evaluate("(m) => [...document.querySelectorAll(m + ' .act-src')].map((a) => !!a.querySelector('img.act-src-img'))", m)
        check('1h picture that failed to load is removed (globe stays), loaded one is kept', imgs == [True, False, False], imgs)
        if SHOTS: page.screenshot(path=os.path.join(SHOTS, 'single-open.png'))
        # Sources strip under the answer + [1] citation link
        strip = page.evaluate("""(m) => { const s = document.querySelector(m + ' .message-sources'); return s ? [...s.querySelectorAll('li a')].map((a) => a.textContent) : null; }""", m)
        check('1i "Sources" list shows under the answer', strip and len(strip) == 3 and strip[0].startswith('Naira hits'), strip)
        cites = page.evaluate("(m) => [...document.querySelectorAll(m + ' .citation-marker')].map((a) => a.href)", m)
        check('1j [1] and [2] in the answer become links to the right sites', cites == ['https://www.reuters.com/markets/naira', 'https://cbn.gov.ng/rates'], cites)

        # 2. Two searches in a row: one grouped row.
        q2, q3 = 'naira exchange rate today', 'bitcoin price'
        a, c = search_step(q2, SRC_A, ms=1200), search_step(q3, SRC_B, ms=800)
        set_script([
            {'event': 'step_start', 'data': {'name': 'web_search', 'provider': 'web', 'providerLabel': 'Web', 'kind': 'read', 'summary': a['summary']}}, {'wait': 200}, {'event': 'step', 'data': a},
            {'event': 'step_start', 'data': {'name': 'web_search', 'provider': 'web', 'providerLabel': 'Web', 'kind': 'read', 'summary': c['summary']}}, {'wait': 200}, {'event': 'step', 'data': c},
            {'event': 'done', 'data': {'reply': 'Here is what I found.', 'ui': [], 'uiPatches': [], 'steps': [a, c], 'sources': SRC_A + SRC_B[:1]}},
        ])
        send(page, 'and bitcoin too')
        wait_done(page, 2)
        m = last_msg(page)
        if not page.evaluate("document.querySelector('%s .act').classList.contains('is-open')" % m):
            page.click(m + ' .act-head')
        g = page.evaluate("""(m) => [...document.querySelectorAll(m + ' .act-item')].map((li) => ({ title: li.querySelector('.act-title').textContent, sub: li.querySelector('.act-sub').textContent,
            ms: li.querySelector('.act-ms').textContent, icon: li.querySelector('.act-node i').className }))""", m)
        check('2a two searches collapse into ONE row', len(g) == 1, g)
        check('2b grouped row reads "Searched the web" / "2 searches"', g and g[0]['title'] == 'Searched the web' and g[0]['sub'] == '2 searches', g)
        check('2c grouped row is not called "Read 2 items" and has a globe', g and 'Read' not in g[0]['title'] and 'ph-globe' in g[0]['icon'], g)
        check('2d grouped row adds up the time', g and g[0]['ms'] == '2.0s', g)
        page.click(m + ' .act-item button.act-toggle')
        page.wait_for_timeout(300)
        det = page.evaluate("""(m) => ({ qs: [...document.querySelectorAll(m + ' .act-search-q')].map((e) => e.textContent), n: document.querySelectorAll(m + ' .act-search .act-src').length })""", m)
        check('2e opened group shows each question and its sites', det['qs'] == [q2, q3] and det['n'] == 5, det)
        if SHOTS: page.screenshot(path=os.path.join(SHOTS, 'group-open.png'))

        # 3. A failed search: red Failed row, with the reason, nothing to open.
        f = search_step('weather lagos', None, ok=False, ms=300)
        set_script([
            {'event': 'step_start', 'data': {'name': 'web_search', 'provider': 'web', 'providerLabel': 'Web', 'kind': 'read', 'summary': f['summary']}}, {'wait': 200}, {'event': 'step', 'data': f},
            {'event': 'done', 'data': {'reply': 'I could not search just now.', 'ui': [], 'uiPatches': [], 'steps': [f]}},
        ])
        send(page, 'weather')
        wait_done(page, 3)
        m = last_msg(page)
        fr = page.evaluate("""(m) => { const li = document.querySelector(m + ' .act-item'); return li ? { state: li.dataset.state, title: li.querySelector('.act-title').textContent,
            note: (li.querySelector('.act-note') || {}).textContent || '', toggle: !!li.querySelector('button.act-toggle'), open: document.querySelector(m + ' .act').classList.contains('is-open'),
            strip: !!document.querySelector(m + ' .message-sources') } : null; }""", m)
        check('3a failed search shows a Failed row with the reason', fr and fr['state'] == 'fail' and 'did not work' in fr['note'], fr)
        check('3b failed row stays "Searching…" wording, is not expandable, timeline opens', fr and fr['title'].startswith('Searching the web') and not fr['toggle'] and fr['open'], fr)
        check('3c no Sources list when nothing was found', fr and not fr['strip'], fr)

        # 4. Chats saved BEFORE this change: no sources/query fields. Still render, as a plain row.
        old = {'type': 'executed', 'name': 'web_search', 'provider': 'web', 'providerLabel': 'Web', 'kind': 'read', 'ms': 900, 'ok': True, 'summary': 'Searching the web for "old chat".'}
        old2 = dict(old, summary='Searching the web for "second".')
        set_script([{'event': 'done', 'data': {'reply': 'Old style.', 'ui': [], 'uiPatches': [], 'steps': [old, old2]}}])
        send(page, 'old')
        wait_done(page, 4)
        m = last_msg(page)
        if not page.evaluate("document.querySelector('%s .act').classList.contains('is-open')" % m):
            page.click(m + ' .act-head')
        og = page.evaluate("""(m) => ({ rows: document.querySelectorAll(m + ' .act-item').length, title: document.querySelector(m + ' .act-title').textContent, sub: document.querySelector(m + ' .act-sub').textContent })""", m)
        check('4a old saved searches still group', og['rows'] == 1 and og['title'] == 'Searched the web' and og['sub'] == '2 searches', og)
        page.click(m + ' .act-item button.act-toggle')
        qs = page.evaluate("(m) => [...document.querySelectorAll(m + ' .act-search-q')].map((e) => e.textContent)", m)
        check('4b the question is recovered from the old sentence', qs == ['old chat', 'second'], qs)

        # 5. Sources list is built from the steps when the server sent none (e.g. after a paused code run)
        set_script([{'event': 'done', 'data': {'reply': 'From steps.', 'ui': [], 'uiPatches': [], 'steps': [search_step('x', SRC_B)]}}])
        send(page, 'steps only')
        wait_done(page, 5)
        strip = page.evaluate("(m) => { const s = document.querySelector(m + ' .message-sources'); return s ? s.querySelectorAll('li').length : null; }", last_msg(page))
        check('5 Sources list falls back to the sites in the search steps', strip == 2, strip)

        # 6. a non-https or junk address is never turned into a link
        bad = [{'title': 'bad', 'url': 'javascript:alert(1)'}, {'title': 'http', 'url': 'http://insecure.example.com'}, {'title': '<img src=x onerror=alert(1)>', 'url': 'https://ok.example.com/a?b=1&c=2'}]
        set_script([{'event': 'done', 'data': {'reply': 'Safe.', 'ui': [], 'uiPatches': [], 'steps': [search_step('safe', bad)]}}])
        send(page, 'safe')
        wait_done(page, 6)
        m = last_msg(page)
        if not page.evaluate("document.querySelector('%s .act').classList.contains('is-open')" % m):
            page.click(m + ' .act-head')
        page.click(m + ' .act-item button.act-toggle')
        safe = page.evaluate("(m) => ({ hrefs: [...document.querySelectorAll(m + ' .act-src')].map((a) => a.getAttribute('href')), imgs: document.querySelectorAll(m + ' .act-src-title img').length })", m)
        check('6a only the https address becomes a link', safe['hrefs'] == ['https://ok.example.com/a?b=1&c=2'], safe)
        check('6b a title with HTML in it is shown as text, not run', safe['imgs'] == 0, safe)

        check('no page errors in the browser', not errors, errors)
        b.close()

    bad = [r for r in results if not r[1]]
    print('\n%d checks, %d failed' % (len(results), len(bad)))
    sys.exit(1 if bad else 0)

main()
