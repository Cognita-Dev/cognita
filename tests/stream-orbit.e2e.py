# Browser checks for the streaming orbit (the small orbiting mark under the newest text).
# Real Chromium + the real front end. The SSE stream is a MOCK (tests/stream-ui-server.mjs).
# Run:  PORT=8801 node tests/stream-ui-server.mjs &   then   python3 tests/stream-orbit.e2e.py
import json, os, urllib.request
from playwright.sync_api import sync_playwright

BASE = os.environ.get('BASE', 'http://localhost:8801')
OUT = os.environ.get('SHOTS', '/tmp/orbit-shots')
os.makedirs(OUT, exist_ok=True)
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

# (7 px of tolerance: a new message slides in by 6 px, see fadeInUp.)
# Every 20 ms: is the orbit visible, where is it, is it below the last message, how far has the ring turned.
SAMPLER = """
window.__s = []; window.__t0 = performance.now();
setInterval(() => {
  const o = document.getElementById('streamOrbit');
  const msgs = document.querySelectorAll('#messageList .message');
  const last = msgs[msgs.length - 1];
  const r = o ? o.getBoundingClientRect() : null;
  const lr = last ? last.getBoundingClientRect() : null;
  const ring = o ? o.querySelector('.so-ring-a') : null;
  window.__s.push({ t: Math.round(performance.now() - window.__t0),
    exists: !!o, shown: !!o && !o.hidden && r.height > 4, hidden: !o || o.hidden,
    top: r ? r.top : null, docTop: r ? r.top + document.getElementById('conversation').scrollTop : null, lb: lr ? lr.bottom : null, n: msgs.length, belowLast: r && lr ? r.top >= lr.bottom - 7 : null,
    tf: ring ? getComputedStyle(ring).transform : '' });
}, 20);
"""

def set_script(steps):
    urllib.request.urlopen(urllib.request.Request(BASE + '/__script', data=json.dumps(steps).encode(), method='POST'))

def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(('PASS ' if ok else 'FAIL ') + name + ((' :: ' + str(detail)) if detail and not ok else ''))

def run(page, steps, prompt='hi'):
    set_script(steps)
    page.evaluate('window.__s = []; window.__t0 = performance.now();')
    page.fill('#composerInput', prompt)
    page.click('#sendBtn')
    page.wait_for_timeout(sum(s.get('wait', 0) for s in steps) + 400)
    page.wait_for_function("!document.querySelector('.message.is-streaming') && !document.querySelector('.live-stream-text')", timeout=40000)
    page.wait_for_timeout(700)
    return page.evaluate('window.__s')

def text_script(parts, gap, reply):
    st = []
    for p in parts:
        st.append({'event': 'text', 'data': {'t': p}}); st.append({'wait': gap})
    st.append({'event': 'done', 'data': {'reply': reply, 'ui': [], 'uiPatches': []}})
    return st

def chunks(t, n): return [t[i:i + n] for i in range(0, len(t), n)]

def new_page(b, **kw):
    ctx = b.new_context(**kw)
    ctx.route('**/js/auth.js', lambda r: r.fulfill(status=200, content_type='text/javascript', body=AUTH_STUB))
    ctx.route(lambda url: not url.startswith(BASE) and not url.startswith('data:') and not url.startswith('blob:'), lambda r: r.abort())
    ctx.add_init_script(SAMPLER)
    page = ctx.new_page()
    errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.on('console', lambda m: errs.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text and 'pwa' not in m.text and 'scope' not in m.text else None)
    page.goto(BASE + '/app.html')
    page.wait_for_selector('#composerInput')
    page.wait_for_timeout(500)
    return ctx, page, errs

