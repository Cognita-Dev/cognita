// Runs the REAL /api/chat handler with a fake model and a fake doc-studio service, and checks the whole Worker side:
// the tools offered, the prompt the model gets, the call made to doc-studio, and what reaches the browser.
// Needs tests/key.pem, cert.pem, sa.pem (see tests/harness.mjs; they are git-ignored).
import { makeWorld, idToken, eq, ok } from './harness.mjs';

const UID = 'uid_ds_1', EMAIL = 'ds@example.com';
const results = [];
async function run(name, fn, env = {}) {
  const w = makeWorld({ GROQ_API_KEY: 'g_test', ...env });
  try { await fn(w); console.log('  PASS  ' + name); results.push(true); }
  catch (e) { console.log('  FAIL  ' + name + '\n        -> ' + (e.stack || e.message).split('\n').slice(0, 3).join('\n           ')); results.push(false); }
  finally { w.restore(); }
}

const sse = (events) => new Response(events.map((e) => 'data: ' + (typeof e === 'string' ? e : JSON.stringify(e)) + '\n\n').join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const toolCall = (id, name, args) => sse([
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]',
]);
const answer = (text) => sse([{ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, '[DONE]']);

const B64 = Buffer.from('%PDF-1.7 fake').toString('base64');
const SVC = (kind, files) => ({ kind, design: { id: 'luxe', name: 'Midnight Luxe' }, preview: { mime: 'image/jpeg', content: B64 }, files: files.map((f) => ({ format: f, name: 'out.' + f, mime: 'application/x-test', size: 13, content: B64 })) });

function install(w, plan, seen, svc) {
  const prev = globalThis.fetch;
  let modelCalls = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://api.groq.com/')) {
      const body = JSON.parse(init.body);
      // what the model was given on its FIRST turn (later turns may differ)
      if (!seen.toolsOffered && (body.tools || []).length) {
        seen.toolsOffered = (body.tools || []).map((t) => t.function.name);
        seen.system = body.messages[0] && body.messages[0].content;
      }
      return plan[Math.min(modelCalls++, plan.length - 1)]();
    }
    if (url.startsWith('https://ds.example.com/')) {
      seen.ds.push({ url, auth: init.headers && init.headers.Authorization, body: JSON.parse(init.body) });
      return svc ? svc(JSON.parse(init.body)) : new Response('{}', { status: 500 });
    }
    return prev(input, init);
  };
}

async function chat(w, text) {
  const { handleChatRequest } = await import('../chat-endpoint.js');
  const req = new Request('https://api.cognita.com.ng/api/chat', {
    method: 'POST', headers: { Authorization: 'Bearer ' + idToken(UID, EMAIL), 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: text }] }),
  });
  const res = await handleChatRequest(req, w.env);
  const raw = await res.text();
  const events = [];
  for (const block of raw.split('\n\n')) {
    const ev = /^event: (.+)$/m.exec(block), da = /^data: (.*)$/m.exec(block);
    if (ev && da) events.push({ event: ev[1], data: JSON.parse(da[1]) });
  }
  return { status: res.status, raw, events };
}
function setupAdmin(w) { w.addUser(UID, EMAIL); w.setDoc('admins/' + UID, { role: 'admin' }); }

const DS = { DOCSTUDIO_URL: 'https://ds.example.com', DOCSTUDIO_TOKEN: 'secret-token' };
const okSvc = (kind, files) => () => new Response(JSON.stringify(SVC(kind, files)), { status: 200, headers: { 'content-type': 'application/json' } });
const FLYER = 'Design a flyer for Greenfield Bakery grand opening on Saturday 12 July at Market Road, Lagos. Call 08000000000. Free entry.';

console.log('\ndoc-studio through the real chat handler');

await run('a document request: create_document is offered, the sandbox helper text is gone, the file reaches the browser', async (w) => {
  setupAdmin(w);
  const seen = { ds: [] };
  install(w, [() => toolCall('c1', 'create_document', { kind: 'document', title: 'Project proposal', design: 'luxe', markdown: '# Project proposal\n\n## Scope\n\nBuild it.' }), () => answer('Your proposal is ready as a PDF and a Word file.')], seen, okSvc('document', ['pdf', 'docx']));
  const r = await chat(w, 'Write me a project proposal as a Word document');
  eq(r.status, 200, 'status ' + r.raw.slice(0, 200));
  ok(seen.toolsOffered.includes('create_document'), 'create_document not offered: ' + JSON.stringify(seen.toolsOffered));
  ok(/create_document/.test(seen.system), 'rules for create_document missing from the prompt');
  ok(!/cognita_docs import docx/.test(seen.system), 'the old Word/PDF helper text should not be in the prompt');
  eq(seen.ds.length, 1);
  eq(seen.ds[0].url, 'https://ds.example.com/api/render');
  eq(seen.ds[0].auth, 'Bearer secret-token');
  eq(seen.ds[0].body.spec.design, 'luxe');
  eq(seen.ds[0].body.spec.markdown, '# Project proposal\n\n## Scope\n\nBuild it.');
  const media = r.events.find((e) => e.event === 'media');
  ok(media, 'no media event: ' + r.raw.slice(-400));
  eq(media.data.kind, 'docfile');
  eq(media.data.files.map((f) => f.format), ['pdf', 'docx']);
  eq(media.data.design, 'Midnight Luxe');
  const done = r.events.find((e) => e.event === 'done');
  ok(done && /proposal is ready/.test(done.data.reply), 'no final answer');
  const st = done.data.steps.find((s) => s.name === 'create_document');
  ok(st && st.ok && st.providerLabel === 'Document', 'step missing: ' + JSON.stringify(done.data.steps));
  ok(!JSON.stringify(done.data).includes(B64), 'file bytes must only travel in the media event');
  // counted against the plan's document allowance
  const used = [...w.kv.entries()].find(([k]) => k.includes(':documentGen:'));
  ok(used && used[1] === '1', 'documentGen usage not counted');
}, DS);

