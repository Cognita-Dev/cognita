// search.js
// Free web search with no API key, no signup, no card. Fetches
// DuckDuckGo's public HTML results page and extracts titles, links, and
// snippets using Cloudflare's built-in HTMLRewriter — no external service,
// no account, nothing to configure.
//
// This isn't an official API, so if DuckDuckGo ever changes their page
// layout, this may need updating. It's built to fail quietly (returns an
// empty array) rather than break the chat if that happens.

function _extractRealUrl(href) {
  // DuckDuckGo's HTML results wrap the real URL as a redirect:
  // //duckduckgo.com/l/?uddg=<encoded-url>&...
  try {
    const full = href.startsWith('//') ? 'https:' + href : href;
    const parsed = new URL(full, 'https://duckduckgo.com');
    const real = parsed.searchParams.get('uddg');
    return real ? decodeURIComponent(real) : full;
  } catch (e) {
    return href;
  }
}

async function _duckDuckGoSearch(query) {
  const url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
  const res = await fetch(url, {
    headers: {
      // A normal browser User-Agent — without this DuckDuckGo tends to
      // reject the request outright.
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
    },
  });
  if (!res.ok) throw new Error('duckduckgo_' + res.status);

  const results = [];
  let current = null;

  const rewriter = new HTMLRewriter()
    .on('div.result', {
      element() {
        current = { title: '', url: '', snippet: '' };
        results.push(current);
      },
    })
    .on('a.result__a', {
      element(el) {
        if (!current) return;
        current.url = _extractRealUrl(el.getAttribute('href') || '');
      },
      text(chunk) {
        if (current) current.title += chunk.text;
      },
    })
    .on('a.result__snippet', {
      text(chunk) {
        if (current) current.snippet += chunk.text;
      },
    });

  // Draining the transformed body is what actually runs the handlers above.
  await rewriter.transform(res).text();

  return results
    .filter((r) => r.url && r.title.trim())
    .slice(0, 5)
    .map((r) => ({
      title: r.title.trim(),
      url: r.url,
      snippet: r.snippet.trim().slice(0, 300),
    }));
}

/**
 * Runs a web search. Returns an empty array (never throws) if the search
 * fails — the chat flow degrades gracefully to an unsourced answer rather
 * than failing the whole request.
 */
export async function webSearch(query) {
  try {
    return await _duckDuckGoSearch(query);
  } catch (e) {
    console.error('[search] web search failed:', e.message);
    return [];
  }
}
