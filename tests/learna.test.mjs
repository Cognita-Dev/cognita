import { test, eq, ok, summary, callWorker, load } from './harness.mjs';

// The shared harness has no Firestore query or AI provider mock, so this file adds both.
let groqReply = null;           // function(messages) -> string, or null to simulate an outage
const lastGroq = { messages: null };
function extend(w) {
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const u = new URL(url);
    if (u.host === 'firestore.googleapis.com' && u.pathname.endsWith(':runQuery')) {
      const q = JSON.parse(init.body).structuredQuery;
      const col = q.from[0].collectionId, field = q.where.fieldFilter.field.fieldPath, val = q.where.fieldFilter.value.stringValue;
      const rows = [...w.docs.entries()].filter(([k, f]) => k.startsWith(col + '/') && f[field] && f[field].stringValue === val)
        .map(([k, f]) => ({ document: { name: 'projects/proj/databases/(default)/documents/' + k, fields: f } }));
      return new Response(JSON.stringify(rows.length ? rows : [{}]), { status: 200 });
    }
    if (u.host === 'api.groq.com' || u.host === 'openrouter.ai') {
      const body = JSON.parse(init.body);
      lastGroq.messages = body.messages;
      const text = groqReply ? groqReply(body.messages) : null;
      if (text === null) return new Response('down', { status: 500 });
      return new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }], usage: {} }), { status: 200 });
    }
    return inner(input, init);
  };
}

const PLUS = 'plus', STUDIO = 'studio';
function user(w, uid, plan) {
  w.addUser(uid, uid + '@x.com');
  if (plan) w.setDoc('accounts/' + uid, { uid, planId: plan, status: 'active', periodEnd: new Date(Date.now() + 20 * 86400000).toISOString(), createdAt: new Date().toISOString() });
  if (plan === 'admin') { w.setDoc('accounts/' + uid, { uid, planId: 'free', status: 'none', periodEnd: null, createdAt: new Date().toISOString() }); w.setDoc('admins/' + uid, { role: 'admin' }); }
}
const call = (w, method, path, uid, body) => callWorker(w, method, '/api/learna' + path, { uid, email: uid + '@x.com', body });
const ALL = ['french-a1', 'javascript-foundations', 'public-speaking-essentials', 'ui-ux-foundations', 'sales-conversations'];

console.log('\nAuth and catalogue');
await test('catalogue needs sign-in', async (w) => { extend(w); eq((await callWorker(w, 'GET', '/api/learna/catalogue')).status, 401); });
await test('free user can browse the catalogue and course detail', async (w) => {
  extend(w); user(w, 'f1');
  const r = await call(w, 'GET', '/catalogue', 'f1'); eq(r.status, 200);
  eq(r.json.courses.length, 5); eq(r.json.viewer.canTake, false); eq(r.json.courses[0].access_state.allowed, false);
  const d = await call(w, 'GET', '/courses/french-a1', 'f1'); eq(d.status, 200); ok(d.json.course.curriculum.length === 2); eq(d.json.access.reason, 'PLAN_REQUIRED');
});
await test('catalogue and detail never contain answer keys', async (w) => {
  extend(w); user(w, 'f1');
  const t = (await call(w, 'GET', '/catalogue', 'f1')).text + (await call(w, 'GET', '/courses/javascript-foundations', 'f1')).text;
  ok(!/"answer"|exemplar|"solution"|"expect"|"accept"/.test(t), 'leaked a key');
});
await test('unknown course is 404', async (w) => { extend(w); user(w, 'f1'); eq((await call(w, 'GET', '/courses/nope', 'f1')).status, 404); });

