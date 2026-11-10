# Skills: the model can now load a skill itself

Before: skills were chosen only by a keyword router (skills.js). If it missed, the model never saw the rules and could not ask for them.

Now (like Claude's skills):
- skills.js has a SKILLS registry (name + one-line description + text + which tools it needs).
- The prompt lists skills that apply to the turn but were not loaded (skillCatalog).
- New `load_skill` tool: the model loads a missed skill mid-turn. Silent (no step card, no quota, does not count as work done), tolerant of name spelling, repeat loads return a short note, bad names return the valid list, capped per turn.
- load_skill is offered only next to other tools, so plain chats keep the fast streaming path.
- The router now reads messages whose content is a list of parts (before they were skipped).
- SKILLS_DISABLED=1 still turns everything off. PROMPT_VERSION bumped (cache warms once).

Files: skills.js, prompts.js, chat-endpoint.js, tests/skills.test.mjs (+5 tests, 16 pass).
Note: other test files need tests/key.pem and fail the same way before and after this change.

## Round 2: the things left out the first time
- **Your own skills** (Settings > Skills): add, edit, turn on/off, delete (up to 10). Saved in Firestore at `userSkills/{uid}` through new `GET/PUT/DELETE /api/skills` (user-skills-endpoint.js, routed in worker.js). A skill loads by itself when its name or a trigger word appears in the message, or the model loads it with `load_skill` (they are listed in the skill list).
- Safety: names/text are cleaned (control and direction characters removed, length limits, built-in names refused), the settings card writes with textContent only, saved text is wrapped as "the person's own skill" and can never override core, safety or tool rules, and a slow or failing read (1.5 s cap) just means no custom skills for that turn.
- **Tool-less turns**: they cannot offer `load_skill`, so a wider router (selectSkillsToolless) loads the on-screen component rules for question-like messages of 40+ characters.
- Files: skills.js, prompts.js, chat-endpoint.js, worker.js, user-skills-endpoint.js (new), app.html, js/account.js, js/skills-ui.js (new), tests/custom-skills.test.mjs (new), tests/skills.test.mjs, tests/qa-prompts.test.mjs.
- Firestore rules: if you lock collections down, `userSkills` is only touched by the Worker (service account), so no client rule is needed.
- Known limit: two saves from two devices at the same instant: the last one wins.
- Other test files still need `tests/key.pem` and fail the same way as before.
