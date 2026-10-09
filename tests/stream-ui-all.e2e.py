# Renders every Generative UI component type through the real front end (mock SSE) and exercises their controls.
# Run:  PORT=8801 node tests/stream-ui-server.mjs &   then   python3 tests/stream-ui-all.e2e.py
import json, os, sys, urllib.request
from playwright.sync_api import sync_playwright
BASE = os.environ.get('BASE', 'http://localhost:8801')
AUTH = open(os.path.join(os.path.dirname(__file__), 'stream-ui.e2e.py')).read().split('AUTH_STUB = """')[1].split('"""')[0]
B = {
 'stat': {'label': 'Revenue', 'value': '$12k', 'explanation': 'up'},
 'bar_chart': {'title': 'Bars', 'labels': ['a', 'b'], 'values': [1, 2]},
 'line_chart': {'title': 'Line', 'labels': ['a', 'b', 'c'], 'values': [1, 3, 2]},
 'pie_chart': {'title': 'Pie', 'labels': ['a', 'b'], 'values': [1, 2]},
 'list': {'title': 'List', 'ordered': True, 'items': ['x', 'y']},
 'steps': {'title': 'Steps', 'items': [{'title': 'S1', 'description': 'd', 'status': 'done'}, {'title': 'S2', 'description': 'd', 'status': 'doing'}]},
 'tabs': {'title': 'Tabs', 'tabs': [{'label': 'T1', 'content': 'first body'}, {'label': 'T2', 'content': 'second body'}]},
 'accordion': {'title': 'Acc', 'sections': [{'title': 'Sec1', 'content': 'sec one body'}, {'title': 'Sec2', 'content': 'sec two body'}]},
 'form': {'title': 'Form', 'fields': [{'name': 'n', 'label': 'Name', 'type': 'text'}, {'name': 'c', 'label': 'Pick', 'type': 'select', 'options': ['A', 'B']}], 'submitLabel': 'Send it', 'submitPrompt': 'Form sent'},
 'timeline': {'title': 'Time', 'items': [{'date': '2026', 'title': 'Start', 'description': 'go'}]},
 'callout': {'variant': 'warning', 'title': 'Careful', 'content': 'heads up'},
 'code': {'title': 'Code', 'language': 'js', 'code': 'const a = 1;'},
 'data_summary': {'title': 'Summary', 'findings': ['f1'], 'metrics': [{'label': 'M', 'value': '5'}]},
 'source_list': {'title': 'Sources', 'sources': [{'title': 'Site', 'url': 'https://example.com', 'description': 'd'}]},
 'plan': {'title': 'Plan', 'description': 'p', 'sections': [{'title': 'P1', 'tasks': [{'text': 'task1', 'done': False}]}], 'editable': True},
 'document_result': {'title': 'Doc', 'description': 'd', 'format': 'pdf'},
 'media_result': {'title': 'Pic', 'description': 'd', 'kind': 'image'},
}
res = []
def check(n, ok, d=''):
    res.append(ok); print(('PASS ' if ok else 'FAIL ') + n + ('' if ok else ' :: ' + str(d)))
with sync_playwright() as p:
    b = p.chromium.launch(); ctx = b.new_context(viewport={'width': 1100, 'height': 900})
    ctx.route('**/js/auth.js', lambda r: r.fulfill(status=200, content_type='text/javascript', body=AUTH))
    ctx.route(lambda u: not u.startswith(BASE) and not u.startswith('data:') and not u.startswith('blob:'), lambda r: r.abort())
    page = ctx.new_page(); errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.on('console', lambda m: errs.append(m.text) if m.type == 'error' and not any(x in m.text for x in ('Failed to load', 'pwa', 'scope')) else None)
    page.goto(BASE + '/app.html'); page.wait_for_selector('#composerInput'); page.wait_for_timeout(400)
    for t, props in B.items():
        blk = {'id': 'x_' + t, 'type': t, 'props': props}
        steps = [{'event': 'ui', 'data': {'ui': [], 'patches': [], 'pending': [t]}}, {'wait': 150},
                 {'event': 'ui', 'data': {'ui': [blk], 'patches': [], 'pending': []}}, {'wait': 150},
                 {'event': 'done', 'data': {'reply': 'ok ' + t, 'ui': [blk], 'uiPatches': []}}]
        urllib.request.urlopen(urllib.request.Request(BASE + '/__script', data=json.dumps(steps).encode(), method='POST'))
        page.fill('#composerInput', 'show ' + t); page.click('#sendBtn')
        page.wait_for_function("document.querySelector('#messageList').innerText.includes('ok %s') && !document.querySelector('.message.is-streaming') && !document.querySelector('[data-cui-live]')" % t, timeout=20000)
        page.wait_for_timeout(250)
        last = page.locator('#messageList .message.is-assistant').last
        n = last.locator('[data-cui-root] .cui-node').count(); sk = last.locator('.cui-skel').count()
        txt = last.inner_text()
        check(t + ' renders (1 node, no skeleton left, no raw JSON)', n >= 1 and sk == 0 and '"type"' not in txt and 'cognita-ui' not in txt, (n, sk))
        if t == 'tabs':
            last.locator('[role=tab], .cui-tab').nth(1).click(); page.wait_for_timeout(150)
            check('tabs switch shows 2nd body', 'second body' in last.locator('[data-cui-root]').inner_text() and last.locator('text=second body').first.is_visible())
        if t == 'accordion':
            last.locator('summary, .cui-acc-head, button').filter(has_text='Sec2').first.click(); page.wait_for_timeout(150)
            check('accordion opens a section', last.locator('text=sec two body').first.is_visible())
        if t == 'plan':
            last.locator('input[data-cui-check]').first.click(); page.wait_for_timeout(150)
            check('plan task toggles progress', last.locator('[data-cui-progress]').first.inner_text().startswith('1 of 1'))
        if t == 'form':
            last.locator('input[type=text]').first.fill('Zed')
            last.locator('button:has-text("Send it")').click(); page.wait_for_timeout(400)
            check('form submit goes back through chat', page.locator('#messageList .message.is-user').last.inner_text().strip() != '', '')
        if t == 'code':
            check('code shows its code', 'const a = 1;' in last.inner_text())
        if t == 'source_list':
            href = last.locator('a[href^="https://example.com"]').first.get_attribute('rel') or ''
            check('source link is safe (noopener)', 'noopener' in href, href)
    check('no JavaScript errors', not errs, errs[:3])
    b.close()
print('%d/%d passed' % (sum(res), len(res))); sys.exit(0 if all(res) else 1)