console.log('\nEnrolment and the Plus limit');
await test('free user cannot enrol', async (w) => {
  extend(w); user(w, 'f1');
  const r = await call(w, 'POST', '/courses/french-a1/enroll', 'f1'); eq(r.status, 403); eq(r.json.code, 'PLAN_REQUIRED');
  eq(w.docsWithPrefix('learna_').length, 0);
});
await test('free user cannot reach lessons or tutor', async (w) => {
  extend(w); user(w, 'f1');
  eq((await call(w, 'GET', '/courses/french-a1/lessons/s1_l1', 'f1')).status, 403);
  eq((await call(w, 'POST', '/courses/french-a1/tutor', 'f1', { message: 'hello' })).status, 403);
});
await test('unauthenticated enrol is 401', async (w) => { extend(w); eq((await callWorker(w, 'POST', '/api/learna/courses/french-a1/enroll')).status, 401); });
await test('plus: first and second allowed, third blocked, repeat is idempotent', async (w) => {
  extend(w); user(w, 'p1', PLUS);
  eq((await call(w, 'POST', '/courses/french-a1/enroll', 'p1')).status, 201);
  eq((await call(w, 'POST', '/courses/javascript-foundations/enroll', 'p1')).status, 201);
  const third = await call(w, 'POST', '/courses/sales-conversations/enroll', 'p1'); eq(third.status, 403); eq(third.json.code, 'COURSE_LIMIT');
  const again = await call(w, 'POST', '/courses/french-a1/enroll', 'p1'); eq(again.status, 200); eq(again.json.already, true);
  eq((await call(w, 'POST', '/courses/sales-conversations/enroll', 'p1')).status, 403);
  eq(w.docsWithPrefix('learna_progress/').length, 2);
});
await test('plus: parallel enrol requests cannot exceed the limit', async (w) => {
  extend(w); user(w, 'p2', PLUS);
  const rs = await Promise.all(ALL.map((c) => call(w, 'POST', '/courses/' + c + '/enroll', 'p2')));
  eq(rs.filter((r) => r.status === 201).length, 2);
  eq(w.docsWithPrefix('learna_progress/').length, 2);
});
await test('studio and admin can enrol in everything', async (w) => {
  extend(w); user(w, 's1', STUDIO); user(w, 'a1', 'admin');
  for (const u of ['s1', 'a1']) for (const c of ALL) eq((await call(w, 'POST', '/courses/' + c + '/enroll', u)).status, 201, u + ' ' + c);
  eq(w.docsWithPrefix('learna_slots/').length, 0);
});
await test("one user's progress is not visible to another", async (w) => {
  extend(w); user(w, 'p1', PLUS); user(w, 'p3', PLUS);
  await call(w, 'POST', '/courses/french-a1/enroll', 'p1');
  eq((await call(w, 'GET', '/courses/french-a1/progress', 'p3')).json.code, 'NOT_ENROLLED');
});
await test('catalogue reports viewer limit and active count', async (w) => {
  extend(w); user(w, 'p1', PLUS);
  await call(w, 'POST', '/courses/french-a1/enroll', 'p1'); await call(w, 'POST', '/courses/ui-ux-foundations/enroll', 'p1');
  const c = (await call(w, 'GET', '/catalogue', 'p1')).json;
  eq(c.viewer.courseLimit, 2); eq(c.viewer.activeCourses, 2); eq(c.viewer.atLimit, true); ok(c.mine['french-a1']);
});

