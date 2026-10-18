# Slide request that looped on "make the subtitle shorter", then flooded the screen

What happened: asked to make a presentation slide from a proposal PDF, the assistant rebuilt `build_slide.py` over and over,
then wrote "The subtitle is still too long. Let me make it even shorter and rebuild." hundreds of times in a row until the
connection dropped ("Connection to Cognita was interrupted").

## Cause 1 (the real bug): the cover subtitle could not fit
- sandbox-frame.html: every content slide shrinks its text to fit its box with `fit()`, but the cover slide's subtitle was
  always 22 pt in a fixed box. A long cover line overflowed, the quality check reported "text in 'Subtitle' is too long for
  its box", and the only way the model could clear it was to cut words. It kept cutting and the check kept failing.
- The cover subtitle now picks the largest size (22 down to 14 pt) that fits, the box is a little taller, and if even 14 pt
  cannot hold it the last lines are dropped (or the line is shortened with "...") instead of overflowing.
- The cover title also shrinks to fit when it is very long, and the footer (which repeats the deck title) is cut to one line
  so a long title cannot make the footer fail the check.

## Cause 2: nothing stopped a model that repeats itself
- providers.js: new `findTextLoop()` and `collapseTextLoops()`. Both streaming readers (OpenAI-compatible providers and
  Workers AI) stop reading as soon as the same stretch of text appears three times in a row, cancel the provider stream, keep
  one copy and return `finishReason: 'repetition'` with no tool call. Short repeats, dash rules and table separators are
  never treated as loops.
- chat-endpoint.js: a turn that ended with `repetition` clears the half-shown text in the browser, tells the model what went
  wrong ("call the next tool now, or give one short answer") and gives it up to `MAX_LOOP_RETRIES` (2) more tries. After that
  the turn ends with a plain message and a "continue" offer instead of a wall of text.
- chat-endpoint.js: the stall check no longer pushes the model twice with the identical sentence. A repeated stall goes
  straight to the "Reply continue" line.

## Cause 3: the Worker ran out of CPU while streaming (Cloudflare log: "Worker exceeded CPU time limit")
- chat-endpoint.js: `_makeTurnStreamer` re-parsed and regex-scanned the whole reply so far for every few characters that
  arrived, so the work grew with the square of the reply length. A 16,000 character reply cost about 0.7 s of CPU, and the
  runaway repeated text pushed the request over the limit, which cut the connection with no `done` event (the "Connection to
  Cognita was interrupted" message). Text is now processed in batches (160 characters or 120 ms, the first piece is never held
  back, and `finish()` always handles what is left). The same 16,000 characters now cost about 0.04 s.
- providers.js: the repeat check only runs every 48 new characters and rejects most positions after comparing four characters.
- `_makeTurnStreamer` is exported so it can be tested.

## Tests
- tests/text-loop.test.mjs: the loop detector (glued repeats like the screenshots, what must not be touched, speed).
- tests/text-loop-stream.test.mjs: a fake model that never stops talking goes through the real stream reader and is cut off.
- tests/cover-subtitle-fit.e2e.py: builds a deck with a long cover subtitle, long title and long footer and checks it passes.
- tests/stream-batching.test.mjs: nothing is lost by batching (plain text, component blocks, tool calls written as text, reset), and a long reply stays cheap.
