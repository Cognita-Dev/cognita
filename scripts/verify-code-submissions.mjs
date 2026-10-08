#!/usr/bin/env node
// scripts/verify-code-submissions.mjs
// Independent re-run of learners' passing code, on a machine YOU control.
//
// Why this exists: Learna runs learner code in the browser sandbox, and a Cloudflare Worker cannot run learner JavaScript, so the
// server cannot prove the browser really ran the code. This script closes that gap after the fact. It downloads every passing
// code submission (source plus ALL tests with their expected values), runs the source itself, and reports a verdict:
//   verified  every test gives the expected value        mismatch  at least one does not (the learner must run the task again)
// A mismatch sends the task back to the learner and blocks their certificate until they pass it again.
//
// Run it on your own computer, or on a free scheduled GitHub Actions job (see learna/README.md). It needs no paid service.
//
//   ADMIN_TOKEN=<a Firebase ID token of an admin account> node scripts/verify-code-submissions.mjs
//   Optional: API_BASE (default https://api.cognita.com.ng), DRY_RUN=1 to print verdicts without sending them.
//
// Safety: each submission runs in its own worker thread with no environment variables, a time limit and a memory limit. Node's vm
// module is NOT a hardened sandbox, so run this in a disposable environment such as a CI runner, not on a machine with secrets.
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import vm from 'node:vm';

if (!isMainThread) {
  const { source, tests } = workerData; const out = [];
  for (const t of tests) {
    try { const v = vm.runInNewContext(source + '\n;(' + t.expr + ')', Object.create(null), { timeout: 1500 }); out.push({ value: JSON.stringify(v === undefined ? null : v) }); }
    catch (e) { out.push({ error: String(e && e.message || e).slice(0, 120) }); }
  }
  parentPort.postMessage(out);
} else {
  const API = process.env.API_BASE || 'https://api.cognita.com.ng';
  const TOKEN = process.env.ADMIN_TOKEN;
  if (!TOKEN) { console.error('Set ADMIN_TOKEN to an admin Firebase ID token.'); process.exit(2); }
  const call = async (path, opts = {}) => {
    const r = await fetch(API + '/api/admin/learna' + path, { ...opts, headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' } });
    const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(path + ': ' + (j.error || r.status)); return j;
  };
  const runOne = (source, tests) => new Promise((resolve) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { source, tests }, env: {}, resourceLimits: { maxOldGenerationSizeMb: 64 } });
    const timer = setTimeout(() => { w.terminate(); resolve({ timeout: true }); }, 15000);
    w.on('message', (m) => { clearTimeout(timer); resolve({ results: m }); });
    w.on('error', (e) => { clearTimeout(timer); resolve({ error: String(e.message || e) }); });
  });
  const { items } = await call('/code-audit');
  console.log(items.length + ' submission(s) to check');
  let bad = 0;
  for (const it of items) {
    const r = await runOne(it.source, it.tests);
    let verdict = 'verified', detail = '';
    if (!r.results) { verdict = 'mismatch'; detail = r.timeout ? 'ran too long' : 'could not run: ' + r.error; }
    else for (let i = 0; i < it.tests.length; i++) {
      const got = r.results[i]; const want = JSON.stringify(it.tests[i].expect === undefined ? null : it.tests[i].expect);
      if (got.error || got.value !== want) { verdict = 'mismatch'; detail = it.tests[i].expr.slice(0, 80) + ' gave ' + (got.error ? 'an error' : got.value) + ', expected ' + want; break; }
    }
    if (verdict === 'mismatch') bad++;
    console.log((verdict === 'verified' ? 'OK       ' : 'MISMATCH ') + it.courseId + ' ' + it.lesson + ' ' + it.activity + ' learner ' + String(it.uid).slice(0, 8) + (detail ? ' (' + detail + ')' : ''));
    if (!process.env.DRY_RUN) await call('/code-audit/result', { method: 'POST', body: JSON.stringify({ id: it.id, verdict, detail }) });
  }
  console.log(bad ? bad + ' mismatch(es) sent back to learners.' : 'All verified.');
}
