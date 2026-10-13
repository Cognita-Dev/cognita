"""On-device model frame, headless Chromium, real CSP headers (served by tests/studio-server.mjs).
Run: node tests/studio-server.mjs 8765 &  then  python3 tests/studio-ml.e2e.py
Checks: the frame starts under its own CSP, Whisper transcribes real speech, silence gives nothing, the matte model cuts out a person,
the frame cannot reach anything outside this site, the main page CSP was not weakened, cancel works."""
import json, sys, time, base64
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:8765'
fails = []
def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (' :: ' + str(detail) if detail != '' else ''))
    if not ok: fails.append(name)

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context()
    page = ctx.new_page()
    errors, csp = [], []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.on('console', lambda m: errors.append(m.text) if m.type == 'error' else None)
    page.goto(BASE + '/tests/fixtures/blank.html')
    page.evaluate("""() => { window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI)); }""")

    # 1. frame starts, runtime reports in
    t0 = time.time()
    info = page.evaluate("""async () => { const m = await import('/studio/ml-client.js'); window.__ml = m; await m.loadModel('matte'); return m.runtime(); }""")
    check('frame starts and loads the matte model under its own CSP', bool(info and info.get('wasm')), info)
    check('load time reasonable', time.time() - t0 < 60, round(time.time() - t0, 1))

    # 2. Whisper on real speech
    ref = {'speech-0.wav': 'after early nightfall the yellow lamps would light up here and there the squalid quarter of the brothels',
           'speech-1.wav': 'god as a direct consequence of the sin which man thus punished had given her a lovely child whose place was on that same dishonored bosom to connect her parent forever with the race and descent of mortals and to be finally a blessed soul in heaven'}
    def norm(s):
        import re
        return re.sub(r'\s+', ' ', re.sub(r"[^a-z ]", '', s.lower().replace('-', ' '))).strip()
    def wer(a, b):
        a, b = a.split(), b.split(); d = list(range(len(b) + 1))
        for i in range(1, len(a) + 1):
            prev, d[0] = d[0], i
            for j in range(1, len(b) + 1):
                cur = d[j]; d[j] = min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] != b[j - 1])); prev = cur
        return d[len(b)] / max(1, len(a))
    for f, expect in ref.items():
        t0 = time.time()
        r = page.evaluate("""async (f) => {
          const buf = await (await fetch('/tests/fixtures/' + f)).arrayBuffer(); const dv = new DataView(buf); const n = (buf.byteLength - 44) / 2; const pcm = new Float32Array(n);
          for (let i = 0; i < n; i++) pcm[i] = dv.getInt16(44 + i * 2, true) / 32768;
          const prog = []; const out = await window.__ml.transcribePcm(pcm, { lang: 'auto', onProgress: (m) => prog.push(m.what) });
          out.progressSeen = [...new Set(prog)]; out.seconds = n / 16000; return out; }""", f)
        text = ' '.join(s['text'] for s in r['segments'])
        w = wer(norm(expect), norm(text))
        check(f + ' transcribed (language ' + r['language'] + ', ' + str(round(time.time() - t0, 1)) + 's for ' + str(round(r['seconds'], 1)) + 's audio)', w <= 0.12 and r['language'] == 'en', 'WER %.3f | %s | %s' % (w, text[:90], json.dumps(r['segments'][:1])))
        check(f + ' has sane timestamps', all(0 <= s['start'] < s['end'] <= r['seconds'] + 0.5 for s in r['segments']), [(round(s['start'], 2), round(s['end'], 2)) for s in r['segments']])

    # 3. silence and noise give no text
    r = page.evaluate("""async () => { const a = await window.__ml.transcribePcm(new Float32Array(16000 * 8), { lang: 'en' });
      const n = new Float32Array(16000 * 8); for (let i = 0; i < n.length; i++) n[i] = (Math.random() - 0.5) * 0.02; const b = await window.__ml.transcribePcm(n, { lang: 'en' });
      return { silence: a.segments, noise: b.segments }; }""")
    check('silence gives no invented text', len(r['silence']) == 0, r['silence'])
    check('quiet noise gives no invented text', len(r['noise']) == 0, r['noise'])

    # 4. matte on a real photo
    res = page.evaluate("""async () => {
      const img = new Image(); img.src = '/tests/fixtures/photo-person.png'; await img.decode();
      const c = document.createElement('canvas'); c.width = c.height = 320; const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0, 320, 320);
      const px = x.getImageData(0, 0, 320, 320).data.buffer.slice(0);
      const t0 = performance.now(); const out = await window.__ml.matteFrames(px, 1, {}); const ms = performance.now() - t0;
      const a = new Uint8Array(out.alpha); let fg = 0; for (const v of a) if (v > 127) fg++;
      const cen = a[160 * 320 + 160], cornerAvg = (a[5 * 320 + 5] + a[5 * 320 + 314] + a[314 * 320 + 5] + a[314 * 320 + 314]) / 4;
      return { ms, fgFrac: fg / a.length, cen, cornerAvg, size: out.size, png: (() => { const m = document.createElement('canvas'); m.width = m.height = 320; const mx = m.getContext('2d'); const id = mx.createImageData(320, 320); for (let i = 0; i < a.length; i++) { id.data[i * 4] = id.data[i * 4 + 1] = id.data[i * 4 + 2] = a[i]; id.data[i * 4 + 3] = 255; } mx.putImageData(id, 0, 0); return m.toDataURL('image/png'); })() }; }""")
    open('/tmp/matte-out.png', 'wb').write(base64.b64decode(res['png'].split(',')[1]))
    check('matte: subject found (foreground share plausible)', 0.08 < res['fgFrac'] < 0.7, round(res['fgFrac'], 3))
    check('matte: subject clearly stronger than the corners', res['cen'] > 200 and res['cornerAvg'] < res['cen'] - 80, (res['cen'], round(res['cornerAvg'])))
    check('matte: ran in reasonable time', res['ms'] < 8000, round(res['ms']))

    # 5. the frame cannot talk to the outside world, and cannot read the parent
    probe = page.evaluate("""async () => {
      const f = document.querySelector('iframe'); const out = {};
      out.sandbox = f.getAttribute('sandbox');
      try { out.parentAccess = String(f.contentWindow.document.title); } catch (e) { out.parentAccess = 'blocked'; }
      return out; }""")
    check('iframe sandbox has no allow-same-origin', probe['sandbox'] == 'allow-scripts', probe['sandbox'])
    check('parent cannot read the frame DOM (opaque origin)', probe['parentAccess'] == 'blocked', probe['parentAccess'])
    # CSP of the frame, tested with real scripts under the exact production headers (a probe page served with the frame's header)
    pr = page.evaluate("""async () => new Promise((resolve) => { const f = document.createElement('iframe'); f.setAttribute('sandbox', 'allow-scripts'); f.src = '/tests/fixtures/csp-probe.html';
      const h = (e) => { if (e.source === f.contentWindow && e.data && e.data.probe) { window.removeEventListener('message', h); resolve(e.data.probe); } }; window.addEventListener('message', h); document.body.appendChild(f); setTimeout(() => resolve({ timeout: true }), 15000); })""")
    check('probe: eval and new Function are blocked', pr.get('eval') == 'blocked' and pr.get('fn') == 'blocked', pr)
    check('probe: other sites unreachable from the frame', pr.get('external') == 'blocked', pr.get('external'))
    check('probe: own model files reachable (CORS) from the opaque origin', pr.get('ownFile') == 200, pr.get('ownFile'))
    check('probe: no storage, no parent access', pr.get('storage') == 'blocked' and pr.get('parent') == 'blocked', pr)
    check('probe: WebAssembly allowed (the one narrow exception)', pr.get('wasm') == 'allowed', pr.get('wasm'))
    check('probe: blob worker starts, and inherits the no-eval rule', pr.get('worker') == 'started' and pr.get('workerEval') == 'worker-eval-blocked', (pr.get('worker'), pr.get('workerEval')))
    check('probe: worker cannot reach other sites either', pr.get('workerFetch') == 'worker-fetch-blocked', pr.get('workerFetch'))
    # the page's own CSP: no wasm-unsafe-eval, no unsafe-eval
    hdr = page.request.get(BASE + '/tests/fixtures/blank.html').headers['content-security-policy']
    check('main page CSP still has no wasm-unsafe-eval / unsafe-eval', 'wasm-unsafe-eval' not in hdr and "'unsafe-eval'" not in hdr)
    # a message with a wrong token is ignored
    bad = page.evaluate("""async () => new Promise((resolve) => { const f = document.querySelector('iframe'); const h = (e) => { if (e.source === f.contentWindow) resolve('answered'); }; window.addEventListener('message', h);
      f.contentWindow.postMessage({ op: 'load', model: 'matte', id: 'x1', token: 'wrong' }, '*'); setTimeout(() => resolve('ignored'), 1500); })""")
    check('frame ignores a request with the wrong token', bad == 'ignored', bad)

    # 6. cancel
    c = page.evaluate("""async () => { const ac = new AbortController(); const pcm = new Float32Array(16000 * 25); for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(i / 20) * 0.3 * Math.sin(i / 8000);
      const p = window.__ml.transcribePcm(pcm, { lang: 'en', signal: ac.signal }); setTimeout(() => ac.abort(), 200); try { await p; return 'finished'; } catch (e) { return e.name; } }""")
    check('cancel rejects with AbortError', c == 'AbortError', c)
    resp = page.evaluate("""async () => { const pcm = new Float32Array(16000 * 25); for (let i = 0; i < pcm.length; i++) pcm[i] = Math.sin(i / 20) * 0.3 * Math.sin(i / 8000); let ticks = 0, maxGap = 0, last = performance.now(); const iv = setInterval(() => { const n = performance.now(); maxGap = Math.max(maxGap, n - last); last = n; ticks++; }, 20); await window.__ml.transcribePcm(pcm, { lang: 'en' }); clearInterval(iv); return { ticks, maxGap }; }""")
    check('editor thread stays responsive while the model runs', resp['ticks'] > 60 and resp['maxGap'] < 300, resp)
    after = page.evaluate("""async () => { const pcm = new Float32Array(16000 * 2); const r = await window.__ml.transcribePcm(pcm, { lang: 'en' }); return Array.isArray(r.segments); }""")
    check('frame still works after a cancel', after is True)

    viol = page.evaluate('window.__csp')
    check('no CSP violations reported on the main page', len(viol) == 0, viol)
    real_errors = [e for e in errors if 'favicon' not in e.lower() and 'example.com' not in e]
    check('no page errors', len(real_errors) == 0, real_errors[:3])
    b.close()
print('\nFAILED: ' + ', '.join(fails) if fails else '\nALL PASSED')
sys.exit(1 if fails else 0)