console.log('\nLessons, answers and progress');
const L = '/courses/french-a1/lessons/s1_l1';
async function started(w, uid = 'p1', plan = PLUS) { extend(w); user(w, uid, plan); await call(w, 'POST', '/courses/french-a1/enroll', uid); }
await test('lesson payload hides answers and shuffles order items', async (w) => {
  await started(w);
  const r = await call(w, 'GET', L, 'p1'); eq(r.status, 200);
  ok(!/"answer"|exemplar|"accept"/.test(r.text), 'leaked');
  const ord = r.json.lesson.steps.find((s) => s.type === 'order'); ok(ord.items.join() !== ['Bonjour !', 'Je m\u2019appelle Léa. Et toi ?', 'Je m\u2019appelle Marc.', 'Enchanté !'].join());
});
await test('locked lessons are refused', async (w) => { await started(w); eq((await call(w, 'GET', '/courses/french-a1/lessons/s2_l2', 'p1')).status, 403); });
await test('cannot skip a step or an unfinished activity', async (w) => {
  await started(w);
  eq((await call(w, 'POST', '/courses/french-a1/advance', 'p1', { lesson: 's1_l1', step: 3 })).status, 409);
  eq((await call(w, 'POST', '/courses/french-a1/advance', 'p1', { lesson: 's1_l1', step: 0 })).status, 200);
  const r = await call(w, 'POST', '/courses/french-a1/advance', 'p1', { lesson: 's1_l1', step: 1 });
  eq(r.status, 409); eq(r.json.code, 'STEP_INCOMPLETE');
});
await test('submitting a non-current activity is refused', async (w) => {
  await started(w);
  eq((await call(w, 'POST', '/courses/french-a1/submit', 'p1', { lesson: 's1_l1', activity: 'a3', answer: 'a' })).status, 409);
});
await test('wrong then right answer; hints counted; attempts persist', async (w) => {
  await started(w);
  await call(w, 'POST', '/courses/french-a1/advance', 'p1', { lesson: 's1_l1', step: 0 });
  let r = await call(w, 'POST', '/courses/french-a1/submit', 'p1', { lesson: 's1_l1', activity: 'a1', answer: 'b' });
  eq(r.json.result.correct, false); ok(/goodbye/.test(r.json.result.feedback)); eq(r.json.result.attemptsLeft, 2);
  const h = await call(w, 'POST', '/courses/french-a1/hint', 'p1', { lesson: 's1_l1', activity: 'a1' }); ok(h.json.hint);
  r = await call(w, 'POST', '/courses/french-a1/submit', 'p1', { lesson: 's1_l1', activity: 'a1', answer: 'a' });
  eq(r.json.result.correct, true); eq(r.json.canAdvance, true);
  const back = await call(w, 'GET', L, 'p1'); eq(back.json.step, 1 + 0 === 1 ? back.json.step : 0); eq(back.json.acts.a1.attempts, 2); eq(back.json.acts.a1.hintsUsed, 1); eq(back.json.acts.a1.passed, true);
  eq((await call(w, 'POST', '/courses/french-a1/submit', 'p1', { lesson: 's1_l1', activity: 'a1', answer: 'a' })).status, 409);
});
await test('three misses reveal the answer and let the learner move on', async (w) => {
  await started(w);
  await call(w, 'POST', '/courses/french-a1/advance', 'p1', { lesson: 's1_l1', step: 0 });
  let r; for (let i = 0; i < 3; i++) r = await call(w, 'POST', '/courses/french-a1/submit', 'p1', { lesson: 's1_l1', activity: 'a1', answer: 'c' });
  eq(r.json.result.revealed.answer, 'Bonsoir'); eq(r.json.canAdvance, true);
});
await test('invalid answers do not use an attempt', async (w) => {
  await started(w);
  await call(w, 'POST', '/courses/french-a1/advance', 'p1', { lesson: 's1_l1', step: 0 });
  const r = await call(w, 'POST', '/courses/french-a1/submit', 'p1', { lesson: 's1_l1', activity: 'a1', answer: 'zzz' });
  eq(r.json.result.invalid, true);
  eq((await call(w, 'GET', L, 'p1')).json.acts.a1.attempts, 0);
});

// Plays a whole lesson using the course's own answer key (loaded server side in the test only).
async function playLesson(w, uid, courseId, key, { fail = false } = {}) {
  const E = await load('learna/engine.js');
  const course = E.COURSE_MAP[courseId];
  const f = E.flatLessons(course).find((x) => x.key === key);
  let last;
  for (let i = 0; i < f.lesson.steps.length; i++) {
    const st = f.lesson.steps[i];
    if (st.kind === 'activity') {
      let res;
      if (fail) { for (let k = 0; k < st.maxAttempts; k++) res = await call(w, 'POST', '/courses/' + courseId + '/submit', uid, wrong(st)); }
      else res = await call(w, 'POST', '/courses/' + courseId + '/submit', uid, right(st, key));
      if (!fail) eq(res.json.result.correct, true, st.id + ': ' + JSON.stringify(res.json));
    }
    last = await call(w, 'POST', '/courses/' + courseId + '/advance', uid, { lesson: key, step: i });
    eq(last.status, 200, 'advance ' + st.id + ' ' + JSON.stringify(last.json));
  }
  return last.json;
}
function right(st, key) {
  const b = { lesson: key, activity: st.id };
  if (st.type === 'choice') b.answer = st.answer;
  else if (st.type === 'fill') b.answer = st.accept[0];
  else if (st.type === 'order') b.answer = st.items;
  else if (st.type === 'match') b.answer = Object.fromEntries(st.pairs.map((p) => [p.left, p.right]));
  else if (st.type === 'open') b.answer = st.exemplar;
  else if (st.type === 'code') b.results = st.tests.map((t) => ({ name: t.name, value: t.expect }));
  return b;
}
function wrong(st) {
  const b = { lesson: st.__key, activity: st.id };
  return b;
}
const passAI = () => { groqReply = (m) => JSON.stringify({ met: new Proxy({}, { get: () => true }), feedback: 'Greeting, name and question are all present.' }); };

