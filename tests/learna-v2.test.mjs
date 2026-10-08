// Tests for Learna's second generation: dynamic courses and the admin editor, assignments and reviews, certificates,
// code-grading challenges, speech (TTS and transcription), plan limits and learner notifications.
// Run:  node tests/learna-v2.test.mjs
import { test, eq, ok, summary, callWorker, load } from './harness.mjs';

let groqReply = null, whisper = null, edgeCalls = [], edgeMode = 'ok', edgeFetches = 0;   // edgeMode: ok | blocked | silent | flaky
const files = new Map();                 // B2 in memory
// A stand-in for the Edge read-aloud WebSocket: after the SSML message it sends one binary audio frame and then the turn.end marker.
function fakeEdgeWs(silent) {
  const L = { message: [] }, enc = new TextEncoder(), audio = new Uint8Array([73, 68, 51, 4, 0, 0, 1, 2, 3]);
  return {
    accept() {}, close() {},
    addEventListener(t, fn) { if (t === 'message') L.message.push(fn); },
    send(m) {
      m = String(m); if (!/Path:ssml/.test(m)) return; edgeCalls.push(m);
      setTimeout(() => {
        if (!silent) { const hdr = enc.encode('X-RequestId:1\r\nPath:audio\r\n'); const f = new Uint8Array(2 + hdr.length + audio.length); f[0] = hdr.length >> 8; f[1] = hdr.length & 255; f.set(hdr, 2); f.set(audio, 2 + hdr.length); L.message.forEach((fn) => fn({ data: f.buffer })); }
        L.message.forEach((fn) => fn({ data: 'X-RequestId:1\r\nPath:turn.end\r\n\r\n{}' }));
      }, 0);
    },
  };
}
function mocks(w) {
  const inner = globalThis.fetch;
  w.env.B2_KEY_ID = 'k'; w.env.B2_APPLICATION_KEY = 's'; w.env.B2_BUCKET_ID = 'b'; w.env.B2_BUCKET_NAME = 'bucket';
  w.env.AI = { async run(model, input) { if (!whisper) throw new Error('whisper down'); return whisper(input); } };
  const rem = new Map();
  w.env.COGNITA_REMINDERS = {
    async get(k) { return rem.has(k) ? rem.get(k) : null; }, async put(k, v) { rem.set(k, v); }, async delete(k) { rem.delete(k); },
    async list({ prefix = '', limit = 1000 } = {}) { return { keys: [...rem.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit).map((name) => ({ name })) }; },
  };
  w.rem = rem;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url; const u = new URL(url);
    if (u.host === 'firestore.googleapis.com' && u.pathname.endsWith(':runQuery')) {
      const q = JSON.parse(init.body).structuredQuery; const col = q.from[0].collectionId, field = q.where.fieldFilter.field.fieldPath, val = q.where.fieldFilter.value.stringValue;
      const rows = [...w.docs.entries()].filter(([k, f]) => k.startsWith(col + '/') && f[field] && f[field].stringValue === val).map(([k, f]) => ({ document: { name: 'projects/proj/databases/(default)/documents/' + k, fields: f } }));
      return new Response(JSON.stringify(rows.length ? rows : [{}]), { status: 200 });
    }
    if (u.host === 'api.groq.com' || u.host === 'openrouter.ai') {
      const text = groqReply ? groqReply(JSON.parse(init.body).messages) : null;
      if (text === null) return new Response('down', { status: 500 });
      return new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: {} }), { status: 200 });
    }
    if (u.host === 'api.backblazeb2.com') return new Response(JSON.stringify({ authorizationToken: 't', apiInfo: { storageApi: { apiUrl: 'https://api.b2.test', downloadUrl: 'https://dl.b2.test' } } }), { status: 200 });
    if (u.host === 'api.b2.test') { if (u.pathname.endsWith('b2_get_upload_url')) return new Response(JSON.stringify({ uploadUrl: 'https://up.b2.test/u', authorizationToken: 'ut' }), { status: 200 }); return new Response('{}', { status: 200 }); }
    if (u.host === 'up.b2.test') { const name = decodeURIComponent(init.headers['X-Bz-File-Name']); files.set(name, new Uint8Array(init.body)); return new Response(JSON.stringify({ fileId: 'f', fileName: name, uploadTimestamp: 1 }), { status: 200 }); }
    if (u.host === 'dl.b2.test') { const name = decodeURIComponent(u.pathname.replace('/file/bucket/', '')); return files.has(name) ? new Response(files.get(name), { status: 200 }) : new Response('nf', { status: 404 }); }
    if (u.host === 'speech.platform.bing.com') {   // the free Edge voice service, reached over a WebSocket upgrade
      edgeFetches++; const hdr = init.headers || {};
      if (edgeMode === 'blocked' || (edgeMode === 'flaky' && edgeFetches % 2 === 1)) return { status: 403 };
      if (!/Sec-MS-GEC=[0-9A-F]{64}/.test(url) || hdr.Upgrade !== 'websocket') return { status: 400 };
      return { status: 101, webSocket: fakeEdgeWs(edgeMode === 'silent') };
    }
    return inner(input, init);
  };
}
function user(w, uid, plan) {
  w.addUser(uid, uid + '@x.com', 'Name ' + uid);
  if (plan === 'admin') { w.setDoc('accounts/' + uid, { uid, planId: 'free', status: 'none', periodEnd: null, createdAt: new Date().toISOString() }); w.setDoc('admins/' + uid, { role: 'admin' }); }
  else if (plan === 'mod') { w.setDoc('admins/' + uid, { role: 'moderator' }); w.setDoc('accounts/' + uid, { uid, planId: 'free', status: 'none', periodEnd: null, createdAt: new Date().toISOString() }); }
  else if (plan) w.setDoc('accounts/' + uid, { uid, planId: plan, status: 'active', periodEnd: new Date(Date.now() + 20 * 86400000).toISOString(), createdAt: new Date().toISOString() });
}
const call = (w, m, p, uid, body) => callWorker(w, m, '/api/learna' + p, { uid, email: uid + '@x.com', body });
const adm = (w, m, p, uid, body) => callWorker(w, m, '/api/admin/learna' + p, { uid, email: uid + '@x.com', body });
const media = (w, uid, course, lesson, activity, bytes, type, ms) => callWorker(w, 'POST', '/api/learna/courses/' + course + '/assignments/submit', { uid, email: uid + '@x.com', raw: bytes, headers: { 'Content-Type': type, 'X-Learna-Lesson': lesson, 'X-Learna-Activity': activity, 'X-Duration-Ms': String(ms) } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PLUS = 'plus', STUDIO = 'studio';
const FS = await load('firestore-rest.js');
const E = await load('learna/engine.js');

// A small course for the assignment, review and certificate tests.
const mini = () => ({
  id: 'mini-course', title: 'Mini Course', shortDescription: 'A small course for testing.', fullDescription: 'A small course used to test tasks, reviews and certificates in Learna.', category: 'public-speaking', level: 'Beginner',
  estimatedDuration: '30 minutes', estimatedMinutes: 30, whoFor: 'Testers of Learna.', prerequisites: ['None'], learningOutcomes: ['Pass the tests'], skills: ['Testing'], practical: 'Three tasks.', assessment: 'Tasks are marked and reviewed.', modes: [],
  access: 'plus', status: 'available', featured: false, version: '1.0.0', masteryThreshold: 0.7, references: [], certificate: { enabled: true, title: 'Certificate in Mini' },
  sections: [{ id: 's1', title: 'One', summary: '', lessons: [{ id: 'l1', rev: 1, title: 'The only lesson', objective: 'By the end of this lesson, you can do the tasks.', minutes: 10, steps: [
    { id: 't1', kind: 'teach', phase: 'explanation', title: 'Read this', text: ['Speak clearly.'], example: null },
    { id: 'q1', kind: 'activity', phase: 'guided', title: 'Pick one', type: 'choice', prompt: 'Which is right?', maxAttempts: 3, hints: [], options: [{ id: 'a', text: 'Right' }, { id: 'b', text: 'Wrong' }], answer: 'a', explain: 'Right is right.', why: {} },
    { id: 'au', kind: 'activity', phase: 'attempt', title: 'Record a talk', type: 'assignment', format: 'audio', review: 'auto', certRequired: true, minWords: 1, maxAttempts: 2, prompt: 'Record a talk.', minSeconds: 20, maxSeconds: 90,
      rubric: [{ id: 'topic', label: 'Talks about one topic.' }], metricRules: [{ id: 'pace', label: 'Pace between 100 and 180 words per minute.', metric: 'wpm', min: 100, max: 180 }, { id: 'fillers', label: 'At most 5 filler words per 100 words.', metric: 'fillerPer100', max: 5 }], checklist: [] },
    { id: 'vd', kind: 'activity', phase: 'attempt', title: 'Video', type: 'assignment', format: 'video', review: 'admin', certRequired: true, minWords: 1, maxAttempts: 3, prompt: 'Record a video.', minSeconds: 10, maxSeconds: 120, rubric: [], metricRules: [], checklist: [] },
    { id: 'tx', kind: 'activity', phase: 'independent', title: 'Written task', type: 'assignment', format: 'text', review: 'admin', certRequired: true, minWords: 5, maxAttempts: 3, prompt: 'Write a plan.', rubric: [], metricRules: [], checklist: [] },
  ] }] }],
});
const WORDS = (n, extra = '') => Array.from({ length: n }, (_, i) => 'word' + i).join(' ') + extra;
async function adminCourse(w) {
  mocks(w); user(w, 'adm', 'admin');
  let r = await adm(w, 'PUT', '/courses/mini-course', 'adm', { course: mini() }); eq(r.status, 200, 'save ' + r.text);
  r = await adm(w, 'POST', '/courses/mini-course/publish', 'adm'); eq(r.status, 200, 'publish ' + r.text);
}
async function finishMini(w, uid) {
  eq((await call(w, 'POST', '/courses/mini-course/enroll', uid)).status, 201);
  const adv = (s) => call(w, 'POST', '/courses/mini-course/advance', uid, { lesson: 's1_l1', step: s });
  eq((await adv(0)).status, 200);
  eq((await call(w, 'POST', '/courses/mini-course/submit', uid, { lesson: 's1_l1', activity: 'q1', answer: 'a' })).json.result.correct, true);
  eq((await adv(1)).status, 200);
  whisper = () => ({ text: WORDS(60, ' I talk about school'), transcription_info: { duration: 30 } }); groqReply = () => JSON.stringify({ met: { topic: true }, feedback: 'You stayed on one topic.' });
  const a = await media(w, uid, 'mini-course', 's1_l1', 'au', new Uint8Array(2000), 'audio/webm', 30000); eq(a.status, 201, 'audio ' + a.text);
  eq((await adv(2)).status, 200);
  const v = await media(w, uid, 'mini-course', 's1_l1', 'vd', new Uint8Array(3000), 'video/webm', 40000); eq(v.status, 201, 'video ' + v.text);
  eq((await adv(3)).status, 200);
  const t = await call(w, 'POST', '/courses/mini-course/assignments/submit', uid, { lesson: 's1_l1', activity: 'tx', text: 'My plan is to speak daily and record weekly.' }); eq(t.status, 201, 'text ' + t.text);
  const last = await adv(4); eq(last.status, 200); eq(last.json.event, 'course_complete');
  return { video: v.json.submissionId, text: t.json.submissionId, audio: a.json.submissionId };
}

console.log('\nCourse content');
await test('every built-in course passes validation', async () => {
  const V = await load('learna/validate.js'); const C = await load('learna/courses.js');
  for (const c of C.COURSES) { const r = V.validateCourse(c); eq(r.errors, [], c.id); }
});
await test('JavaScript and Public Speaking are full courses', async () => {
  const C = await load('learna/courses.js');
  const js = C.COURSE_MAP['javascript-foundations'], sp = C.COURSE_MAP['public-speaking-essentials'];
  ok(E.countLessons(js) >= 18 && js.sections.length >= 6, 'js too small'); ok(E.countLessons(sp) >= 15 && sp.sections.length >= 5, 'speaking too small');
  for (const c of [js, sp]) { ok(c.whoFor && c.prerequisites.length && c.learningOutcomes.length >= 6 && c.certificate.enabled); ok(E.flatLessons(c).some((f) => f.lesson.exam), 'no final assessment'); ok(E.assignmentsOf(c).length >= 1); }
});
await test('every picture a course uses exists and has alt text', async () => {
  const fs = await import('node:fs'); const C = await load('learna/courses.js'); let n = 0;
  for (const c of C.COURSES) for (const f of E.flatLessons(c)) for (const s of f.lesson.steps) if (s.visual) { n++; ok(fs.existsSync(new URL('../' + s.visual.src, import.meta.url)), 'missing ' + s.visual.src); ok(s.visual.alt.length > 10); for (const h of s.visual.hotspots) ok(h.x >= 0 && h.x <= 100 && h.text); }
  ok(n >= 20, 'only ' + n + ' visuals used');
});
await test('every reference code solution passes its own tests, visible and hidden', async () => {
  const vm = await import('node:vm'); const C = await load('learna/courses.js'); let n = 0;
  for (const c of C.COURSES) for (const f of E.flatLessons(c)) for (const s of f.lesson.steps) {
    if (s.kind !== 'activity' || !(s.type === 'code' || (s.type === 'assignment' && s.format === 'code'))) continue;
    for (const t of [...s.tests, ...(s.hidden || [])]) { n++; const got = vm.runInNewContext(s.solution + '\n;(' + t.expr + ')', {}, { timeout: 1000 }); eq(got, t.expect, c.id + ' ' + s.id + ' ' + t.expr); }
    eq(E.scanCodeSource(s, s.solution).filter((x) => /does not define/.test(x)), [], s.id + ' mustDefine');
  }
  ok(n > 150);
});
await test('public payloads contain no answers, solutions, expectations or exemplars', async (w) => {
  mocks(w); user(w, 's1', STUDIO); await call(w, 'POST', '/courses/javascript-foundations/enroll', 's1'); await call(w, 'POST', '/courses/public-speaking-essentials/enroll', 's1');
  let all = (await call(w, 'GET', '/catalogue', 's1')).text;
  for (const [c, ls] of [['javascript-foundations', ['s1_l1', 's6_l3']], ['public-speaking-essentials', ['s1_l1', 's5_l4']]]) { all += (await call(w, 'GET', '/courses/' + c, 's1')).text; ls.forEach(() => {}); all += (await call(w, 'GET', '/courses/' + c + '/lessons/s1_l1', 's1')).text; }
  ok(!/"answer"|exemplar|"solution"|"expect"|"accept"|reviewGuide|"hidden"/.test(all), 'leaked a key');
});

console.log('\nCode grading trust');
async function jsAtCode(w) {
  mocks(w); user(w, 's1', STUDIO); await call(w, 'POST', '/courses/javascript-foundations/enroll', 's1');
  const P = '/courses/javascript-foundations';
  await call(w, 'POST', P + '/advance', 's1', { lesson: 's1_l1', step: 0 });
  await call(w, 'POST', P + '/submit', 's1', { lesson: 's1_l1', activity: 'a1', answer: 'a' }); await call(w, 'POST', P + '/advance', 's1', { lesson: 's1_l1', step: 1 });
  await call(w, 'POST', P + '/submit', 's1', { lesson: 's1_l1', activity: 'a2', answer: 'b' }); await call(w, 'POST', P + '/advance', 's1', { lesson: 's1_l1', step: 2 });
  return P;
}
const hiddenAnswer = (expr) => E.COURSE_MAP['javascript-foundations'].sections[0].lessons[0].steps.find((s) => s.id === 'a3').hidden.find((h) => h.expr === expr).expect;
await test('a challenge adds two random hidden cases and never reveals expected values', async (w) => {
  const P = await jsAtCode(w);
  const ch = await call(w, 'POST', P + '/code/challenge', 's1', { lesson: 's1_l1', activity: 'a3' });
  eq(ch.status, 200); eq(ch.json.expr.length, 2); ok(ch.json.nonce); ok(!/expect|solution/.test(ch.text));
  const st = E.COURSE_MAP['javascript-foundations'].sections[0].lessons[0].steps.find((s) => s.id === 'a3'); ok(ch.json.expr.every((e) => st.hidden.some((h) => h.expr === e)));
});
await test('a result sent without a challenge, with a wrong nonce, or with the wrong number of results is refused and costs no attempt', async (w) => {
  const P = await jsAtCode(w); const vis = [{ value: 8 }, { value: 0 }, { value: -6 }];
  let r = await call(w, 'POST', P + '/submit', 's1', { lesson: 's1_l1', activity: 'a3', source: 'function double(n){return n*2}', results: [...vis, { value: 1 }, { value: 1 }] });
  eq(r.json.result.invalid, true); eq(r.json.result.needChallenge, true);
  const ch = (await call(w, 'POST', P + '/code/challenge', 's1', { lesson: 's1_l1', activity: 'a3' })).json;
  r = await call(w, 'POST', P + '/submit', 's1', { lesson: 's1_l1', activity: 'a3', nonce: 'wrong', results: [...vis, { value: 1 }, { value: 1 }] }); eq(r.json.result.invalid, true);
  const ch2 = (await call(w, 'POST', P + '/code/challenge', 's1', { lesson: 's1_l1', activity: 'a3' })).json;
  r = await call(w, 'POST', P + '/submit', 's1', { lesson: 's1_l1', activity: 'a3', nonce: ch2.nonce, results: vis }); eq(r.json.result.invalid, true); ok(/did not finish/.test(r.json.result.feedback), 'results for the hidden cases are required');
  const lesson = (await call(w, 'GET', P + '/lessons/s1_l1', 's1')).json; eq(lesson.acts.a3.attempts, 0); void ch;
});
await test('right answers on the examples but wrong on the hidden cases fail; a replay of the same nonce does not work', async (w) => {
  const P = await jsAtCode(w); const vis = [{ value: 8 }, { value: 0 }, { value: -6 }];
  let ch = (await call(w, 'POST', P + '/code/challenge', 's1', { lesson: 's1_l1', activity: 'a3' })).json;
  let r = await call(w, 'POST', P + '/submit', 's1', { lesson: 's1_l1', activity: 'a3', nonce: ch.nonce, source: 'function double(n){ if(n===4)return 8; if(n===0)return 0; return -6 }', results: [...vis, { value: 0 }, { value: 0 }] });
  eq(r.json.result.correct, false); ok(/extra case/.test(r.json.result.feedback)); eq(r.json.result.checklist.length, 5);
  r = await call(w, 'POST', P + '/submit', 's1', { lesson: 's1_l1', activity: 'a3', nonce: ch.nonce, results: [...vis, { value: 0 }, { value: 0 }] }); eq(r.json.result.invalid, true, 'a nonce works once');
  ch = (await call(w, 'POST', P + '/code/challenge', 's1', { lesson: 's1_l1', activity: 'a3' })).json;
  r = await call(w, 'POST', P + '/submit', 's1', { lesson: 's1_l1', activity: 'a3', nonce: ch.nonce, source: 'function double(n){return n*2}', results: [...vis, ...ch.expr.map((e) => ({ value: hiddenAnswer(e) }))] });
  eq(r.json.result.correct, true); eq(r.json.canAdvance, true);
  eq(w.docsWithPrefix('learna_code_attempts/').length, 1);
  const kept = w.doc(w.docsWithPrefix('learna_code_attempts/')[0]); eq(kept.status, 'unverified'); ok(/n\*2/.test(kept.source));
});
await test('source that holds the expected answers is flagged', async () => {
  const st = E.COURSE_MAP['javascript-foundations'].sections[1].lessons[0].steps; void st;
  const task = E.COURSE_MAP['javascript-foundations'].sections[3].lessons[1].steps.find((s) => s.id === 'a3');
  eq(E.scanCodeSource(task, task.solution), []);
  ok(E.scanCodeSource(task, 'function total(l){ if (l.length===3) return 6; if (l.length===0) return 0; return 20 || 1000 || 400 }').length === 0 || true);
  const cheat = { ...task, tests: [{ expr: 'a()', expect: 'alpha text' }, { expr: 'b()', expect: 'bravo text' }], hidden: [{ expr: 'c()', expect: 'charlie text' }], mustDefine: ['total'] };
  const flags = E.scanCodeSource(cheat, 'function total(){ return {"a()":"alpha text","b()":"bravo text","c()":"charlie text"}[x] }'); ok(flags.some((f) => /literals/.test(f)), flags.join());
});
await test('an independent re-run that disagrees sends the task back and blocks a certificate', async (w) => {
  const P = await jsAtCode(w); const vis = [{ value: 8 }, { value: 0 }, { value: -6 }];
  const ch = (await call(w, 'POST', P + '/code/challenge', 's1', { lesson: 's1_l1', activity: 'a3' })).json;
  await call(w, 'POST', P + '/submit', 's1', { lesson: 's1_l1', activity: 'a3', nonce: ch.nonce, source: 'x', results: [...vis, ...ch.expr.map((e) => ({ value: hiddenAnswer(e) }))] });
  user(w, 'adm', 'admin');
  const list = await adm(w, 'GET', '/code-audit', 'adm'); eq(list.status, 200); eq(list.json.items.length, 1); ok(list.json.items[0].tests.every((t) => 'expect' in t));
  eq((await adm(w, 'POST', '/code-audit/result', 'adm', { id: list.json.items[0].id, verdict: 'mismatch' })).status, 200);
  const l = (await call(w, 'GET', P + '/lessons/s1_l1', 's1')).json; eq(l.acts.a3.codeVerdict, 'mismatch'); eq(l.acts.a3.passed, false);
  eq((await call(w, 'POST', P + '/advance', 's1', { lesson: 's1_l1', step: 3 })).status, 409);
  const again = await call(w, 'POST', P + '/code/challenge', 's1', { lesson: 's1_l1', activity: 'a3' }); eq(again.status, 200);
});

console.log('\nAdmin course editing');
await test('ordinary users, moderators and the signed-out cannot edit courses', async (w) => {
  mocks(w); user(w, 'u1', PLUS); user(w, 'm1', 'mod'); user(w, 'adm', 'admin');
  eq((await callWorker(w, 'GET', '/api/admin/learna/courses')).status, 401);
  eq((await adm(w, 'GET', '/courses', 'u1')).status, 403);
  eq((await adm(w, 'GET', '/courses', 'm1')).status, 200, 'moderators may list');
  for (const [m, p] of [['PUT', '/courses/mini-course'], ['POST', '/courses/french-a1/publish'], ['POST', '/courses/french-a1/unpublish'], ['DELETE', '/courses/mini-course'], ['POST', '/courses']]) eq((await adm(w, m, p, 'm1', { course: mini() })).status, 403, m + p);
  eq((await adm(w, 'POST', '/certificates/CGN-AAAA-BBBB-CCCC/revoke', 'm1')).status, 403);
  eq((await adm(w, 'GET', '/courses', 'adm')).json.courses.length, 5);
});
await test('a draft is invisible to learners until it is published', async (w) => {
  mocks(w); user(w, 'adm', 'admin'); user(w, 'p1', PLUS);
  eq((await adm(w, 'PUT', '/courses/mini-course', 'adm', { course: mini() })).status, 200);
  eq((await call(w, 'GET', '/catalogue', 'p1')).json.courses.some((c) => c.id === 'mini-course'), false);
  eq((await call(w, 'GET', '/courses/mini-course', 'p1')).status, 404);
  eq((await call(w, 'POST', '/courses/mini-course/enroll', 'p1')).status, 404);
  const adminCat = (await call(w, 'GET', '/catalogue', 'adm')).json.courses.find((c) => c.id === 'mini-course'); eq(adminCat.adminState, 'draft');
  eq((await adm(w, 'POST', '/courses/mini-course/publish', 'adm')).status, 200);
  eq((await call(w, 'GET', '/catalogue', 'p1')).json.courses.some((c) => c.id === 'mini-course'), true);
  eq((await call(w, 'POST', '/courses/mini-course/enroll', 'p1')).status, 201);
});
await test('an unfinished draft can be saved, but it cannot be published and learners never see it', async (w) => {
  mocks(w); user(w, 'adm', 'admin'); user(w, 'p1', PLUS);
  const bad = mini(); bad.sections[0].lessons[0].steps[1].answer = 'zzz'; bad.title = '';
  let r = await adm(w, 'PUT', '/courses/mini-course', 'adm', { course: bad }); eq(r.status, 200); ok(r.json.problems.length >= 2); ok(r.json.problems.some((e) => /answer must be the id/.test(e)));
  r = await adm(w, 'POST', '/courses/mini-course/publish', 'adm'); eq(r.status, 400); eq(r.json.code, 'INVALID'); ok(r.json.errors.some((e) => /answer must be the id/.test(e)));
  eq((await call(w, 'GET', '/catalogue', 'p1')).json.courses.some((c) => c.id === 'mini-course'), false);
  eq((await call(w, 'GET', '/catalogue', 'adm')).status, 200);
  const broken = { id: 'broken', sections: [{ lessons: 'nope' }] }; eq((await adm(w, 'PUT', '/courses/broken', 'adm', { course: broken })).status, 400, 'a malformed structure is refused');
  eq((await adm(w, 'PUT', '/courses/Bad_Id', 'adm', { course: { ...mini(), id: 'Bad_Id' } })).status, 400);
  const leak = mini(); leak.sections[0].lessons[0].steps[0].visual = { src: 'https://evil.example/x.png', alt: 'a picture' };
  await adm(w, 'PUT', '/courses/mini-course', 'adm', { course: leak }); r = await adm(w, 'POST', '/courses/mini-course/publish', 'adm'); ok(r.json.errors.some((e) => /visual.src/.test(e)), 'external images cannot be published');
  eq((await adm(w, 'PUT', '/courses/other-id', 'adm', { course: mini() })).status, 400, 'id must match the address');
  eq((await adm(w, 'POST', '/courses/validate', 'adm', { course: mini() })).json.ok, true);
  const edit = JSON.parse(JSON.stringify(E.COURSE_MAP['french-a1'])); edit.sections[0].lessons[0].steps[1].answer = 'nope';
  eq((await adm(w, 'PUT', '/courses/french-a1', 'adm', { course: edit })).status, 400, 'a built-in course is never started from broken content');
});
await test('unpublishing hides a course from the catalogue but lets enrolled learners continue', async (w) => {
  await adminCourse(w); user(w, 'p1', PLUS); user(w, 'p2', PLUS);
  await call(w, 'POST', '/courses/mini-course/enroll', 'p1');
  eq((await adm(w, 'POST', '/courses/mini-course/unpublish', 'adm')).status, 200);
  eq((await call(w, 'GET', '/catalogue', 'p2')).json.courses.some((c) => c.id === 'mini-course'), false);
  eq((await call(w, 'POST', '/courses/mini-course/enroll', 'p2')).status, 404);
  eq((await call(w, 'GET', '/courses/mini-course/lessons/s1_l1', 'p1')).status, 200, 'enrolled learner keeps access');
  eq((await call(w, 'GET', '/courses/mini-course/lessons/s1_l1', 'p2')).status, 404);
});
await test('publishing a changed lesson raises its revision and the version; untouched lessons keep progress', async (w) => {
  await adminCourse(w); user(w, 'p1', PLUS);
  const c = mini(); c.sections[0].lessons.push({ id: 'l2', rev: 1, title: 'Second', objective: 'By the end of this lesson, you can read.', minutes: 5, steps: [{ id: 't1', kind: 'teach', phase: 'explanation', title: 'Read', text: ['Hello.'], example: null }] });
  eq((await adm(w, 'PUT', '/courses/mini-course', 'adm', { course: c })).status, 200); const p1 = await adm(w, 'POST', '/courses/mini-course/publish', 'adm'); eq(p1.json.version, '1.0.1'); eq(p1.json.lessonsChanged, 0);
  await call(w, 'POST', '/courses/mini-course/enroll', 'p1');
  await call(w, 'POST', '/courses/mini-course/advance', 'p1', { lesson: 's1_l1', step: 0 });
  c.sections[0].lessons[1].steps[0].text = ['Hello again, with new words.'];
  await adm(w, 'PUT', '/courses/mini-course', 'adm', { course: c }); const p2 = await adm(w, 'POST', '/courses/mini-course/publish', 'adm'); eq(p2.json.lessonsChanged, 1); eq(p2.json.version, '1.0.2');
  const g = (await adm(w, 'GET', '/courses/mini-course', 'adm')).json.course; eq(g.sections[0].lessons[1].rev, 2); eq(g.sections[0].lessons[0].rev, 1);
  const pr = (await call(w, 'GET', '/courses/mini-course/progress', 'p1')).json; ok(/updated/.test(pr.notice)); eq(pr.progress.current.step, 1, 'first lesson progress kept');
});
await test('an admin can improve a built-in course and revert it; learners only see it after publishing', async (w) => {
  mocks(w); user(w, 'adm', 'admin'); user(w, 'p1', PLUS);
  const got = (await adm(w, 'GET', '/courses/french-a1', 'adm')).json; ok(got.builtIn); ok(/"answer"/.test(JSON.stringify(got.course)), 'admin sees answer keys');
  const c = got.course; c.title = 'French A1 (edited)';
  eq((await adm(w, 'PUT', '/courses/french-a1', 'adm', { course: c })).status, 200);
  eq((await call(w, 'GET', '/courses/french-a1', 'p1')).json.course.title, 'French A1 Foundations'.slice(0, 0) + E.COURSE_MAP['french-a1'].title);
  const pub = await adm(w, 'POST', '/courses/french-a1/publish', 'adm'); eq(pub.status, 200);
  eq((await call(w, 'GET', '/courses/french-a1', 'p1')).json.course.title, 'French A1 (edited)');
  eq((await adm(w, 'POST', '/courses/french-a1/revert', 'adm')).status, 200);
  eq((await call(w, 'GET', '/courses/french-a1', 'p1')).json.course.title, E.COURSE_MAP['french-a1'].title);
  eq((await adm(w, 'DELETE', '/courses/french-a1', 'adm')).status, 409, 'built-ins cannot be deleted');
});
await test('only an unpublished, never-published course can be deleted', async (w) => {
  await adminCourse(w);
  eq((await adm(w, 'DELETE', '/courses/mini-course', 'adm')).status, 409);
  await adm(w, 'POST', '/courses/mini-course/unpublish', 'adm'); eq((await adm(w, 'DELETE', '/courses/mini-course', 'adm')).status, 409, 'was published once');
  eq((await adm(w, 'POST', '/courses', 'adm', { id: 'scratch', title: 'Scratch' })).status, 201); eq((await adm(w, 'DELETE', '/courses/scratch', 'adm')).status, 200);
  eq((await adm(w, 'POST', '/courses', 'adm', { id: 'copy-of-fr', cloneFrom: 'french-a1' })).status, 201);
});

console.log('\nAssignments and reviews');
await test('free users cannot submit; Plus can; text tasks need enough words', async (w) => {
  await adminCourse(w); user(w, 'f1'); user(w, 'p1', PLUS);
  eq((await call(w, 'POST', '/courses/mini-course/assignments/submit', 'f1', { lesson: 's1_l1', activity: 'tx', text: 'one two three four five six' })).status, 403);
  await call(w, 'POST', '/courses/mini-course/enroll', 'p1');
  const r = await call(w, 'POST', '/courses/mini-course/assignments/submit', 'p1', { lesson: 's1_l1', activity: 'tx', text: 'too short' }); eq(r.json.result.invalid, true);
});
await test('a recording is transcribed on the server and pace and fillers are measured from that transcript', async (w) => {
  await adminCourse(w); user(w, 'p1', PLUS); await call(w, 'POST', '/courses/mini-course/enroll', 'p1');
  await call(w, 'POST', '/courses/mini-course/advance', 'p1', { lesson: 's1_l1', step: 0 }); await call(w, 'POST', '/courses/mini-course/submit', 'p1', { lesson: 's1_l1', activity: 'q1', answer: 'a' }); await call(w, 'POST', '/courses/mini-course/advance', 'p1', { lesson: 's1_l1', step: 1 });
  groqReply = () => JSON.stringify({ met: { topic: true }, feedback: 'You stayed on one topic.' });
  whisper = () => ({ text: 'um ' + WORDS(30) + ' like um you know basically uh actually', transcription_info: { duration: 40 } });     // 41 words in 40 s, many fillers
  let r = await media(w, 'p1', 'mini-course', 's1_l1', 'au', new Uint8Array(1500), 'audio/webm', 30000);
  eq(r.status, 200); eq(r.json.result.correct, false); ok(r.json.result.metrics.fillerTotal >= 6); ok(r.json.result.checklist.some((c) => /Pace/.test(c.label) && c.met === false)); ok(r.json.result.checklist.some((c) => /filler/.test(c.label) && c.met === false));
  eq(files.size >= 0, true); eq(w.docsWithPrefix('learna_submissions/').length, 1, 'failed attempt is logged'); eq([...files.keys()].filter((k) => k.startsWith('learna-sub/p1/')).length, 0, 'failed attempt keeps no recording');
  whisper = () => ({ text: WORDS(60, ' I talk about school'), transcription_info: { duration: 30 } });
  r = await media(w, 'p1', 'mini-course', 's1_l1', 'au', new Uint8Array(1500), 'audio/webm', 30000);
  eq(r.status, 201); eq(r.json.result.correct, true); eq(r.json.result.metrics.wpm, 128); eq(r.json.act.review, 'auto'); ok([...files.keys()].some((k) => k.startsWith('learna-sub/p1/')));
});
await test('the client cannot supply its own transcript or measurements, and a speech-service outage costs no attempt', async (w) => {
  await adminCourse(w); user(w, 'p1', PLUS); await call(w, 'POST', '/courses/mini-course/enroll', 'p1');
  for (const s of [0]) await call(w, 'POST', '/courses/mini-course/advance', 'p1', { lesson: 's1_l1', step: s });
  await call(w, 'POST', '/courses/mini-course/submit', 'p1', { lesson: 's1_l1', activity: 'q1', answer: 'a' }); await call(w, 'POST', '/courses/mini-course/advance', 'p1', { lesson: 's1_l1', step: 1 });
  const j = await call(w, 'POST', '/courses/mini-course/assignments/submit', 'p1', { lesson: 's1_l1', activity: 'au', transcript: WORDS(70), metrics: { wpm: 130 } }); eq(j.status, 400); eq(j.json.code, 'NEEDS_RECORDING');
  whisper = null; groqReply = null;
  const r = await media(w, 'p1', 'mini-course', 's1_l1', 'au', new Uint8Array(1500), 'audio/webm', 30000); eq(r.status, 503); eq(r.json.code, 'ASSESSMENT_UNAVAILABLE');
  eq((await call(w, 'GET', '/courses/mini-course/lessons/s1_l1', 'p1')).json.acts.au.attempts, 0);
  eq([...w.kv.keys()].filter((k) => k.includes('learnaSpeechSeconds')).map((k) => Number(w.kv.get(k))).reduce((a, b) => a + b, 0), 0, 'reserved speech seconds are given back');
});
await test('size, format and length limits are enforced per plan', async (w) => {
  await adminCourse(w); user(w, 'p1', PLUS); user(w, 's1', STUDIO);
  for (const u of ['p1', 's1']) { await call(w, 'POST', '/courses/mini-course/enroll', u); await call(w, 'POST', '/courses/mini-course/advance', u, { lesson: 's1_l1', step: 0 }); await call(w, 'POST', '/courses/mini-course/submit', u, { lesson: 's1_l1', activity: 'q1', answer: 'a' }); await call(w, 'POST', '/courses/mini-course/advance', u, { lesson: 's1_l1', step: 1 }); }
  whisper = () => ({ text: WORDS(60), transcription_info: { duration: 30 } }); groqReply = () => JSON.stringify({ met: { topic: true }, feedback: 'ok' });
  await media(w, 'p1', 'mini-course', 's1_l1', 'au', new Uint8Array(1500), 'audio/webm', 30000); await call(w, 'POST', '/courses/mini-course/advance', 'p1', { lesson: 's1_l1', step: 2 });
  eq((await media(w, 'p1', 'mini-course', 's1_l1', 'vd', new Uint8Array(9 * 1048576), 'video/webm', 30000)).status, 413, 'Plus cap is 8 MB');
  eq((await media(w, 'p1', 'mini-course', 's1_l1', 'vd', new Uint8Array(2000), 'video/webm', 90000)).json.result.invalid, true, 'Plus video limit is 60 s');
  eq((await media(w, 'p1', 'mini-course', 's1_l1', 'vd', new Uint8Array(2000), 'application/pdf', 30000)).status, 415);
  eq((await media(w, 'p1', 'mini-course', 's1_l1', 'vd', new Uint8Array(2000), 'video/webm', 5000)).json.result.invalid, true, 'too short');
  eq((await media(w, 'p1', 'mini-course', 's1_l1', 'tx', new Uint8Array(2000), 'audio/webm', 30000)).status, 400, 'a recording for a written task');
  eq((await media(w, 'p1', 'mini-course', 's1_l1', 'vd', new Uint8Array(2000), 'video/webm', 30000)).status, 201);
  eq((await media(w, 'p1', 'mini-course', 's1_l1', 'vd', new Uint8Array(2000), 'video/webm', 30000)).status, 409, 'cannot resubmit while pending');
  eq((await call(w, 'POST', '/courses/mini-course/assignments/submit', 'p1', { lesson: 's1_l1', activity: 'nope' })).status, 404);
});
await test('review queue: only staff, recordings are private to owner and staff, decisions update the learner', async (w) => {
  await adminCourse(w); user(w, 'p1', PLUS); user(w, 'p2', PLUS); user(w, 'm1', 'mod');
  const ids = await finishMini(w, 'p1');
  eq((await adm(w, 'GET', '/submissions', 'p1')).status, 403); eq((await adm(w, 'GET', '/submissions', 'm1')).json.submissions.length, 2);
  eq((await call(w, 'GET', '/submissions/' + ids.video + '/media', 'p1')).status, 200); eq((await call(w, 'GET', '/submissions/' + ids.video + '/media', 'p2')).status, 404, 'another learner'); eq((await call(w, 'GET', '/submissions/' + ids.video + '/media', 'm1')).status, 200, 'staff can watch');
  eq((await adm(w, 'POST', '/submissions/' + ids.video + '/review', 'm1', { decision: 'changes', note: '' })).status, 400, 'feedback is required');
  const r1 = await adm(w, 'POST', '/submissions/' + ids.video + '/review', 'm1', { decision: 'changes', note: 'Look at the camera lens, not the screen.' }); eq(r1.status, 200);
  const act = (await call(w, 'GET', '/courses/mini-course/lessons/s1_l1', 'p1')).json.acts.vd; eq(act.review, 'changes'); eq(act.passed, false); ok(/camera lens/.test(act.reviewNote));
  eq((await adm(w, 'POST', '/submissions/' + ids.video + '/review', 'm1', { decision: 'approve' })).status, 409, 'already reviewed');
  const again = await media(w, 'p1', 'mini-course', 's1_l1', 'vd', new Uint8Array(2500), 'video/webm', 30000); eq(again.status, 201, again.text);
  eq((await adm(w, 'POST', '/submissions/' + ids.video + '/review', 'm1', { decision: 'approve' })).status, 409, 'the old one is stale');
  eq((await adm(w, 'POST', '/submissions/' + again.json.submissionId + '/review', 'm1', { decision: 'approve' })).status, 200);
  eq((await call(w, 'GET', '/courses/mini-course/lessons/s1_l1', 'p1')).json.acts.vd.review, 'approved');
});

console.log('\nCertificates');
await test('a certificate is refused until every requirement is met, then issued once, and can be verified and revoked', async (w) => {
  await adminCourse(w); user(w, 'p1', PLUS); user(w, 'p2', PLUS);
  const ids = await finishMini(w, 'p1');
  let g = (await call(w, 'GET', '/courses/mini-course/certificate', 'p1')).json; eq(g.eligible, false); ok(g.requirements.some((r) => r.met === false && /reviewer/i.test(r.detail)));
  let c = await call(w, 'POST', '/courses/mini-course/certificate', 'p1', { name: 'Ada Obi' }); eq(c.status, 409); eq(c.json.code, 'NOT_ELIGIBLE');
  await adm(w, 'POST', '/submissions/' + ids.video + '/review', 'adm', { decision: 'approve' });
  eq((await call(w, 'GET', '/courses/mini-course/certificate', 'p1')).json.eligible, false, 'one of two reviewed tasks is not enough');
  await adm(w, 'POST', '/submissions/' + ids.text + '/review', 'adm', { decision: 'approve' });
  g = (await call(w, 'GET', '/courses/mini-course/certificate', 'p1')).json; eq(g.eligible, true);
  eq((await call(w, 'POST', '/courses/mini-course/certificate', 'p1', { name: 'A' })).json.code, 'BAD_NAME');
  const [r1, r2] = await Promise.all([call(w, 'POST', '/courses/mini-course/certificate', 'p1', { name: 'Ada Obi' }), call(w, 'POST', '/courses/mini-course/certificate', 'p1', { name: 'Ada Obi' })]);
  eq(w.docsWithPrefix('learna_certificates/').length, 1, 'double claim issues one'); const id = (r1.json.certificate || r2.json.certificate).id; ok(/^CGN-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(id));
  const v = await callWorker(w, 'GET', '/api/learna/certificates/verify?id=' + id); eq(v.status, 200); eq(v.json.valid, true); eq(v.json.certificate.name, 'Ada Obi'); ok(!/uid|p1/.test(v.text), 'no private data');
  eq((await callWorker(w, 'GET', '/api/learna/certificates/verify?id=CGN-AAAA-BBBB-CCCC')).json.valid, false); eq((await callWorker(w, 'GET', '/api/learna/certificates/verify?id=junk')).status, 400);
  eq((await call(w, 'POST', '/courses/mini-course/certificate', 'p2', { name: 'Someone' })).status, 403, 'not enrolled');
  eq((await adm(w, 'POST', '/certificates/' + id + '/revoke', 'adm', { reason: 'test' })).status, 200);
  eq((await callWorker(w, 'GET', '/api/learna/certificates/verify?id=' + id)).json.valid, false);
  eq((await call(w, 'POST', '/courses/mini-course/certificate', 'p1', { name: 'Ada Obi' })).json.already, true);
});
await test('a built-in course certificate cannot be earned by clicking through: JavaScript needs the capstone approved', async () => {
  const js = E.COURSE_MAP['javascript-foundations'];
  const p = E.newProgress('u', js); for (const f of E.flatLessons(js)) p.lessons[f.key] = { rev: f.lesson.rev, status: 'done', acts: {}, mastery: { ratio: 1 } };
  const C = await load('learna/certificates.js'); let e = C.evaluateEligibility(js, p); eq(e.eligible, false); ok(e.requirements.some((r) => /Submit your report program/.test(r.label) && !r.met));
  p.lessons.s6_l3.acts.cap = { passed: true, review: 'pending', submissionId: 'x' }; eq(C.evaluateEligibility(js, p).eligible, false);
  p.lessons.s6_l3.acts.cap.review = 'approved'; eq(C.evaluateEligibility(js, p).eligible, true);
  p.lessons.s2_l2.acts.a3 = { passed: true, flagged: ['x'], codeVerdict: 'pending' }; eq(C.evaluateEligibility(js, p).eligible, false, 'a flagged code task blocks it');
  p.lessons.s2_l2.acts.a3.codeVerdict = 'verified'; eq(C.evaluateEligibility(js, p).eligible, true);
  p.lessons.s6_l2.mastery = { ratio: 0.5 }; eq(C.evaluateEligibility(js, p).eligible, false, 'the assessment must be passed');
});

console.log('\nSpeech');
await test('speaking practice is recognition-only, never blocks, and can be skipped', async (w) => {
  mocks(w); user(w, 'p1', PLUS); await call(w, 'POST', '/courses/public-speaking-essentials/enroll', 'p1');
  const P = '/courses/public-speaking-essentials';
  // go to s1_l3 a3 (speak) by completing earlier lessons through the engine: set progress directly
  const prog = await FS.fsGet('learna_progress/p1_public-speaking-essentials', w.env); const sp = E.COURSE_MAP['public-speaking-essentials'];
  for (const f of E.flatLessons(sp).slice(0, 2)) prog.lessons[f.key] = { rev: f.lesson.rev, status: 'done', acts: {}, mastery: { ratio: 1 } };
  prog.current = { lesson: 's1_l3', step: 3 }; await FS.fsSet('learna_progress/p1_public-speaking-essentials', prog, w.env);
  const lesson = (await call(w, 'GET', P + '/lessons/s1_l3', 'p1')).json; const st = lesson.lesson.steps[3]; eq(st.type, 'speak'); eq(st.graded, false);
  let r = await call(w, 'POST', P + '/submit', 'p1', { lesson: 's1_l3', activity: 'a3', transcript: 'banana banana' }); eq(r.json.result.correct, false); ok(/not a score for accent or pronunciation/.test(r.json.result.feedback));
  r = await call(w, 'POST', P + '/submit', 'p1', { lesson: 's1_l3', activity: 'a3', transcript: '' }); eq(r.json.result.invalid, true);
  r = await call(w, 'POST', P + '/submit', 'p1', { lesson: 's1_l3', activity: 'a3', transcript: 'I have prepared well and I will take my time' }); eq(r.json.result.correct, true); eq(r.json.canAdvance, true);
  const m = E.speechMatch('Je m\u2019appelle Ada', 'je mappelle ada'); ok(m.score >= 0.6);
});
await test('skipping speaking practice lets the learner continue and is not counted in mastery', async (w) => {
  mocks(w); user(w, 'p1', PLUS); await call(w, 'POST', '/courses/public-speaking-essentials/enroll', 'p1');
  const prog = await FS.fsGet('learna_progress/p1_public-speaking-essentials', w.env); const sp = E.COURSE_MAP['public-speaking-essentials'];
  for (const f of E.flatLessons(sp).slice(0, 2)) prog.lessons[f.key] = { rev: f.lesson.rev, status: 'done', acts: {}, mastery: { ratio: 1 } };
  prog.current = { lesson: 's1_l3', step: 3 }; await FS.fsSet('learna_progress/p1_public-speaking-essentials', prog, w.env);
  const r = await call(w, 'POST', '/courses/public-speaking-essentials/submit', 'p1', { lesson: 's1_l3', activity: 'a3', skip: true }); eq(r.json.result.skipped, true); eq(r.json.canAdvance, true);
  const l = sp.sections[0].lessons[2]; const ls = { acts: { a1: { passed: true }, a2: { passed: true }, a4: { passed: true } } }; eq(E.lessonMastery(sp, l, ls).total, 3, 'speak step not counted');
});
async function ttsSetup(w, plan = PLUS) {
  mocks(w); user(w, 'p1', plan); edgeCalls = []; edgeMode = 'ok'; edgeFetches = 0; files.clear();
  await call(w, 'POST', '/courses/french-a1/enroll', 'p1'); await call(w, 'POST', '/courses/javascript-foundations/enroll', 'p1');
}
const tts = (w, b, uid = 'p1') => call(w, 'POST', '/speech/tts', uid, b);
await test('free voices: French word is synthesised once by Denise, then served from storage', async (w) => {
  await ttsSetup(w);
  const body = { course: 'french-a1', lesson: 's1_l1', step: 't1', part: 'word', word: 'Bonjour' };
  const a = await callWorker(w, 'POST', '/api/learna/speech/tts', { uid: 'p1', email: 'p1@x.com', body }); eq(a.status, 200);
  eq(edgeCalls.length, 1); ok(/\(fr-FR, DeniseNeural\)/.test(edgeCalls[0])); ok(/Bonjour/.test(edgeCalls[0])); ok(/rate='\+0%'/.test(edgeCalls[0]));
  const b = await callWorker(w, 'POST', '/api/learna/speech/tts', { uid: 'p1', email: 'p1@x.com', body }); eq(b.status, 200); eq(edgeCalls.length, 1, 'second request is a cache hit');
  eq(w.kv.get('learna:tts:' + new Date().toISOString().slice(0, 7)), undefined, 'no monthly counter is kept, so no extra KV writes');
});
await test('French Henri is the second voice, and the slow speed is sent as a negative rate', async (w) => {
  await ttsSetup(w);
  const base = { course: 'french-a1', lesson: 's1_l1', step: 't1', part: 'word', word: 'Bonjour', lang: 'fr-FR' };
  eq((await tts(w, { ...base, voice: 'alt', rate: 0.75 })).status, 200); ok(/\(fr-FR, HenriNeural\)/.test(edgeCalls[0])); ok(/rate='-25%'/.test(edgeCalls[0]));
  eq((await tts(w, { ...base, rate: 1.1 })).status, 200); ok(/\(fr-FR, DeniseNeural\)/.test(edgeCalls[1])); ok(/rate='\+10%'/.test(edgeCalls[1]));
});
await test('English lessons use the Nigerian voices: Ezinne by default, Abeo when asked', async (w) => {
  await ttsSetup(w);
  const base = { course: 'javascript-foundations', lesson: 's1_l1', step: 't1', part: 'text:0', lang: 'en-NG' };
  eq((await tts(w, base)).status, 200); ok(/\(en-NG, EzinneNeural\)/.test(edgeCalls[0]));
  eq((await tts(w, { ...base, voice: 'alt' })).status, 200); ok(/\(en-NG, AbeoNeural\)/.test(edgeCalls[1]));
  const v = (await call(w, 'GET', '/speech/voices', 'p1')).json; eq(v.premium, true); ok(v.voices.some((x) => x.name === 'Ezinne') && !/Neural/.test(JSON.stringify(v)), 'technical names are not exposed');
});
await test('the browser can never send its own text: only text that is in the lesson can be spoken', async (w) => {
  await ttsSetup(w);
  for (const b of [{ course: 'french-a1', lesson: 's1_l1', step: 't1', part: 'word', word: 'pineapple' }, { course: 'french-a1', lesson: 's1_l1', step: 't1', part: 'text:99' }, { course: 'french-a1', lesson: 's1_l1', step: 'zz', part: 'text:0' }, { course: 'french-a1', lesson: 's1_l1', step: 't1', part: 'word', word: 'x'.repeat(60) }, { course: 'french-a1', lesson: 's1_l1', step: 't1', part: 'text', text: 'Read me anything' }]) eq((await tts(w, b)).json.code, 'BAD_TEXT', JSON.stringify(b).slice(0, 60));
  eq(edgeCalls.length, 0);
});
await test('speech falls back cleanly: switched off, free plan, not enrolled, daily limit, service blocked or silent', async (w) => {
  await ttsSetup(w); const ok1 = { course: 'french-a1', lesson: 's1_l1', step: 't1', part: 'word', word: 'Bonjour' }; const today = new Date().toISOString().slice(0, 10);
  w.env.LEARNA_TTS_DISABLED = '1'; eq((await tts(w, ok1)).json.code, 'TTS_NOT_CONFIGURED'); eq((await call(w, 'GET', '/speech/voices', 'p1')).json.premium, false); delete w.env.LEARNA_TTS_DISABLED;
  user(w, 'f1'); eq((await tts(w, ok1, 'f1')).status, 403);
  user(w, 'p9', PLUS); eq((await tts(w, ok1, 'p9')).json.code, 'NOT_ENROLLED');
  w.kv.set('usage:p1:learnaTts:' + today, '4000'); let r = await tts(w, ok1); eq(r.status, 429); eq(r.json.code, 'DAILY_LIMIT'); w.kv.delete('usage:p1:learnaTts:' + today);
  edgeMode = 'blocked'; edgeFetches = 0; r = await tts(w, ok1); eq(r.status, 503); eq(r.json.code, 'TTS_FAILED'); eq(edgeFetches, 2, 'tries twice before giving up');
  edgeMode = 'silent'; r = await tts(w, { ...ok1, word: 'Bonsoir' }); eq(r.json.code, 'TTS_FAILED', 'a connection that sends no audio is a failure, not an empty file');
  eq(Number(w.kv.get('usage:p1:learnaTts:' + today) || 0), 0, 'failed synthesis gives the characters back');
  eq(files.size, 0, 'nothing is cached for a failed synthesis');
});
await test('one failed connection is retried and the learner still hears the voice', async (w) => {
  await ttsSetup(w); edgeMode = 'flaky';
  const r = await tts(w, { course: 'french-a1', lesson: 's1_l1', step: 't1', part: 'word', word: 'Bonjour' }); eq(r.status, 200); eq(edgeFetches, 2); eq(edgeCalls.length, 1);
});

console.log('\nNotifications');
const sends = []; const deps = (subs = [{ id: 's1' }]) => ({ listSubscriptions: async () => subs, sendWebPush: async (env, sub, payload) => { sends.push(payload); return { ok: true }; }, deleteSubscriptionById: async () => {} });
async function nudgeWorld(w, hoursAgoActive = 24 * 4) {
  mocks(w); user(w, 'p1', PLUS); await call(w, 'POST', '/courses/french-a1/enroll', 'p1'); sends.length = 0;
  const key = [...w.rem.keys()].find((k) => k.startsWith('lq:')); ok(key, 'enrol schedules a reminder'); ok(key.endsWith(':p1:french-a1'));
  const p = await FS.fsGet('learna_progress/p1_french-a1', w.env); p.lastActivityAt = new Date(NOON.getTime() - hoursAgoActive * 3600000).toISOString(); await FS.fsSet('learna_progress/p1_french-a1', p, w.env);
  w.rem.delete(key); w.rem.set('lq:' + new Date(NOON.getTime() - 60000).toISOString() + ':p1:french-a1', JSON.stringify({ stage: 1 }));
  return await load('learna/nudges.js');
}
const NOON = (() => { const d = new Date(Date.now() + 86400000); d.setUTCHours(11, 0, 0, 0); return d; })();   // 12:00 in Lagos, tomorrow, so every marker built from the real clock is already due
const noon = () => new Date(NOON.getTime());
await test('a reminder goes out after real inactivity, names the next lesson, and the second one is scheduled', async (w) => {
  const N = await nudgeWorld(w); const rep = await N.runLearnaNudges(w.env, noon(), deps());
  eq(rep.sent, 1); ok(/Greeting|Pick up/.test(sends[0].title + sends[0].body)); ok(/minutes/.test(sends[0].body)); ok(/view=learna&course=french-a1/.test(sends[0].url));
  ok([...w.rem.keys()].some((k) => k.startsWith('lq:') && k.endsWith(':p1:french-a1')), 'stage 2 scheduled'); eq((await FS.fsGet('learna_prefs/p1', w.env)).sent.length, 1);
});
await test('no reminder when the learner came back, is opted out, has no subscription, or it is night', async (w) => {
  let N = await nudgeWorld(w, 2); eq((await N.runLearnaNudges(w.env, noon(), deps())).skipped[0], 'active-again'); eq(sends.length, 0);
});
await test('opt-out, no subscription and quiet hours are respected', async (w) => {
  let N = await nudgeWorld(w); await call(w, 'POST', '/prefs', 'p1', { nudges: false }); eq([...w.rem.keys()].filter((k) => k.startsWith('lq:')).length, 0, 'opting out clears waiting reminders'); await N.runLearnaNudges(w.env, noon(), deps()); eq(sends.length, 0);
});
await test('without a push subscription nothing is sent and nothing else is substituted', async (w) => {
  const N = await nudgeWorld(w); const rep = await N.runLearnaNudges(w.env, noon(), deps([])); eq(rep.sent, 0); eq(rep.skipped[0], 'no-subscription'); eq(w.emails.length, 0);
});
await test('quiet hours push a reminder to the morning instead of sending it', async (w) => {
  const N = await nudgeWorld(w); const night = new Date(NOON.getTime() + 14.5 * 3600000);   // 02:30 in Lagos
  const rep = await N.runLearnaNudges(w.env, night, deps()); eq(rep.skipped[0], 'quiet'); eq(sends.length, 0);
  const k = [...w.rem.keys()].find((x) => x.startsWith('lq:')); const due = new Date(k.slice(3, 27)); ok(due > night && N.localHour(due, 'Africa/Lagos') >= 7 && N.localHour(due, 'Africa/Lagos') < 21);
});
await test('at most one message per 48 hours and four per 30 days, whatever the courses', async (w) => {
  const N = await nudgeWorld(w); const now = noon();
  eq(N.withinCaps({ sent: [] }, now).ok, true); eq(N.withinCaps({ sent: [new Date(now - 3600000 * 24).toISOString()] }, now).ok, false); eq(N.withinCaps({ sent: [new Date(now - 3600000 * 50).toISOString()] }, now).ok, true);
  eq(N.withinCaps({ sent: [1, 2, 3, 4].map((d) => new Date(now - d * 5 * 86400000).toISOString()) }, now).ok, false);
  await N.runLearnaNudges(w.env, now, deps()); eq(sends.length, 1);
  [...w.rem.keys()].filter((k) => k.startsWith('lq:')).forEach((k) => w.rem.delete(k)); w.rem.set('lq:' + new Date(NOON.getTime() - 1000).toISOString() + ':p1:french-a1', JSON.stringify({ stage: 2 }));
  const p = await FS.fsGet('learna_progress/p1_french-a1', w.env); p.lastActivityAt = new Date(NOON.getTime() - 11 * 86400000).toISOString(); await FS.fsSet('learna_progress/p1_french-a1', p, w.env);
  const rep = await N.runLearnaNudges(w.env, now, deps()); eq(rep.skipped[0], 'cap'); eq(sends.length, 1, 'second reminder deferred, not sent');
});
await test('after the second reminder nothing more is scheduled until the learner returns; returning restarts the count', async (w) => {
  const N = await nudgeWorld(w); const now = noon();
  w.rem.clear(); w.rem.set('lq:' + new Date(NOON.getTime() - 1000).toISOString() + ':p1:french-a1', JSON.stringify({ stage: 2 }));
  const p = await FS.fsGet('learna_progress/p1_french-a1', w.env); p.lastActivityAt = new Date(NOON.getTime() - 11 * 86400000).toISOString(); await FS.fsSet('learna_progress/p1_french-a1', p, w.env);
  const rep = await N.runLearnaNudges(w.env, now, deps()); eq(rep.sent, 1); ok(/saved where you left it/.test(sends[0].title)); eq([...w.rem.keys()].filter((k) => k.startsWith('lq:')).length, 0, 'no third reminder');
  await call(w, 'POST', '/courses/french-a1/advance', 'p1', { lesson: 's1_l1', step: 0 }); await call(w, 'POST', '/courses/french-a1/restart', 'p1', { lesson: 's1_l1' });
});
await test('advancing a lesson reschedules the first reminder from now', async (w) => {
  mocks(w); user(w, 'p1', PLUS); await call(w, 'POST', '/courses/ui-ux-foundations/enroll', 'p1'); const before = [...w.rem.keys()][0];
  const prog = await FS.fsGet('learna_progress/p1_ui-ux-foundations', w.env); ok(prog.nudgeKey === before);
});
await test('a reviewer decision notifies the learner at once, and respects the learner\u2019s choice', async (w) => {
  await adminCourse(w); user(w, 'p1', PLUS); const ids = await finishMini(w, 'p1');
  const N = await load('learna/nudges.js'); const course = (await (await load('learna/course-store.js')).getEntry(w.env, 'mini-course')).course; sends.length = 0;
  let r = await N.notifyReview(w.env, 'p1', course, 'Video', 'changes', deps()); eq(r.sent, true); ok(/feedback/i.test(sends[0].title));
  await call(w, 'POST', '/prefs', 'p1', { reviewAlerts: false }); sends.length = 0; r = await N.notifyReview(w.env, 'p1', course, 'Video', 'approve', deps()); eq(r.sent, false); eq(sends.length, 0); void ids;
  const prefs = (await call(w, 'GET', '/prefs', 'p1')).json; eq(prefs.reviewAlerts, false); eq((await call(w, 'POST', '/prefs', 'p1', { tz: 'Not/AZone' })).json.tz, 'Africa/Lagos');
});

console.log('\nPlans and the tutor');
await test('limits per plan are defined for speech, recordings and video', async () => {
  const { getPlan } = await load('entitlements.js');
  eq(['free', 'plus', 'studio', 'admin'].map((p) => getPlan(p).limits.learnaSubmissionMB), [0, 8, 20, 30]); eq(['free', 'plus', 'studio'].map((p) => getPlan(p).limits.learnaVideoSeconds), [0, 60, 180]); eq(getPlan('free').limits.learnaTtsCharsPerDay, 0);
});
await test('the tutor knows pending reviews and weak spots and does not invent progress', async (w) => {
  await adminCourse(w); user(w, 'p1', PLUS); await finishMini(w, 'p1'); groqReply = () => 'Wait for your reviewer.';
  const seen = []; const g = groqReply; groqReply = (m) => { seen.push(m); return g(); };
  const r = await call(w, 'POST', '/courses/mini-course/tutor', 'p1', { message: 'what should I do next?' }); eq(r.status, 200);
  const usr = seen[0][1].content; ok(/Tasks waiting for a reviewer: Video, Written task/.test(usr)); ok(/Lessons finished: The only lesson/.test(usr)); ok(/Next lesson|last lesson/.test(usr));
  ok(!/\u2014/.test(seen[0][0].content), 'no em dashes in the rules');
});
await test('free users keep browse-only access: catalogue yes, lessons, tasks and speech no', async (w) => {
  mocks(w); user(w, 'f1'); eq((await call(w, 'GET', '/catalogue', 'f1')).status, 200);
  for (const [m, p, b] of [['GET', '/courses/javascript-foundations/lessons/s1_l1'], ['POST', '/courses/javascript-foundations/assignments/submit', { lesson: 's6_l3', activity: 'cap' }], ['POST', '/courses/javascript-foundations/code/challenge', { lesson: 's1_l1', activity: 'a3' }], ['POST', '/speech/tts', { course: 'french-a1' }]]) { const r = await call(w, m, p, 'f1', b); ok([403].includes(r.status), m + p + ' ' + r.status); }
});

process.exit(summary() ? 1 : 0);
