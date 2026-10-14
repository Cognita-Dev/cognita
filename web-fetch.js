// web-fetch.js
// Lets the assistant read a public web page or data file. It runs on the Worker, NOT in the
// person's browser sandbox, so model-written code still has no way to call out to other sites.
// The text comes back as a tool result; sandbox_import_from_tool then places it in /workspace
// where Python (html.parser, BeautifulSoup, pandas) can work on it.
//
// Safety: https only, standard port, no credentials, no IP addresses or local names (checked
// again on every redirect), no cookies or sign-in details are sent, at most MAX_BYTES read,
// a hard time limit, and text-like content only. Workers cannot reach private networks, so
// this is a second layer on top of that, not the only one.

import { checkPublicUrl } from './browser-rendering.js';

// sandbox_import_from_tool keeps at most 300,000 characters of a step's text and cuts the rest without saying so.
// Text never has more characters than bytes, so capping the read at 300,000 bytes means the saved file is
// always exactly what was read, and `truncated` below tells the model honestly when the page was cut.
export const MAX_BYTES = 300_000;
const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 4;
const TEXT_TYPES = /^(?:text\/[\w.+-]+|application\/(?:json|[\w.+-]*\+json|xml|[\w.+-]*\+xml|x-ndjson|csv|javascript|x-yaml|yaml))(?:\s*;|$)/i;

/** Decoder for the page's declared charset, falling back to UTF-8 when the label is unknown. */
function _decoder(contentType, bytes) {
  let label = (/charset=["']?([\w.:-]+)/i.exec(contentType || '') || [])[1];
  if (!label && bytes && /html|xml/i.test(contentType || '')) {
    // Older pages declare their encoding inside the page instead of in the header.
    const head = new TextDecoder('latin1').decode(bytes.subarray(0, 2048));
    label = (/<meta[^>]+charset=["']?\s*([\w.:-]+)/i.exec(head) || /<\?xml[^>]+encoding=["']([\w.:-]+)["']/i.exec(head) || [])[1];
  }
  try { return new TextDecoder(label || 'utf-8', { fatal: false }); } catch (_) { return new TextDecoder('utf-8'); }
}

/**
 * Fetches one public page. Never throws. Resolves to
 *   { ok:true, status, url, contentType, text, bytes, truncated }
 * or { ok:false, error } (the error is written for the model and is safe to show).
 */
export async function fetchPublicText(rawUrl, fetchImpl) {
  const doFetch = fetchImpl || fetch;
  let current = checkPublicUrl(rawUrl);
  if (!current.ok) return { ok: false, error: current.error };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    let res = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      res = await doFetch(current.url, {
        method: 'GET',
        redirect: 'manual',
        signal: ctl.signal,
        headers: {
          'User-Agent': 'CognitaBot/1.0 (+https://app.cognita.com.ng)',
          'Accept': 'text/html,text/plain,text/csv,application/json,application/xml;q=0.9,*/*;q=0.1',
          'Accept-Language': 'en',
        },
      });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        if (hop === MAX_REDIRECTS) return { ok: false, error: 'The page redirected too many times.' };
        let next;
        try { next = new URL(res.headers.get('location'), current.url).toString(); } catch (_) { return { ok: false, error: 'The page redirected to an invalid address.' }; }
        const c = checkPublicUrl(next);
        if (!c.ok) return { ok: false, error: 'The page redirected somewhere that is not allowed (' + c.error + ')' };
        try { await res.body?.cancel(); } catch (_) { /* ignore */ }
        current = c;
        continue;
      }
      break;
    }
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'The site refused access (' + res.status + '). It may need a sign-in or may block automated readers.' };
    if (res.status === 404 || res.status === 410) return { ok: false, error: 'The page was not found (' + res.status + ').' };
    if (res.status === 429) return { ok: false, error: 'The site is limiting requests right now (429). Try again later.' };
    if (!res.ok) return { ok: false, error: 'The site answered with an error (' + res.status + ').' };
    const type = (res.headers.get('content-type') || '').trim();
    if (type && !TEXT_TYPES.test(type)) {
      return { ok: false, error: 'That address is not a text page or data file (' + type.split(';')[0] + '). Only web pages, text, CSV, JSON and XML can be read.' };
    }
    const reader = res.body ? res.body.getReader() : null;
    if (!reader) return { ok: false, error: 'The page had no content.' };
    const chunks = [];
    let bytes = 0;
    let truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (bytes + value.length > MAX_BYTES) {
        chunks.push(value.slice(0, MAX_BYTES - bytes));
        bytes = MAX_BYTES;
        truncated = true;
        try { await reader.cancel(); } catch (_) { /* ignore */ }
        break;
      }
      chunks.push(value);
      bytes += value.length;
    }
    const all = new Uint8Array(bytes);
    let off = 0;
    for (const c of chunks) { all.set(c, off); off += c.length; }
    const text = _decoder(type, all).decode(all);
    if (/\u0000/.test(text.slice(0, 2000))) return { ok: false, error: 'That address is a binary file, not text.' };
    return { ok: true, status: res.status, url: current.url, contentType: type.split(';')[0] || 'text/plain', text, bytes, truncated };
  } catch (e) {
    if (e && e.name === 'AbortError') return { ok: false, error: 'The page took too long to answer (over ' + TIMEOUT_MS / 1000 + ' seconds).' };
    return { ok: false, error: 'The page could not be reached.' };
  } finally {
    clearTimeout(timer);
  }
}

/** Short preview for the model; the full text travels separately as the importable blob. */
export function previewForModel(r, previewChars = 5000) {
  const head = 'Fetched ' + r.url + ' (' + r.status + ', ' + r.contentType + ', ' + r.bytes + ' bytes' + (r.truncated ? ', cut at ' + MAX_BYTES + ' bytes' : '') + ').';
  const body = r.text.length > previewChars ? r.text.slice(0, previewChars) + '\n[preview cut: ' + (r.text.length - previewChars) + ' more characters]' : r.text;
  return head + '\n\n' + body;
}