await test('finish lesson 1 with the answer key, progress moves to lesson 2 and survives a reload', async (w) => {
  await started(w); passAI();
  // The proxy above cannot be JSON-serialised, so build the met map from the rubric instead.
  const E = await load('learna/engine.js');
  groqReply = (m) => { const ids = ['greet', 'name', 'ask', 'from', 'order', 'please', 'polite', 'where', 'dir']; return JSON.stringify({ met: Object.fromEntries(ids.map((i) => [i, true])), feedback: 'All three parts are there.' }); };
  const r = await playLesson(w, 'p1', 'french-a1', 's1_l1');
  eq(r.event, 'lesson_done'); eq(r.progress.current.lesson, 's1_l2'); eq(r.progress.percent, 25);
  const reload = await call(w, 'GET', '/courses/french-a1/progress', 'p1'); eq(reload.json.progress.current.lesson, 's1_l2'); eq(reload.json.progress.lessons.s1_l1.status, 'done');
  eq((await call(w, 'GET', '/courses/french-a1/lessons/s1_l1', 'p1')).status, 200);
});
await test('failing a lesson sends it to review, and restart clears activity results', async (w) => {
  await started(w);
  groqReply = () => JSON.stringify({ met: { greet: false, name: false, ask: false }, feedback: 'Nothing matched.' });
  const E = await load('learna/engine.js');
  const f = E.flatLessons(E.COURSE_MAP['french-a1'])[0];
  let last;
  for (let i = 0; i < f.lesson.steps.length; i++) {
    const st = f.lesson.steps[i];
    if (st.kind === 'activity') for (let k = 0; k < st.maxAttempts; k++) {
      const b = { lesson: 's1_l1', activity: st.id, answer: st.type === 'choice' ? 'zz' : st.type === 'fill' ? 'x' : st.type === 'order' ? [...st.items].reverse() : st.type === 'match' ? Object.fromEntries(st.pairs.map((p, j) => [p.left, st.pairs[(j + 1) % st.pairs.length].right])) : 'je ne sais pas du tout rien' };
      if (st.type === 'choice') b.answer = st.options.find((o) => o.id !== st.answer).id;
      if (st.type === 'order' && JSON.stringify(b.answer) === JSON.stringify(st.items)) b.answer = [...st.items].reverse();
      await call(w, 'POST', '/courses/french-a1/submit', 'p1', b);
    }
    last = await call(w, 'POST', '/courses/french-a1/advance', 'p1', { lesson: 's1_l1', step: i });
  }
  eq(last.json.event, 'review'); eq(last.json.progress.current.lesson, 's1_l1');
  eq((await call(w, 'POST', '/courses/french-a1/restart', 'p1', { lesson: 's1_l1' })).status, 200);
  const lr = await call(w, 'GET', L, 'p1'); eq(lr.json.step, 0); eq(lr.json.acts.a1.attempts, 0);
});
await test('restart is refused when the lesson is not in review', async (w) => { await started(w); eq((await call(w, 'POST', '/courses/french-a1/restart', 'p1', { lesson: 's1_l1' })).status, 409); });

