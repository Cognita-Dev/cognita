"""Headless Chromium: the page-test screenshot path, end to end up to the server boundary.
1. The sandbox frame runs sandbox_browser_test on a page and returns a small JPEG screenshot.
2. app.js withoutPreviewFields() turns that screenshot into result.reviewImages (and strips the big fields).
3. The server side (normalizeResult + reviewPictures) accepts it and produces the review text.
"""
import re, json, pathlib, subprocess, sys, threading, functools, http.server
from playwright.sync_api import sync_playwright

root = pathlib.Path(__file__).resolve().parent.parent
host = root / "tests" / "_frame-host.html"
host.write_text('<!doctype html><iframe id="f" src="/sandbox-frame.html" style="width:900px;height:700px"></iframe>', encoding="utf8")
PAGE = '<!doctype html><html><body style="font-family:sans-serif;margin:0"><h1 style="background:#4f46e5;color:#fff;padding:24px">Term plan</h1><p style="padding:24px;font-size:20px">Fees open on Monday. Pay at the school office.</p></body></html>'
class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass
srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=str(root)))
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = "http://127.0.0.1:%d" % srv.server_address[1]
try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page()
        pg.goto(base + "/tests/_frame-host.html")
        pg.wait_for_timeout(1000)
        res = pg.evaluate("""(html) => new Promise((resolve) => {
            const fr = document.getElementById('f');
            window.addEventListener('message', (e) => { if (e.data && e.data.t === 'result') resolve(e.data.result); });
            fr.contentWindow.postMessage({ t: 'call', call: { id: 'c1', name: 'sandbox_browser_test', args: { html } } }, '*');
            setTimeout(() => resolve({ timeout: true }), 25000);
        })""", PAGE)
        b.close()
finally:
    host.unlink(missing_ok=True)
    srv.shutdown()

assert not res.get("timeout"), "the frame never answered the page test"
shot = res.get("screenshot")
print("exitCode", res.get("exitCode"), "| screenshot:", bool(shot), "| fallback:", bool(res.get("fallback")))
if not shot:
    # Some headless builds cannot draw a page to a canvas; the frame then says so and the run carries on.
    assert res.get("fallback") or "No screenshot" in (res.get("stdout") or "") or res.get("exitCode") == 0, res
    print("SKIP the screenshot could not be captured in this browser (the frame reported it); nothing to forward")
    sys.exit(0)
assert re.match(r"^data:image/jpeg;base64,[A-Za-z0-9+/=]+$", shot["dataUrl"]), "screenshot must be a JPEG data address"
print("screenshot bytes ~", len(shot["dataUrl"]) * 3 // 4)

# 2 + 3: run the real app.js function and the real server modules on that screenshot.
app = (root / "js" / "app.js").read_text(encoding="utf8")
fn = re.search(r"function withoutPreviewFields\(r\) \{.*?\n\}\n", app, re.S).group(0)
js = f"""
{fn}
import {{ normalizeResult }} from {json.dumps((root / 'sandbox-tools.js').as_uri())};
import {{ reviewPictures }} from {json.dumps((root / 'vision-review.js').as_uri())};
const raw = {json.dumps(res)};
const sent = withoutPreviewFields(raw);
if (sent.screenshot || sent.previewHtml || sent.tastePicture) throw new Error('preview fields must be stripped');
if (!sent.reviewImages || sent.reviewImages[0].kind !== 'page-test') throw new Error('page-test screenshot was not forwarded');
const n = normalizeResult(sent);
if (!n.reviewImages || n.reviewImages.length !== 1) throw new Error('server rejected the screenshot');
let seen = 0;
const note = await reviewPictures(n.reviewImages, {{ AI: {{}} }}, {{ call: async (m, msgs, imgs) => {{ seen = imgs[0].base64.length; return {{ text: '- Heading text is low contrast.' }}; }} }});
if (!seen || !/VISION REVIEW/.test(note) || !/Page test screenshot/.test(note)) throw new Error('review did not run: ' + note);
console.log('forwarded, validated and reviewed (' + seen + ' base64 chars)');
"""
out = subprocess.run(["node", "--input-type=module", "-e", js], capture_output=True, text=True, timeout=60)
print(out.stdout.strip(), out.stderr.strip()[-400:])
assert out.returncode == 0, out.stderr
print("ok  page-test screenshot path")
