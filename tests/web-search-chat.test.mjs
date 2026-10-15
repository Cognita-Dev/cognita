// Runs the REAL /api/chat handler with a fake model and a fake search service, and checks that a web search
// reaches the browser with its sources: on the step (so the row can open into a list of sites), numbered
// across the whole turn, and on the final answer (for the "Sources" list). No real network calls.
// Needs tests/key.pem, cert.pem, sa.pem (see tests/harness.mjs; they are git-ignored).
import { makeWorld, idToken, eq, ok, summary } from './harness.mjs';

const UID = 'uid_ws_1', EMAIL = 'ws@example.com';
const results = [];
async function run(name, fn) {
  const w = makeWorld({ GROQ_API_KEY: 'g_test', TAVILY_API_KEY: 't_test' });
  try { await fn(w); console.log('  PASS  ' + name); results.push(true); }
  catch (e) { console.log('  FAIL  ' + name + '\n        -> ' + e.message.split('\n')[0]); results.push(false); }
  finally { w.restore(); }
}

const sse = (events) => new Response(events.map((e) => 'data: ' + (typeof e === 'string' ? e : JSON.stringify(e)) + '\n\n').join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const toolCall = (id, query) => sse([
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query }) } }] }, finish_reason: null }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]',
]);
const answer = (text) => sse([{ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, '[DONE]']);

// Tavily answers by query. Both searches return the CBN page, to check that a repeated address keeps its first number.
const TAVILY = {
  'naira rate': [{ title: 'Naira hits new low', url: 'https://www.reuters.com/markets/naira', content: 'a' }, { title: 'CBN rates', url: 'https://cbn.gov.ng/rates', content: 'b' }],
  'bitcoin price': [{ title: 'Bitcoin price', url: 'https://www.coindesk.com/price/bitcoin', content: 'c' }, { title: 'CBN rates', url: 'https://cbn.gov.ng/rates', content: 'b' }],
};

function install(w, plan, seen) {
  const prev = globalThis.fetch;
  let modelCalls = 0;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    if (url.startsWith('https://api.groq.com/')) {
      const body = JSON.parse(init.body);
      seen.toolsOffered = (body.tools || []).map((t) => t.function.name);
      seen.lastMessages = body.messages;
      return plan[Math.min(modelCalls++, plan.length - 1)]();
    }
    if (url === 'https://api.tavily.com/search') {
      const b = JSON.parse(init.body);
      seen.searches.push(b.query);
      if (seen.tavilyFails) return new Response('busy', { status: 429 });
      return new Response(JSON.stringify({ results: TAVILY[b.query] || [] }), { status: 200, headers: { 'content-type': 'application/json' } });
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

console.log('\nweb search through the real chat handler');

await run('two searches: steps carry query + sources, numbering runs across the turn, answer carries sources', async (w) => {
  setupAdmin(w);
  const seen = { searches: [] };
  install(w, [() => toolCall('c1', 'naira rate'), () => toolCall('c2', 'bitcoin price'), () => answer('The naira is weak [1] and bitcoin is up [3].')], seen);
  const r = await chat(w, 'what is the latest naira rate and bitcoin price today');
  eq(r.status, 200, 'status ' + r.raw.slice(0, 200));
  ok(seen.toolsOffered && seen.toolsOffered.includes('web_search'), 'web_search was not offered: ' + JSON.stringify(seen.toolsOffered));
  eq(seen.searches, ['naira rate', 'bitcoin price']);
  const done = r.events.find((e) => e.event === 'done');
  ok(done, 'no done event: ' + r.raw.slice(-300));
  const steps = done.data.steps.filter((s) => s.name === 'web_search');
  eq(steps.length, 2, 'steps');
  eq(steps[0].query, 'naira rate');
  eq(steps[0].providerLabel, 'Web');
  eq(steps[0].sources, [{ title: 'Naira hits new low', url: 'https://www.reuters.com/markets/naira' }, { title: 'CBN rates', url: 'https://cbn.gov.ng/rates' }]);
  eq(steps[1].sources.map((s) => s.url), ['https://www.coindesk.com/price/bitcoin', 'https://cbn.gov.ng/rates']);
  ok(!JSON.stringify(steps).includes('"snippet"') && !JSON.stringify(steps).includes('content'), 'excerpts must not be sent to the browser');
  // the same step objects were also streamed live
  const live = r.events.filter((e) => e.event === 'step' && e.data.name === 'web_search');
  eq(live.length, 2); eq(live[0].data.sources.length, 2);
  // one list for the whole answer, no repeats, in the order the model was told
  eq(done.data.sources.map((s) => s.url), ['https://www.reuters.com/markets/naira', 'https://cbn.gov.ng/rates', 'https://www.coindesk.com/price/bitcoin']);
  // the model was told the same numbers: second search = [3] Bitcoin, and the repeated CBN page keeps its number 2
  const toolText = JSON.stringify(seen.lastMessages);
  ok(/3\. Bitcoin price/.test(toolText.replace(/\\n/g, '\n')), 'second search should start at 3 for a new address');
  ok(/2\. CBN rates/.test(toolText.replace(/\\n/g, '\n')), 'repeated address should keep number 2');
});

await run('a failed search: no sources, a failed step, no sources on the answer', async (w) => {
  setupAdmin(w);
  const seen = { searches: [], tavilyFails: true };
  install(w, [() => toolCall('c1', 'naira rate'), () => answer('I could not search just now.')], seen);
  const r = await chat(w, 'what is the latest naira rate today');
  const done = r.events.find((e) => e.event === 'done');
  ok(done, 'no done event: ' + r.raw.slice(-300));
  const st = done.data.steps.find((s) => s.name === 'web_search');
  eq(st.ok, false); ok(!('sources' in st), 'a failed search must not carry sources'); eq(st.query, 'naira rate');
  ok(done.data.sources === undefined || done.data.sources === null, 'no sources expected on the answer');
});

await run('a chat with no search sends no sources', async (w) => {
  setupAdmin(w);
  const seen = { searches: [] };
  install(w, [() => answer('Hello there.')], seen);
  const r = await chat(w, 'hi, how are you');
  const done = r.events.find((e) => e.event === 'done');
  ok(done, 'no done event: ' + r.raw.slice(-300));
  ok(!done.data.sources, 'unexpected sources');
});

process.exit(results.every(Boolean) ? 0 : 1);
