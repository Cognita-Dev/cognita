"""Headless Chromium: the sandbox frame page still parses and starts after the taste changes, and its embedded
Python source (docs helper with the taste rules) compiles."""
import re, sys, pathlib
from playwright.sync_api import sync_playwright
root = pathlib.Path(__file__).resolve().parent.parent
html = (root / "sandbox-frame.html").read_text(encoding="utf8")
m = re.search(r'<script type="text/plain" id="docs-py-src">\n(.*?)</script>', html, re.S)
compile(m.group(1), "cognita_docs", "exec")
errors = []
with sync_playwright() as p:
    b = p.chromium.launch()
    pg = b.new_page()
    pg.on("pageerror", lambda e: errors.append(str(e)))
    pg.goto((root / "sandbox-frame.html").as_uri())
    pg.wait_for_timeout(800)
    src = pg.evaluate("document.getElementById('docs-py-src').textContent")
    assert "def _taste(" in src and "_TASTE_PASS = 78" in src
    # every inline JS worker source must be valid JavaScript
    for wid in ("js-worker-src", "py-worker-src"):
        ok = pg.evaluate("(id) => { try { new Function(document.getElementById(id).textContent); return true; } catch (e) { return String(e); } }", wid)
        assert ok is True, (wid, ok)
    b.close()
real = [e for e in errors if "parent" not in e.lower() and "VFS" not in e]
assert not real, real
print("ok  frame loads in Chromium; Python and worker sources valid")
