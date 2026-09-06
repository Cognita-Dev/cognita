// search.js
// Free web search with no API key, no signup, no card — uses Wikipedia's
// public API. Wikipedia's servers are built to be hit programmatically (no
// anti-bot wall), which is why this works reliably from a Cloudflare
// Worker when scraping general search engines does not — most sites,
// including DuckDuckGo, block requests coming from cloud/datacenter IP
// ranges (which is what a Worker's outbound traffic looks like) before
// they even look at headers or User-Agent. Wikipedia doesn't do that.
//
// Trade-off: this only covers things Wikipedia covers — people, places,
// organisations, historical and current-affairs facts ("who is the
// current president of X", "what is Y company", "when did Z happen").
// It won't find today's news articles or prices. For Cognita's use
// (writing, research, general questions) that covers most of what
// actually needs a search tool.

// Wikimedia asks API clients to identify themselves. Swap the URL below
// for your real domain — it doesn't need to be a working contact page,
// just something that identifies the app.
const WIKI_USER_AGENT = 'Cognita/1.0 (https://cognitai.vercel.app)';

async function _wikipediaSearch(query) {
  const searchUrl =
    'https://en.wikipedia.org/w/api.php?action=query&list=search&format=json&origin=*&srlimit=3&srsearch=' +
    encodeURIComponent(query);

  const searchRes = await fetch(searchUrl, {
    headers: { 'User-Agent': WIKI_USER_AGENT },
  });
  if (!searchRes.ok) throw new Error('wikipedia_search_' + searchRes.status);
  const searchData = await searchRes.json();
  const hits = searchData.query?.search || [];
  if (!hits.length) return [];

  const summaries = await Promise.all(
    hits.slice(0, 3).map(async (hit) => {
      try {
        const summaryRes = await fetch(
          'https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(hit.title.replace(/ /g, '_')),
          { headers: { 'User-Agent': WIKI_USER_AGENT } }
        );
        if (!summaryRes.ok) return null;
        const summary = await summaryRes.json();
        if (!summary.extract) return null;
        return {
          title: summary.title || hit.title,
          url:
            summary.content_urls?.desktop?.page ||
            'https://en.wikipedia.org/wiki/' + encodeURIComponent(hit.title.replace(/ /g, '_')),
          snippet: summary.extract.slice(0, 400),
        };
      } catch (e) {
        return null;
      }
    })
  );

  return summaries.filter(Boolean);
}

/**
 * Runs a web search. Returns an empty array (never throws) if the search
 * fails — the chat flow degrades gracefully to an unsourced answer rather
 * than failing the whole request.
 */
export async function webSearch(query) {
  try {
    return await _wikipediaSearch(query);
  } catch (e) {
    console.error('[search] web search failed:', e.message);
    return [];
  }
}
