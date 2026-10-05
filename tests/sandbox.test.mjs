import { test, eq, ok, summary, load } from './harness.mjs';
const intent = await load('sandbox-intent.js');
const conf = await load('confirmation.js');
const files = await load('files-endpoint.js');
const ent = await load('entitlements.js');

console.log('\nGate: should the code tools be offered?');
const OFFER = [
  "what's the average of 4, 8, 15, 16", 'calculate 18% of 2450', 'sum these numbers: 3 5 7 9',
  'analyze this csv for me', 'make a chart of monthly sales: 10 20 30', 'plot a bar graph of these values',
  'write a python script to rename files', 'run this code: print(1+1)', 'what is the median of 3, 9, 12, 20',
  'convert this json to csv', 'give me the result as an excel file', 'create a csv file of 10 names',
  'test this regex ^a+$ on aaab', 'compute the standard deviation of 2 4 4 4 5 5 7 9', 'use code to sort these numbers 5 3 9 1',
  'I attached data.csv, summarize it', 'transform this table into json', 'what percentage is 45 of 180',
  '```python\nprint(2)\n```', 'make me a spreadsheet of my budget',
];
const SKIP = [
  'write me a poem about rain', 'hello', 'who won the 2014 world cup', 'explain how vaccines work',
  'give me tips for a job interview', 'translate good morning to french', 'what is the capital of Kenya',
  'summarize the plot of Hamlet', 'draft an email to my landlord', 'how do I stay motivated',
  'tell me a joke', 'what does photosynthesis do', 'suggest a name for my bakery', 'recommend a good book',
  'why is the sky blue', 'help me write a cover letter', 'what should I cook tonight', 'describe the Roman empire',
  'how are you today', 'list the planets',
];
for (const t of OFFER) await test('offers: ' + t.slice(0, 40).replace(/\n/g, ' '), async () => ok(intent.shouldOfferSandbox({ text: t }).offer, 'not offered'));
for (const t of SKIP) await test('skips: ' + t.slice(0, 40), async () => ok(!intent.shouldOfferSandbox({ text: t }).offer, 'offered by ' + intent.shouldOfferSandbox({ text: t }).reason));
await test('resume always offers', async () => eq(intent.shouldOfferSandbox({ text: 'hello', resuming: true }).reason, 'resume'));
await test('hint from client offers', async () => ok(intent.shouldOfferSandbox({ text: 'ok thanks', hint: true }).offer));

console.log('\nApproval card text');
await test('GitHub issue card', async () => {
  const d = conf.describeConfirmation('github_create_issue', { owner: 'a', repo: 'b', title: 'Bug', body: 'x'.repeat(900), token: 'ghp_SECRET123' });
  eq(d.providerKey, 'github'); ok(d.title && d.consequence);
  const flat = JSON.stringify(d);
  ok(!flat.includes('ghp_SECRET123'), 'token leaked');
  ok(d.details.length <= 6, 'too many rows');
  ok(d.details.every((r) => r.value.length <= 601), 'value not capped');
});
await test('unknown tool falls back safely', async () => {
  const d = conf.describeConfirmation('weird_delete_thing', { api_key: 'sk-1', name: 'n' });
  eq(d.verb, 'delete'); ok(!JSON.stringify(d).includes('sk-1'));
});
await test('gmail send shows recipient', async () => {
  const d = conf.describeConfirmation('google_send_gmail_message', { to: 'a@b.com', subject: 'Hi', body: 'yo' });
  eq(d.providerKey, 'gmail'); ok(d.details.some((r) => r.value === 'a@b.com'));
});

console.log('\nSaved file names and plans');
await test('filename sanitizer', async () => {
  eq(files.cleanArtifactFilename('../../etc/passwd'), null);
  eq(files.cleanArtifactFilename('run.exe'), null);
  eq(files.cleanArtifactFilename('a/b/c.PNG'), 'c.png');
  ok(files.cleanArtifactFilename('my report (1).csv').endsWith('.csv'));
});
await test('every plan has artifact limits', async () => {
  for (const id of ['free', 'plus', 'studio', 'admin']) {
    const l = ent.getPlan(id).limits;
    ok(l.sandboxArtifactMaxMB > 0 && l.sandboxArtifactsPerDay > 0, id);
  }
});
process.exit(summary() ? 1 : 0);
