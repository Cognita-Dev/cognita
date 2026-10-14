# Cloud terminals (Google Cloud Shell + GitHub Codespaces) and Canva removal

## What users get
- **Cloud terminal that Cognita can run commands in (GitHub Codespaces).** The user connects
  their own GitHub. Cognita creates a Codespace in THEIR account from a small public template
  repo (`/terminal-agent`), then runs commands in it when the user confirms each one.
  Tools: `codespaces_create_terminal`, `codespaces_terminal_status`, `codespaces_run_command`,
  plus `codespaces_list / start / stop / open_terminal / create`.
- **Google Cloud Shell (separate connection).** Cognita can check and start the user's own Cloud
  Shell and give them a link to its terminal. It cannot run commands there (Google has no way
  to expose a port or run a command remotely). Tools: `cloudshell_get_environment`,
  `cloudshell_start`, `cloudshell_open_terminal`.
- Canva is removed everywhere.

## Cost: Cognita pays $0
Everything is called with the USER's own token, so Codespaces and Cloud Shell are created in
and billed to the user's own allowance. Enforced, not assumed: right after a Codespace is
created, Cognita checks GitHub's `billable_owner`; if it is anyone but the user, the
Codespace is deleted again and the request fails. Cognita's only cost is ordinary Worker
requests. New terminals stop after 30 idle minutes and are deleted after 3 unused days.

## How commands reach the Codespace
Cognita -> `https://<codespace>-8787.app.github.dev/exec` (HTTPS, user's token) -> helper
`cognita-agent.py` running inside the Codespace. Two independent locks: GitHub's private-port
check, and the helper itself asking GitHub "does this token own this codespace?" before running
anything. Commands run with all `*TOKEN*` environment variables removed, one at a time, with a
time limit (default 60s, max 120s), output capped.

## Things you must do (not doable from code)
1. **Publish the template repo.** Create a PUBLIC GitHub repo (default name
   `Cognita-Dev/cognita-terminal`) and put the contents of `terminal-agent/` at its root
   (`.devcontainer/` at the top level). Different name? Set the Worker variable
   `TERMINAL_TEMPLATE_REPO=owner/repo`.
2. **Google Cloud Console** (project that owns GOOGLE_CLIENT_ID), for Cloud Shell only: enable
   the Cloud Shell API; add redirect URI `https://api.cognita.com.ng/auth/cloudshell/callback`
   (or your WORKER_ORIGIN); add the `cloud-platform` scope to the consent screen and check how
   Google classifies it for verification.
3. **GitHub OAuth app:** nothing to change. The `codespace` scope is requested at connect time.
   Existing GitHub users keep all other GitHub tools and reconnect only when they first use
   Codespaces.
4. Remove old secrets: `wrangler secret delete CANVA_CLIENT_ID` and `CANVA_CLIENT_SECRET`.
5. Delete `canva-tools.js` and `assets/canva-icon-logo.svg` from the repo (a zip cannot delete).
6. Update `privacy.html` and `terms.html` (not touched). They still describe Canva and say
   nothing about Cloud Shell, the Codespaces permission, or running commands in a user's
   Codespace.
7. Redeploy the Worker and the frontend.

## NOT verified against the live services (no credentials here). Test these first
- That GitHub's port forwarding accepts the user's Cognita login token in the `X-Github-Token`
  header. GitHub's docs describe that header with the Codespace's own token. If the call never
  gets through, `codespaces_terminal_status` reports "not answering yet" and nothing runs.
- That port 8787 is forwarded while nobody has the Codespace open in a browser. If it is not,
  the user opens the Codespace link once; the tools say so.
- That traffic to the port keeps a Codespace awake. If not, it may stop while idle and needs
  `codespaces_start`.

Smoke test (5 minutes, your own account): connect GitHub in Cognita, ask for a cloud terminal,
confirm, wait for it, then ask Cognita to run `echo hello`.

## Tested here
Syntax on every changed file; the tool registry loads with all new tools and no duplicates; and
18 end-to-end checks of the helper (run as a real process) driven by the real tool code against
a fake GitHub: correct request, limits, billing guard, missing scope, stopped/foreign codespace,
stdout/stderr/exit codes, working folder carry-over, hidden tokens, timeout kill, output cap,
bad folder, one-at-a-time, wrong-token refusal, sign-in redirect, empty command.

## Files
New: `codespaces-tools.js`, `cloudshell-tools.js`, `terminal-agent/` (3 files), this file.
Deleted: `canva-tools.js`, `assets/canva-icon-logo.svg`.
Changed: `connectors.js`, `connector-providers.js`, `connector-tools.js`, `github-tools.js`,
`confirmation.js`, `account-deletion.js`, `prompts.js`, `worker.js`, `entitlements.js`,
`providers.js`, `index.html`, `app.html`, `js/account.js`, `js/app.js`, `.vercelignore`.
