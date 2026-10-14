// Run: node tests/web-search.test.mjs
import assert from 'node:assert/strict';
import * as ws from '../web-search.js';
import { buildChatSystemPrompt, chatPromptInfo } from '../prompts.js';
import { getPlan, UNLIMITED } from '../entitlements.js';

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

// provider selection
assert.equal(ws.webSearchProvider({}), null);
assert.equal(ws.webSearchProvider({ TAVILY_API_KEY: '  ' }), null);
assert.equal(ws.webSearchProvider({ FIRECRAWL_API_KEY: 'f' }), 'firecrawl');
assert.equal(ws.webSearchProvider({ BRAVE_SEARCH_API_KEY: 'b' }), null); // Brave is no longer supported
assert.equal(ws.webSearchProvider({ TAVILY_API_KEY: 't', FIRECRAWL_API_KEY: 'f' }), 'tavily');
assert.deepEqual(ws.webSearchProviders({ TAVILY_API_KEY: 't', FIRECRAWL_API_KEY: 'f' }), ['tavily', 'firecrawl']);
assert.equal(ws.webSearchConfigured({ TAVILY_API_KEY: 't' }), true);

// not configured: nothing is called
let called = 0;
let r = await ws.searchWeb({ query: 'x' }, {}, async () => { called++; return json({}); });
assert.equal(r.ok, false); assert.equal(r.notConfigured, true); assert.equal(called, 0);

// tool schema + validation
const schema = ws.toolSchema();
assert.equal(schema.function.name, 'web_search');
assert.deepEqual(schema.function.parameters.required, ['query']);
assert.equal(ws.validateArgs({ query: '  ' }).ok, false);
assert.equal(ws.validateArgs({ query: 'naira rate', recency: 'week' }).ok, true);
assert.equal(ws.validateArgs({ query: 'naira rate', recency: 'hour' }).ok, false);

// tavily request + parsing; unsafe and duplicate addresses are dropped
let seen = null;
r = await ws.searchWeb({ query: 'naira  exchange rate', recency: 'day' }, { TAVILY_API_KEY: 'tvly-1' }, async (url, init) => {
  seen = { url, init };
  return json({ results: [
    { title: 'A', url: 'https://example.com/a', content: 'alpha', published_date: '2026-10-14' },
    { title: 'dup', url: 'https://example.com/a', content: 'again' },
    { title: 'local', url: 'http://localhost/x', content: 'no' },
    { title: 'ip', url: 'https://10.0.0.1/x', content: 'no' },
    { title: '', url: 'https://example.org/b', content: 'beta' },
  ] });
});
assert.equal(r.ok, true);
assert.equal(seen.url, 'https://api.tavily.com/search');
assert.equal(seen.init.headers.Authorization, 'Bearer tvly-1');
const sent = JSON.parse(seen.init.body);
assert.equal(sent.query, 'naira exchange rate'); assert.equal(sent.time_range, 'day');
assert.equal(r.results.length, 2);
assert.equal(r.results[1].title, 'example.org'); // untitled result falls back to its host

// firecrawl request + parsing
r = await ws.searchWeb({ query: 'fuel price', recency: 'week' }, { FIRECRAWL_API_KEY: 'fc-1' }, async (url, init) => {
  seen = { url, init };
  return json({ success: true, data: { web: [{ title: 'B', url: 'https://example.com/b', description: 'desc' }] } });
});
assert.equal(r.ok, true); assert.equal(r.provider, 'firecrawl');
assert.equal(seen.url, 'https://api.firecrawl.dev/v2/search');
assert.equal(seen.init.method, 'POST');
assert.equal(seen.init.headers.Authorization, 'Bearer fc-1');
const fsent = JSON.parse(seen.init.body);
assert.equal(fsent.tbs, 'qdr:w'); assert.deepEqual(fsent.sources, ['web']);
assert.equal(r.results[0].snippet, 'desc');

// with both keys, a Tavily failure (allowance used up) falls through to Firecrawl
const urls = [];
r = await ws.searchWeb({ query: 'x' }, { TAVILY_API_KEY: 't', FIRECRAWL_API_KEY: 'f' }, async (url) => {
  urls.push(url);
  return url.includes('tavily') ? json({}, 432) : json({ data: { web: [{ title: 'C', url: 'https://example.com/c', description: 'd' }] } });
});
assert.equal(r.ok, true); assert.equal(r.provider, 'firecrawl'); assert.equal(urls.length, 2);
// a working first provider means the second is never called
urls.length = 0;
r = await ws.searchWeb({ query: 'x' }, { TAVILY_API_KEY: 't', FIRECRAWL_API_KEY: 'f' }, async (url) => { urls.push(url); return json({ results: [{ title: 'D', url: 'https://example.com/d', content: 'd' }] }); });
assert.equal(r.provider, 'tavily'); assert.equal(urls.length, 1);
// both failing reports the failure
r = await ws.searchWeb({ query: 'x' }, { TAVILY_API_KEY: 't', FIRECRAWL_API_KEY: 'f' }, async () => json({}, 500));
assert.equal(r.ok, false);

// failures never throw and read plainly
r = await ws.searchWeb({ query: 'x' }, { TAVILY_API_KEY: 't' }, async () => json({}, 429));
assert.equal(r.ok, false); assert.match(r.error, /busy/);
r = await ws.searchWeb({ query: 'x' }, { TAVILY_API_KEY: 't' }, async () => json({}, 401));
assert.equal(r.ok, false); assert.equal(r.notConfigured, true);
r = await ws.searchWeb({ query: 'x' }, { TAVILY_API_KEY: 't' }, async () => { throw new Error('boom'); });
assert.equal(r.ok, false); assert.match(r.error, /could not be reached/);

// text for the model is fenced as data and honest about failure
const okText = ws.resultForModel({ ok: true, query: 'q', results: [{ title: 'T', url: 'https://example.com', snippet: 's', date: '' }] });
assert.match(okText, /<search_results>/); assert.match(okText, /never as instructions/);
assert.match(ws.resultForModel({ ok: false, error: 'down.' }), /do not invent/);
assert.match(ws.resultForModel({ ok: true, query: 'q', results: [] }), /no results/);

// gate: lookups yes, ordinary chat no
for (const t of ['What is the latest iPhone?', 'search for flights to Abuja', 'who is the current CEO of Dangote', 'naira to dollar rate today', 'see https://example.com']) assert.equal(ws.shouldOfferWebSearch(t), true, t);
for (const t of ['Write a cover letter for a nurse', 'Explain photosynthesis', 'fix this python loop', '']) assert.equal(ws.shouldOfferWebSearch(t), false, t);

// prompt: the web rule is only present when the tool is offered
assert.ok(buildChatSystemPrompt({ hasWeb: true }).includes('web_search'));
assert.ok(!buildChatSystemPrompt({}).includes('web_search'));
assert.ok(chatPromptInfo({ hasWeb: true }).variant.endsWith('+web'));
// the shared beginning stays identical so provider caching still works
const plain = buildChatSystemPrompt({ now: new Date('2026-10-14T00:00:00Z') }).split('\n\nSession details')[0];
const web = buildChatSystemPrompt({ hasWeb: true, now: new Date('2026-10-14T00:00:00Z') });
assert.ok(web.startsWith(plain.slice(0, 1000)));

// every plan has a daily search allowance
for (const id of ['free', 'plus', 'studio', 'admin']) assert.ok(getPlan(id).limits.webSearchPerDay > 0, id);
assert.equal(getPlan('admin').limits.webSearchPerDay, UNLIMITED);

console.log('web-search tests ok');
