// Taste: the design-quality score in check() (Python inside sandbox-frame.html), the picture review module,
// and the plumbing that carries the drawn pages from the browser to the server.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { cleanReviewImages, reviewPictures } from '../vision-review.js';
import { normalizeResult } from '../sandbox-tools.js';
import { MODES } from '../browser-rendering.js';

const frame = fs.readFileSync(new URL('../sandbox-frame.html', import.meta.url), 'utf8');
const py = /<script type="text\/plain" id="docs-py-src">\n([\s\S]*?)<\/script>/.exec(frame);
assert.ok(py, 'docs helper source not found in sandbox-frame.html');

// 1. The Python taste rules, run with real files built by the helper itself.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taste-'));
fs.writeFileSync(path.join(dir, 'cognita_docs.py'), py[1]);
const have = spawnSync('python3', ['-c', 'import PIL'], { encoding: 'utf8' }).status === 0;
const script = `
import sys, re, os
sys.path.insert(0, ${JSON.stringify(dir)})
import cognita_docs as c
os.makedirs('/workspace', exist_ok=True)
good = [("title","Term Plan"),("p","Fahmid Nursery and Primary School"),("h1","Where we are"),("bullets",["Enrolment is up 12 percent","Two new classrooms open in January","Staff training is on schedule"]),("h1","Fees"),("table",[["Class","Fee"],["Nursery","45,000"],["Primary","60,000"]]),("h1","Timeline"),("numbered",["Register pupils","Order books","Start lessons"]),("h1","Next steps"),("bullets",["Confirm budget","Brief parents"])]
filler = "In today's fast-paced world we must leverage synergy and delve into a robust, holistic, game-changer solution. "
wall = " ".join(["This slide explains many things at great length without any structure at all."] * 9)
bad = [("title","Plan")] + [x for k in "ABCDEF" for x in (("h1",k),("p",filler+wall))]
import io, contextlib
def run(fn, name, blocks):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        fn("/workspace/"+name, blocks)
    return buf.getvalue()
out = []
out.append("GOODPPTX " + run(c.pptx, "good.pptx", good))
out.append("BADPPTX " + run(c.pptx, "bad.pptx", bad))
out.append("GOODDOCX " + run(c.docx, "good.docx", good))
out.append("BADDOCX " + run(c.docx, "bad.docx", [("p", filler+wall*3), ("p", wall*3), ("p", wall*3)]))
out.append("GOODPDF " + run(c.pdf, "good.pdf", good))
out.append("BADPDF " + run(c.pdf, "bad.pdf", [("p", wall*4+filler)]*6))
print("\\n".join(out))
`;
const res = spawnSync('python3', ['-I', '-c', script], { encoding: 'utf8', timeout: 120000 });
assert.equal(res.status, 0, 'python run failed: ' + res.stderr);
const out = res.stdout;
const line = (tag) => (new RegExp(tag + ' ([\\s\\S]*?)(?=\\n[A-Z]{6,} |$)').exec(out) || [])[1] || '';
for (const tag of ['GOODPPTX', 'GOODDOCX', 'GOODPDF']) {
  assert.match(line(tag), /PASS/, tag + ' should pass: ' + line(tag));
  assert.match(line(tag), /taste \d+\/100/, tag + ' should report a taste score');
}
for (const tag of ['BADPPTX', 'BADDOCX', 'BADPDF']) {
  assert.match(line(tag), /NEEDS FIXES/, tag + ' should fail: ' + line(tag));
  assert.match(line(tag), /Design taste score \d+\/100/, tag + ' should fail on taste: ' + line(tag));
}
assert.match(line('BADPPTX'), /filler wording/);
assert.match(line('BADDOCX'), /headings/);
assert.match(line('BADPDF'), /hierarchy|wall of text/);
// The drawn picture is a small JPEG in a hidden folder.
assert.ok(fs.existsSync('/workspace/.cognita-taste/preview.jpg'), 'check() should draw a page picture');
assert.ok(fs.statSync('/workspace/.cognita-taste/preview.jpg').size < 140000, 'the picture must stay small enough to forward');
console.log('ok  taste scores' + (have ? '' : ' (Pillow missing: drawing skipped)'));

