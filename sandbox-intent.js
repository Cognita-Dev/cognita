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
  { name: 'chart', re: /\b(?:chart|histogram|scatter|heatmap|matplotlib|(?:plot|graph) (?:a|an|the|this|these|my|it|me)\b|bar graph|line graph|pie chart)/i },
  { name: 'regex', re: /\b(?:regex|regexp|regular expression)\b/i },
  { name: 'transform', re: /\b(?:parse|parsing|dedupe|deduplicate|sort these|convert (?:this|these|the|it|them)|clean (?:up )?(?:this|the) data)\b/i },
  { name: 'script', re: /\b(?:script|python|javascript|node\.?js|node)\b/i },
  { name: 'run-code', re: /\b(?:run (?:this|the|my|that)(?: code| script| program)?|execute|test this code|unit tests?|run the (?:code|tests?))\b/i },
  { name: 'use-code', re: /\b(?:use code|using code|with code|write a (?:program|script|function)|write code)\b/i },
  { name: 'code-fence', re: /```/ },
  { name: 'number-list', re: /(?:^|[^\w.])-?\d+(?:[.,]\d+)?(?:\s*(?:,|;|\band\b|\s)\s*-?\d+(?:[.,]\d+)?){2,}(?![\w.])/ },
  { name: 'file-format', re: /\b(?:as|into|to) (?:an? )?(?:excel|xlsx|csv|spreadsheet)\b/i },
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
