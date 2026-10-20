// API + safety tests for the service Cognita calls.   npm run test:api
// Needs Chromium (set CHROMIUM_PATH to use one that is already installed).
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';

process.env.DOCSTUDIO_TOKEN = 'test-token';
process.env.DOCSTUDIO_UI = 'off';
process.env.MAX_CONCURRENT = '2';
const { app } = await import('./server.js');
const { sanitizeSpec } = await import('./src/sanitize.js');
const { exportAs, closeBrowser } = await import('./src/export.js');

const server = await new Promise((r) => { const s = app.listen(0, () => r(s)); });
const base = `http://127.0.0.1:${server.address().port}`;
const auth = { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' };
const post = (path, body, headers = auth) => fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) });

// a tiny valid PNG (solid colour) used as a "photo" and a "logo"
function png(w, h, [r, g, b]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, (_, x) => [Math.round(r * (0.4 + 0.6 * x / w)), g, b]).flat())]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const dataUri = (buf) => 'data:image/png;base64,' + buf.toString('base64');
const photo = dataUri(png(400, 300, [200, 90, 60]));
const logo = dataUri(png(120, 40, [20, 60, 140]));

const magic = (b64) => Buffer.from(b64, 'base64').subarray(0, 4).toString('latin1');

test('health is public', async () => {
  const j = await (await fetch(base + '/api/health')).json();
  assert.equal(j.ok, true);
  assert.equal(j.designs, 8);
});

test('render and export need the token', async () => {
  assert.equal((await post('/api/render', { spec: {} }, { 'Content-Type': 'application/json' })).status, 401);
  assert.equal((await post('/api/render', { spec: {} }, { Authorization: 'Bearer wrong', 'Content-Type': 'application/json' })).status, 401);
  assert.equal((await post('/api/export', { spec: {}, format: 'pdf' }, { 'Content-Type': 'application/json' })).status, 401);
});

test('the browser studio is not served when DOCSTUDIO_UI=off', async () => {
  assert.equal((await fetch(base + '/')).status, 404);
  assert.equal((await fetch(base + '/api/examples')).status, 404);
});

test('bad input is refused with JSON', async () => {
  assert.equal((await post('/api/render', { spec: 'nope' })).status, 400);
  const r = await fetch(base + '/api/render', { method: 'POST', headers: auth, body: '{bad json' });
  assert.equal(r.status, 400);
  assert.ok((await r.json()).error);
});

