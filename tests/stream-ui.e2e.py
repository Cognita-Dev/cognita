# Browser checks for the live chat stream: typewriter reveal, text_reset, progressive Generative UI.
# Real Chromium + the real front end (app.html, js/app.js, js/ui-render.js). The SSE stream is a MOCK
# (tests/stream-ui-server.mjs), so these results say nothing about a real AI provider.
# Run:  PORT=8801 node tests/stream-ui-server.mjs &   then   python3 tests/stream-ui.e2e.py
import json, os, sys, time, urllib.request
from playwright.sync_api import sync_playwright

BASE = os.environ.get('BASE', 'http://localhost:8801')
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

# Samples what the person can see in the newest assistant message every 20 ms.
SAMPLER = """
window.__s = []; window.__t0 = performance.now();
setInterval(() => {
  const msgs = document.querySelectorAll('#messageList .message.is-assistant');
  const m = msgs[msgs.length - 1];
  const live = document.querySelector('.live-stream-text');
  const body = m ? m.querySelector('.message-content') : null;
  const txt = live ? live.innerText : (body ? body.innerText : '');
  window.__s.push({ t: Math.round(performance.now() - window.__t0), n: txt.length, txt: txt,
    cui: document.querySelectorAll('.cui-node:not(.cui-skel)').length, skel: document.querySelectorAll('.cui-skel').length,
    live: !!live, liveUi: !!document.querySelector('[data-cui-live]') });
}, 20);
"""

def set_script(steps):
    urllib.request.urlopen(urllib.request.Request(BASE + '/__script', data=json.dumps(steps).encode(), method='POST'))

def check(name, ok, detail=''):
    results.append((name, bool(ok), detail))
    print(('PASS ' if ok else 'FAIL ') + name + ((' :: ' + str(detail)) if detail and not ok else ''))

def run(page, steps, prompt='hi', settle=600):
    set_script(steps)
    page.evaluate('window.__s = []; window.__t0 = performance.now();')
    page.fill('#composerInput', prompt)
    page.click('#sendBtn')
    total = sum(s.get('wait', 0) for s in steps)
    page.wait_for_timeout(total + settle)
    # wait for the reveal to finish
    page.wait_for_function("!document.querySelector('.message.is-streaming') && !document.querySelector('.live-stream-text')", timeout=30000)
    page.wait_for_timeout(300)
    return page.evaluate('window.__s')

def chunks(text, size):
    return [text[i:i + size] for i in range(0, len(text), size)]

def text_script(parts, gap, reply, extra_done=None):
    steps = []
    for p in parts:
        steps.append({'event': 'text', 'data': {'t': p}}); steps.append({'wait': gap})
    done = {'reply': reply, 'ui': [], 'uiPatches': []}
    done.update(extra_done or {})
    steps.append({'event': 'done', 'data': done})
    return steps

def last_text(page):
    return page.evaluate("(() => { const m = document.querySelectorAll('#messageList .message.is-assistant'); const x = m[m.length-1]; const c = x && x.querySelector('.message-content'); return c ? c.innerText : ''; })()")

