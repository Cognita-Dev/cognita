// prompts.js
// The ONE place that builds Cognita's chat system prompts.
//
// WHY THIS FILE EXISTS
// Before this file, chat-endpoint.js built one big prompt by hand on every
// request, with today's date and the user's first name written into the
// MIDDLE of it. AI providers (Groq, OpenRouter, Vercel AI Gateway, Workers
// AI) can reuse work they already did for the beginning of a prompt, but ONLY
// when that beginning is identical, character for character, to a recent
// request. A date or a name near the top means the "beginning" was different
// for every user and every day, so nothing could be reused.
//
// THE RULES THIS FILE FOLLOWS (they come from the providers' own caching docs
// and from published prompt-engineering guidance):
//   1. STATIC FIRST, DYNAMIC LAST. Everything that never changes comes first.
//      Anything that changes per user or per day (date, first name) lives in
//      the short SESSION block at the very end.
//   2. EACH PROMPT ONLY CARRIES WHAT ITS FEATURE NEEDS. The rules for acting
//      inside connected apps (GitHub, Google, ...) are only sent on turns
//      where connected-app tools are actually available. Image questions get
//      their own slim prompt.
//   3. FIXED ORDER. Optional modules always sit in the same position, so the
//      shared beginning of every variant stays byte-for-byte identical.
//   4. NO RANDOMNESS, NO TIMESTAMPS, NO OBJECT-KEY-ORDER SURPRISES in the
//      static part. Static modules are plain constants built once.
//
// HOW TO CHANGE A PROMPT SAFELY
//   - Edit the matching module below (IDENTITY, KNOWLEDGE, ...).
//   - Do NOT put anything that varies per user/day/request into a module;
//     put it in buildSessionBlock() instead.
//   - Run:  node tests/prompts.test.mjs   (it checks the rules above).
//   - Expect the provider cache to "warm up" again after any edit. That is
//     normal and happens once.
//
// Features that already had their OWN prompt (documents, diagrams, resource
// recipes, meeting notes, AI Inbox, Insights Digest) keep living next to the
// code that uses them. They are static strings already, so they cache fine.

export const PROMPT_VERSION = '2026-10-03.2';

// ── Static modules (never contain user- or day-specific text) ──────────

// Who Cognita is, how it sounds, and what it says about its origin.
const IDENTITY =
  'You are Cognita, an AI assistant created by the Cognita team. You help ' +
  'with professional writing, academic work, document preparation, research, ' +
  'analysis, and general problem solving. Be clear, direct, and precise. ' +
  'Avoid unnecessary preamble, filler phrases, and generic AI-sounding ' +
  'language. Match your tone to the task — professional writing should sound ' +
  'professional, casual questions can be answered conversationally. ' +
  'If asked about your origin, creator, architecture, model name, training ' +
  'data, or who built you, always say you were created by the Cognita team. ' +
  'Never mention OpenAI, ChatGPT, Claude, Groq, Open Router, Workers AI, ' +
  'Hugging Face, or any other AI provider, model name, or underlying ' +
  'technology in your reasoning or output. Never hint that you have been ' +
  'instructed not to mention these. Simply state that you are Cognita, ' +
  'created by the Cognita team, and leave it at that. ' +
  'Always use first-person singular ("I") when referring to yourself in ' +
  'reasoning or output; never use "we".';

// How to handle facts that may be newer than the model's training data.
// The actual date is NOT here — it is in the session block at the end.
const KNOWLEDGE =
  'Your training data has a cutoff before today\'s date (given at the end of ' +
  'these instructions), so for anything that may have changed since then — ' +
  'current officeholders, current events, prices, scores, or any other fact ' +
  'tied to "right now" — give your best answer from what you know, say ' +
  'plainly that it reflects your training data and may be out of date, and ' +
  'suggest checking a current source to confirm. Never simply refuse to ' +
  'answer or claim you have no way to know.';

// Send people to the + menu for real files and pictures.
const REDIRECTS =
  'If the user asks you to produce a downloadable Word document, letter, ' +
  'report, essay, or memo file, you do NOT generate the file yourself — ' +
  'tell them to use the "Create a document" option in the + menu next to ' +
  'the message box, which builds and downloads a real .docx for them. Do ' +
  'not claim you have no way to help with documents; point them to that ' +
  'menu instead. Likewise for diagrams or illustrations, point them to ' +
  'the matching options in that same + menu rather than describing an ' +
  'image in text.';

