// browser-rendering.js
// Server-side fallback browser, using Cloudflare Browser Rendering's REST API.
//
// Only Studio and Admin plans may use it (entitlements.js: features.sandboxBrowserRemote).
// The Worker needs two secrets: CF_BROWSER_ACCOUNT_ID and CF_BROWSER_API_TOKEN
// (an API token with the "Browser Rendering - Edit" permission). Without both,
// this module reports "not configured" and nothing calls Cloudflare.
//
// What it can do: render a public https page, or a piece of HTML the model wrote,
// in a real headless Chrome, and return the rendered text, links or element
// measurements. What it cannot do: report console errors (the REST API does
// not expose them) or show a screenshot to the model (tool results are text).

const API = 'https://api.cloudflare.com/client/v4/accounts/';
export const MODES = ['text', 'html', 'links', 'elements'];
const ENDPOINT = { text: 'markdown', html: 'content', links: 'links', elements: 'scrape' };
const MAX_HTML_CHARS = 200_000;
const MAX_OUT_CHARS = 12_000;
const MAX_SELECTORS = 10;
const TIMEOUT_MS = 30_000;

export function remoteBrowserConfigured(env) {
  return !!(env && env.CF_BROWSER_ACCOUNT_ID && env.CF_BROWSER_API_TOKEN &&
    /^[A-Za-z0-9]{8,64}$/.test(String(env.CF_BROWSER_ACCOUNT_ID)));
}

/** Blocks anything that is not a plain public https URL (no localhost, private ranges, credentials, odd ports). */
export function checkPublicUrl(raw) {
  let u;
  try { u = new URL(String(raw || '').trim()); } catch (_) { return { ok: false, error: 'That is not a valid web address.' }; }
  if (u.protocol !== 'https:') return { ok: false, error: 'Only https:// addresses are allowed.' };
  if (u.username || u.password) return { ok: false, error: 'Addresses with a username or password are not allowed.' };
  if (u.port && u.port !== '443') return { ok: false, error: 'Only the standard https port is allowed.' };
  const h = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!h.includes('.') || h === 'localhost' || /\.(local|internal|localhost|lan|home|corp)$/.test(h)) {
    return { ok: false, error: 'Private or local addresses are not allowed.' };
  }
  if (h.startsWith('[') || /^[0-9a-f:]+$/.test(h) && h.includes(':')) return { ok: false, error: 'IP addresses are not allowed. Use a domain name.' };
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) return { ok: false, error: 'IP addresses are not allowed. Use a domain name.' };
  if (/^\d+$/.test(h.replace(/\./g, ''))) return { ok: false, error: 'IP addresses are not allowed. Use a domain name.' };
  return { ok: true, url: u.toString() };
}

function cleanSelectors(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((s) => typeof s === 'string' && s.trim() && s.length <= 200).slice(0, MAX_SELECTORS).map((s) => s.trim());
}

function cap(s, n) {
  s = typeof s === 'string' ? s : JSON.stringify(s);
  return s.length > n ? s.slice(0, n) + '\n[cut: ' + (s.length - n) + ' more characters]' : s;
}

/**
 * Runs one render. args: { url? | html?, mode, selectors? }. Exactly one of url / html.
 * Always resolves to { ok, stdout, stderr, exitCode, note? }, never throws.
 */
export async function renderRemote(args, env) {
  const fail = (msg, code) => ({ ok: false, exitCode: code || 1, stdout: '', stderr: msg, error: true });
  if (!remoteBrowserConfigured(env)) return fail('The cloud browser is not set up on this server.', 3);
  const a = args || {};
  const mode = MODES.includes(a.mode) ? a.mode : 'text';
  const hasUrl = typeof a.url === 'string' && a.url.trim();
  const hasHtml = typeof a.html === 'string' && a.html.length > 0;
  if (hasUrl === hasHtml) return fail('Give either "url" or "html", not both and not neither.');
  const body = {};
  if (hasUrl) {
    const chk = checkPublicUrl(a.url);
    if (!chk.ok) return fail(chk.error);
    body.url = chk.url;
  } else {
    if (a.html.length > MAX_HTML_CHARS) return fail('That HTML is too large for the cloud browser (max ' + MAX_HTML_CHARS + ' characters).');
    body.html = a.html;
  }
  if (mode === 'elements') {
    const sel = cleanSelectors(a.selectors);
    if (!sel.length) return fail('mode "elements" needs at least one CSS selector.');
    body.elements = sel.map((selector) => ({ selector }));
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(API + env.CF_BROWSER_ACCOUNT_ID + '/browser-rendering/' + ENDPOINT[mode], {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.CF_BROWSER_API_TOKEN },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (res.status === 429) {
      const wait = res.headers.get('retry-after');
      return fail('The cloud browser is busy or today\'s allowance is used up' + (wait ? '. Try again in ' + wait + ' seconds.' : '. Try again later.'), 429);
    }
    if (res.status === 401 || res.status === 403) {
      console.warn('[browser-rendering] auth rejected status=' + res.status);
      return fail('The cloud browser is not available right now.', 3);
    }
    let data = null;
    try { data = await res.json(); } catch (_) { /* not JSON */ }
    if (!res.ok || !data || data.success === false) {
      const msg = data && Array.isArray(data.errors) && data.errors[0] && data.errors[0].message;
      return fail('The cloud browser could not render that' + (msg ? ': ' + String(msg).slice(0, 200) : '.'));
    }
    let out;
    if (mode === 'elements') {
      const groups = Array.isArray(data.result) ? data.result : [];
      out = groups.map((g) => ({
        selector: String(g && g.selector || '').slice(0, 200),
        count: Array.isArray(g && g.results) ? g.results.length : 0,
        first: g && g.results && g.results[0] ? {
          text: String(g.results[0].text || '').slice(0, 300),
          top: g.results[0].top, left: g.results[0].left, width: g.results[0].width, height: g.results[0].height,
        } : null,
      }));
    } else {
      out = data.result;
    }
    return { ok: true, exitCode: 0, stdout: cap(out, MAX_OUT_CHARS), stderr: '', durationMs: Date.now() - t0,
      note: 'Rendered by the cloud browser (mode ' + mode + '). Console errors are not available from it.' };
  } catch (e) {
    if (e && e.name === 'AbortError') return fail('The cloud browser took too long and was stopped.', 124);
    console.warn('[browser-rendering] failed:', e && e.message);
    return fail('The cloud browser could not be reached.', 2);
  } finally {
    clearTimeout(timer);
  }
}
