# Web search + real chat titles (14 Oct 2026)

## 1. "I have no web search" was half true
What Cognita really had: a page READER (`sandbox_web_fetch`, any plan with the sandbox) and a cloud browser (`sandbox_browser_fetch`, Studio/Admin only, needs `CF_BROWSER_ACCOUNT_ID` + `CF_BROWSER_API_TOKEN`, only offered when the sandbox is offered for that message). Both open ONE address you already have; neither can take a question and find sources. And nothing in the prompt told the model it could read pages, so it said it had no web access.
- NEW `web-search.js`: `web_search` tool, runs on the Worker. Providers (both free plans renew monthly, no card): `TAVILY_API_KEY` first, `FIRECRAWL_API_KEY` as backup and as automatic fallback when Tavily's allowance runs out. Brave was dropped (needs a card). No key = tool never offered.
- `chat-endpoint.js`: offers it only when the message looks like a lookup (`shouldOfferWebSearch`), the plan still has searches left today, and a key is set. Runs on the Worker, 4 per request, counted under usage key `webSearches`, refunded on failure. Works on every plan, with or without the sandbox.
- `entitlements.js`: `limits.webSearchPerDay` free 10, plus 50, studio 200, admin unlimited.
- `prompts.js` (version 2026-10-14.2): new WEB_RULES (only sent when the tool is offered); KNOWLEDGE no longer lets the model claim it has no web access; the sandbox rule now says only the model's CODE is offline and pages can be read. Trimmed to stay inside the token budget test.
- `wrangler.jsonc`: comment listing the new secrets.

## 2. Chat titles
Before: title = first 60 characters of the first message (`deriveTitle`).
Now: the first reply is shown at once with that stand-in, then the browser asks `POST /api/chat/title`; the fast model writes a 3 to 6 word title in the user's language from the opening exchange only. Stored on the chat as `titleSource: 'ai'`, synced to B2 like the rest, kept on later messages, never moves the chat in the sidebar. If the request fails the stand-in stays and the next exchange retries. Old chats get a real title the next time they receive a message.
- NEW `chat-title-endpoint.js` (300 titles/day/user, refunded on failure, chat text fenced as data). Route added in `worker.js` (+ small-body list).
- `js/app.js`: `maybeRequestAiTitle`, `requestAiTitle`, `updateConversationTitle` reads the stored title, placeholders keep `titleSource`.

## Deploy
Worker: chat-endpoint.js, chat-title-endpoint.js, web-search.js, entitlements.js, prompts.js, worker.js. Site: js/app.js. Then `npx wrangler secret put TAVILY_API_KEY`, and optionally `FIRECRAWL_API_KEY`.

## Not verified
No live call to Tavily, Firecrawl or a model, no browser run of the new client code (syntax and unit tests only). Tests: `node tests/web-search.test.mjs`, `node tests/chat-title.test.mjs`, `node tests/qa-prompts.test.mjs`. The sandbox/billing tests need `tests/key.pem`, which is not in the repo, so they could not run here.