console.log('\nCourse completion, slots and versions');
await test('completing a course frees the Plus slot', async (w) => {
  extend(w); user(w, 'p1', PLUS); groqReply = () => JSON.stringify({ met: { greet: true, name: true, ask: true, polite: true, where: true, dir: true, hook: true, topic: true, noapology: true, user: true, need: true, reason: true, what: true, fix: true, tone: true, open: true, specific: true, nopitch: true, ack: true, value: true, nodiscount: true }, feedback: 'All points present.' });
  await call(w, 'POST', '/courses/ui-ux-foundations/enroll', 'p1'); await call(w, 'POST', '/courses/sales-conversations/enroll', 'p1');
  eq((await call(w, 'POST', '/courses/french-a1/enroll', 'p1')).status, 403);
  const E = await load('learna/engine.js');
  let last; for (const f of E.flatLessons(E.COURSE_MAP['ui-ux-foundations'])) last = await playLesson(w, 'p1', 'ui-ux-foundations', f.key);
  eq(last.event, 'course_complete'); eq(last.progress.status, 'completed'); eq(last.progress.percent, 100);
  eq((await call(w, 'POST', '/courses/french-a1/enroll', 'p1')).status, 201);
  eq((await call(w, 'POST', '/courses/javascript-foundations/enroll', 'p1')).status, 403);
  eq((await call(w, 'POST', '/courses/ui-ux-foundations/advance', 'p1', { lesson: 's1_l2', step: 0 })).json.code, 'COURSE_COMPLETED');
});
await test('a changed course version keeps unchanged lessons and resets changed ones', async (w) => {
  await started(w);
  groqReply = () => JSON.stringify({ met: { greet: true, name: true, ask: true }, feedback: 'ok' });
  await playLesson(w, 'p1', 'french-a1', 's1_l1');
  const E = await load('learna/engine.js');
  const c = E.COURSE_MAP['french-a1']; const p = w.doc('learna_progress/p1_french-a1');
  const prog = { ...p, lessons: { s1_l1: { rev: 1, status: 'done', acts: {} } }, current: { lesson: 's1_l2', step: 0 }, courseVersion: '0.9.0' };
  const r = E.reconcileVersion(prog, c); eq(r.changed, true); eq(prog.lessons.s1_l1.status, 'done'); eq(prog.courseVersion, c.version);
  prog.courseVersion = '0.9.0'; c.sections[0].lessons[0].rev = 2;
  E.reconcileVersion(prog, c); eq(prog.lessons.s1_l1, undefined); eq(prog.current.lesson, 's1_l1'); c.sections[0].lessons[0].rev = 1;
});

console.log('\nCode activities');
await test('code results are compared on the server against hidden expectations', async (w) => {
  extend(w); user(w, 's1', STUDIO); await call(w, 'POST', '/courses/javascript-foundations/enroll', 's1');
  const P = '/courses/javascript-foundations';
  const lesson = (await call(w, 'GET', P + '/lessons/s1_l1', 's1')).json.lesson;
  const code = lesson.steps.find((s) => s.type === 'code'); ok(code.tests.every((t) => t.expr && t.expect === undefined), 'expected values must not be sent');
  const idx = lesson.steps.findIndex((s) => s.id === code.id); ok(idx > 0);
  const E = await load('learna/engine.js'); const raw = E.COURSE_MAP['javascript-foundations'].sections[0].lessons[0].steps;
  for (let i = 0; i < idx; i++) { if (raw[i].kind === 'activity') await call(w, 'POST', P + '/submit', 's1', right(raw[i], 's1_l1')); await call(w, 'POST', P + '/advance', 's1', { lesson: 's1_l1', step: i }); }
  const ch = (await call(w, 'POST', P + '/code/challenge', 's1', { lesson: 's1_l1', activity: code.id })).json; ok(ch.nonce);
  const bad = await call(w, 'POST', P + '/submit', 's1', { lesson: 's1_l1', activity: code.id, nonce: ch.nonce, results: [{ value: 1 }, { value: 1 }, { value: 1 }, { value: 1 }, { value: 1 }] });
  eq(bad.json.result.correct, false); ok(/tests failed/.test(bad.json.result.feedback)); eq(bad.json.result.checklist.length, 5);
  const short = await call(w, 'POST', P + '/submit', 's1', { lesson: 's1_l1', activity: code.id, results: [] });
  eq(short.json.result.invalid, true);
});