def main():
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={'width': 1100, 'height': 900})
        ctx.route('**/js/auth.js', lambda r: r.fulfill(status=200, content_type='text/javascript', body=AUTH_STUB))
        ctx.route(lambda url: not url.startswith(BASE) and not url.startswith('data:') and not url.startswith('blob:'), lambda r: r.abort())
        ctx.add_init_script(SAMPLER)
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('console', lambda m: errors.append(m.text) if m.type == 'error' and 'Failed to load resource' not in m.text and 'pwa' not in m.text and 'scope' not in m.text else None)
        page.goto(BASE + '/app.html')
        page.wait_for_selector('#composerInput')
        page.wait_for_timeout(500)

        # 1. Long reply arriving in a few big, delayed chunks: must be revealed gradually, not pasted in.
        reply = ' '.join('Sentence number %d is here to read.' % i for i in range(1, 17))
        s = run(page, text_script(chunks(reply, 150), 400, reply), 'long')
        first = next((x for x in s if x['n'] > 0), None)
        done_t = s[-1]['t']
        jumps = [s[i]['n'] - s[i - 1]['n'] for i in range(1, len(s))]
        check('1a text visible before the response is complete', first is not None and first['t'] < 1200, first and first['t'])
        check('1b text is revealed gradually (no chunk-sized jumps)', max(jumps or [0]) < 60, max(jumps or [0]))
        check('1c final text equals reply exactly (no duplication/loss)', last_text(page).replace('\n', ' ').split() == reply.split(), last_text(page)[:120])

        # 1d. Hand-over: when `done` arrives the visible text must never shrink or restart (no replay, no blank flash).
        drops = [s[i]['n'] - s[i - 1]['n'] for i in range(1, len(s)) if s[i]['n'] < s[i - 1]['n'] - 2]
        check('1d visible text never shrinks/restarts at hand-over', not drops, drops[:3])
        check('1e reveal finishes cleanly (no animation left running)', page.evaluate("!document.querySelector('.message.is-streaming') && !document.querySelector('.is-typing')"))

        # 2. Short, fast reply.
        s = run(page, text_script(['Hello there, ', 'friend.'], 20, 'Hello there, friend.'), 'short')
        check('2 short reply ends exactly once', last_text(page).strip() == 'Hello there, friend.', last_text(page))

        # 3. Tool-call preamble then text_reset: no stale text, final answer only.
        steps = [{'event': 'text', 'data': {'t': 'Let me look that up for you.'}}, {'wait': 150}, {'event': 'text_reset', 'data': {}},
                 {'wait': 200}, {'event': 'text', 'data': {'t': 'The answer is 42.'}}, {'wait': 300},
                 {'event': 'done', 'data': {'reply': 'The answer is 42.', 'ui': [], 'uiPatches': []}}]
        s = run(page, steps, 'tool')
        seen_preamble = max((len(x['txt']) for x in s if 'Let me' in x['txt']), default=0)
        check('3a final text is only the final answer', last_text(page).strip() == 'The answer is 42.', last_text(page))
        check('3b no live text left behind', not s[-1]['live'])
        check('3c preamble never fully shown', seen_preamble < len('Let me look that up for you.'), seen_preamble)

        # 4. Generative UI: progressive card + table + multi-component, then done.
        card = {'id': 'c1', 'type': 'card', 'props': {'title': 'Summary', 'description': 'Hello card'}}
        table = {'id': 't1', 'type': 'table', 'props': {'title': 'Sales', 'columns': ['A', 'B'], 'rows': [['1', '2'], ['3', '4']]}}
        steps = [{'event': 'ui', 'data': {'ui': [], 'patches': [], 'pending': ['card']}}, {'wait': 300},
                 {'event': 'ui', 'data': {'ui': [card], 'patches': [], 'pending': ['table']}}, {'wait': 300},
                 {'event': 'ui', 'data': {'ui': [card, table], 'patches': [], 'pending': []}}, {'wait': 300},
                 {'event': 'text', 'data': {'t': 'Here is the summary and the table.'}}, {'wait': 300},
                 {'event': 'done', 'data': {'reply': 'Here is the summary and the table.', 'ui': [card, table], 'uiPatches': []}}]
        s = run(page, steps, 'ui')
        mid = [x for x in s if x['liveUi'] and x['cui'] >= 1]
        check('4a components render progressively before done', len(mid) > 3 and mid[0]['t'] < 900, mid[0]['t'] if mid else None)
        final_cui = page.evaluate("document.querySelectorAll('#messageList [data-cui-root] .cui-node').length")
        check('4b final UI has exactly the two components', final_cui == 2, final_cui)
        # no disappearing component between the first full render and the end
        full = [x for x in s if x['cui'] >= 2]
        gaps = [x for x in s[s.index(full[0]):] if x['cui'] < 2] if full else s
        check('4c components do not disappear/flicker at hand-over', not gaps, len(gaps))
        check('4d no raw markup leaked into text', 'cognita-ui' not in last_text(page) and '{' not in last_text(page), last_text(page))

        # 5. Unicode, newlines, markdown and code blocks arriving split across chunks.
        md = 'Café ☕ \U0001F600 done.\n\n- one\n- two\n\n```js\nconst a = 1;\n```\n\nThe end.'
        s = run(page, text_script(chunks(md, 7), 60, md), 'md')
        txt = last_text(page)
        check('5a unicode/emoji intact', 'Café ☕ \U0001F600 done.' in txt, txt[:60])
        check('5b code block rendered, text complete', page.evaluate("!!document.querySelector('#messageList .message.is-assistant:last-child pre, #messageList .message.is-assistant:last-child .code-block-wrap')") and 'The end.' in txt)

        # 6. Error mid-stream leaves no stale live content.
        set_script([{'event': 'text', 'data': {'t': 'Partial answer that will fail'}}, {'wait': 300}, {'event': 'error', 'data': {'message': 'Boom', 'status': 500}}])
        page.fill('#composerInput', 'err'); page.click('#sendBtn'); page.wait_for_timeout(1500)
        check('6 error clears live preview', page.evaluate("!document.querySelector('.live-stream-text') && !document.querySelector('[data-cui-live]')"))
        page.wait_for_timeout(500)

        check('7 no JavaScript errors', not errors, errors[:3])
        b.close()
    failed = [r for r in results if not r[1]]
    print('\n%d passed, %d failed' % (len(results) - len(failed), len(failed)))
    sys.exit(1 if failed else 0)

main()
