# Longer sandbox tasks

Problem: a request that needed real back-and-forth (write, run, read the error, fix, run, check, repeat per file) was cut off after 12 sandbox calls / 14 rounds, and the saved step history only held 40 entries.

Changes
- `sandbox-tools.js`: `MAX_SANDBOX_CALLS_PER_TURN` 12 to 40. The plan's daily run allowance (`sandboxRunsPerDay`) is still charged on every call and is the real cost limit.
- `sandbox-tools.js`: saved step history (`MAX_TRACE_ENTRIES`) 40 to 100 and its size cap 1.2M to 2M characters, so a long task is not trimmed when the browser sends it back after each run.
- `chat-endpoint.js`: `MAX_AGENT_ROUNDS_SANDBOX` is now the call cap plus 20 (was a fixed 14), so retries and corrections cannot end a task before the call cap does.
- `sandbox-tools.js` + `chat-endpoint.js`: new `shrinkOldResults()`. Before each model call, tool results older than the newest 4 are cut to 1,500 characters (the "full text can still be imported" note is kept). The full results stay in the saved history. This keeps long tasks inside the model's request-size and per-minute limits.
- `chat-endpoint.js`: when a limit is still reached, the message now says to reply "continue".
- `tests/sandbox-rounds.test.mjs`: new checks for all of the above.

Not changed: the non-sandbox ceiling (8 rounds) and the 6 web pages per request.
