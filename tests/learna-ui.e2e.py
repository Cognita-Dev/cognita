# Browser tests for Learna: real Chromium, the real front end (app.html, js/learna.js, js/learna-speech.js) and the real
# worker code, with Firestore, AI, storage and speech services faked by tests/learna-ui-server.mjs.
# Run:  PORT=8799 node tests/learna-ui-server.mjs &   then   python3 tests/learna-ui.e2e.py
import json, sys, urllib.request, urllib.parse, time, os
from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get('BASE', 'http://localhost:8799')
SHOTS = os.environ.get('SHOTS', '/tmp/shots')
os.makedirs(SHOTS, exist_ok=True)
results = []

AUTH_STUB = """
const uid = window.__UID || 'plus';
const base = (u) => String(u).replace('https://api.cognita.com.ng', '');
const user = { uid, email: uid + '@x.com', displayName: 'Test ' + uid };
const impl = {
  ready: async () => user, requireAuthOrRedirect: async () => user, currentUser: user, getCurrentUser: () => user,
  authedFetch: (u, o = {}) => fetch(base(u), { ...o, headers: { ...(o.headers || {}), 'x-test-user': uid } }),
  logOut: async () => {}, onAuthStateChanged: (cb) => { setTimeout(() => cb(user), 0); return () => {}; },
};
const Auth = new Proxy(impl, { get: (t, k) => (k in t ? t[k] : (typeof k === 'string' ? async () => null : undefined)) });
window.Auth = Auth; export { Auth };
"""

def ctl(action, **q):
    return urllib.request.urlopen(BASE + '/__ctl/' + action + '?' + urllib.parse.urlencode(q)).read().decode()

def api(uid, method, path, body=None, raw=None, headers=None):
    h = {'x-test-user': uid, **(headers or {})}
    data = raw
    if body is not None: data = json.dumps(body).encode(); h['Content-Type'] = 'application/json'
    req = urllib.request.Request(BASE + '/api' + path, data=data, method=method, headers=h)
    try:
        r = urllib.request.urlopen(req); return r.status, json.loads(r.read() or b'{}')
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read() or b'{}')
        except Exception: return e.code, {}

INIT_SPEECH = """
window.__spoken = []; window.__played = [];
const origPlay = HTMLMediaElement.prototype.play;
HTMLMediaElement.prototype.play = function () { if (!(this.dataset && this.dataset.primer)) window.__played.push(this.src.slice(0, 20)); return origPlay.apply(this, arguments); };
if (!window.__noVoices) {
  window.speechSynthesis.cancel = () => {};
  window.speechSynthesis.getVoices = () => [{ name: 'Test French', lang: 'fr-FR' }, { name: 'Test English NG', lang: 'en-NG' }];
  window.speechSynthesis.speak = (u) => { window.__spoken.push({ text: u.text, lang: u.lang, voice: u.voice && u.voice.name, rate: u.rate }); setTimeout(() => u.onstart && u.onstart(), 5); setTimeout(() => u.onend && u.onend(), 20); };
}
class FakeSR { constructor() { this.onresult = null; this.onend = null; this.onerror = null; }
  start() { this._t = setTimeout(() => { const text = window.__heard || ''; if (text && this.onresult) { const r = [{ transcript: text }]; r.isFinal = true; this.onresult({ resultIndex: 0, results: [r] }); } }, 150); }
  stop() { clearTimeout(this._t); setTimeout(() => this.onend && this.onend(), 50); }
}
window.webkitSpeechRecognition = FakeSR; window.SpeechRecognition = FakeSR;
"""

def new_ctx(pw, browser, uid, mobile=False, no_voices=False, speech=True):
    kw = dict(viewport={'width': 390, 'height': 844} if mobile else {'width': 1280, 'height': 900}, permissions=['microphone', 'camera'])
    if mobile: kw.update(is_mobile=True, has_touch=True, device_scale_factor=2)
    ctx = browser.new_context(**kw)
    ctx.add_init_script('window.__UID = ' + json.dumps(uid) + '; ' + ('window.__noVoices = true;' if no_voices else ''))
    if speech: ctx.add_init_script(INIT_SPEECH)
    ctx.route('**/js/auth.js', lambda r: r.fulfill(status=200, content_type='text/javascript', body=AUTH_STUB))
    ctx.route(lambda url: not url.startswith(BASE) and not url.startswith('data:') and not url.startswith('blob:'), lambda r: r.abort())
    return ctx

