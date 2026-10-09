# Browser checks for the step timeline ("Activity"): live rows, per-tool icons, failures with a reason,
# a turn that errors after some steps ran, and the saved view after the turn ends.
# Real Chromium + the real front end; the SSE stream is a MOCK (tests/stream-ui-server.mjs).
# Run:  PORT=8801 node tests/stream-ui-server.mjs &   then   python3 tests/steps-ui.e2e.py
import json, os, sys, urllib.request
from playwright.sync_api import sync_playwright

BASE = os.environ.get('BASE', 'http://localhost:8801')
SHOTS = os.environ.get('SHOTS')  # optional folder for screenshots
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

def send(page, prompt):
    page.fill('#composerInput', prompt)
    page.click('#sendBtn')

def rows(page, scope='.act'):
    return page.evaluate("""(scope) => [...document.querySelectorAll(scope + ' .act-item')].map((li) => ({
      state: li.dataset.state, title: (li.querySelector('.act-title') || {}).textContent || '',
      sub: (li.querySelector('.act-sub') || {}).textContent || '', note: (li.querySelector('.act-note') || {}).textContent || '',
      icon: ((li.querySelector('.act-node i') || {}).className || '') }))""", scope)

def main():
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={'width': 420, 'height': 860})
        ctx.route('**/js/auth.js', lambda r: r.fulfill(status=200, content_type='text/javascript', body=AUTH_STUB))
        ctx.route(lambda url: not url.startswith(BASE) and not url.startswith('data:') and not url.startswith('blob:'), lambda r: r.abort())
        page = ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.goto(BASE + '/app.html')
        page.wait_for_selector('#composerInput')
        page.wait_for_timeout(500)

        # 1. Running row appears on step_start, settles on step, icon follows the app, a failure shows its reason.
        set_script([
            {'event': 'round', 'data': {'round': 0}}, {'wait': 100},
            {'event': 'step_start', 'data': {'name': 'github_get_file_contents', 'provider': 'github', 'providerLabel': 'GitHub', 'kind': 'read', 'summary': 'Read README.md from acme/app'}},
            {'wait': 1200},
            {'event': 'step', 'data': {'type': 'executed', 'name': 'github_get_file_contents', 'provider': 'github', 'providerLabel': 'GitHub', 'kind': 'read', 'ms': 900, 'ok': True, 'summary': 'Read README.md from acme/app'}},
            {'event': 'round', 'data': {'round': 1}}, {'wait': 100},
            {'event': 'step_start', 'data': {'name': 'gmail_send', 'provider': 'google', 'providerLabel': 'Gmail', 'kind': 'write', 'summary': 'Send an email to sam'}},
            {'wait': 1200},
            {'event': 'step', 'data': {'type': 'executed', 'name': 'gmail_send', 'provider': 'google', 'providerLabel': 'Gmail', 'kind': 'write', 'ms': 300, 'ok': False, 'reason': 'Not connected. Connect it in Account Settings.', 'summary': 'Send an email to sam'}},
            {'event': 'round', 'data': {'round': 2}}, {'wait': 800},
            {'event': 'done', 'data': {'reply': 'Done.', 'ui': [], 'uiPatches': [], 'steps': [
                {'type': 'executed', 'name': 'github_get_file_contents', 'provider': 'github', 'providerLabel': 'GitHub', 'kind': 'read', 'ms': 900, 'ok': True, 'summary': 'Read README.md from acme/app'},
                {'type': 'executed', 'name': 'gmail_send', 'provider': 'google', 'providerLabel': 'Gmail', 'kind': 'write', 'ms': 300, 'ok': False, 'reason': 'Not connected. Connect it in Account Settings.', 'summary': 'Send an email to sam'}]}},
        ])
        send(page, 'do things')
        page.wait_for_timeout(600)
        r = rows(page)
        check('1a running row shows as soon as step_start arrives', len(r) == 1 and r[0]['state'] == 'running' and 'README' in r[0]['title'], r)
        check('1b running row uses the app icon', r and 'github' in r[0]['icon'], r)
        page.wait_for_timeout(1200)
        r = rows(page)
        check('1c finished row settles in place (no duplicate)', r and r[0]['state'] == 'done' and len([x for x in r if 'README' in x['title']]) == 1, r)
        page.wait_for_timeout(1000)
        head = page.evaluate("(document.querySelector('.act.is-live .act-label')||{}).textContent")
        check('1d live header counts steps and failures', head and '2 steps' in head and '1 failed' in head, head)
        if SHOTS: page.screenshot(path=os.path.join(SHOTS, 'live.png'))
        page.wait_for_function("!document.querySelector('.act.is-live')", timeout=15000)
        page.wait_for_timeout(900)
        saved = rows(page, '.act.has-fail')
        check('1e saved view keeps both rows and the failure reason', len(saved) == 2 and saved[1]['state'] == 'fail' and 'Not connected' in saved[1]['note'], saved)
        check('1f failed turn opens its timeline', page.evaluate("document.querySelector('.act.has-fail').classList.contains('is-open')"))
        if SHOTS: page.screenshot(path=os.path.join(SHOTS, 'saved.png'))

        # 2. Browser step is labelled Browser, not Code.
        set_script([
            {'event': 'step_start', 'data': {'name': 'sandbox_browser_fetch', 'provider': 'sandbox', 'providerLabel': 'Browser', 'kind': 'run', 'summary': 'Open the page'}}, {'wait': 300},
            {'event': 'step', 'data': {'type': 'sandbox', 'name': 'sandbox_browser_fetch', 'provider': 'sandbox', 'providerLabel': 'Browser', 'kind': 'run', 'ms': 250, 'ok': True, 'summary': 'Open the page', 'sandbox': {'command': 'open page', 'stdout': 'ok', 'stderr': '', 'exitCode': 0, 'durationMs': 250, 'files': []}}},
            {'event': 'done', 'data': {'reply': 'Opened.', 'ui': [], 'uiPatches': [], 'steps': [
                {'type': 'sandbox', 'name': 'sandbox_browser_fetch', 'provider': 'sandbox', 'providerLabel': 'Browser', 'kind': 'run', 'ms': 250, 'ok': True, 'summary': 'Open the page', 'sandbox': {'command': 'open page', 'stdout': 'ok', 'stderr': '', 'exitCode': 0, 'durationMs': 250, 'files': []}}]}},
        ])
        send(page, 'browse')
        page.wait_for_function("document.querySelectorAll('#messageList .message.is-assistant').length >= 2 && !document.querySelector('.act.is-live')", timeout=15000)
        page.wait_for_timeout(900)
        last = rows(page, '#messageList .message.is-assistant:last-child .act')
        check('2 browser step says Browser with a globe icon', last and last[0]['sub'] == 'Browser' and 'globe' in last[0]['icon'], last)

        # 3. Error after a step ran: the finished step stays, the spinner stops, an error notice follows.
        set_script([
            {'event': 'step_start', 'data': {'name': 'github_get_file_contents', 'provider': 'github', 'providerLabel': 'GitHub', 'kind': 'read', 'summary': 'Read a file'}}, {'wait': 200},
            {'event': 'step', 'data': {'type': 'executed', 'name': 'github_get_file_contents', 'provider': 'github', 'providerLabel': 'GitHub', 'kind': 'read', 'ms': 200, 'ok': True, 'summary': 'Read a file'}},
            {'event': 'step_start', 'data': {'name': 'github_create_file', 'provider': 'github', 'providerLabel': 'GitHub', 'kind': 'write', 'summary': 'Create a file'}}, {'wait': 300},
            {'event': 'error', 'data': {'message': 'The model is unavailable.', 'status': 503}},
        ])
        send(page, 'break')
        page.wait_for_timeout(1500)
        r = rows(page, '.act.is-live, .act')
        stopped = page.evaluate("[...document.querySelectorAll('.act-item[data-state=running]')].length")
        lbl = page.evaluate("[...document.querySelectorAll('.act-label')].map(e=>e.textContent).pop()")
        check('3a no spinner left running after an error', stopped == 0, stopped)
        check('3b the steps that ran stay visible and say Stopped', lbl and lbl.startswith('Stopped after 1 step'), lbl)

        # 4. Plain answer with streamed text never leaves a "Working" row behind.
        set_script([
            {'event': 'round', 'data': {'round': 0}},
            {'event': 'step_start', 'data': {'name': 'x', 'provider': 'github', 'providerLabel': 'GitHub', 'kind': 'read', 'summary': 'Read a file'}}, {'wait': 150},
            {'event': 'step', 'data': {'type': 'executed', 'name': 'x', 'provider': 'github', 'providerLabel': 'GitHub', 'kind': 'read', 'ms': 150, 'ok': True, 'summary': 'Read a file'}},
            {'event': 'round', 'data': {'round': 1}}, {'wait': 200},
            {'event': 'text', 'data': {'t': 'Here is the answer, written out in full for you to read. ' * 6}}, {'wait': 200},
            {'event': 'text', 'data': {'t': 'And a little more.'}},
        ])
        # hold the stream open by sampling before the (missing) done: the mock closes it, so just sample mid-way
        send(page, 'answer')
        page.wait_for_timeout(500)
        pending = page.evaluate("[...document.querySelectorAll('.act.is-live .act-item[data-state=running]')].length")
        check('4 answer text replaces the generic Working row', pending == 0, pending)
        page.wait_for_timeout(1500)

        check('no page errors', not errors, errors[:3])
        b.close()
    bad = [r for r in results if not r[1]]
    print('\n%d/%d passed' % (len(results) - len(bad), len(results)))
    sys.exit(1 if bad else 0)

main()
