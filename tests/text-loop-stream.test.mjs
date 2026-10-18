// A model that streams the same sentence forever is cut off by the real stream reader (providers.js), and what
// reached the browser is only a few copies at most, not a wall of text.
import { callWithTools } from '../providers.js';

let bad = 0;
const t = (name, ok) => { console.log(name, ok ? 'OK' : 'FAIL'); if (!ok) bad++; };

const line = 'The subtitle is still too long. Let me make it even shorter and rebuild.';
const enc = new TextEncoder();
let chunksSent = 0;
let cancelled = false;

// A fake provider that never stops talking: 'Done. ' once, then the same sentence for ever.
globalThis.fetch = async () => {
  const body = new ReadableStream({
    async pull(controller) {
      chunksSent++;
      const piece = chunksSent === 1 ? 'Working on it. ' : line;
      controller.enqueue(enc.encode('data: ' + JSON.stringify({ choices: [{ delta: { content: piece } }] }) + '\n\n'));
      if (chunksSent > 5000) controller.close(); // safety net so a broken guard fails the test instead of hanging
    },
    cancel() { cancelled = true; },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};

const shown = [];
const tierConfig = { provider: 'groq', model: 'test-model' };
const result = await callWithTools(tierConfig, [{ role: 'user', content: 'hi' }], [{ type: 'function', function: { name: 'x', parameters: { type: 'object', properties: {} } } }],
  { GROQ_API_KEY: 'test' }, { onText: (d) => shown.push(d) });

const shownText = shown.join('');
t('stream reports a repetition stop', result.finishReason === 'repetition');
t('no tool call comes out of a looped turn', !result.toolCalls);
t('the kept text has one copy of the sentence', result.text === 'Working on it. ' + line);
t('the provider stream was stopped (cancelled)', cancelled);
t('reading stopped right away', chunksSent <= 6);
t('the browser saw at most 2 copies', shownText.split(line).length - 1 <= 2);

process.exit(bad ? 1 : 0);
