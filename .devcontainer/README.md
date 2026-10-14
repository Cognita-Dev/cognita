# Cognita terminal template

This is the small, open-source setup that Cognita uses to give a user their own
cloud terminal. When a Cognita user asks for a terminal, Cognita creates a GitHub
Codespace **in that user's own GitHub account** from this repository. It is billed
to the user's own Codespaces allowance, never to Cognita.

## What runs in the Codespace
`.devcontainer/cognita-agent.py` starts when the Codespace starts. It listens on
port 8787 and runs a shell command only when the request carries a GitHub token
that GitHub confirms belongs to the owner of this Codespace. Read the file: it is
one short, standard-library-only Python script.

- Commands run in a fresh login shell, one at a time, with a time limit (default 60s, max 120s).
- Any environment variable with "TOKEN" in its name is removed for commands, so
  the Codespace's own GitHub token is not visible to what runs.
- Do not change port 8787 to **Public** in the Ports tab. It works while Public
  (the helper still checks the token), but there is no reason to widen it.
- Interactive programs that wait for typed input will not work. Background jobs
  must redirect their output (`cmd > /dev/null 2>&1 &`) or the command will wait
  for them until the time limit.

## For the Cognita maintainer: publishing this template
1. Create a **public** repository, for example `Cognita-Dev/cognita-terminal`.
2. Put the contents of this folder in its root (so `.devcontainer/` is at the top level).
3. If you used a different name, set the Worker variable `TERMINAL_TEMPLATE_REPO`
   to `owner/repo`. The default is `Cognita-Dev/cognita-terminal`.
4. Test once with your own account: connect GitHub in Cognita, ask for a cloud
   terminal, confirm, then ask it to run `echo hello`.