def open_learna(ctx, query=''):
    page = ctx.new_page(); errs = []
    page.on('pageerror', lambda e: errs.append(str(e)))
    page.on('console', lambda m: errs.append('console: ' + m.text) if m.type == 'error' and 'Failed to load resource' not in m.text and 'net::ERR' not in m.text else None)
    page.goto(BASE + '/app.html?view=learna' + query); page.wait_for_selector('#learnaRoot .lrn-page, #learnaRoot .lrn-work', timeout=15000)
    page.errs = errs
    return page

def check(name, fn):
    try: fn(); results.append((name, True)); print('  PASS ', name)
    except Exception as e:
        results.append((name, False)); print('  FAIL ', name, '\n        ->', str(e).split('\n')[0][:300])

def no_overflow(page):
    w = page.evaluate('[document.documentElement.scrollWidth, window.innerWidth, (document.querySelector("#learnaScroll")||{}).scrollWidth||0, (document.querySelector("#learnaScroll")||{}).clientWidth||0]')
    assert w[0] <= w[1] + 1, 'page scrolls sideways %s' % w
    assert w[2] <= w[3] + 1, 'learna scroller scrolls sideways %s' % w

IGNORE = ('service worker', 'ServiceWorker', 'scope')
def errs_of(page): return [e for e in page.errs if not any(i in e for i in IGNORE)]