def main():
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx, page, errs = new_page(b, viewport={'width': 1100, 'height': 800})

        before = page.evaluate("(() => { const o = document.getElementById('streamOrbit'); return !o || o.hidden; })()")
        check('1 orbit is not on screen before any reply', before)

        # A long reply with a slow, uneven connection: bursts, then a 2.5 s stall in the middle.
        reply = ' '.join('Sentence number %d is here to read and it keeps going for a while.' % i for i in range(1, 40))
        parts = chunks(reply, 120)
        steps = []
        for i, c in enumerate(parts):
            steps.append({'event': 'text', 'data': {'t': c}})
            steps.append({'wait': 2500 if i == 6 else 180})
        steps.append({'event': 'done', 'data': {'reply': reply, 'ui': [], 'uiPatches': []}})
        set_script(steps)
        page.evaluate('window.__s = []; window.__t0 = performance.now();')
        page.fill('#composerInput', 'long one')
        page.click('#sendBtn')
        page.wait_for_timeout(1800)
        page.screenshot(path=OUT + '/1-streaming-desktop-dark.png')
        page.wait_for_timeout(sum(x.get('wait', 0) for x in steps))
        page.wait_for_function("!document.querySelector('.message.is-streaming') && !document.querySelector('.live-stream-text')", timeout=60000)
        page.wait_for_timeout(900)
        s = page.evaluate('window.__s')

        on = [x for x in s if x['shown']]
        check('2 orbit appears once text starts streaming', len(on) > 20, len(on))
        first_on = on[0]['t'] if on else None
        check('2b orbit shows early (within 1 s of send)', first_on is not None and first_on < 1000, first_on)
        check('3 orbit is always below the newest message', all(x['belowLast'] for x in on), [(x['t'],x['top'],x['lb'],x['n']) for x in on if not x['belowLast']][:6])
        tops = [x['docTop'] for x in on]
        check('4 orbit moves down the page as text grows (space is made)', max(tops) - min(tops) > 150, (min(tops), max(tops)))
        # 5. continuous: no blink between first show and the finish (hand-over live -> reveal)
        i0 = s.index(on[0]); i1 = max(i for i, x in enumerate(s) if x['shown'])
        blinks = [x for x in s[i0:i1 + 1] if not x['shown']]
        check('5 orbit never blinks off while the reply is arriving or being revealed', not blinks, len(blinks))
        # 6. stall: during the quiet gap the mark must still be on screen and still turning
        end_t = s[i1]['t']
        stall = [x for x in s[i0:i1 + 1] if x['shown']]
        tfs = len(set(x['tf'] for x in stall))
        check('6 orbit keeps turning (animation never freezes)', tfs > 30, tfs)
        check('7 orbit is gone once the reply is complete', s[-1]['hidden'], s[-1])
        check('7b exactly one orbit element in the page', page.evaluate("document.querySelectorAll('#streamOrbit').length") == 1)
        page.screenshot(path=OUT + '/2-finished-desktop.png')

        # 8. scroll-follow: the mark stays in view while the person reads at the bottom
        set_script(steps)
        page.fill('#composerInput', 'again'); page.click('#sendBtn')
        page.wait_for_timeout(5200)
        vis = page.evaluate("(() => { const o = document.getElementById('streamOrbit'); const r = o.getBoundingClientRect(); const c = document.getElementById('conversation').getBoundingClientRect(); return { top: r.top, bottom: r.bottom, cb: c.bottom, hidden: o.hidden }; })()")
        check('8 orbit stays inside the visible chat area while following', (not vis['hidden']) and vis['bottom'] <= vis['cb'] + 2, vis)
        page.screenshot(path=OUT + '/3-streaming-scrolled-follow.png')
        # 9. person scrolls up: orbit is allowed to leave the view, nothing yanks them back
        page.evaluate("document.getElementById('conversation').scrollTop = 0")
        page.mouse.move(500, 300); page.mouse.wheel(0, -200)
        page.wait_for_timeout(1500)
        st = page.evaluate("document.getElementById('conversation').scrollTop")
        check('9 reading older text is not interrupted by the orbit', st < 400, st)
        page.wait_for_function("!document.querySelector('.message.is-streaming') && !document.querySelector('.live-stream-text')", timeout=60000)
        page.wait_for_timeout(900)

        # 10. error mid-stream: orbit must go away
        err_steps = [{'event': 'text', 'data': {'t': 'Starting an answer that '}}, {'wait': 900}, {'event': 'error', 'data': {'message': 'boom'}}]
        set_script(err_steps)
        page.fill('#composerInput', 'err'); page.click('#sendBtn')
        page.wait_for_timeout(2500)
        gone = page.evaluate("(() => { const o = document.getElementById('streamOrbit'); return !o || o.hidden; })()")
        check('10 orbit goes away when the turn fails', gone)

        # 11. text_reset (tool lead-in): orbit hides with the discarded text, returns for the real answer
        steps = [{'event': 'text', 'data': {'t': 'Let me look that up for you.'}}, {'wait': 500}, {'event': 'text_reset', 'data': {}},
                 {'wait': 600}, {'event': 'text', 'data': {'t': 'The answer is 42.'}}, {'wait': 600},
                 {'event': 'done', 'data': {'reply': 'The answer is 42.', 'ui': [], 'uiPatches': []}}]
        s = run(page, steps, 'tool')
        check('11 after a tool lead-in the final reply still ends with the orbit gone', s[-1]['hidden'])

        # 12. short reply
        s = run(page, text_script(['Hello there, ', 'friend.'], 20, 'Hello there, friend.'), 'short')
        check('12 short reply: orbit gone at the end', s[-1]['hidden'])
        check('12b no JS errors', not errs, errs[:3])
        ctx.close()

        # Mobile, light theme
        ctx, page, errs = new_page(b, viewport={'width': 390, 'height': 780}, device_scale_factor=2, is_mobile=True, has_touch=True, color_scheme='light')
        parts2 = chunks(reply, 120); st2 = []
        for c in parts2:
            st2.append({'event': 'text', 'data': {'t': c}}); st2.append({'wait': 200})
        st2.append({'event': 'done', 'data': {'reply': reply, 'ui': [], 'uiPatches': []}})
        set_script(st2)
        page.fill('#composerInput', 'mobile long'); page.click('#sendBtn')
        page.wait_for_timeout(2600)
        page.screenshot(path=OUT + '/4-streaming-mobile-light.png')
        ok = page.evaluate("(() => { const o = document.getElementById('streamOrbit'); const r = o.getBoundingClientRect(); return !o.hidden && r.left >= 0 && r.right <= innerWidth; })()")
        check('13 mobile: orbit visible and inside the screen', ok)
        page.wait_for_function("!document.querySelector('.message.is-streaming') && !document.querySelector('.live-stream-text')", timeout=60000)
        ctx.close()

        # Reduced motion
        ctx, page, errs = new_page(b, viewport={'width': 1100, 'height': 800}, reduced_motion='reduce')
        set_script(st2)
        page.fill('#composerInput', 'rm'); page.click('#sendBtn')
        page.wait_for_timeout(1200)
        rm = page.evaluate("(() => { const o = document.getElementById('streamOrbit'); const a = getComputedStyle(document.querySelector('.so-ring-a')).animationName; return { shown: !!o && !o.hidden, spin: a }; })()")
        check('14 reduced motion: no spinning, mark still present', rm['spin'] == 'none', rm)
        ctx.close()
        b.close()
    bad = [r for r in results if not r[1]]
    print('\n%d/%d passed' % (len(results) - len(bad), len(results)))
    raise SystemExit(1 if bad else 0)

main()