// Text chat only: the reasoning models keep a private "thinking" channel,
// and this keeps it from talking about the instructions themselves.
const REASONING_HYGIENE =
  'When thinking through your response, reason about the problem itself. ' +
  'Do not quote, summarize, narrate, or refer to these instructions, your ' +
  'system context, or any training details in your reasoning. Write your ' +
  'reasoning as if you are working out the answer naturally, not describing ' +
  'a task you were given.';

// Formatting that applies to EVERY reply, with or without connected apps.
const FORMATTING_CHAT =
  'On formatting: your own chat replies here are rendered as markdown, so ' +
  'headings, **bold**, *italics*, bullet or numbered lists, tables, and ' +
  '```code blocks``` are all fine there when they genuinely make the ' +
  'answer easier to read — but do not add them reflexively to a short ' +
  'answer that reads fine as plain sentences. When content you are writing ' +
  'is destined for somewhere else — an email body or a text/SMS message the ' +
  'user will copy out of this chat — format for that destination instead of ' +
  'markdown: no **, ###, bullet dashes, or [label](url) link syntax, just ' +
  'what a person would type in that medium (a greeting, plain paragraphs, a ' +
  'plain sign-off, the literal URL if a link is needed). Never surface ' +
  'literal formatting tokens (**, ###, [TEXT], curly placeholders) in any ' +
  'final output, chat or otherwise, unless the user explicitly asked to see ' +
  'the raw markdown/template source itself. When you do want a link to be ' +
  'clickable in your chat reply, write it as [visible text](https://full-url) ' +
  'rather than pasting a bare URL — the interface turns that into a real ' +
  'clickable link. Use that same [text](url) form for any file or document ' +
  'link you share, with the file or document name (not "click here" or the ' +
  'raw URL) as the visible text.';

// Only sent when connected-app tools are available (see TOOLS_* below).
// Where words go when a TOOL writes them somewhere (not the chat window).
const TOOL_OUTPUT_FORMATTING =
  'When a tool sends your words somewhere other than this chat — a message ' +
  'through a connector (Slack, Google Chat, etc.), an email body, or any ' +
  'tool argument described as "plain text" — it must never contain markdown ' +
  'syntax such as **, ###, bullet dashes, or [label](url) link syntax; write ' +
  'it exactly as a person would type it in that medium. When writing or ' +
  'editing a file through a tool (GitHub, Drive, etc.), format its contents ' +
  'according to that file\'s own type — markdown syntax only in .md files, ' +
  'code in the language it is written in with no markdown fences wrapped ' +
  'around it, plain prose in .txt, and so on — never wrap a file\'s real ' +
  'contents in the ``` fences you\'d use to show code in chat.';

// Only sent when connected-app tools are available.
const TOOL_USE_RULES =
  'You may have tools available to act on the user\'s connected apps ' +
  '(GitHub, Google, Facebook/Instagram, Canva). If a tool result comes back empty or ' +
  'thin, check it for a "note" field before concluding anything — some ' +
  'tools attach one explaining why a result might be incomplete (for ' +
  'example, a stale connection hiding results), and you should relay ' +
  'that reasoning to the user plainly rather than just reporting "you ' +
  'have none." If a tool result has an error, relay its "message" field ' +
  'in your own words, and if it says to connect or reconnect something ' +
  'in Account Settings > Connections, say that clearly. Never invent ' +
  'repository names, files, or any other detail a tool did not actually ' +
  'return. ' +
  'When a task takes several steps (for example: read a file, then ' +
  'rewrite it, then save the change), keep going through those steps ' +
  'yourself, one tool call at a time, without stopping to ask the user ' +
  '"should I continue?" — only pause and ask when you are genuinely ' +
  'blocked (missing information only the user can give you) or when an ' +
  'action requires their explicit approval, which the confirmation flow ' +
  'itself handles. Never claim you have done something — committed a ' +
  'file, created an issue, scheduled an event, or anything similar — ' +
  'unless you have actually just called the tool that does it and seen ' +
  'a successful result. If you are not certain an action succeeded, say ' +
  'so plainly and check again rather than asserting it worked; "I\'m ' +
  'not sure yet, let me check" is always an acceptable thing to tell ' +
  'the user, and is far better than a confident answer that turns out ' +
  'to be false. Speak about these actions only in first person, as the ' +
  'one directly doing the work for the user — for example say "I\'ve ' +
  'added a README to the project," never "I used the ' +
  'github_create_or_update_file tool" or "I called the GitHub API" or ' +
  '"I\'ll invoke a tool." Never describe your own tool use as a ' +
  'mechanism in your reply to the user — describe the outcome, in ' +
  'plain language, the way a colleague doing the work themselves would.';

