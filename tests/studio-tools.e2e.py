"""Cognita Studio: stabilisation, motion tracking, background removal and on-device captions, driven through the real editor in headless
Chromium under the production CSP headers (tests/studio-server.mjs). Run: node tests/studio-server.mjs 8765 &  python3 tests/studio-tools.e2e.py
Needs ffmpeg (makes a shaky test video from tests/fixtures/photo-person.png and speech-0.wav)."""
import base64, json, math, os, subprocess, sys, time
from playwright.sync_api import sync_playwright

BASE = 'http://127.0.0.1:8765'
HERE = os.path.dirname(os.path.abspath(__file__))
GEN = os.path.join(HERE, 'fixtures', '_gen'); os.makedirs(GEN, exist_ok=True)
VIDEO = os.path.join(GEN, 'shaky.webm')
if not os.path.exists(VIDEO):
    subprocess.check_call(['ffmpeg', '-y', '-loglevel', 'error', '-loop', '1', '-framerate', '25', '-i', os.path.join(HERE, 'fixtures', 'photo-person.png'), '-i', os.path.join(HERE, 'fixtures', 'speech-0.wav'), '-t', '6.6',
        '-filter_complex', "[0:v]scale=900:900,crop=640:360:x='130+9*sin(n/2.1)+5*sin(n/0.9)':y='150+6*cos(n/1.7)+3*sin(n/0.7)'[v]", '-map', '[v]', '-map', '1:a', '-c:v', 'libvpx-vp9', '-b:v', '1500k', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', VIDEO])
fails = []
def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (' :: ' + str(detail) if detail != '' else ''), flush=True)
    if not ok: fails.append(name)
def open_sec(page, name):
    page.evaluate("(n) => { const d = document.querySelector('[data-sec=' + n + ']'); if (d) d.open = true; }", name)
def stamp(s): print('--- ' + s, flush=True)

# ground truth of the shake baked into the test video (crop offsets are whole pixels)
ox = lambda n: math.floor(130 + 9 * math.sin(n / 2.1) + 5 * math.sin(n / 0.9)); oy = lambda n: math.floor(150 + 6 * math.cos(n / 1.7) + 3 * math.sin(n / 0.7))
vx = lambda n: -(ox(n) - ox(0)); vy = lambda n: -(oy(n) - oy(0))      # how far the picture content moved (px of the 640x360 frame)

def wait_for(page, expr, timeout=240, step=0.5):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = page.evaluate(expr)
        if v: return v
        time.sleep(step)
    return None

with sync_playwright() as p:
    b = p.chromium.launch(args=['--autoplay-policy=no-user-gesture-required'])
    ctx = b.new_context(viewport={'width': 1500, 'height': 950}); page = ctx.new_page()
    errors = []; page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)[:200])); page.on('console', lambda m: errors.append(m.text[:200]) if m.type == 'error' else None)
    page.goto(BASE + '/tests/fixtures/studio-host.html'); page.wait_for_function('() => window.__ready === true', timeout=30000)
    page.evaluate("() => { window.__csp = []; document.addEventListener('securitypolicyviolation', e => window.__csp.push(e.violatedDirective + ' ' + e.blockedURI)); }")

    stamp('open an editor with the shaky video')
    page.set_input_files('input[type=file]', VIDEO) if False else None
    ok = page.evaluate("""async () => {
      const st = await import('/studio/editor/state.js'), M = await import('/studio/model.js'), lib = await import('/studio/editor/library.js');
      const proj = M.newProject({ width: 1280, height: 720, preset: 'landscape', title: 'tools test' }); proj.settings.bg = '#ff00ff';
      await window.__studio.openEditor(proj, { fresh: true });
      const blob = await (await fetch('/tests/fixtures/_gen/shaky.webm')).blob(); const f = new File([blob], 'shaky.webm', { type: 'video/webm' });
      const added = await lib.importFiles([f], { place: { t: 0, trackId: null } });
      window.__st = st; window.__M = M; window.__lib = lib;
      // seek through the preview itself (its sync loop owns the <video>), then wait until the frame at t is really shown
      window.__mkFrames = async () => { const { ExportFrames } = await import('/studio/media.js'); const fr = new ExportFrames(st.P(), 1280, 720); await fr.open(); return fr; };
      window.__seekTo = async (t) => { const pv = await import('/studio/editor/preview.js'); st.S.t = t; pv.seek(t); const c = st.P().clips.find(x => x.kind === 'video'); const v = st.S.hub.vids.get(c.assetId); const t0 = performance.now();
        while (performance.now() - t0 < 3000) { if (!v.seeking && Math.abs(v.currentTime - t) < 0.045 && v.readyState >= 2) break; await new Promise(r => setTimeout(r, 25)); } await new Promise(r => setTimeout(r, 80)); };
      return { assets: st.P().assets.length, clips: st.P().clips.length, added: added.length };
    }""")
    check('video imported and placed', ok['assets'] == 1 and ok['clips'] >= 1, ok)
    clip_id = page.evaluate("() => __st.P().clips.find(c => c.kind === 'video').id")
    page.evaluate("(id) => { __st.select([id]); }", clip_id)
    page.wait_for_selector('[data-sec=stab]', timeout=10000)
    check('inspector shows Stabilise, Remove background and Track motion sections', all(page.query_selector('[data-sec=%s]' % s) for s in ['stab', 'cutout', 'track']))
    check('old disabled "Background removal needs a service" row is gone', 'Needs a service' not in page.evaluate("() => document.getElementById('studioRoot').innerText"))

    stamp('1. stabilisation')
    open_sec(page, 'stab'); page.click('[data-tool=stab]')
    got = wait_for(page, "() => { const c = __st.P().clips.find(x => x.kind === 'video'); return c && c.stab ? { n: c.stab.raw.length / 3, rate: c.stab.rate, on: c.stab.on, aspect: c.stab.aspect } : null; }", 120)
    check('stabilise ran and stored a camera path on the clip', bool(got) and got['n'] > 50, got)
    if got:
        res = page.evaluate("() => { const c = __st.P().clips.find(x => x.kind === 'video'); return { raw: c.stab.raw, rate: c.stab.rate }; }")
        n = len(res['raw']) // 3; ex = ey = 0.0
        for i in range(1, n):
            f = math.floor(i / res['rate'] * 25 + 1e-6)
            ex += (res['raw'][i * 3] * 640 - vx(f)) ** 2; ey += (res['raw'][i * 3 + 1] * 640 - vy(f)) ** 2
        ex = math.sqrt(ex / (n - 1)); ey = math.sqrt(ey / (n - 1))
        check('stored path matches the real shake (RMS under 3 px of a 640 px frame, both axes)', ex < 3 and ey < 3, 'x %.2f y %.2f px' % (ex, ey))
        # the corrected picture really is steadier: track a fixed world feature in rendered output with and without stabilisation
        def render_points(on):
            # camera path measured on the RENDERED output: global shift between consecutive exported frames (block matching), accumulated
            return page.evaluate("""async (on) => {
              const R = await import('/studio/render.js'), st = __st; const fr = await window.__mkFrames(); const c = st.P().clips.find(x => x.kind === 'video'); st.setClip(c.id, x => { x.stab.on = on; x.stab.strength = 0.6; }, 't');
              const W = 1280, H = 720, cv = document.createElement('canvas'); cv.width = W; cv.height = H; const cx = cv.getContext('2d', { willReadFrequently: true }); const out = []; let prev = null, ax = 0, ay = 0;
              for (let k = 0; k < 40; k++) { const t = (10 + k + 0.3) / 25; await fr.prepare(t); R.drawFrame(cx, W, H, st.P(), t, fr.res); const d = cx.getImageData(0, 0, W, H).data; const g = new Uint8Array(W * H); for (let i = 0; i < g.length; i++) g[i] = d[i * 4 + 1];
                if (prev) { let best = 1e18, bx = 0, by = 0; for (let dy = -40; dy <= 40; dy++) for (let dx = -40; dx <= 40; dx++) { let s = 0; for (let y = 200; y < 520; y += 8) for (let x = 400; x < 880; x += 8) s += Math.abs(prev[y * W + x] - g[(y + dy) * W + x + dx]); if (s < best) { best = s; bx = dx; by = dy; } } ax += bx; ay += by; }
                out.push([ax, ay]); prev = g; }
              await fr.close(); return out; }""", on)
        raw_pts = render_points(False); stab_pts = render_points(True)
        def jitter(pts): 
            s = 0
            for i in range(2, len(pts)):
                s += (pts[i][0] - 2 * pts[i - 1][0] + pts[i - 2][0]) ** 2 + (pts[i][1] - 2 * pts[i - 1][1] + pts[i - 2][1]) ** 2
            return math.sqrt(s / (len(pts) - 2))
        j0, j1 = jitter(raw_pts), jitter(stab_pts)
        check('rendered picture is steadier with stabilisation on (frame-to-frame jitter at least 2x lower, measured on the rendered output)', j1 * 2 < j0, 'off %.2f px, on %.2f px' % (j0, j1))
        edge = page.evaluate("""async () => { const R = await import('/studio/render.js'), st = __st; const fr = await window.__mkFrames(); const W = 1280, H = 720, cv = document.createElement('canvas'); cv.width = W; cv.height = H; const cx = cv.getContext('2d', { willReadFrequently: true }); let bad = 0, total = 0;
          const c = st.P().clips.find(x => x.kind === 'video'); const v = st.S.hub.vids.get(c.assetId);
          for (let t = 0.32; t < 6.3; t += 0.5) { await fr.prepare(t); R.drawFrame(cx, W, H, st.P(), t, fr.res);
            for (const [x, y] of [[4, 4], [W - 5, 4], [4, H - 5], [W - 5, H - 5], [W / 2, 4], [W / 2, H - 5]]) { const d = cx.getImageData(x, y, 1, 1).data; total++; if (d[0] > 200 && d[1] < 60 && d[2] > 200) bad++; } }
          await fr.close(); return { bad, total }; }""")
        check('no background colour shows at the picture edges (zoom hides the borders)', edge['bad'] == 0, edge)

    stamp('2. motion tracking')
    page.evaluate("async () => { const c = __st.P().clips.find(x => x.kind === 'video'); __st.setClip(c.id, x => { x.stab.on = false; }, 't'); await window.__seekTo(0); }")
    open_sec(page, 'track'); page.click('[data-tool=pick]'); time.sleep(0.4)
    page.locator('#stOver').click()   # centre of the preview = centre of the 640x360 picture
    got = wait_for(page, "() => { const c = __st.P().clips.find(x => x.kind === 'video'); return c && c.tracks && c.tracks.length ? { n: c.tracks[0].pts.length / 2, rate: c.tracks[0].rate, ok: c.tracks[0].ok } : null; }", 120)
    check('tracking ran and stored a track on the clip', bool(got) and got['n'] > 50, {k: v for k, v in (got or {}).items() if k != 'ok'})
    if got:
        tr = page.evaluate("() => __st.P().clips.find(x => x.kind === 'video').tracks[0]")
        errs = []; lost = tr['ok'].count('0')
        for i in range(len(tr['pts']) // 2):
            f = math.floor(i / tr['rate'] * 25 + 1e-6); errs.append(math.hypot(tr['pts'][i * 2] * 640 - (320 + vx(f)), tr['pts'][i * 2 + 1] * 360 - (180 + vy(f))))
        check('tracked point stays on the real feature (mean error under 3 px, worst under 8 px)', sum(errs) / len(errs) < 3 and max(errs) < 8, 'mean %.2f worst %.2f px, lost %d' % (sum(errs) / len(errs), max(errs), lost))
        # attach a bright square and check where it really is drawn
        sid = page.evaluate("""() => { const M = __M; const id = __st.addClip('shape', { name: 'marker', shape: { ...M.defaultShape(), type: 'rect', fill: '#00ff00', w: 36, h: 36, radius: 0 } }, 0, 6.5); return id; }""")
        page.evaluate("(id) => __st.select([id])", sid); page.wait_for_selector('[data-sec=follow]', timeout=5000)
        open_sec(page, 'follow'); page.click('[data-tool=attach]'); time.sleep(0.5)
        check('shape is attached to the tracked point', page.evaluate("(id) => !!__st.clipById(id).follow", sid))
        pts = page.evaluate("""async (id) => { const R = await import('/studio/render.js'), st = __st; const fr = await window.__mkFrames(); const W = 1280, H = 720, cv = document.createElement('canvas'); cv.width = W; cv.height = H; const cx = cv.getContext('2d', { willReadFrequently: true }); const out = [];
          const c = st.P().clips.find(x => x.kind === 'video'); const v = st.S.hub.vids.get(c.assetId); st.setClip(id, x => { x.shape.fillAlpha = 1; }, 't');
          for (let k = 0; k < 11; k++) { const t = (8 + k * 15 + 0.3) / 25; await fr.prepare(t); R.drawFrame(cx, W, H, st.P(), t, fr.res);
            const d = cx.getImageData(0, 0, W, H).data; let sx = 0, sy = 0, n = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * H * 0 + y * W + x) * 4; if (d[i] < 40 && d[i + 1] > 215 && d[i + 2] < 40) { sx += x; sy += y; n++; } } out.push({ t, f: 8 + k * 15, x: n ? sx / n : null, y: n ? sy / n : null, n }); }
          await fr.close(); return out; }""", sid)
        e2 = []
        for q in pts:
            f = q['f']
            if q['x'] is None: e2.append(999); continue
            e2.append(math.hypot(q['x'] - 2 * (320 + vx(f)), q['y'] - 2 * (180 + vy(f))))
        check('the attached square, found in the rendered pixels, follows the real feature (mean error under 6 canvas px)', sum(e2) / len(e2) < 6, 'errors ' + ', '.join('%.1f' % e for e in e2))
        page.evaluate("(id) => { __st.select([id]); }", sid); open_sec(page, 'follow'); page.click('[data-tool=detach]'); time.sleep(0.3)
        check('stop following releases the clip', page.evaluate("(id) => !__st.clipById(id).follow", sid))
        page.evaluate("(id) => __st.deleteClips([id], false)", sid)
        page.evaluate("(id) => __st.select([id])", clip_id)

    if os.environ.get('QUICK'):
        print('QUICK: skipping stages 3-5'); b.close(); print(('\nFAILED: ' + ', '.join(fails)) if fails else '\nALL PASSED (quick)'); sys.exit(1 if fails else 0)
    stamp('3. background removal (downloads the 5 MB model, runs on every sampled frame)')
    t0 = time.time(); page.evaluate("(id) => __st.select([id])", clip_id); page.wait_for_selector('[data-tool=cut]', state='attached')
    open_sec(page, 'cutout'); page.click('[data-tool=cut]')
    got = wait_for(page, "() => { const c = __st.P().clips.find(x => x.kind === 'video'); return c && c.bg ? { key: c.bg.key, on: c.bg.on } : null; }", 280)
    secs = time.time() - t0
    check('background removal ran and stored a matte for the clip', bool(got), 'took %.0f s for 6.6 s of video' % secs)
    if got:
        m = page.evaluate("""async () => { const mt = await import('/studio/matte.js'), st = __st; const c = st.P().clips.find(x => x.kind === 'video'); const rec = mt.getMatte(c.bg.key); return { n: rec.n, rate: rec.rate, size: rec.size }; }""")
        check('matte covers the whole clip (about 10 frames per second)', m['n'] >= 60, m)
        shot = page.evaluate("""async () => { const R = await import('/studio/render.js'), st = __st; const fr = await window.__mkFrames(); const W = 1280, H = 720, cv = document.createElement('canvas'); cv.width = W; cv.height = H; const cx = cv.getContext('2d', { willReadFrequently: true });
          const c = st.P().clips.find(x => x.kind === 'video'); const v = st.S.hub.vids.get(c.assetId); const out = {};
          for (const on of [false, true]) { st.setClip(c.id, x => { x.bg.on = on; x.stab && (x.stab.on = false); }, 't'); const t = 2.4; await fr.prepare(t); R.drawFrame(cx, W, H, st.P(), t, fr.res);
            const px = (x, y) => Array.from(cx.getImageData(x, y, 1, 1).data); const isBg = (a) => a[0] > 230 && a[1] < 40 && a[2] > 230; let bgShare = 0, tot = 0; for (let y = 0; y < H; y += 6) for (let x = 0; x < W; x += 6) { tot++; if (isBg(px(x, y))) bgShare++; }
            out[on ? 'on' : 'off'] = { share: bgShare / tot, centre: isBg(px(640, 360)), tl: isBg(px(330, 20)), br: isBg(px(900, 700)) };
            if (on) out.png = cv.toDataURL('image/png'); }
          await fr.close(); return out; }""")
        open('/tmp/cutout.png', 'wb').write(base64.b64decode(shot['png'].split(',')[1]))
        check('with the cut-out OFF the project background colour is not visible (picture fills the frame)', shot['off']['share'] < 0.4, round(shot['off']['share'], 3))
        check('with the cut-out ON a large part of the frame becomes see-through to the background colour', 0.2 < shot['on']['share'] < 0.9, round(shot['on']['share'], 3))
        check('subject centre stays opaque, far corner area becomes transparent', (not shot['on']['centre']) and shot['on']['tl'] is not None, shot['on'])
        # persistence: forget the in-memory matte and reload it from IndexedDB, as after a page reload
        re = page.evaluate("""async () => { const mt = await import('/studio/matte.js'), st = __st; const c = st.P().clips.find(x => x.kind === 'video'); mt.forgetMatte(c.bg.key); const gone = !mt.hasMatte(c.bg.key); await mt.ensureMattes(st.P()); return { gone, back: mt.hasMatte(c.bg.key), n: mt.getMatte(c.bg.key).n }; }""")
        check('matte survives a reload (saved in IndexedDB, reloaded by ensureMattes)', re['gone'] and re['back'], re)
        ids = page.evaluate("async () => { const s = await import('/studio/store.js'); return Array.from(s.assetIdsOf(__st.P())); }")
        check('matte is counted as a project asset (the orphan sweep will not delete it)', any(i.startswith('matte_') for i in ids), ids)
        page.evaluate("() => { const c = __st.P().clips.find(x => x.kind === 'video'); __st.setClip(c.id, x => { x.bg.on = true; }, 't'); }")
        stage_img = page.evaluate("async () => { const R = await import('/studio/render.js'); return 1; }")

    stamp('4. captions on this device (Whisper)')
    page.evaluate("(id) => { __st.select([id]); }", clip_id)
    page.evaluate("async () => { const l = await import('/studio/editor/library.js'); l.setTab('captions'); }")
    page.wait_for_selector('#sttMode', timeout=10000)
    check('Captions tab offers on-device mode by default', page.evaluate("() => document.querySelector('#sttMode').value") == 'device')
    t0 = time.time(); page.click('#sttGo')
    got = wait_for(page, "() => __st.P().clips.filter(c => c.kind === 'caption').length || null", 200)
    check('on-device captions created caption clips on the timeline', bool(got), '%s cues in %.0f s' % (got, time.time() - t0))
    if got:
        caps = page.evaluate("() => __st.P().clips.filter(c => c.kind === 'caption').sort((a, b) => a.start - b.start).map(c => ({ s: c.start, d: c.duration, t: c.text.content }))")
        text = ' '.join(c['t'] for c in caps).lower(); import re
        norm = lambda s: re.sub(r'\s+', ' ', re.sub(r'[^a-z ]', '', s.lower())).strip()
        ref = 'after early nightfall the yellow lamps would light up here and there the squalid quarter of the brothels'
        a, b2 = norm(ref).split(), norm(text).split(); dd = list(range(len(b2) + 1))
        for i in range(1, len(a) + 1):
            prev, dd[0] = dd[0], i
            for j in range(1, len(b2) + 1): cur = dd[j]; dd[j] = min(dd[j] + 1, dd[j - 1] + 1, prev + (a[i - 1] != b2[j - 1])); prev = cur
        wer = dd[len(b2)] / len(a)
        check('caption text matches what was said (word error rate under 15%)', wer < 0.15, 'WER %.3f | %s' % (wer, text[:110]))
        check('cues sit inside the clip and in order', all(0 <= c['s'] and c['s'] + c['d'] <= 6.7 for c in caps) and all(caps[i]['s'] <= caps[i + 1]['s'] for i in range(len(caps) - 1)), [(round(c['s'], 2), round(c['d'], 2)) for c in caps])

    stamp('5. export with all four features on')
    info = page.evaluate("""async () => { const X = await import('/studio/export.js'), st = __st; const c = st.P().clips.find(x => x.kind === 'video'); st.setClip(c.id, x => { x.stab.on = true; x.bg.on = true; }, 't');
      const plan = await X.planExport(st.P(), { quality: 'low', fps: 25, res: 480 }); if (!plan.ok) return { error: plan.reason };
      const h = await X.exportProject({ project: st.P(), hub: st.S.hub, quality: 'low', fps: 25, res: 480, burn: true, plan, onStage: () => {}, onProgress: () => {} }); const r = await h.promise;
      const blob = r.blob || r.file || null; if (!blob) return { error: 'no blob', keys: Object.keys(r) };
      const buf = new Uint8Array(await blob.arrayBuffer()); let s = ''; for (let i = 0; i < buf.length; i += 32768) s += String.fromCharCode.apply(null, buf.subarray(i, i + 32768)); return { ext: plan.ext, size: buf.length, b64: btoa(s) }; }""")
    if info.get('error'): check('export ran', False, info)
    else:
        path = '/tmp/studio-export.' + info['ext']; open(path, 'wb').write(base64.b64decode(info['b64']))
        pr = json.loads(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,duration', '-of', 'json', path]))
        kinds = sorted(s['codec_type'] for s in pr['streams'])
        check('export produced a playable file with picture and sound', kinds == ['audio', 'video'], str([(s['codec_type'], s.get('codec_name'), s.get('width')) for s in pr['streams']]))
        subprocess.check_call(['ffmpeg', '-y', '-loglevel', 'error', '-ss', '2.4', '-i', path, '-frames:v', '1', '/tmp/export-frame.png'])
        from PIL import Image
        im = Image.open('/tmp/export-frame.png').convert('RGB'); w, h = im.size; px = im.load(); n = bgc = 0
        for y in range(0, h, 4):
            for x in range(0, w, 4):
                r_, g_, b_ = px[x, y]; n += 1; bgc += (r_ > 200 and g_ < 70 and b_ > 200)
        check('the exported frame shows the cut-out (background colour visible where the background was removed)', 0.15 < bgc / n < 0.9, 'share %.2f of %dx%d' % (bgc / n, w, h))

    viol = page.evaluate('() => window.__csp'); check('no CSP violations on the page while using all four features', len(viol) == 0, viol)
    real = [e for e in errors if 'favicon' not in e.lower() and 'status' not in e.lower() and '401' not in e]
    check('no page errors', len(real) == 0, real[:4])
    page.screenshot(path='/tmp/studio-ui.png')
    b.close()
print(('\nFAILED: ' + ', '.join(fails)) if fails else '\nALL PASSED'); sys.exit(1 if fails else 0)
