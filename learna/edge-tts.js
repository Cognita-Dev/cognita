// learna/edge-tts.js
// Free neural text to speech for Learna. No account, no API key, no billing.
//
// This is the same design Vertex uses. The Worker opens a WebSocket to the Microsoft Edge "Read Aloud" voice service and gets
// MP3 audio back. It is the protocol the open source `edge-tts` package speaks, and it serves the same neural voices
// (Ezinne and Abeo for Nigerian English, Denise and Henri for French).
//
// The endpoint is unofficial. Microsoft can change or block it at any time. When that happens `edgeTtsSynthesize` throws,
// `synthesize` in learna/speech.js answers TTS_FAILED, and the browser speaks with its own voice instead. Nothing else breaks.
//
// If the service ever starts refusing connections, the constants below are the first place to look. They are the same values
// as the current `edge-tts` release (CHROMIUM_FULL_VERSION and TRUSTED_CLIENT_TOKEN).

const EDGE_TTS_HOST = 'speech.platform.bing.com';
const EDGE_TTS_PATH = '/consumer/speech/synthesize/readaloud/edge/v1';
const EDGE_TTS_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const EDGE_CHROMIUM = '143.0.3650.75';
const EDGE_CHROMIUM_MAJOR = EDGE_CHROMIUM.split('.')[0];
const TIMEOUT_MS = 15000;
const ATTEMPTS = 2;

const hex = (bytes) => { const a = new Uint8Array(bytes); crypto.getRandomValues(a); return [...a].map((b) => b.toString(16).padStart(2, '0')).join(''); };
const sha256Upper = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** Learna rates are 0.75, 1 and 1.1. The service wants a signed percentage, for example "-25%", "+0%" or "+10%". */
export function edgeRate(rate) {
  const pct = Math.max(-50, Math.min(50, Math.round(((Number(rate) || 1) - 1) * 100)));
  return (pct < 0 ? '-' : '+') + Math.abs(pct) + '%';
}

// Sec-MS-GEC: SHA-256 of the Windows file time (rounded down to 5 minutes) plus the trusted client token.
export async function edgeTtsGec(nowMs = Date.now()) {
  let secs = Math.floor(nowMs / 1000) + 11644473600;
  secs -= secs % 300;
  return sha256Upper(String(BigInt(secs) * 10000000n) + EDGE_TTS_TOKEN);
}

// "fr-FR-DeniseNeural" becomes "Microsoft Server Speech Text to Speech Voice (fr-FR, DeniseNeural)", the long form Edge itself sends.
export function longVoiceName(shortName) {
  const m = /^([a-z]{2,})-([A-Z]{2,})-(.+Neural)$/.exec(shortName);
  return m ? 'Microsoft Server Speech Text to Speech Voice (' + m[1] + '-' + m[2] + ', ' + m[3] + ')' : shortName;
}

const dateString = (d) => {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => String(n).padStart(2, '0');
  return days[d.getUTCDay()] + ' ' + months[d.getUTCMonth()] + ' ' + p(d.getUTCDate()) + ' ' + d.getUTCFullYear() + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds()) + ' GMT+0000 (Coordinated Universal Time)';
};

export function buildMessages(text, voiceName, rate, now = new Date()) {
  const ts = dateString(now);
  const config = 'X-Timestamp:' + ts + '\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n' +
    '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"true","wordBoundaryEnabled":"false"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n';
  // xml:lang stays en-US for every voice. That is what the edge-tts package sends and it works for French too: the voice name decides the language.
  const ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='" + longVoiceName(voiceName) + "'><prosody pitch='+0Hz' rate='" + rate + "' volume='+0%'>" + xmlEscape(text) + '</prosody></voice></speak>';
  // The stray "Z" after the timestamp is intentional. It matches what Microsoft Edge sends.
  const ssmlMsg = 'X-RequestId:' + hex(16) + '\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:' + ts + 'Z\r\nPath:ssml\r\n\r\n' + ssml;
  return { config, ssml: ssmlMsg };
}

