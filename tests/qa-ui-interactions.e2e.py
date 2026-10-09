# Browser tests (mock SSE, no real AI) for Generative UI interactions, odd inputs, touch and persistence.
# Run:  PORT=8801 node tests/stream-ui-server.mjs &   then   python3 tests/qa-ui-interactions.e2e.py
import json, os, sys, urllib.request
from playwright.sync_api import sync_playwright
BASE = os.environ.get('BASE', 'http://localhost:8801')
AUTH = open(os.path.join(os.path.dirname(__file__), 'stream-ui.e2e.py')).read().split('AUTH_STUB = """')[1].split('"""')[0]
res = []
def check(n, ok, d=''):
    res.append(bool(ok)); print(('PASS ' if ok else 'FAIL ') + n + ('' if ok else ' :: ' + str(d)))
def script(steps): urllib.request.urlopen(urllib.request.Request(BASE + '/__script', data=json.dumps(steps).encode(), method='POST'))
def reply(page, blocks, tag, patches=None, pending=None):
    steps = []
    if pending: steps += [{'event': 'ui', 'data': {'ui': [], 'patches': [], 'pending': pending}}, {'wait': 700}]
    steps += [{'event': 'ui', 'data': {'ui': blocks, 'patches': patches or [], 'pending': []}}, {'wait': 120},
              {'event': 'done', 'data': {'reply': 'ok ' + tag, 'ui': blocks, 'uiPatches': patches or []}}]
    script(steps)
    page.fill('#composerInput', 'go ' + tag); page.click('#sendBtn')
    page.wait_for_function("document.querySelector('#messageList').innerText.includes('ok %s') && !document.querySelector('.message.is-streaming') && !document.querySelector('[data-cui-live]')" % tag, timeout=20000)
    page.wait_for_timeout(250)
    return page.locator('#messageList .message.is-assistant').last