await run('a presentation request builds slides', async (w) => {
  setupAdmin(w);
  const seen = { ds: [] };
  install(w, [() => toolCall('c1', 'create_document', { kind: 'slides', title: 'Pitch', slides: [{ layout: 'title', title: 'Pitch' }, { layout: 'bullets', title: 'Why', bullets: ['a', 'b'] }] }), () => answer('Your deck is ready.')], seen, okSvc('slides', ['pptx', 'pdf']));
  const r = await chat(w, 'Make a pitch deck for my startup');
  ok(seen.toolsOffered.includes('create_document'));
  eq(seen.ds[0].body.spec.kind, 'slides');
  eq(seen.ds[0].body.spec.slides.length, 2);
  eq(r.events.find((e) => e.event === 'media').data.docKind, 'slides');
}, DS);

await run('a flyer request goes to doc-studio as a poster with the person\'s facts', async (w) => {
  setupAdmin(w);
  const seen = { ds: [] };
  install(w, [() => toolCall('c1', 'create_design', { kind: 'flyer', headline: 'Grand Opening', tagline: 'GREENFIELD BAKERY', details: ['Date: Saturday 12 July', 'Venue: Market Road, Lagos', 'Call: 08000000000'], cta: 'Come along', style: 'botanical' }), () => answer('Your flyer is ready.')], seen, okSvc('poster', ['png', 'pdf']));
  const r = await chat(w, FLYER);
  const paused = r.events.find((e) => e.event === 'done' && e.data.pendingDesignRequest);
  ok(!paused, 'the design paused to ask the person for details: ' + JSON.stringify(paused && paused.data.pendingDesignRequest));
  eq(seen.ds.length, 1, 'doc-studio calls');
  const spec = seen.ds[0].body.spec;
  eq(spec.kind, 'poster'); eq(spec.size, 'a4'); eq(spec.design, 'botanical'); eq(spec.headline, 'Grand Opening');
  ok(spec.details.some((d) => /Saturday 12 July/.test(d)), 'date missing from the poster: ' + JSON.stringify(spec.details));
  eq(r.events.find((e) => e.event === 'media').data.kind, 'docfile');
}, DS);

await run('doc-studio down: a flyer still gets made with the built-in designer', async (w) => {
  setupAdmin(w);
  const seen = { ds: [] };
  install(w, [() => toolCall('c1', 'create_design', { kind: 'flyer', headline: 'Grand Opening', tagline: 'GREENFIELD BAKERY', details: ['Date: Saturday 12 July', 'Venue: Market Road, Lagos', 'Call: 08000000000'] }), () => answer('Your flyer is ready.')], seen, () => new Response('down', { status: 503 }));
  const r = await chat(w, FLYER);
  eq(seen.ds.length, 1);
  const media = r.events.find((e) => e.event === 'media');
  ok(media && media.data.kind === 'design' && media.data.svg.startsWith('<svg'), 'expected the SVG design as a fallback');
}, DS);

await run('doc-studio down: a document fails honestly, quota is given back, nothing is pasted', async (w) => {
  setupAdmin(w);
  const seen = { ds: [] };
  install(w, [() => toolCall('c1', 'create_document', { kind: 'document', title: 'Report', markdown: '# Report\n\nText' }), () => answer('I could not make the file just now. Please try again in a moment.')], seen, () => new Response('down', { status: 503 }));
  const r = await chat(w, 'Write a report as a PDF');
  ok(!r.events.some((e) => e.event === 'media'), 'no media expected');
  const done = r.events.find((e) => e.event === 'done');
  const st = done.data.steps.find((s) => s.name === 'create_document');
  ok(st && st.ok === false);
  const used = [...w.kv.entries()].find(([k]) => k.includes(':documentGen:'));
  ok(used && used[1] === '0', 'quota should be refunded');
}, DS);

await run('NOT configured: no create_document, old sandbox helper text stays, flyers use the built-in designer', async (w) => {
  setupAdmin(w);
  const seen = { ds: [] };
  install(w, [() => toolCall('c1', 'create_design', { kind: 'flyer', headline: 'Grand Opening', tagline: 'GREENFIELD BAKERY', details: ['Date: Saturday 12 July', 'Venue: Market Road, Lagos', 'Call: 08000000000'] }), () => answer('Your flyer is ready.')], seen, null);
  const r = await chat(w, FLYER);
  ok(!seen.toolsOffered.includes('create_document'));
  eq(seen.ds.length, 0);
  eq(r.events.find((e) => e.event === 'media').data.kind, 'design');
  // a document request: the sandbox still carries the Word/PDF helper
  const seen2 = { ds: [] };
  install(w, [() => answer('Sure.')], seen2, null);
  await chat(w, 'Write me a project proposal as a Word document');
  ok(!seen2.toolsOffered.includes('create_document'));
  ok(/cognita_docs import docx/.test(seen2.system), 'the old helper text must remain when doc-studio is off');
});

await run('a plain chat is not charged any extra tools', async (w) => {
  setupAdmin(w);
  const seen = { ds: [] };
  install(w, [() => answer('Hello!')], seen, okSvc('document', ['pdf']));
  await chat(w, 'hi, how are you today?');
  ok(!(seen.toolsOffered || []).includes('create_document'), 'create_document offered for small talk');
}, DS);

process.exit(results.every(Boolean) ? 0 : 1);