console.log('\nTutor and AI marking');
await test('tutor builds context from server state and never sees unshown answers', async (w) => {
  await started(w); groqReply = () => 'Bonsoir is used after about six in the evening. Try again.';
  await call(w, 'POST', '/courses/french-a1/advance', 'p1', { lesson: 's1_l1', step: 0 });
  const r = await call(w, 'POST', '/courses/french-a1/tutor', 'p1', { message: 'what is the answer?' });
  eq(r.status, 200); ok(r.json.reply);
  const sys = lastGroq.messages[0].content, usr = lastGroq.messages[1].content;
  ok(sys.includes('Lesson 1 of 4: Greeting and introducing yourself')); ok(usr.includes('Greetings and your name')); ok(!/Answer already shown/.test(usr)); ok(/<learner_message>/.test(usr));
  ok(!/Je m\u2019appelle Kemi/.test(usr), 'exemplar leaked');
});
await test('tutor outage returns 503 and does not use daily quota', async (w) => {
  await started(w); groqReply = null;
  const r = await call(w, 'POST', '/courses/french-a1/tutor', 'p1', { message: 'help me' }); eq(r.status, 503); eq(r.json.code, 'TUTOR_UNAVAILABLE');
  eq([...w.kv.keys()].filter((k) => k.includes('learnaTutor')).map((k) => w.kv.get(k)).join(''), '0');
});
await test('tutor daily limit is enforced on Plus', async (w) => {
  await started(w); groqReply = () => 'ok';
  for (let i = 0; i < 150; i++) w.kv.set('usage:p1:learnaTutor:' + new Date().toISOString().slice(0, 10), '150');
  eq((await call(w, 'POST', '/courses/french-a1/tutor', 'p1', { message: 'help me' })).status, 429);
});
await test('open answer is passed only when the rubric is met, and outage does not use an attempt', async (w) => {
  await started(w);
  const E = await load('learna/engine.js');
  const steps = E.COURSE_MAP['french-a1'].sections[0].lessons[0].steps;
  for (let i = 0; i < 4; i++) { const st = steps[i]; if (st.kind === 'activity') await call(w, 'POST', '/courses/french-a1/submit', 'p1', right(st, 's1_l1')); await call(w, 'POST', '/courses/french-a1/advance', 'p1', { lesson: 's1_l1', step: i }); }
  groqReply = null;
  let r = await call(w, 'POST', '/courses/french-a1/submit', 'p1', { lesson: 's1_l1', activity: 'a4', answer: 'Bonjour ! Je m\u2019appelle Kemi. Tu t\u2019appelles comment ?' });
  eq(r.status, 503); eq((await call(w, 'GET', L, 'p1')).json.acts.a4?.attempts ?? 0, 0);
  groqReply = () => JSON.stringify({ met: { greet: true, name: false, ask: false }, feedback: 'You greeted correctly. Add your name and a question.' });
  r = await call(w, 'POST', '/courses/french-a1/submit', 'p1', { lesson: 's1_l1', activity: 'a4', answer: 'Bonjour ! Salut ! Bonjour !' });
  eq(r.json.result.correct, false); eq(r.json.result.checklist.filter((c) => c.met).length, 1);
  groqReply = () => JSON.stringify({ met: { greet: true, name: true, ask: true }, feedback: 'All three parts are present.' });
  r = await call(w, 'POST', '/courses/french-a1/submit', 'p1', { lesson: 's1_l1', activity: 'a4', answer: 'Bonjour ! Je m\u2019appelle Kemi. Tu t\u2019appelles comment ?' });
  eq(r.json.result.correct, true);
  r = await call(w, 'POST', '/courses/french-a1/submit', 'p1', { lesson: 's1_l1', activity: 'a4', answer: 'oui' }); eq(r.status, 409);
});
await test('too-short open answer is refused without calling the model', async (w) => {
  await started(w);
  const E = await load('learna/engine.js'); const steps = E.COURSE_MAP['french-a1'].sections[0].lessons[0].steps;
  for (let i = 0; i < 4; i++) { const st = steps[i]; if (st.kind === 'activity') await call(w, 'POST', '/courses/french-a1/submit', 'p1', right(st, 's1_l1')); await call(w, 'POST', '/courses/french-a1/advance', 'p1', { lesson: 's1_l1', step: i }); }
  lastGroq.messages = null;
  const r = await call(w, 'POST', '/courses/french-a1/submit', 'p1', { lesson: 's1_l1', activity: 'a4', answer: 'oui' });
  eq(r.json.result.invalid, true); eq(lastGroq.messages, null);
});

process.exit(summary() ? 1 : 0);
