// Local server for browser testing: serves the repo as static files and routes /api/* into the REAL
// worker.js. Only Firestore, the AI provider and Paystack are faked (same harness as the unit tests).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { makeWorld, idToken, ROOT } from './harness.mjs';
import { pathToFileURL } from 'node:url';

const world = makeWorld({ GROQ_API_KEY: 'x', B2_KEY_ID: 'k', B2_APPLICATION_KEY: 's', B2_BUCKET_ID: 'b', B2_BUCKET_NAME: 'bucket' });
world.env.AI = { async run() { return { text: whisperText, transcription_info: { duration: whisperDur } }; } };
{ const rem = new Map(); world.env.COGNITA_REMINDERS = { async get(k) { return rem.has(k) ? rem.get(k) : null; }, async put(k, v) { rem.set(k, v); }, async delete(k) { rem.delete(k); }, async list({ prefix = '', limit = 1000 } = {}) { return { keys: [...rem.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit).map((name) => ({ name })) }; } }; }
const real = globalThis.fetch;
let aiDown = false, failNext = 0, delayMs = 0;
let whisperText = 'Good morning everyone. ' + Array.from({ length: 70 }, (_, i) => 'word' + i).join(' ') + ' school', whisperDur = 35;
const b2 = new Map();                  // fake B2 bucket
let ttsOn = true;
const inner = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const u = new URL(typeof input === 'string' ? input : input.url);
  if (u.host === 'firestore.googleapis.com' && u.pathname.endsWith(':runQuery')) {
    const q = JSON.parse(init.body).structuredQuery; const col = q.from[0].collectionId, field = q.where.fieldFilter.field.fieldPath, val = q.where.fieldFilter.value.stringValue;
    const rows = [...world.docs.entries()].filter(([k, f]) => k.startsWith(col + '/') && f[field] && f[field].stringValue === val).map(([k, f]) => ({ document: { name: 'projects/proj/databases/(default)/documents/' + k, fields: f } }));
    return new Response(JSON.stringify(rows.length ? rows : [{}]), { status: 200 });
  }
  if (u.host === 'api.groq.com' || u.host === 'openrouter.ai') {
    if (aiDown) return new Response('down', { status: 500 });
    const body = JSON.parse(init.body); const sys = body.messages[0].content;
    let text;
    if (sys.startsWith('You mark one short learner answer')) { const ids = [...body.messages[1].content.matchAll(/^- (\w+):/gm)].map((m) => m[1]); const ans = (body.messages[1].content.split('<answer>')[1] || '').split('</answer>')[0].trim(); const good = ans.length > 40; text = JSON.stringify({ met: Object.fromEntries(ids.map((i) => [i, good])), feedback: good ? 'Every point on the list is covered.' : 'Your answer is too short to cover the points. Add each part from the list.' }); }
    else text = 'We have not covered that yet. Let us finish this part first. For now, look again at the example above and try the step once more.';
    return new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: {} }), { status: 200 });
  }
  if (u.host === 'api.backblazeb2.com') return new Response(JSON.stringify({ authorizationToken: 't', apiInfo: { storageApi: { apiUrl: 'https://api.b2.test', downloadUrl: 'https://dl.b2.test' } } }), { status: 200 });
  if (u.host === 'api.b2.test') return new Response(u.pathname.endsWith('b2_get_upload_url') ? JSON.stringify({ uploadUrl: 'https://up.b2.test/u', authorizationToken: 'ut' }) : '{}', { status: 200 });
  if (u.host === 'up.b2.test') { const name = decodeURIComponent(init.headers['X-Bz-File-Name']); b2.set(name, new Uint8Array(init.body)); return new Response(JSON.stringify({ fileId: 'f', fileName: name, uploadTimestamp: 1 }), { status: 200 }); }
  if (u.host === 'dl.b2.test') { const name = decodeURIComponent(u.pathname.replace('/file/bucket/', '')); return b2.has(name) ? new Response(b2.get(name), { status: 200 }) : new Response('nf', { status: 404 }); }
  if (u.host === 'speech.platform.bing.com') {   // the free Edge voice service: a WebSocket that sends one audio frame, then turn.end
    if (!ttsOn) return { status: 403 };
    const L = []; const enc = new TextEncoder();
    return { status: 101, webSocket: { accept() {}, close() {}, addEventListener(t, fn) { if (t === 'message') L.push(fn); }, send(m) { if (!/Path:ssml/.test(String(m))) return; setTimeout(() => { const hdr = enc.encode('X-RequestId:1\r\nPath:audio\r\n'); const f = new Uint8Array(2 + hdr.length + WAV.length); f[0] = hdr.length >> 8; f[1] = hdr.length & 255; f.set(hdr, 2); f.set(WAV, 2 + hdr.length); L.forEach((fn) => fn({ data: f.buffer })); L.forEach((fn) => fn({ data: 'Path:turn.end\r\n\r\n{}' })); }, 0); } } };
  }
  return inner(input, init);
};
const worker = (await import(pathToFileURL(path.join(ROOT, 'worker.js')).href)).default;
const FS = await import(pathToFileURL(path.join(ROOT, 'firestore-rest.js')).href);
const E = await import(pathToFileURL(path.join(ROOT, 'learna/engine.js')).href);
// A tiny silent WAV: the browser can really play it, so the free voice path is exercised end to end.
const WAV = (() => { const n = 8000 * 0.3, b = Buffer.alloc(44 + n * 2); b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(8000, 24); b.writeUInt32LE(16000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40); return new Uint8Array(b); })();
const users = { free: 'free', plus: 'plus', studio: 'studio', admin: 'admin', plus2: 'plus', mod: 'free' };
for (const [uid, plan] of Object.entries(users)) {
  world.addUser(uid, uid + '@x.com', uid);
  world.setDoc('accounts/' + uid, { uid, planId: plan === 'admin' ? 'free' : plan, status: plan === 'free' ? 'none' : 'active', periodEnd: new Date(Date.now() + 25 * 86400000).toISOString(), createdAt: new Date().toISOString() });
}
world.setDoc('admins/admin', { role: 'admin' });
world.setDoc('admins/mod', { role: 'moderator' });

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json', '.svg': 'image/svg+xml' };
http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/__ctl/')) { // test controls
    if (url.pathname === '/__ctl/ai') aiDown = url.searchParams.get('down') === '1';
    if (url.pathname === '/__ctl/reset') { for (const k of [...world.docs.keys()]) if (k.startsWith('learna_')) world.docs.delete(k); for (const k of [...world.kv.keys()]) world.kv.delete(k); }
    if (url.pathname === '/__ctl/whisper') { whisperText = url.searchParams.get('text') || whisperText; whisperDur = +url.searchParams.get('dur') || whisperDur; }
    if (url.pathname === '/__ctl/tts') { ttsOn = url.searchParams.get('on') === '1'; if (url.searchParams.get('key') === '0') world.env.LEARNA_TTS_DISABLED = '1'; else delete world.env.LEARNA_TTS_DISABLED; }
    if (url.pathname === '/__ctl/doc') { const d = world.doc(url.searchParams.get('path')); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(d)); return; }
    if (url.pathname === '/__ctl/jump') {   // put a learner at a lesson and step, with every earlier lesson done
      const uid = url.searchParams.get('uid'), cid = url.searchParams.get('course'), key = url.searchParams.get('lesson'), step = +url.searchParams.get('step') || 0;
      const course = E.COURSE_MAP[cid]; const flat = E.flatLessons(course); const idx = flat.findIndex((f) => f.key === key);
      let p = await FS.fsGet('learna_progress/' + uid + '_' + cid, world.env); if (!p) { p = E.newProgress(uid, course); }
      flat.forEach((f, i) => { if (i < idx) p.lessons[f.key] = { rev: f.lesson.rev, status: 'done', acts: p.lessons[f.key] ? p.lessons[f.key].acts : {}, mastery: { ratio: 1, mastered: true, passedClean: 1, total: 1 } }; });
      p.current = { lesson: key, step }; await FS.fsSet('learna_progress/' + uid + '_' + cid, p, world.env); res.end('ok'); return;
    }
    if (url.pathname === '/__ctl/satisfy') {   // mark every requirement for a certificate as met (for the certificate screens)
      const uid = url.searchParams.get('uid'), cid = url.searchParams.get('course'); const course = E.COURSE_MAP[cid];
      const p = E.newProgress(uid, course);
      for (const f of E.flatLessons(course)) p.lessons[f.key] = { rev: f.lesson.rev, status: 'done', acts: {}, mastery: { ratio: 1, mastered: true, passedClean: 1, total: 1 } };
      for (const a of E.assignmentsOf(course)) { p.lessons[a.lessonKey].acts[a.step.id] = { attempts: 1, passed: true, review: a.step.review === 'auto' ? 'auto' : 'approved', submissionId: 'x', mistakes: [] }; }
      p.status = 'completed'; await FS.fsSet('learna_progress/' + uid + '_' + cid, p, world.env); res.end('ok'); return;
    }
    if (url.pathname === '/__ctl/delay') delayMs = +url.searchParams.get('ms') || 0;
    res.end('ok'); return;
  }
  if (url.pathname.startsWith('/api/')) {
    const chunks = []; for await (const c of req) chunks.push(c);
    const uid = url.searchParams.get('as') || req.headers['x-test-user'];
    const h = { ...req.headers }; delete h.host; delete h['content-length']; delete h['x-test-user'];
    if (uid) h.authorization = 'Bearer ' + idToken(uid, uid + '@x.com');
    url.searchParams.delete('as');
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    const r = await worker.fetch(new Request('https://api.cognita.com.ng' + url.pathname + url.search, { method: req.method, headers: h, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) }), world.env, { waitUntil() {} });
    res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/json' }); res.end(Buffer.from(await r.arrayBuffer())); return;
  }
  let p = path.join(ROOT, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
  if (!fs.existsSync(p) && fs.existsSync(p + '.html')) p += '.html';
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' }); res.end(fs.readFileSync(p));
}).listen(+process.env.PORT || 8799, () => console.log('ready'));
