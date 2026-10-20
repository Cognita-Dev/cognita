// doc-studio integration: the Worker client, the create_document / create_design tools, the prompt and the intent gate.
// No network and no Chromium: the service is faked. (doc-studio/test-api.js tests the real service.)
import assert from 'node:assert/strict';
import { docStudioConfigured, docStudioBase, renderWithDocStudio, checkResult } from '../docstudio-client.js';
import * as media from '../media-tools.js';
import { buildChatSystemPrompt } from '../prompts.js';
import { shouldOfferSandbox } from '../sandbox-intent.js';

let passed = 0;
const t = async (name, fn) => { try { await fn(); passed++; console.log('ok  ' + name); } catch (e) { console.error('FAIL ' + name + '\n  ' + (e && e.stack || e)); process.exitCode = 1; } };

const B64 = Buffer.from('hello pdf').toString('base64');
const goodReply = (over = {}) => ({ kind: 'document', design: { id: 'editorial', name: 'Editorial' }, preview: { mime: 'image/jpeg', content: B64 }, files: [{ format: 'pdf', name: 'report.pdf', mime: 'application/pdf', size: 9, content: B64 }, { format: 'docx', name: 'report.docx', mime: 'application/x-x', size: 9, content: B64 }], ...over });
const fakeFetch = (status, body, calls = []) => async (url, init) => { calls.push({ url, init }); return { ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) }; };

// KV that counts usage like the real one
function env(extra = {}) {
  const kv = new Map();
  return { DOCSTUDIO_URL: 'https://ds.example.com/', DOCSTUDIO_TOKEN: 'tok', COGNITA_USAGE: { get: async (k) => (kv.has(k) ? kv.get(k) : null), put: async (k, v) => { kv.set(k, v); } }, _kv: kv, ...extra };
}
const PLAN = { limits: { documentGenPerDay: 2, imageGenPerDay: 5 } };

await t('configured only with a usable https url', () => {
  assert.equal(docStudioConfigured({}), false);
  assert.equal(docStudioConfigured({ DOCSTUDIO_URL: '  ' }), false);
  assert.equal(docStudioBase({ DOCSTUDIO_URL: 'https://ds.example.com/' }), 'https://ds.example.com');
  assert.equal(docStudioBase({ DOCSTUDIO_URL: 'http://ds.example.com' }), null);
  assert.equal(docStudioBase({ DOCSTUDIO_URL: 'http://localhost:3333' }), 'http://localhost:3333');
  assert.equal(docStudioBase({ DOCSTUDIO_URL: 'https://u:p@ds.example.com' }), null);
  assert.equal(docStudioBase({ DOCSTUDIO_URL: 'not a url' }), null);
});

await t('client sends the token and the spec, and shapes the reply', async () => {
  const calls = [];
  const out = await renderWithDocStudio(env(), { kind: 'document', title: 'T' }, ['pdf'], { fetch: fakeFetch(200, goodReply(), calls) });
  assert.equal(calls[0].url, 'https://ds.example.com/api/render');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer tok');
  assert.deepEqual(JSON.parse(calls[0].init.body), { spec: { kind: 'document', title: 'T' }, formats: ['pdf'] });
  assert.equal(out.files.length, 2);
  assert.equal(out.preview.mime, 'image/jpeg');
  assert.equal(out.design.name, 'Editorial');
});

