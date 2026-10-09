// sandbox-intent.js
// Shared by the Worker (sandbox-tools.js) and the browser (js/app.js). It must
// stay plain JavaScript with no imports, because the browser loads it directly.
// Do NOT add this file to .vercelignore.

// ── Should the sandbox be offered for this message? ─────────────────────
// Offering the sandbox costs about 1,300 tokens on every message (rules plus
// tool schemas), so it is only offered when the request needs it. Add a new
// phrase by adding one { name, re } line below; `name` shows up in the log.
//
// The patterns are word-boundary aware and case-insensitive. They lean
// towards "offer": a wrongly offered sandbox costs a few tokens, a wrongly
// withheld one makes the assistant guess a calculation.
export const SANDBOX_INTENT_PATTERNS = [
  { name: 'calculate', re: /\b(?:calculat\w*|compute\w*|computation)\b/i },
  { name: 'average', re: /\b(?:averag\w*|(?:the |arithmetic |geometric |sample )mean|mean (?:of|and|value)|median|std dev\w*|standard deviation|variance)\b/i },
  { name: 'sum', re: /\b(?:sum of|total of|add up|adding up|running total)\b/i },
  { name: 'percentage', re: /\b(?:percent(?:age)?s?|percentile|growth rate|ratio of)\b/i },
  { name: 'statistics', re: /\b(?:statistic\w*|correlat\w*|regression)\b/i },
  { name: 'analyze', re: /\banaly[sz]\w*\b/i },
  { name: 'data-file', re: /\b(?:csv|tsv|json|xlsx|xls|spreadsheet|dataset|data set|dataframe|pandas|numpy)\b/i },
  { name: 'data-table', re: /\b(?:table of data|data table|rows and columns)\b/i },
  // A chart in a plan or budget is drawn by the chat's built-in chart cards, no code needed.
  // Only real plotting libraries or a data file send the request to the sandbox.
  { name: 'chart', re: /\b(?:histogram|heatmap|matplotlib|seaborn|plotly|scatter ?plot|(?:plot|graph|chart) (?:these|this|my|the following)\b|bar graph of (?:these|my|this))/i },
  { name: 'regex', re: /\b(?:regex|regexp|regular expression)\b/i },
  { name: 'transform', re: /\b(?:parse|parsing|dedupe|deduplicate|sort these|convert (?:this|these|the|it|them)|clean (?:up )?(?:this|the) data)\b/i },
  { name: 'script', re: /\b(?:script|python|javascript|node\.?js|node)\b/i },
  { name: 'run-code', re: /\b(?:run (?:this|the|my|that)(?: code| script| program)?|execute|test this code|unit tests?|run the (?:code|tests?))\b/i },
  { name: 'use-code', re: /\b(?:use code|using code|with code|write a (?:program|script|function)|write code)\b/i },
  // Web pages: lets the model build a page and check it in a browser, and lets Studio and
  // Admin ask about a live site. Without these the browser tools would never be offered.
  { name: 'web-page', re: /\b(?:html|css|web ?page|landing page|web ?site|webpage)\b/i },
  { name: 'url', re: /https?:\/\/[^\s]+/i },
  { name: 'code-fence', re: /```/ },
  { name: 'number-list', re: /(?:^|[^\w.])-?\d+(?:[.,]\d+)?(?:\s*(?:,|;|\band\b|\s)\s*-?\d+(?:[.,]\d+)?){2,}(?![\w.])/ },
  { name: 'file-format', re: /\b(?:as|into|to) (?:an? )?(?:excel|xlsx|csv|spreadsheet)\b/i },
  // Someone asking for a document they can download. Without these the
  // assistant would only ever send them to the + menu, even though it can
  // build Word and PDF files itself (see cognita_docs in sandbox-frame.html).
  { name: 'document-file', re: /\b(?:word (?:doc(?:ument)?s?|files?)|ms word|microsoft word|docx|pdf)\b/i },
  { name: 'make-document', re: /\b(?:write|draft|create|make|prepare|generate|produce|compose|build|give me|put together|turn (?:this|it|that) into)\b[^.?!\n]{0,40}\b(?:document|doc|downloadable|printable)\b/i },
  { name: 'downloadable', re: /\b(?:downloadable|printable|download (?:it|this|that|link))\b/i },
  { name: 'file-request', re: /\b(?:make|create|generate|produce|build|give me|put .{0,40} in|save .{0,40} (?:as|to|in)) (?:me )?(?:a |an |the )?(?:\w+ )?(?:file|csv|spreadsheet|xlsx|report file|txt|text file|download|excel file|word file|pdf)\b/i },
];

/**
 * Decides whether this request gets the sandbox tools.
 *   resuming  a browser run just finished and the turn is continuing, so the
 *             tools must stay (otherwise they would vanish mid-loop)
 *   hint      the browser says this chat already has a workspace, or a data
 *             file is attached
 *   text      the newest user message
 * Returns { offer: boolean, reason: string } where reason is "resume",
 * "hint", the name of the pattern that matched, or "none".
 */
export function shouldOfferSandbox({ text, hint, resuming } = {}) {
  if (resuming) return { offer: true, reason: 'resume' };
  if (hint === true) return { offer: true, reason: 'hint' };
  const t = typeof text === 'string' ? text.slice(0, 20000) : '';
  for (const p of SANDBOX_INTENT_PATTERNS) {
    if (p.re.test(t)) return { offer: true, reason: p.name };
  }
  return { offer: false, reason: 'none' };
}