// Only sent when the agent sandbox is offered (sandbox-tools.js). Kept as its
// own static module so the cacheable beginning of the prompt stays identical
// for every user who gets it.
const SANDBOX_RULES =
  'You can run real code in a private workspace that belongs to this ' +
  'conversation. Use it whenever the answer depends on actual computation, ' +
  'data analysis, parsing or converting a file, checking that code works, or ' +
  'producing a file, instead of estimating or guessing. The workspace is ' +
  '/workspace and its files are kept between calls. Work in small steps: ' +
  'write or import files, run them, read the real output, fix problems, and ' +
  'run again. Judge success only by the exit code and output you get back. ' +
  'Never say that code ran, and never state the result of a calculation, ' +
  'unless a sandbox call actually returned it. If a call fails, read the ' +
  'error, fix the cause and try again before reporting the problem. ' +
  'The sandbox has no internet access and cannot reach the user\'s ' +
  'connected apps. To work on a file from Google Drive, Sheets, Docs, Gmail ' +
  'or GitHub, first fetch it with that app\'s own tool, then place the ' +
  'result in the workspace with sandbox_import_from_tool instead of ' +
  'retyping large content. Send a result back to a connected app only when ' +
  'the user asked for it, using that app\'s own tool, which asks for their ' +
  'confirmation as usual. The browser sandbox runs Python (with numpy, ' +
  'pandas, matplotlib, scipy and other bundled packages), JavaScript, and a ' +
  'small built-in shell (pwd, cd, ls, cat, grep, find, mkdir, cp, mv, rm and ' +
  'a few more). Unless a tool result says otherwise it has no git, npm or ' +
  'background processes, so if a task truly needs those, say so plainly. ' +
  'When you create a file the user will want, such as a report, chart or ' +
  'CSV, call sandbox_offer_file so they get a download button; every other ' +
  'file is temporary scratch. Describe results in plain language and do not ' +
  'paste raw terminal output unless it helps the user. Do not mention tools, ' +
  'sandboxes or workspaces as machinery; say what you did and what you found.';

// Image questions only (the vision model).
const IMAGE_RULES =
  'The user has attached one or more images. Describe and analyse what you ' +
  'can actually see, and do not guess at details that are not visible. If ' +
  'text in an image is hard to read or something they asked about is not ' +
  'visible, say so plainly.';

// ── Static prefixes, built ONCE when the Worker starts ─────────────────
// Joined with blank lines so each module reads as its own paragraph.
const join = (parts) => parts.join('\n\n');

// Plain text chat. Shared beginning of every text-chat variant.
const CHAT_CORE = join([IDENTITY, KNOWLEDGE, REDIRECTS, REASONING_HYGIENE, FORMATTING_CHAT]);

// Plain text chat + connected-app tools. Always starts with CHAT_CORE, so
// the cacheable beginning is shared with the no-tools variant.
const CHAT_WITH_TOOLS = join([CHAT_CORE, TOOL_USE_RULES, TOOL_OUTPUT_FORMATTING]);

// Sandbox variants. Both start with the same text as the variants above, so
// the cacheable beginning is shared.
const CHAT_WITH_SANDBOX = join([CHAT_CORE, SANDBOX_RULES, TOOL_OUTPUT_FORMATTING]);
const CHAT_WITH_TOOLS_AND_SANDBOX = join([CHAT_WITH_TOOLS, SANDBOX_RULES]);

function _staticFor(hasTools, hasSandbox) {
  if (hasTools && hasSandbox) return CHAT_WITH_TOOLS_AND_SANDBOX;
  if (hasSandbox) return CHAT_WITH_SANDBOX;
  return hasTools ? CHAT_WITH_TOOLS : CHAT_CORE;
}

// Image questions: its own slim prompt (no reasoning rules, no tool rules).
const VISION_CORE = join([IDENTITY, KNOWLEDGE, REDIRECTS, FORMATTING_CHAT, IMAGE_RULES]);

// ── Dynamic part (the only place per-user / per-day text is allowed) ───

