// Tests for js/learna-speech.js (the browser side of Learna's voice), run in Node with fake browser globals.
// Covers the Vertex order: built-in neural voice, then the Worker voice, then any device voice.
// Run:  node tests/learna-speech-client.test.mjs
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODULE = pathToFileURL(path.join(HERE, '..', 'js', 'learna-speech.js')).href;

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); } catch (e) { failed++; console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
}

// A fresh fake browser and a fresh copy of the module for every test, so module state never leaks between tests.
let n = 0;
async function browser({ voices = [], tts = 'ok' } = {}) {
  const spoken = [], audio = { created: 0, plays: [] }, apiCalls = [];
  class FakeUtterance { constructor(text) { this.text = text; } }
  class FakeAudio {
    constructor() { audio.created++; this.dataset = {}; }
    play() { audio.plays.push({ src: this.src, primer: !!this.dataset.primer }); if (!this.dataset.primer) setTimeout(() => this.onended && this.onended(), 3); return Promise.resolve(); }
    pause() {}
  }
  const synth = {
    speaking: false, paused: false,
    getVoices: () => voices, addEventListener() {}, cancel() {}, pause() {}, resume() {},
    speak(u) { spoken.push({ text: u.text, lang: u.lang, voice: u.voice && u.voice.name, rate: u.rate }); setTimeout(() => u.onstart && u.onstart(), 1); setTimeout(() => u.onend && u.onend(), 3); },
  };
  Object.assign(globalThis, { window: globalThis, speechSynthesis: synth, SpeechSynthesisUtterance: FakeUtterance, Audio: FakeAudio });
  const api = { async blob(p, body) {
    apiCalls.push({ p, body });
    if (tts === 'ok') return { ok: true, blob: new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/mpeg' }) };
    if (tts === 'never') return new Promise(() => {});
    return { ok: false, code: tts };
  } };
  const S = await import(MODULE + '?t=' + (++n));
  return { S, api, spoken, audio, apiCalls };
}
const V = (name, lang) => ({ name, lang, localService: false });
const ref = (extra = {}) => ({ course: 'french-a1', lesson: 's1_l1', step: 't1', part: 'word', word: 'Bonjour', lang: 'fr-FR', ...extra });

await test('a browser with the built-in French neural voice uses it and never calls the Worker', async () => {
  const b = await browser({ voices: [V('Microsoft Denise Online (Natural) - French (France)', 'fr-FR'), V('Microsoft Henri Online (Natural) - French (France)', 'fr-FR'), V('Test French', 'fr-FR')] });
  const r = await b.S.speak(ref(), 'Bonjour', b.api);
  assert.equal(r.ok, true); assert.equal(r.source, 'browser'); assert.equal(b.apiCalls.length, 0);
  assert.match(b.spoken[0].voice, /Denise/); assert.equal(b.spoken[0].lang, 'fr-FR');
  const r2 = await b.S.speak(ref({ voice: 'alt' }), 'Bonjour', b.api);
  assert.match(b.spoken[1].voice, /Henri/); assert.equal(r2.ok, true);
});

await test('English uses Ezinne and Abeo from the browser when they exist', async () => {
  const b = await browser({ voices: [V('Microsoft Abeo Online (Natural) - English (Nigeria)', 'en-NG'), V('Microsoft Ezinne Online (Natural) - English (Nigeria)', 'en_NG'), V('Google UK English', 'en-GB')] });
  await b.S.speak(ref({ lang: 'en-NG' }), 'Hello', b.api); assert.match(b.spoken[0].voice, /Ezinne/, 'default voice is Ezinne, and en_NG (Android spelling) still matches');
  await b.S.speak(ref({ lang: 'en-NG', voice: 'alt' }), 'Hello', b.api); assert.match(b.spoken[1].voice, /Abeo/);
  assert.equal(b.apiCalls.length, 0);
});

await test('without a built-in neural voice the Worker voice plays, through one shared audio element that was unlocked first', async () => {
  const b = await browser({ voices: [V('Test French', 'fr-FR')] }); const started = [];
  const r = await b.S.speak(ref(), 'Bonjour', b.api, { onStart: (x) => started.push(x.source) });
  assert.equal(r.ok, true); assert.equal(r.source, 'premium'); assert.deepEqual(started, ['premium']); assert.equal(b.apiCalls.length, 1);
  assert.equal(b.apiCalls[0].p, '/speech/tts'); assert.equal(b.apiCalls[0].body.lang, 'fr-FR'); assert.equal(b.apiCalls[0].body.word, 'Bonjour');
  assert.equal(b.audio.created, 1, 'one audio element for the whole page');
  assert.equal(b.audio.plays[0].primer, true, 'the silent unlock clip plays first, inside the tap'); assert.equal(b.audio.plays[1].primer, false);
  assert.equal(b.spoken.length, 0);
});

await test('a repeat press plays from the cached clip without asking the Worker again', async () => {
  const b = await browser({ voices: [] });
  await b.S.speak(ref(), 'Bonjour', b.api); await b.S.speak(ref(), 'Bonjour', b.api);
  assert.equal(b.apiCalls.length, 1); assert.equal(b.audio.plays.filter((p) => !p.primer).length, 2);
});

await test('when the Worker voice fails the device voice speaks, and the Worker is rested for a while', async () => {
  const b = await browser({ voices: [V('Test French', 'fr-FR')], tts: 'TTS_FAILED' });
  const r = await b.S.speak(ref(), 'Bonjour', b.api); assert.equal(r.ok, true); assert.equal(r.source, 'browser'); assert.equal(b.apiCalls.length, 1);
  assert.equal(b.spoken[0].voice, 'Test French');
  await b.S.speak(ref({ word: 'Bonsoir' }), 'Bonsoir', b.api); assert.equal(b.apiCalls.length, 1, 'no second request during the rest period');
  assert.equal(b.spoken.length, 2);
});

await test('a plan or switch-off answer stops further requests for the page session', async () => {
  for (const code of ['PLAN_REQUIRED', 'TTS_NOT_CONFIGURED']) {
    const b = await browser({ voices: [V('Test French', 'fr-FR')], tts: code });
    await b.S.speak(ref(), 'Bonjour', b.api); await b.S.speak(ref({ word: 'Bonsoir' }), 'Bonsoir', b.api);
    assert.equal(b.apiCalls.length, 1, code); assert.equal(b.spoken.length, 2, code);
  }
});

await test('a daily-limit answer falls back to the device voice for that press only', async () => {
  const b = await browser({ voices: [V('Test French', 'fr-FR')], tts: 'DAILY_LIMIT' });
  await b.S.speak(ref(), 'Bonjour', b.api); await b.S.speak(ref({ word: 'Bonsoir' }), 'Bonsoir', b.api);
  assert.equal(b.apiCalls.length, 2, 'it asks again, because the limit can be lifted by an upgrade'); assert.equal(b.spoken.length, 2);
});

await test('device voices read long text in sentence sized pieces, in order', async () => {
  const b = await browser({ voices: [V('Test French', 'fr-FR')], tts: 'TTS_FAILED' });
  const sentence = 'Ceci est une phrase assez longue pour le test de lecture. ';
  const text = sentence.repeat(12).trim();
  const r = await b.S.speak(ref({ part: 'text:0', word: undefined }), text, b.api); assert.equal(r.ok, true);
  assert.ok(b.spoken.length >= 4, 'split into several pieces: ' + b.spoken.length); assert.ok(b.spoken.every((s) => s.text.length <= 180));
  assert.equal(b.spoken.map((s) => s.text).join(' '), text, 'nothing lost, nothing reordered');
});

await test('stopping while the Worker voice is playing ends the call as cancelled instead of hanging', async () => {
  const b = await browser({ voices: [] });
  const p = b.S.speak(ref(), 'Bonjour', b.api);
  await new Promise((r) => setTimeout(r, 1)); b.S.stopSpeaking();
  const r = await Promise.race([p, new Promise((res) => setTimeout(() => res('HUNG'), 500))]);
  assert.notEqual(r, 'HUNG'); assert.equal(r.ok, false); assert.equal(r.cancelled, true);
});

await test('a device with no voice for the language says so plainly', async () => {
  const b = await browser({ voices: [], tts: 'TTS_FAILED' });
  const r = await b.S.speak(ref(), 'Bonjour', b.api); assert.equal(r.ok, true); assert.match(r.note, /no fr-FR voice installed/);
});

console.log('\n' + passed + '/' + (passed + failed) + ' passed');
process.exit(failed ? 1 : 0);