test('document → pdf + docx + preview', async () => {
  const r = await post('/api/render', { spec: { kind: 'document', design: 'editorial', title: 'Quarterly review', subtitle: 'Q3', blocks: [{ type: 'h2', text: 'Summary' }, { type: 'p', text: 'Revenue grew **12%**.' }, { type: 'table', head: ['A', 'B'], rows: [['1', '2']] }] } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.kind, 'document');
  assert.deepEqual(j.files.map((f) => f.format), ['pdf', 'docx']);
  assert.equal(magic(j.files[0].content), '%PDF');
  assert.equal(magic(j.files[1].content).slice(0, 2), 'PK');
  assert.equal(j.files[0].name, 'quarterly-review.pdf');
  assert.equal(Buffer.from(j.preview.content, 'base64')[0], 0xff); // JPEG
  assert.ok(j.preview.content.length < 400000, 'preview stays small');
});

test('markdown input works', async () => {
  const j = await (await post('/api/render', { spec: { design: 'swiss', markdown: '# Hello\n\n## Part one\n\nText here.\n\n- a\n- b' }, formats: ['pdf'] })).json();
  assert.deepEqual(j.files.map((f) => f.format), ['pdf']);
  assert.equal(j.files[0].name, 'hello.pdf');
});

test('markdown input also reaches the Word file (not an empty page)', async () => {
  const buf = await exportAs(sanitizeSpec({ design: 'editorial', markdown: '# Plan\n\n## Phase one\n\nBuild the thing.' }), 'docx');
  const xml = await new Promise((resolve, reject) => {
    // a .docx is a zip; the body text is stored deflated in word/document.xml
    const chunks = [];
    let i = 0;
    while (i < buf.length - 30) {
      if (buf.readUInt32LE(i) === 0x04034b50) {
        const method = buf.readUInt16LE(i + 8); const csize = buf.readUInt32LE(i + 18);
        const nlen = buf.readUInt16LE(i + 26); const xlen = buf.readUInt16LE(i + 28);
        const name = buf.toString('latin1', i + 30, i + 30 + nlen);
        const start = i + 30 + nlen + xlen;
        if (name === 'word/document.xml') { const raw = buf.subarray(start, start + csize); return resolve((method === 8 ? zlib.inflateRawSync(raw) : raw).toString('utf8')); }
        i = start + csize;
      } else i++;
    }
    reject(new Error('document.xml not found'));
  });
  assert.match(xml, /Phase one/);
  assert.match(xml, /Build the thing/);
});

test('slides → pptx + pdf', async () => {
  const j = await (await post('/api/render', { spec: { kind: 'slides', design: 'aurora', slides: [{ layout: 'title', title: 'Hi', subtitle: 'There' }, { layout: 'bullets', title: 'Points', bullets: ['one', 'two'] }, { layout: 'stat', value: '42%', title: 'Growth' }] } })).json();
  assert.deepEqual(j.files.map((f) => f.format), ['pptx', 'pdf']);
  assert.equal(magic(j.files[0].content).slice(0, 2), 'PK');
  assert.equal(magic(j.files[1].content), '%PDF');
});

test('sheet → xlsx', async () => {
  const j = await (await post('/api/render', { spec: { kind: 'sheet', sheets: [{ name: 'Budget', columns: [{ header: 'Item' }, { header: 'Cost', format: '$#,##0' }], rows: [['Rent', 1200], ['Food', 400], ['Total', '=SUM(B2:B3)']] }] } })).json();
  assert.deepEqual(j.files.map((f) => f.format), ['xlsx']);
  assert.equal(magic(j.files[0].content).slice(0, 2), 'PK');
});

test('formats that do not fit the kind are ignored', async () => {
  const j = await (await post('/api/render', { spec: { kind: 'poster', design: 'brutal', headline: 'Hello' }, formats: ['docx', 'png'] })).json();
  assert.deepEqual(j.files.map((f) => f.format), ['png']);
  const k = await (await post('/api/render', { spec: { kind: 'poster', design: 'brutal', headline: 'Hello' }, formats: ['docx'] })).json();
  assert.deepEqual(k.files.map((f) => f.format), ['png', 'pdf']); // nothing valid asked → the default set
});

test('poster with a photo and a logo renders on every design', async () => {
  for (const design of ['editorial', 'swiss', 'brutal', 'luxe', 'bauhaus', 'botanical', 'newsprint', 'aurora']) {
    const j = await (await post('/api/render', { spec: { kind: 'poster', design, size: 'a4', headline: 'Open day', kicker: 'Admissions', subheadline: 'Meet the teachers', details: ['Date: Sat 12 July', 'Venue: City Hall'], cta: 'Register', footer: 'school.example', image: photo, logo }, formats: ['png'] })).json();
    assert.equal(magic(j.files[0].content), '\x89PNG', design);
  }
});

test('a photo changes the poster', async () => {
  const spec = { kind: 'poster', design: 'swiss', size: 'square', headline: 'Same text' };
  const a = await exportAs(sanitizeSpec(spec), 'png');
  const b = await exportAs(sanitizeSpec({ ...spec, image: photo }), 'png');
  assert.notDeepEqual(a, b);
});

test('sanitizeSpec removes css, bad colours, unknown fonts and url pictures', () => {
  const s = sanitizeSpec({
    kind: 'poster', headline: 'x', css: 'body{background:url(http://evil)}',
    colors: { accent: '#ff0000', bg: 'red;}body{x:y', ink: 'url(http://evil)', bogus: '#000' },
    fonts: { head: 'Inter', body: 'Comic Sans' },
    image: 'http://evil.example/a.png', logo: 'javascript:alert(1)',
    blocks: [{ type: 'image', src: 'https://evil.example/x.png' }, { type: 'p', text: 'ok' }, { type: 'script', text: 'x' }],
  });
  assert.equal(s.css, undefined);
  assert.deepEqual(s.colors, { accent: '#ff0000' });
  assert.deepEqual(s.fonts, { head: 'Inter' });
  assert.equal(s.image, undefined);
  assert.equal(s.logo, undefined);
  assert.deepEqual(s.blocks, [{ type: 'p', text: 'ok' }]);
});

test('sanitizeSpec caps sizes', () => {
  const s = sanitizeSpec({ kind: 'slides', slides: Array.from({ length: 500 }, () => ({ title: 'x'.repeat(5000), bullets: Array.from({ length: 50 }, () => 'b') })) });
  assert.equal(s.slides.length, 60);
  assert.ok(s.slides[0].title.length <= 400);
  assert.ok(s.slides[0].bullets.length <= 12);
});

test('the renderer never fetches a URL, even if one reaches it', async () => {
  let hits = 0;
  const trap = await new Promise((r) => { const s = http.createServer((_q, res) => { hits++; res.end('x'); }); s.listen(0, '127.0.0.1', () => r(s)); });
  const url = `http://127.0.0.1:${trap.address().port}/p.png`;
  // bypass sanitizeSpec on purpose: this is the second line of defence
  await exportAs({ kind: 'document', title: 'T', blocks: [{ type: 'image', src: url }, { type: 'p', text: 'x' }], css: `body{background:url(${url})}` }, 'pdf');
  await exportAs({ kind: 'poster', headline: 'T', css: `.poster{background:url(${url})}` }, 'png');
  trap.close();
  assert.equal(hits, 0);
});

test('a burst of renders all complete (queue)', async () => {
  const spec = { kind: 'poster', design: 'luxe', headline: 'Burst', size: 'square' };
  const rs = await Promise.all(Array.from({ length: 6 }, () => post('/api/render', { spec, formats: ['png'] })));
  assert.deepEqual(rs.map((r) => r.status), [200, 200, 200, 200, 200, 200]);
});

test.after(async () => { server.close(); await closeBrowser(); });