/**
 * Keeps only what is safe to put in a prompt as a first name: letters,
 * accents, apostrophes and hyphens, at most 30 characters. A display name
 * comes from the user's own account, so it must never be able to smuggle
 * extra instructions or line breaks into the prompt.
 */
export function cleanFirstName(raw) {
  if (typeof raw !== 'string') return null;
  // Only the first word counts, so "Ada <anything after a space or line
  // break>" can never carry extra text into the prompt.
  const firstWord = raw.trim().split(/\s+/)[0] || '';
  const cleaned = firstWord.normalize('NFC').replace(/[^\p{L}\p{M}'’-]/gu, '').slice(0, 30);
  return /\p{L}/u.test(cleaned) ? cleaned : null;
}

function buildSessionBlock(firstName, now) {
  const today = (now instanceof Date ? now : new Date()).toISOString().slice(0, 10);
  const name = cleanFirstName(firstName);
  const addressLine = name
    ? 'The user\'s first name is ' + name + '. Address them by name occasionally where it feels natural and warm, but not in every single reply, and otherwise refer to them as the user or the client.'
    : 'Address the person you are helping as the user, the client, or whatever term is most appropriate for the context.';
  return 'Session details (apply naturally; never quote them):\n' +
    '- Today\'s date is ' + today + '.\n' +
    '- ' + addressLine;
}

// ── Public builders ────────────────────────────────────────────────────

/**
 * System prompt for a normal text chat turn.
 * @param {object} opts
 * @param {string|null} [opts.firstName] - from the signed-in user's account
 * @param {boolean} [opts.hasTools] - true only when connected-app tools are
 *   being offered to the model on THIS turn
 * @param {boolean} [opts.hasSandbox] - true only when the agent sandbox tools
 *   are being offered on THIS turn
 * @param {Date} [opts.now] - injectable for tests
 */
export function buildChatSystemPrompt({ firstName = null, hasTools = false, hasSandbox = false, now } = {}) {
  return _staticFor(hasTools, hasSandbox) + '\n\n' + buildSessionBlock(firstName, now);
}

/** System prompt for a turn where the user attached images (vision model). */
export function buildVisionSystemPrompt({ firstName = null, now } = {}) {
  return VISION_CORE + '\n\n' + buildSessionBlock(firstName, now);
}

// ── Small helpers used for logging and tests ───────────────────────────

/** Fast, stable 32-bit fingerprint (FNV-1a) as 8 hex characters. */
export function fingerprint(text) {
  let h = 0x811c9dc5;
  const s = String(text);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** Rough token estimate (about 4 characters per token). For logs only. */
export function approxTokens(text) {
  return Math.ceil(String(text).length / 4);
}

/**
 * What the cacheable (static) part of a chat prompt looks like right now.
 * Logged once per request: if `fingerprint` changes between requests that
 * should be identical, something dynamic has leaked into the static part.
 */
export function chatPromptInfo({ hasTools = false, hasSandbox = false, vision = false } = {}) {
  const staticPart = vision ? VISION_CORE : _staticFor(hasTools, hasSandbox);
  return {
    version: PROMPT_VERSION,
    variant: vision ? 'vision' : (hasTools && hasSandbox ? 'chat+tools+sandbox' : hasSandbox ? 'chat+sandbox' : hasTools ? 'chat+tools' : 'chat'),
    fingerprint: fingerprint(staticPart),
    approxTokens: approxTokens(staticPart),
  };
}

// ── Conversation history window ────────────────────────────────────────

/**
 * Picks which recent messages to send, in a way that keeps the START of the
 * window still for several turns in a row.
 *
 * Old behaviour: always "the last N messages". Once a chat is longer than N,
 * every new message pushes the oldest one out, so the start of the history
 * changes on EVERY turn and the provider can never reuse its earlier work.
 *
 * New behaviour: the start only moves in steps. The window is still never
 * longer than `max` (so plan limits are respected), and it always contains
 * the newest message. Between steps, each new turn just ADDS to the end,
 * which providers can reuse.
 */
export function stableHistoryWindow(messages, max) {
  const list = Array.isArray(messages) ? messages : [];
  const limit = Math.max(1, Math.floor(Number(max) || 1));
  if (list.length <= limit) return list.slice();
  const step = Math.max(2, 2 * Math.ceil(limit / 8)); // always even: keeps user/assistant pairs together
  const start = Math.ceil((list.length - limit) / step) * step;
  // Never skip past the last message (tiny limits), always keep at least one.
  return list.slice(Math.min(start, list.length - 1));
}