async function synthesizeOnce(text, voiceName, rate) {
  const url = 'https://' + EDGE_TTS_HOST + EDGE_TTS_PATH + '?TrustedClientToken=' + EDGE_TTS_TOKEN + '&ConnectionId=' + hex(16) + '&Sec-MS-GEC=' + (await edgeTtsGec()) + '&Sec-MS-GEC-Version=1-' + EDGE_CHROMIUM;
  const resp = await fetch(url, {
    headers: {
      Upgrade: 'websocket', Pragma: 'no-cache', 'Cache-Control': 'no-cache',
      Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/' + EDGE_CHROMIUM_MAJOR + '.0.0.0 Safari/537.36 Edg/' + EDGE_CHROMIUM_MAJOR + '.0.0.0',
      'Accept-Language': 'en-US,en;q=0.9',
      Cookie: 'muid=' + hex(16).toUpperCase() + ';',
    },
  });
  const ws = resp.webSocket;
  if (!ws) throw new Error('WebSocket upgrade refused (HTTP ' + resp.status + ')');
  ws.accept();
  const msgs = buildMessages(text, voiceName, rate);

  return new Promise((resolve, reject) => {
    const parts = []; let total = 0, finished = false, chain = Promise.resolve();
    const timer = setTimeout(() => finish(new Error('timeout')), TIMEOUT_MS);
    function finish(err) {
      if (finished) return; finished = true; clearTimeout(timer);
      try { ws.close(1000, 'done'); } catch (_) { /* already closed */ }
      if (err) return reject(err);
      if (!total) return reject(new Error('no audio received'));
      const out = new Uint8Array(total); let off = 0;
      for (const p of parts) { out.set(p, off); off += p.length; }
      resolve(out);
    }
    async function onMessage(ev) {
      if (finished) return;
      let d = ev.data;
      if (typeof d === 'string') {   // text frames carry the turn markers; "turn.end" means the audio is complete
        const head = d.slice(0, d.indexOf('\r\n\r\n') >= 0 ? d.indexOf('\r\n\r\n') : d.length);
        const m = /(?:^|\r\n)Path:([^\r\n]+)/.exec(head);
        if (m && m[1].trim() === 'turn.end') finish();
        return;
      }
      if (d && typeof d.arrayBuffer === 'function') d = await d.arrayBuffer();   // Blob to ArrayBuffer
      const bytes = new Uint8Array(d);
      if (bytes.length < 2) return;
      const headerLen = (bytes[0] << 8) | bytes[1];   // binary frames start with a two byte header length
      if (headerLen + 2 > bytes.length) return;
      const headers = new TextDecoder().decode(bytes.subarray(2, 2 + headerLen));
      if (!/(?:^|\r\n)Path:audio\s*(?:\r\n|$)/.test(headers)) return;
      const audio = bytes.subarray(2 + headerLen);
      if (audio.length) { parts.push(audio.slice()); total += audio.length; }
    }
    ws.addEventListener('message', (ev) => { chain = chain.then(() => onMessage(ev)).catch((e) => finish(e)); });
    ws.addEventListener('error', () => { chain = chain.then(() => finish(new Error('socket error'))); });
    ws.addEventListener('close', () => { chain = chain.then(() => finish()); });
    try { ws.send(msgs.config); ws.send(msgs.ssml); } catch (e) { finish(e); }
  });
}

/** Returns MP3 bytes (Uint8Array). Tries twice, then throws. `voiceName` is a neural voice id such as "fr-FR-DeniseNeural". */
export async function edgeTtsSynthesize(text, voiceName, rate) {
  text = String(text).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ' ').replace(/\s+/g, ' ').trim();   // control characters would break the SSML
  if (!text) throw new Error('no text');
  const r = edgeRate(rate); let lastErr = null;
  for (let i = 0; i < ATTEMPTS; i++) {
    try { return await synthesizeOnce(text, voiceName, r); } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('synthesis failed');
}