def run():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'])
        ctl('reset')

        print('\nCatalogue, plans and states')
        ctx = new_ctx(pw, browser, 'free'); page = open_learna(ctx)
        def t():
            page.wait_for_selector('.lrn-row'); assert page.locator('.lrn-row').count() == 5, page.locator('.lrn-row').count()
            assert 'Browsing is free' in page.inner_text('.lrn-plan'); assert page.locator('#lrnTasks').count() == 0
            assert errs_of(page) == [], errs_of(page)
        check('free user sees five courses and the upgrade message, no errors', t)
        def t():
            page.click('.lrn-row >> text=JavaScript Foundations'); page.wait_for_selector('.lrn-course')
            txt = page.inner_text('.lrn-course-main')
            assert '20' in txt and 'Section 6: Build and check' in txt; assert 'Certificate in JavaScript Foundations' in txt and 'Submit your report program' in txt
            assert 'Upgrade to start' in page.inner_text('.lrn-aside')
            page.screenshot(path=SHOTS + '/desk-course-free.png', full_page=True)
        check('course page lists the curriculum and certificate requirements, and asks free users to upgrade', t)
        ctx.close()

        ctx = new_ctx(pw, browser, 'plus'); page = open_learna(ctx)
        def t():
            page.wait_for_selector('.lrn-row'); page.click('.lrn-row >> text=Public Speaking Essentials'); page.wait_for_selector('.lrn-course')
            assert 'Start course' in page.inner_text('.lrn-aside')
            page.route('**/api/learna/prefs', lambda r: r.abort())
        check('plus user can start a course', t)
        page.unroute('**/api/learna/prefs')
        def t():
            ctl('delay', ms='0'); page.goto(BASE + '/app.html?view=learna'); page.wait_for_selector('.lrn-row')
            page.click('summary:has-text("Reminders and notifications")'); page.wait_for_selector('input[data-pref-n="nudges"]')
            page.uncheck('input[data-pref-n="nudges"]'); page.wait_for_timeout(500)
            s, j = api('plus', 'GET', '/learna/prefs'); assert j['nudges'] is False and j['reviewAlerts'] is True, j
            assert 'Never daily' in page.inner_text('.lrn-prefs')
        check('reminder preferences save and the page explains the limits', t)
        def t():
            page2 = ctx.new_page(); page2.route('**/api/learna/catalogue', lambda r: r.fulfill(status=500, content_type='application/json', body='{"error":"Boom"}'))
            page2.goto(BASE + '/app.html?view=learna'); page2.wait_for_selector('.lrn-state', timeout=10000)
            assert 'Try again' in page2.inner_text('.lrn-state'); page2.unroute('**/api/learna/catalogue'); page2.click('text=Try again'); page2.wait_for_selector('.lrn-row'); page2.close()
        check('a failed load shows an error with Try again, and it recovers', t)
        ctx.close()

        print('\nJavaScript course: visuals, hotspots, code with hidden cases')
        ctx = new_ctx(pw, browser, 'studio'); page = open_learna(ctx, '&course=javascript-foundations')
        def t():
            page.click('text=Start course'); page.wait_for_selector('.lrn-work', timeout=10000)
            assert 'How code runs' in page.inner_text('.lrn-title--lesson')
            page.click('button[data-act="advance"]'); page.wait_for_selector('.lrn-card')
        check('enrolling opens the first lesson', t)
        ctl('jump', uid='studio', course='javascript-foundations', lesson='s1_l1', step='0'); page.goto(BASE + '/app.html?view=learna&course=javascript-foundations&lesson=s1_l1'); page.wait_for_selector('.lrn-visual img')
        def t():
            page.wait_for_function('(() => { const i = document.querySelector(".lrn-visual img"); return i && i.complete && i.naturalWidth === 1200; })()', timeout=8000)
            assert page.evaluate('document.querySelector(".lrn-visual img").alt.length') > 10
            assert page.locator('.lrn-hot').count() == 3
            page.click('.lrn-hot[data-i="1"]'); assert 'engine' in page.inner_text('.lrn-hot-panel').lower() and 'line 2' in page.inner_text('.lrn-hot-panel')
            assert page.locator('.lrn-hot.is-on').count() == 1 and page.get_attribute('.lrn-hot.is-on', 'aria-pressed') == 'true'
            page.click('summary:has-text("Read the numbered points")'); assert page.locator('.lrn-hot-list li').count() == 3
            page.screenshot(path=SHOTS + '/desk-visual.png')
        check('the diagram loads, hotspots explain themselves, and there is a text alternative', t)
        def t():
            page.click('button[data-act="advance"]')
            page.check('input[name="ans"][value="a"]'); page.click('button:has-text("Check answer")'); page.wait_for_selector('.lrn-feedback.is-right'); page.click('button[data-act="advance"]')
            page.check('input[name="ans"][value="b"]'); page.click('button:has-text("Check answer")'); page.wait_for_selector('.lrn-feedback.is-right'); page.click('button[data-act="advance"]')
            page.wait_for_selector('#lrnCode'); assert page.locator('.lrn-check li').count() == 4, page.locator('.lrn-check li').count()
            assert 'extra cases you cannot see' in page.inner_text('.lrn-tests')
        check('the code task shows its examples and says how many hidden cases will be added', t)
        def t():
            page.fill('#lrnCode', 'function double(n) {\n  return n * 3;\n}\n'); page.click('button:has-text("Run tests")'); page.wait_for_selector('.lrn-feedback', timeout=30000)
            assert 'Not yet' in page.inner_text('.lrn-feedback'); assert page.locator('.lrn-check li.is-miss').count() >= 1 and page.locator('.lrn-check li').count() == 5
            page.fill('#lrnCode', 'function double(n) {\n  return n * 2;\n}\n'); page.click('button:has-text("Run tests")'); page.wait_for_selector('.lrn-feedback.is-right', timeout=30000)
            assert page.locator('.lrn-check li.is-met').count() == 5
            page.screenshot(path=SHOTS + '/desk-code-pass.png')
        check('wrong code fails five checks including hidden ones; right code passes all five (real sandbox, real server)', t)
        ctx.close()

        print('\nListening: premium voice, per-word icons, and fallbacks')
        ctl('tts', on='1'); ctl('reset')
        ctx = new_ctx(pw, browser, 'plus'); api('plus', 'POST', '/learna/courses/french-a1/enroll')
        page = open_learna(ctx, '&course=french-a1&lesson=s1_l1')
        page.wait_for_selector('.lrn-card')
        reqs = []; page.on('request', lambda r: reqs.append((r.url, r.post_data)) if '/speech/tts' in r.url else None)
        def t():
            assert page.locator('.lrn-w .lrn-spk').count() >= 3, 'word speakers'
            page.click('.lrn-w:has-text("Bonjour") .lrn-spk'); page.wait_for_function('window.__played.length >= 1', timeout=8000)
            body = json.loads(reqs[-1][1]); assert body['part'] == 'word' and body['word'] == 'Bonjour' and body['lang'] == 'fr-FR', body
            assert page.evaluate('window.__spoken.length') == 0, 'premium voice should have been used, not the browser voice'
        check('a word speaker button pronounces only that word with the premium French voice', t)
        def t():
            before = len(reqs); page.click('button.lrn-listen >> nth=0'); page.wait_for_function('window.__played.length >= 2', timeout=15000)
            parts = [json.loads(r[1])['part'] for r in reqs[before:]]; assert parts[0].startswith('text:'), parts
            assert page.locator('.lrn-voice select[data-pref="voice"] option').count() == 2
            assert [o.strip() for o in page.locator('.lrn-voice select[data-pref="voice"] option').all_inner_texts()] == ['Denise', 'Henri']
            assert 'Neural' not in page.inner_text('.lrn-card')
        check('Listen reads the explanation paragraph by paragraph; voices have friendly names', t)
        def t():
            page.evaluate('window.__played.length = 0'); page.select_option('select[data-pref="rate"]', '0.75'); page.click('.lrn-w:has-text("Bonsoir") .lrn-spk'); page.wait_for_function('window.__played.length >= 1')
            assert json.loads(reqs[-1][1])['rate'] == 0.75
        check('the speed setting is honoured', t)
        ctl('tts', on='0', key='0')
        def t():
            page.evaluate('window.__played.length = 0; window.__spoken.length = 0')
            page.click('.lrn-w:has-text("Au revoir") .lrn-spk'); page.wait_for_function('window.__spoken.length >= 1', timeout=8000)
            sp = page.evaluate('window.__spoken[0]'); assert sp['text'] == 'Au revoir' and sp['lang'] == 'fr-FR', sp
        check('with no premium voice the browser voice says the same word, using a French voice', t)
        ctx.close(); ctl('tts', on='1')

        ctx = new_ctx(pw, browser, 'plus', no_voices=True)
        page = open_learna(ctx, '&course=french-a1&lesson=s1_l1'); page.wait_for_selector('.lrn-card'); ctl('tts', on='0', key='0')
        def t():
            page.evaluate('window.speechSynthesis.getVoices = () => []; window.speechSynthesis.speak = (u) => setTimeout(() => u.onend && u.onend(), 5); window.speechSynthesis.cancel = () => {}')
            page.click('.lrn-w:has-text("Bonjour") .lrn-spk'); page.wait_for_selector('.lrn-speech-note', timeout=8000)
            assert 'no fr-FR voice installed' in page.inner_text('.lrn-speech-note'); assert errs_of(page) == [], errs_of(page)
        check('on a device with no French voice the learner is told plainly, and nothing breaks', t)
        ctx.close(); ctl('tts', on='1')

        ctl('reset'); api('studio', 'POST', '/learna/courses/javascript-foundations/enroll')
        ctx = new_ctx(pw, browser, 'studio'); page = open_learna(ctx, '&course=javascript-foundations&lesson=s1_l1')
        def t():
            page.wait_for_selector('.lrn-card'); reqs = []; page.on('request', lambda r: reqs.append((r.url, r.post_data)) if '/speech/tts' in r.url else None)
            page.select_option('select[data-pref="voice"]', 'alt') if page.locator('select[data-pref="voice"]').count() else None
            assert page.locator('.lrn-card-top button.lrn-listen').count() == 0, 'Listen only where it helps: not offered on a plain coding explanation'
        check('English coding lessons do not get voice controls everywhere, only where the step asks for them', t)
        ctx.close()

        print('\nSpeaking: say-it-aloud practice, recording audio, recording video, reviews')
        ctl('reset')
        ctl('jump', uid='plus', course='public-speaking-essentials', lesson='s1_l3', step='5')
        ctx = new_ctx(pw, browser, 'plus'); page = open_learna(ctx, '&course=public-speaking-essentials&lesson=s1_l3'); page.wait_for_selector('.lrn-target')
        def t():
            assert 'It cannot judge your accent' in page.inner_text('.lrn-card'); assert page.locator('button:has-text("Skip this practice")').count() == 1
            page.evaluate('window.__heard = "I have prepared well and I will take my time"'); page.click('button[data-act="speak-record"]'); page.wait_for_timeout(500); page.click('button[data-act="speak-record"]')
            page.wait_for_selector('.lrn-feedback.is-right', timeout=8000); assert 'understood 10 of 10 words' in page.inner_text('.lrn-feedback') and 'not a score for accent' in page.inner_text('.lrn-feedback')
            page.screenshot(path=SHOTS + '/desk-speak.png')
        check('saying the sentence gets a recognition result that is honest about what it is', t)
        ctl('reset'); ctl('jump', uid='plus', course='public-speaking-essentials', lesson='s1_l3', step='5'); page.reload(); page.wait_for_selector('.lrn-target')
        def t():
            page.click('button:has-text("Skip this practice")'); page.wait_for_selector('button[data-act="advance"]'); assert 'Skipped' in page.inner_text('.lrn-feedback')
        check('a learner can always skip speaking practice and carry on', t)
        ctx.close()

        ctl('reset'); ctl('jump', uid='plus', course='public-speaking-essentials', lesson='s1_l1', step='2'); ctl('whisper', text='Good morning everyone. ' + ' '.join('word%d' % i for i in range(70)) + ' school and why I want to improve', dur='35')
        ctx = new_ctx(pw, browser, 'plus'); page = open_learna(ctx, '&course=public-speaking-essentials&lesson=s1_l1'); page.wait_for_selector('button[data-act="rec-start"]')
        def t():
            assert 'Start recording' in page.inner_text('.lrn-card'), page.inner_text('.lrn-card')[:300]; assert 'private to you and your reviewers' in page.inner_text('.lrn-card')
            page.click('button[data-act="rec-start"]'); page.wait_for_selector('#lrnRecTime'); page.wait_for_timeout(2500)
            assert page.inner_text('#lrnRecTime') != '0:00'
            page.wait_for_timeout(29000)   # this task needs at least 30 seconds
            page.click('button[data-act="rec-stop"]'); page.wait_for_selector('audio.lrn-audio')
            assert page.locator('button[data-act="rec-send"]').count() == 1 and page.locator('button[data-act="rec-redo"]').count() == 1
            page.screenshot(path=SHOTS + '/desk-record-review.png')
        check('recording audio with the real recorder shows a timer, then playback with send and record-again', t)
        def t():
            page.click('button[data-act="rec-send"]'); page.wait_for_selector('.lrn-feedback', timeout=20000)
            txt = page.inner_text('.lrn-feedback'); assert 'Passed' in txt or 'Not yet' in txt, txt
            assert page.locator('.lrn-metrics').count() == 1 and 'per min' in txt, txt
        check('sending shows server-measured pace, filler count and a checklist', t)
        s1, l1 = api('plus', 'GET', '/learna/courses/public-speaking-essentials/lessons/s1_l1')
        check('the recording is stored and linked to the learner\u2019s progress record', lambda: (l1['acts']['a1']['submissionId'] and l1['acts']['a1']['review'] == 'auto') or (_ for _ in ()).throw(AssertionError(l1['acts'])))
        ctx.close()

        ctl('reset'); ctl('jump', uid='plus', course='public-speaking-essentials', lesson='s3_l3', step='5')
        ctx = new_ctx(pw, browser, 'plus'); page = open_learna(ctx, '&course=public-speaking-essentials&lesson=s3_l3'); page.wait_for_selector('button[data-act="rec-start"]')
        def t():
            assert 'Record a short video' in page.inner_text('.lrn-card') and page.locator('.lrn-cam--off').count() == 1
            page.click('button[data-act="rec-start"]'); page.wait_for_selector('video#lrnCam'); page.wait_for_timeout(3000)
            assert page.evaluate('document.querySelector("#lrnCam").srcObject !== null'), 'camera preview'
            page.wait_for_timeout(18500)   # this task needs at least 20 seconds
            page.click('button[data-act="rec-stop"]'); page.wait_for_selector('video.lrn-cam[controls]')
            page.screenshot(path=SHOTS + '/desk-video-review.png')
        check('video tasks use the camera with a live preview and a playback step', t)
        def t():
            page.click('button[data-act="rec-send"]'); page.wait_for_selector('.lrn-review--pending', timeout=20000); txt = page.inner_text('#lrnStep')
            assert 'Submitted' in txt and 'Waiting for a reviewer' in txt, txt
        check('a real video recording uploads and is queued for a reviewer; the learner is told it will not block the course', t)
        ctx.close()
        # a longer clip through the API so the review flow can be tested with the real screens
        sid = api('plus', 'GET', '/learna/courses/public-speaking-essentials/lessons/s3_l3')[1]['acts']['a3']['submissionId']
        check('the video submission exists with an id', lambda: bool(sid) or (_ for _ in ()).throw(AssertionError('no submission id')))
        ctx = new_ctx(pw, browser, 'plus'); page = open_learna(ctx, '&course=public-speaking-essentials')
        def t():
            page.wait_for_selector('.lrn-course'); page.wait_for_selector('#lrnTasks'); txt = page.inner_text('.lrn-tasklist'); assert 'Waiting for a reviewer' in txt, txt
        check('the course page shows the task as waiting for a reviewer', t)
        s2, r2 = api('mod', 'POST', '/admin/learna/submissions/%s/review' % sid, {'decision': 'changes', 'note': 'Look at the camera lens and keep your shoulders relaxed.'})
        check('a moderator can send the task back with a note', lambda: s2 == 200 or (_ for _ in ()).throw(AssertionError(r2)))
        page.reload(); page.wait_for_selector('#lrnTasks')
        def t():
            row = page.inner_text('.lrn-tasklist'); assert 'Changes requested' in row and 'camera lens' in row and page.locator('button:has-text("Fix it")').count() == 1, row
            page.click('button:has-text("Fix it")'); page.wait_for_selector('.lrn-review--changes', timeout=8000); assert 'camera lens' in page.inner_text('.lrn-review--changes')
            page.screenshot(path=SHOTS + '/desk-task-changes.png', full_page=True)
        check('the learner sees the reviewer\u2019s note and can reopen the task to fix it', t)
        ctx.close()

        print('\nCertificate')
        ctl('reset'); ctl('satisfy', uid='studio', course='public-speaking-essentials')
        ctx = new_ctx(pw, browser, 'studio'); page = open_learna(ctx, '&course=public-speaking-essentials'); page.wait_for_selector('#lrnCert')
        def t():
            assert page.locator('.lrn-reqs li.is-met').count() == page.locator('.lrn-reqs li').count() >= 6
            page.fill('#lrnCertName', 'A'); page.click('button:has-text("Get my certificate")'); page.wait_for_selector('#lrnCertForm .lrn-error'); assert 'full name' in page.inner_text('#lrnCertForm .lrn-error').lower()
            page.fill('#lrnCertName', 'Ada Obi'); page.click('button:has-text("Get my certificate")'); page.wait_for_selector('.lrn-certcard')
            assert 'CGN-' in page.inner_text('.lrn-certcard') and 'Ada Obi' in page.inner_text('.lrn-certcard')
            page.screenshot(path=SHOTS + '/desk-cert-issued.png', full_page=True)
        check('with every requirement met the learner can claim a certificate, and a bad name is refused', t)
        def t():
            cid = page.inner_text('.lrn-certcard code'); p2 = ctx.new_page(); p2.goto(BASE + '/certificate.html?id=' + cid); p2.wait_for_selector('.cert-sheet', timeout=10000)
            txt = p2.inner_text('.cert-sheet'); assert 'Ada Obi' in txt and 'Public Speaking Essentials' in txt and cid in txt, txt
            assert 'Valid' in p2.inner_text('.cert-status'); p2.screenshot(path=SHOTS + '/desk-certificate.png', full_page=True)
            p3 = ctx.new_page(); p3.goto(BASE + '/certificate.html?id=CGN-AAAA-BBBB-CCCC'); p3.wait_for_selector('.cert-status'); assert 'not found' in p3.inner_text('.cert-status').lower()
        check('the public certificate page shows the certificate and says "not found" for a made-up number', t)
        ctx.close()
        ctl('reset'); api('plus', 'POST', '/learna/courses/javascript-foundations/enroll')
        ctx = new_ctx(pw, browser, 'plus'); page = open_learna(ctx, '&course=javascript-foundations'); page.wait_for_selector('#lrnCert')
        def t():
            assert page.locator('#lrnCertForm').count() == 0 and page.locator('.lrn-reqs li.is-met').count() == 0
            assert 'only issued when every item above is done' in page.inner_text('#lrnCert >> xpath=..')
        check('a learner who has not met the requirements has no way to claim one', t)
        ctx.close()
        browser.close()

if __name__ == '__main__':
    run()
    bad = [r for r in results if not r[1]]
    print('\n%d/%d passed' % (len(results) - len(bad), len(results)))
    sys.exit(1 if bad else 0)