// 2. Source checks: the frame collects and removes the picture; the page forwards only small JPEGs.
assert.match(frame, /\.cognita-taste\/preview\.jpg/);
assert.match(frame, /tastePicture: tastePicture/);
const app = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
assert.match(app, /reviewImages/);
assert.match(app, /delete out\.tastePicture/);
console.log('ok  picture hand-off wiring');

// 3. Vision review: only small JPEGs, one call per picture, failures are silent, advice is labelled.
const jpg = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
assert.deepEqual(cleanReviewImages([{ kind: 'pages', dataUrl: 'data:image/png;base64,AAAA' }, { dataUrl: 'x' }, null]), []);
assert.equal(cleanReviewImages([{ dataUrl: jpg }, { dataUrl: jpg }, { dataUrl: jpg }]).length, 2);
let calls = 0;
const note = await reviewPictures([{ kind: 'pages', dataUrl: jpg }], { AI: {} }, { call: async () => { calls++; return { text: '- Title is too small.' }; } });
assert.equal(calls, 1);
assert.match(note, /VISION REVIEW \(advisory/);
assert.match(note, /Title is too small/);
assert.equal(await reviewPictures([{ dataUrl: jpg }], { AI: {} }, { call: async () => ({ text: 'Looks clean.' }) }), '');
assert.equal(await reviewPictures([{ dataUrl: jpg }], { AI: {} }, { call: async () => { throw new Error('boom'); } }), '');
assert.equal(await reviewPictures([{ dataUrl: jpg }], {}), '');
assert.ok(!/—/.test(await reviewPictures([{ dataUrl: jpg }], { AI: {} }, { call: async () => ({ text: 'Bad — spacing' }) })));
console.log('ok  vision review');

// 4. The server keeps review pictures out of the model's text and drops bad ones.
const n = normalizeResult({ exitCode: 0, stdout: 'x', reviewImages: [{ kind: 'pages', dataUrl: jpg }, { kind: 'pages', dataUrl: 'javascript:alert(1)' }] });
assert.equal(n.reviewImages.length, 1);
assert.ok(MODES.includes('screenshot'), 'Browser Run should offer a screenshot mode');
console.log('ok  normalizeResult + screenshot mode');

// 5. Browser Run screenshot mode: a small JPEG comes back as an image; anything else is a clean failure.
{
  const { renderRemote } = await import('../browser-rendering.js');
  const env = { CF_BROWSER_ACCOUNT_ID: 'abcdef1234567890', CF_BROWSER_API_TOKEN: 'tok' };
  const realFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (url, init) => {
    sent = { url, body: JSON.parse(init.body) };
    return new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]), { status: 200, headers: { 'content-type': 'image/jpeg' } });
  };
  try {
    const r = await renderRemote({ html: '<h1>Hi</h1>', mode: 'screenshot' }, env);
    assert.ok(r.ok && r.image && /^data:image\/jpeg;base64,/.test(r.image.dataUrl), 'screenshot should return a jpeg');
    assert.match(sent.url, /\/browser-run\/screenshot$/);
    assert.equal(sent.body.screenshotOptions.type, 'jpeg');
    globalThis.fetch = async () => new Response(JSON.stringify({ success: true, result: 'x' }), { status: 200, headers: { 'content-type': 'application/json' } });
    const bad = await renderRemote({ html: '<h1>Hi</h1>', mode: 'screenshot' }, env);
    assert.ok(!bad.ok && !bad.image, 'a non-image answer must fail cleanly');
  } finally { globalThis.fetch = realFetch; }
  console.log('ok  Browser Run screenshot mode');
}

// 6. The chat flow uses it: fallback screenshot, explicit screenshot mode, and the shared review helper.
{
  const ce = fs.readFileSync(new URL('../chat-endpoint.js', import.meta.url), 'utf8');
  assert.match(ce, /async function _applyVisionReview/);
  assert.match(ce, /mode: 'screenshot' \}, \{ uid: identity\.uid/, 'fallback path should take a cloud screenshot');
  assert.match(ce, /reviewImages: cb\.image \? \[cb\.image\] : undefined/, 'explicit screenshot mode should be reviewed');
  console.log('ok  chat flow wiring for screenshots');
}