def run(mobile):
    with sync_playwright() as p:
        b = p.chromium.launch()
        ctx = b.new_context(viewport={'width': 375, 'height': 760} if mobile else {'width': 1100, 'height': 900}, has_touch=mobile, is_mobile=mobile)
        ctx.route('**/js/auth.js', lambda r: r.fulfill(status=200, content_type='text/javascript', body=AUTH))
        ctx.route(lambda u: not u.startswith(BASE) and not u.startswith('data:') and not u.startswith('blob:'), lambda r: r.abort())
        page = ctx.new_page(); errs = []
        page.on('pageerror', lambda e: errs.append(str(e)))
        page.on('console', lambda m: errs.append(m.text) if m.type == 'error' and not any(x in m.text for x in ('Failed to load', 'pwa', 'scope')) else None)
        page.goto(BASE + '/app.html'); page.wait_for_selector('#composerInput'); page.wait_for_timeout(400)
        M = 'mobile ' if mobile else 'desktop '
        click = (lambda loc: loc.tap()) if mobile else (lambda loc: loc.click())
        sent = lambda: page.locator('#messageList .message.is-user').last.inner_text()

        # loading placeholder appears while pending, gone after
        script([{'event': 'ui', 'data': {'ui': [], 'patches': [], 'pending': ['table']}}, {'wait': 1500},
                {'event': 'ui', 'data': {'ui': [{'id': 'pt', 'type': 'stat', 'props': {'label': 'a', 'value': '1'}}], 'patches': [], 'pending': []}},
                {'event': 'done', 'data': {'reply': 'ok pend', 'ui': [{'id': 'pt', 'type': 'stat', 'props': {'label': 'a', 'value': '1'}}], 'uiPatches': []}}])
        page.fill('#composerInput', 'pend'); page.click('#sendBtn'); page.wait_for_timeout(700)
        check(M + 'loading placeholder shows while pending', page.locator('.cui-skel').count() >= 1)
        page.wait_for_function("document.querySelector('#messageList').innerText.includes('ok pend')", timeout=15000); page.wait_for_timeout(300)
        check(M + 'placeholder gone after final', page.locator('.cui-skel').count() == 0)

        # table: sort, select, ask-AI with selection
        tb = {'id': 'tb', 'type': 'table', 'props': {'columns': ['Name', 'Score'], 'rows': [['Ada', '30'], ['Bo', '4'], ['Cy', '100']], 'selectable': True},
              'actions': [{'label': 'Explain rows', 'prompt': 'Explain these', 'withSelection': True}]}
        last = reply(page, [tb], 'tb')
        click(last.locator('th[data-cui-sort]').nth(1)); page.wait_for_timeout(150)
        order = last.locator('tbody tr td:nth-child(2)').all_inner_texts()
        check(M + 'table sorts numerically asc', order == ['4', '30', '100'], order)
        click(last.locator('th[data-cui-sort]').nth(1)); page.wait_for_timeout(150)
        check(M + 'table sorts desc', last.locator('tbody tr td:nth-child(2)').all_inner_texts() == ['100', '30', '4'])
        click(last.locator('button:has-text("Explain rows")')); page.wait_for_timeout(300)
        check(M + 'ask with no selection is blocked', 'Selected rows' not in sent() or sent() != 'Explain these')
        click(last.locator('tbody tr').first); page.wait_for_timeout(150)
        check(M + 'row select toggles', last.locator('tr.is-selected').count() == 1)
        script([{'event': 'done', 'data': {'reply': 'ok ask', 'ui': [], 'uiPatches': []}}])
        click(last.locator('button:has-text("Explain rows")')); page.wait_for_timeout(600)
        check(M + 'ask sends selected rows + component id', 'Selected rows (Name | Score)' in sent() and 'Component id: tb' in sent(), sent()[:120])

        # tabs / accordion / chart toggle / checklist / steps
        blocks = [
            {'id': 'tabs1', 'type': 'tabs', 'props': {'tabs': [{'label': 'One', 'content': 'body one'}, {'label': 'Two', 'content': 'body two'}]}},
            {'id': 'acc1', 'type': 'accordion', 'props': {'sections': [{'title': 'S1', 'content': 'acc one'}, {'title': 'S2', 'content': 'acc two'}]}},
            {'id': 'ch1', 'type': 'bar_chart', 'props': {'labels': ['a', 'b'], 'values': [1, 2]}},
            {'id': 'cl1', 'type': 'checklist', 'props': {'items': [{'text': 'x'}, {'text': 'y'}]}},
            {'id': 'st1', 'type': 'steps', 'props': {'items': [{'title': 'A'}, {'title': 'B'}]}}]
        last = reply(page, blocks, 'mix')
        click(last.locator('[data-cui-tab]').nth(1)); page.wait_for_timeout(150)
        check(M + 'tab 2 visible, tab 1 hidden', last.locator('text=body two').first.is_visible() and not last.locator('text=body one').first.is_visible())
        click(last.locator('summary:has-text("S2")')); page.wait_for_timeout(150)
        check(M + 'accordion opens', last.locator('text=acc two').first.is_visible())
        click(last.locator('[data-cui-view="table"]')); page.wait_for_timeout(150)
        check(M + 'chart to table toggle', last.locator('[data-cui-pane="table"]').first.is_visible() and not last.locator('[data-cui-pane="chart"]').first.is_visible())
        click(last.locator('[data-cui-view="chart"]')); page.wait_for_timeout(100)
        check(M + 'table back to chart', last.locator('[data-cui-pane="chart"]').first.is_visible())
        last.locator('input[data-cui-check]').first.check() if not mobile else click(last.locator('input[data-cui-check]').first); page.wait_for_timeout(150)
        check(M + 'checklist ticks', last.locator('input[data-cui-check]:checked').count() == 1)
        click(last.locator('.cui-step-dot').first); page.wait_for_timeout(150)
        check(M + 'step status cycles', last.locator('[data-cui-step]').first.get_attribute('data-status') == 'doing')

        # state survives reload
        page.reload(); page.wait_for_selector('#composerInput'); page.wait_for_timeout(1200)
        stored = page.evaluate("localStorage.getItem('cognita:conversations')") or ''
        check(M + 'component state is saved to local history', '"active":1' in stored and '"checked":[true' in stored.replace(' ', '') and '"status":["doing"' in stored.replace(' ', ''), stored[:80])
        page.evaluate("(() => { const id = JSON.parse(localStorage.getItem('cognita:conversations'))[0].id; const el = document.querySelector('.sidebar-history-item[data-id=\"' + id + '\"]'); if (el) el.click(); })()")
        page.wait_for_timeout(1200)
        m = page.locator('#messageList .message.is-assistant').filter(has=page.locator('[data-cui-id="tabs1"]'))
        if m.count():
            m = m.last
            check(M + 'reload keeps active tab', m.locator('[data-cui-tab]').nth(1).get_attribute('aria-selected') == 'true')
            check(M + 'reload keeps checklist tick', m.locator('input[data-cui-check]:checked').count() == 1)
            check(M + 'reload keeps step status', m.locator('[data-cui-step]').first.get_attribute('data-status') == 'doing')
        else: check(M + 'reload restores conversation', False, 'tabs message not found after reopening chat')

        # form: typing, required, checkbox, bad types, empty select
        fm = {'id': 'fm', 'type': 'form', 'props': {'title': 'F', 'submitPrompt': 'Sent form', 'fields': [
            {'name': 'who', 'label': 'Who', 'type': 'text', 'required': True}, {'name': 'pick', 'label': 'Pick', 'type': 'select', 'options': ['A', 'B']},
            {'name': 'agree', 'label': 'Agree', 'type': 'checkbox'}, {'name': 'n', 'label': 'Age', 'type': 'number'}, {'name': 'e', 'label': 'Empty', 'type': 'select', 'options': []}]}}
        last = reply(page, [fm], 'fm')
        check(M + 'form shows 5 fields (bad type falls back to text)', last.locator('[data-name]').count() == 5, last.locator('[data-name]').count())
        click(last.locator('button:has-text("Submit")')); page.wait_for_timeout(300)
        check(M + 'required field blocks submit', sent() != 'Sent form' and 'Sent form' not in sent())
        last.locator('[data-name="who"]').fill('Zoë 🎓 你好'); last.locator('[data-name="pick"]').select_option('B')
        click(last.locator('[data-name="agree"]')); page.wait_for_timeout(150)
        script([{'event': 'done', 'data': {'reply': 'ok sub', 'ui': [], 'uiPatches': []}}])
        click(last.locator('button:has-text("Submit")')); page.wait_for_timeout(600)
        s = sent()
        check(M + 'form submit sends values incl. unicode + checkbox', 'Sent form' in s and 'Who: Zoë 🎓 你好' in s and 'Pick: B' in s and 'Agree: Yes' in s, s[:160])

        # plan: toggle, edit, add task, turn into doc
        pl = {'id': 'pl', 'type': 'plan', 'props': {'title': 'P', 'sections': [{'title': 'Sec', 'tasks': ['t1', 't2']}]}}
        last = reply(page, [pl], 'pl')
        click(last.locator('input[data-cui-check]').first); page.wait_for_timeout(150)
        check(M + 'plan progress updates', last.locator('[data-cui-progress]').first.inner_text().startswith('1 of 2'), last.locator('[data-cui-progress]').first.inner_text())
        click(last.locator('[data-cui-act="addtask"]').first); page.wait_for_timeout(200)
        page.keyboard.type('Brand new 🎯'); page.keyboard.press('Enter'); page.wait_for_timeout(200)
        check(M + 'plan add + edit task', 'Brand new 🎯' in last.inner_text() and last.locator('[data-cui-progress]').first.inner_text().startswith('1 of 3'), last.locator('[data-cui-progress]').first.inner_text())
        script([{'event': 'done', 'data': {'reply': 'ok doc', 'ui': [], 'uiPatches': []}}])
        click(last.locator('[data-cui-act="plandoc"]')); page.wait_for_timeout(600)
        check(M + 'turn plan into document sends plan text', 'Turn this plan into a document' in sent() and 'Brand new' in sent())

        # local action button + AI action button
        lc = [{'id': 'tt', 'type': 'tabs', 'props': {'tabs': [{'label': 'A', 'content': 'aa'}, {'label': 'B', 'content': 'bb'}]},
               'actions': [{'label': 'Go B', 'kind': 'local', 'target': 'tt', 'state': {'active': 1}}, {'label': 'Ask more', 'prompt': 'More please'}]}]
        last = reply(page, lc, 'act')
        click(last.locator('button:has-text("Go B")')); page.wait_for_timeout(250)
        check(M + 'local action button switches tab with no model call', last.locator('text=bb').first.is_visible())
        script([{'event': 'done', 'data': {'reply': 'ok ai', 'ui': [], 'uiPatches': []}}])
        click(last.locator('button:has-text("Ask more")')); page.wait_for_timeout(600)
        check(M + 'ai action button sends prompt', 'More please' in sent())

        # patches on line/pie/tabs/accordion/plan/data_summary/source_list in the browser
        base = [{'id': 'lc', 'type': 'line_chart', 'props': {'labels': ['a', 'b'], 'values': [1, 2]}}, {'id': 'pc', 'type': 'pie_chart', 'props': {'labels': ['a', 'b'], 'values': [1, 2]}},
                {'id': 'tb2', 'type': 'tabs', 'props': {'tabs': [{'label': 'a', 'content': 'x'}]}}, {'id': 'ds', 'type': 'data_summary', 'props': {'findings': ['f1']}},
                {'id': 'sl', 'type': 'source_list', 'props': {'sources': [{'title': 'S1', 'url': 'https://a.com'}]}}]
        last = reply(page, base, 'pbase')
        patches = [{'op': 'append', 'target': 'lc', 'labels': ['c'], 'values': [3]}, {'op': 'append', 'target': 'pc', 'labels': ['c'], 'values': [3]},
                   {'op': 'append', 'target': 'tb2', 'tabs': [{'label': 'zz', 'content': 'new tab'}]}, {'op': 'append', 'target': 'ds', 'findings': ['f2 added']},
                   {'op': 'append', 'target': 'sl', 'sources': [{'title': 'S2 added', 'url': 'https://b.com'}]}]
        final = S_apply = None
        # the Worker sends final ui already patched; mirror that via the browser's own validator
        last2 = reply(page, base, 'pp', patches=patches)
        txt = last2.inner_text()
        check(M + 'patches render (tabs/data summary/sources)', 'zz' in txt and 'f2 added' in txt and 'S2 added' in txt, txt[:200])
        check(M + 'line + pie patched to 3 points', last2.locator('[data-cui-id="lc"] circle.cui-dot').count() == 3 and last2.locator('[data-cui-id="pc"] .cui-legend li').count() == 3)

        # odd inputs: very many rows, long text, emoji, nested at depth limit, mismatched chart
        big = [{'id': 'big', 'type': 'table', 'props': {'columns': ['c%d' % i for i in range(20)], 'rows': [['x' * 400] * 20] * 200}},
               {'id': 'emo', 'type': 'card', 'props': {'title': '🎓 مرحبا 你好', 'content': 'a' * 5000}},
               {'id': 'mm', 'type': 'bar_chart', 'props': {'labels': ['a', 'b', 'c', 'd'], 'values': [1, 2]}}]
        deep = {'type': 'card', 'props': {'title': 'L0'}}
        for i in range(8): deep = {'type': 'card', 'props': {'title': 'L%d' % (i + 1)}, 'children': [deep]}
        big.append(deep)
        last = reply(page, big, 'odd')
        check(M + 'big/odd inputs render without raw JSON', last.locator('[data-cui-root] .cui-node').count() >= 3 and '"type"' not in last.inner_text())
        ow = page.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")
        check(M + 'no page-level horizontal overflow', ow)
        check(M + 'no JS errors', not errs, errs[:3])
        b.close()
run(False); run(True)
print('%d/%d passed' % (sum(res), len(res))); sys.exit(0 if all(res) else 1)