await t('client error codes', async () => {
  const code = async (f, e = env()) => { try { await renderWithDocStudio(e, {}, undefined, { fetch: f }); } catch (x) { return x.code; } return 'none'; };
  assert.equal(await code(fakeFetch(400, { error: 'bad' })), 'rejected');
  assert.equal(await code(fakeFetch(401, { error: 'no' })), 'rejected');
  assert.equal(await code(fakeFetch(500, { error: 'boom' })), 'failed');
  assert.equal(await code(fakeFetch(200, 'not json')), 'bad_response');
  assert.equal(await code(fakeFetch(200, { files: [] })), 'bad_response');
  assert.equal(await code(async () => { throw new Error('down'); }), 'unreachable');
  assert.equal(await code(async (_u, init) => new Promise((_r, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' }))))), 'timeout'.replace('timeout', 'timeout'), 'timeout path');
  assert.equal(await code(fakeFetch(200, goodReply()), {}), 'not_configured');
});

await t('checkResult refuses odd files and cleans names', () => {
  assert.throws(() => checkResult({ files: [{ name: 'a.pdf', content: 'not base64!!' }] }), /broken file/);
  assert.throws(() => checkResult({ files: Array.from({ length: 9 }, () => ({ name: 'a.pdf', content: B64 })) }), /no files/);
  const r = checkResult({ files: [{ format: 'pdf', name: '../../etc/pass wd.pdf', content: B64 }], preview: { mime: 'text/html', content: B64 } });
  assert.equal(r.files[0].name, 'etc-pass-wd.pdf');
  assert.equal(r.preview, null);
});

// the client test above for 'timeout' needs a short timeout to finish quickly
await t('client times out', async () => {
  let code = '';
  try { await renderWithDocStudio(env(), {}, undefined, { timeoutMs: 30, fetch: (_u, init) => new Promise((_r, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' })))) }); } catch (e) { code = e.code; }
  assert.equal(code, 'timeout');
});

await t('create_document is offered only when docs are on', () => {
  const names = (o) => media.toolSchemas(o).map((x) => x.function.name);
  assert.deepEqual(names(), ['generate_image', 'create_design']);
  assert.deepEqual(names({ docs: false }), ['generate_image', 'create_design']);
  assert.deepEqual(names({ docs: true }), ['generate_image', 'create_design', 'create_document']);
  assert.ok(media.isMediaTool('create_document'));
});

await t('intent: documents trigger the tools only when docs are on', () => {
  const asks = ['Write me a project proposal as a Word document', 'Make a pitch deck for my startup', 'I need a CV', 'create a PDF report on malaria', 'budget spreadsheet for my wedding'];
  for (const text of asks) {
    assert.equal(media.shouldOfferMedia({ text, docs: false }).offer && /doc-/.test(media.shouldOfferMedia({ text, docs: false }).reason), false, text);
    assert.equal(media.shouldOfferMedia({ text, docs: true }).offer, true, text);
  }
  assert.equal(media.shouldOfferMedia({ text: 'what is the capital of Ghana?', docs: true }).offer, false);
  assert.equal(media.shouldOfferMedia({ text: 'hello', docs: true }).offer, false);
});

await t('validateArgs for create_document', () => {
  const v = (a) => media.validateArgs('create_document', a);
  assert.equal(v({ kind: 'document', title: 'T', markdown: '# T\n\ntext' }).ok, true);
  assert.equal(v({ kind: 'document', title: 'T', blocks: [{ type: 'p', text: 'x' }] }).ok, true);
  assert.deepEqual(v({ kind: 'document', title: 'T' }).missing, ['markdown or blocks']);
  assert.deepEqual(v({ kind: 'slides', title: 'T' }).missing, ['slides']);
  assert.deepEqual(v({ kind: 'sheet', title: 'T' }).missing, ['sheets']);
  assert.deepEqual(v({ kind: 'document', markdown: 'x' }).missing, ['title']);
  assert.equal(v({ title: 'T', slides: [{ title: 'a' }] }).ok, true, 'kind inferred from slides');
});

await t('documentSpecFrom builds the right spec', () => {
  const d = media.documentSpecFrom({ kind: 'document', title: 'T', markdown: '# T', design: 'LUXE', author: '[Your name]', date: '1 May', blocks: [] });
  assert.deepEqual(d, { kind: 'document', title: 'T', design: 'luxe', date: '1 May', markdown: '# T' });
  const s = media.documentSpecFrom({ kind: 'slides', title: 'T', design: 'nope', slides: [{ title: 'a' }] });
  assert.equal(s.design, undefined);
  assert.equal(s.slides.length, 1);
  const x = media.documentSpecFrom({ title: 'T', sheets: [{ name: 'A' }] });
  assert.equal(x.kind, 'sheet');
});

// run execute() with the global fetch faked
async function exec(name, args, e, ctx = {}) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = fakeFetch(e._status || 200, e._body || goodReply(), calls);
  try { return { out: await media.execute(name, args, { uid: 'u1', plan: PLAN, env: e, ...ctx }), calls }; } finally { globalThis.fetch = real; }
}

await t('create_document returns a docfile media item and counts the quota', async () => {
  const e = env();
  const { out, calls } = await exec('create_document', { kind: 'document', title: 'Report', markdown: '# Report\n\nBody' }, e);
  assert.equal(out.ok, true);
  assert.equal(out.media.kind, 'docfile');
  assert.equal(out.media.docKind, 'document');
  assert.equal(out.media.files.length, 2);
  assert.equal(out.media.design, 'Editorial');
  assert.match(out.modelResult, /created successfully/);
  assert.match(out.modelResult, /report\.pdf/);
  assert.equal(JSON.parse(calls[0].init.body).spec.markdown, '# Report\n\nBody');
  const used = [...e._kv.entries()].find(([k]) => k.includes(':documentGen:'));
  assert.equal(used[1], '1');
});

await t('create_document stops at the daily limit', async () => {
  const e = env();
  await exec('create_document', { kind: 'document', title: 'A', markdown: 'x' }, e);
  await exec('create_document', { kind: 'document', title: 'B', markdown: 'x' }, e);
  const { out, calls } = await exec('create_document', { kind: 'document', title: 'C', markdown: 'x' }, e);
  assert.equal(out.ok, false);
  assert.match(out.modelResult, /document limit/);
  assert.equal(calls.length, 0);
});

await t('create_document failure refunds the quota and tells the model plainly', async () => {
  const e = env();
  e._status = 500; e._body = { error: 'boom' };
  const { out } = await exec('create_document', { kind: 'document', title: 'A', markdown: 'x' }, e);
  assert.equal(out.ok, false);
  assert.match(out.modelResult, /could not make this file/);
  const used = [...e._kv.entries()].find(([k]) => k.includes(':documentGen:'));
  assert.equal(used[1], '0');
});

await t('create_document without the service is refused, not crashed', async () => {
  const { out } = await exec('create_document', { kind: 'document', title: 'A', markdown: 'x' }, { COGNITA_USAGE: env().COGNITA_USAGE });
  assert.equal(out.ok, false);
});

const designArgs = { kind: 'flyer', headline: 'Grand Opening', tagline: 'NEW IN TOWN', subheadline: 'Fresh bread daily', details: ['Date: Saturday 12 July', 'Venue: Market Road, Lagos'], cta: 'Visit us', footer: 'greenfield.example', style: 'botanical', accent_color: '#0F766E' };

await t('create_design goes through doc-studio as a poster spec', async () => {
  const e = env();
  e._body = goodReply({ kind: 'poster', files: [{ format: 'png', name: 'grand-opening.png', mime: 'image/png', size: 9, content: B64 }, { format: 'pdf', name: 'grand-opening.pdf', mime: 'application/pdf', size: 9, content: B64 }] });
  const { out, calls } = await exec('create_design', designArgs, e, { userText: 'Grand Opening flyer, Saturday 12 July at Market Road, Lagos', facts: {} });
  assert.equal(out.ok, true);
  assert.equal(out.media.kind, 'docfile');
  const spec = JSON.parse(calls[0].init.body).spec;
  assert.equal(spec.kind, 'poster');
  assert.equal(spec.size, 'a4');
  assert.equal(spec.headline, 'Grand Opening');
  assert.equal(spec.kicker, 'NEW IN TOWN');
  assert.equal(spec.design, 'botanical');
  assert.equal(spec.colors.accent, '#0F766E');
  assert.deepEqual(JSON.parse(calls[0].init.body).formats, ['png', 'pdf']);
  assert.ok(spec.details.some((d) => /Saturday 12 July/.test(d)));
});

await t('create_design with a picture and logo sends them as data pictures', async () => {
  const e = env();
  const png = Buffer.from('x'.repeat(200)).toString('base64');
  const { calls } = await exec('create_design', { ...designArgs, kind: 'poster' }, e, {
    userText: 'poster Saturday 12 July Market Road Lagos', assets: { photo: { mime: 'image/png', base64: png }, logo: { mime: 'image/png', base64: png } },
  });
  const spec = JSON.parse(calls[0].init.body).spec;
  assert.equal(spec.size, 'a3');
  assert.match(spec.image, /^data:image\/png;base64,/);
  assert.match(spec.logo, /^data:image\/png;base64,/);
});

await t('create_design falls back to the built-in composer when the service is down', async () => {
  const e = env();
  e._status = 502; e._body = { error: 'bad gateway' };
  const { out } = await exec('create_design', designArgs, e, { userText: 'Grand Opening flyer Saturday 12 July Market Road Lagos' });
  assert.equal(out.ok, true);
  assert.equal(out.media.kind, 'design');
  assert.ok(out.media.svg.startsWith('<svg'));
});

await t('create_design without doc-studio configured is unchanged (SVG)', async () => {
  const e = { COGNITA_USAGE: env().COGNITA_USAGE };
  const { out } = await exec('create_design', designArgs, e, { userText: 'Grand Opening flyer Saturday 12 July Market Road Lagos' });
  assert.equal(out.media.kind, 'design');
});

await t('posterSpecFrom maps sizes and brand colours with readable text', () => {
  const norm = (a) => media.normalizeDesignSpec(a, { userText: '' });
  for (const [kind, size] of [['flyer', 'a4'], ['poster', 'a3'], ['invitation', 'portrait'], ['social_post', 'square'], ['story', 'story'], ['banner', 'landscape']]) {
    assert.equal(media.posterSpecFrom(norm({ kind, headline: 'H' }), { kind }, null, null).size, size, kind);
  }
  const dark = media.posterSpecFrom(norm({ kind: 'flyer', headline: 'H' }), { primary_color: '#0B1F3A' }, null, null);
  assert.equal(dark.colors.bg, '#0B1F3A');
  assert.equal(dark.colors.ink, '#FFFFFF');
  const light = media.posterSpecFrom(norm({ kind: 'flyer', headline: 'H' }), { primary_color: '#FFE94A' }, null, null);
  assert.equal(light.colors.ink, '#111111');
});

await t('prompt: unchanged without docs; docs variant drops the helper and adds the rules', () => {
  const base = { hasSandbox: true, hasMedia: true, now: new Date('2026-10-19T00:00:00Z') };
  const off = buildChatSystemPrompt(base);
  const on = buildChatSystemPrompt({ ...base, hasDocs: true });
  assert.ok(off.includes('cognita_docs import docx, pdf, pptx'));
  assert.ok(!off.includes('create_document'));
  assert.ok(!on.includes('cognita_docs import docx, pdf, pptx'));
  assert.ok(on.includes('create_document'));
  assert.ok(on.length < off.length);
  // hasDocs without media tools adds nothing
  assert.equal(buildChatSystemPrompt({ hasSandbox: true, hasDocs: true, now: base.now }).includes('create_document with'), false);
});

await t('code tools stay off for pure document requests when doc-studio makes the files', () => {
  const docOnly = ['Write me a project proposal as a Word document', 'Make a pitch deck for my startup', 'turn this into a PDF', 'I need a printable certificate document'];
  for (const text of docOnly) {
    assert.equal(shouldOfferSandbox({ text, docsHandled: true }).offer, false, text);
  }
  // unchanged without the service
  assert.equal(shouldOfferSandbox({ text: 'Write me a project proposal as a Word document' }).offer, true);
  // real code and data work still turns them on
  for (const text of ['analyse this csv and give the average', 'write a python script to rename files', 'calculate the mean of 4, 8, 15, 16']) {
    assert.equal(shouldOfferSandbox({ text, docsHandled: true }).offer, true, text);
  }
  // a chat that already uses the workspace keeps it
  assert.equal(shouldOfferSandbox({ text: 'make it a PDF', docsHandled: true, hint: true }).offer, true);
});

console.log('\n' + passed + ' passed' + (process.exitCode ? ', some FAILED' : ''));
