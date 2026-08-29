# Artifact Share CLI

Copyright © TechTalk, Inc.

The official CLI to open, share, and update files, folders, and static sites on [Artifact Share](https://artifactshare.com) from terminals, AI agents, and automation. Share HTML, Markdown, and exported sites to stable URLs, update existing files, and emit `--json` for scripts and agents.

Artifact Share hosts AI-built reports, documents, and static sites so you can share them with teammates and clients. This CLI shares a single file or a whole folder (HTML, Markdown, exported SPAs, images included), updates versions, opens shared URLs for agents, reads content and comments back, and works the same for humans, terminal agents (Claude Code, Codex, Cursor Agent), and automation.

## Quick start

Requires Node.js 22 or later.

```sh
npx --yes @artifactshare/cli share ./report.html
```

`--yes` lets agents and CI fetch the package without stopping for an npx install prompt.

On the first run in an interactive terminal, the CLI prints a sign-in link — open it in your browser, and the share completes and prints the share URL. Folders work too:

```sh
npx --yes @artifactshare/cli open <artifact-id-or-url> --json
npx --yes @artifactshare/cli share ./dist --project 'Weekly Reports'
npx --yes @artifactshare/cli projects create 'Client reports' --json
npx --yes @artifactshare/cli projects edit <id> --add-email viewer@example.com --json
npx --yes @artifactshare/cli edit <artifact-id-or-url> --project-id <id> --json
npx --yes @artifactshare/cli edit <artifact-id-or-url> --visibility private --grant-email viewer@example.com --json
npx --yes @artifactshare/cli share ./report.html --visibility link --link-expires-at '2026-08-01T00:00:00Z' --json
npx --yes @artifactshare/cli edit <artifact-id-or-url> --visibility link --no-link-expiry --json
npx --yes @artifactshare/cli update <artifact-id-or-url> ./dist
npx --yes @artifactshare/cli append <artifact-id-or-url> ./new-section.md
npx --yes @artifactshare/cli delete <artifact-id-or-url> --json
npx --yes @artifactshare/cli logout --profile default --json
npx --yes @artifactshare/cli config set home_audience private --scope user --json
npx --yes @artifactshare/cli config get home_audience --scope effective --json
```

To keep an existing share URL, update it with
`npx --yes @artifactshare/cli update <artifact-id-or-url> <path>` instead of
sharing again. For CI, scheduled reports, or other repeat jobs, use
`share <path> --key <key>`: the first run creates the shared file, and later
runs add versions to the same file.

## Authentication

- **Interactive person**: run `npx --yes @artifactshare/cli login`.
- **Attended local agent**: use `login --preset agent` on the user's own machine to authorize one project. Add `--project <exact-name-or-id>` to make the browser confirm that fixed project; omit it to use the project picker. Device-login profiles renew expired CLI sessions automatically during normal use, and `login` / `whoami` distinguish the session expiry from the rotating refresh-credential expiry.
- **CI / non-interactive**: issue a token at `https://artifactshare.com/settings/tokens`, then inject `ARTIFACTSHARE_TOKEN` (or pass `--token`). Without a token, non-interactive runs fail with `error.code: "auth_required"` instead of hanging.
- **Shared agent platform**: use a workspace-managed bot credential in a trusted host service outside the model sandbox. Do not store a user's device-login profile or expose the bot credential to model shell commands.

Running `share`, `update`, or `download` directly also starts interactive sign-in when unauthenticated (the CLI prints a link and code to open in your browser).

- Multiple accounts: keep one local profile per account (`profiles list` / `profiles use <name>`). In non-interactive agents, pipe an issued token into `profiles import-token --profile <name> --json` to create a saved API-token profile without browser login; API-token profiles are not renewed by the CLI. Workspace-issued bot tokens (`asb_` prefix) are imported the same way: the CLI detects the prefix, performs the first rotating refresh (which consumes the displayed token), and stores the rotated credential; replacing an existing profile credential with a bot token requires `--force` (a no-op for API tokens), and a rejected bot token reports `bot_token_invalid` (recovery is an admin reissue). Use `logout --profile <name>` to revoke a device-login credential before removing it locally while keeping profile metadata, or `profiles delete <name>` to remove the profile entry too. API-token profiles are only removed locally.

Successful `share --json` output may include `data.warnings`. Surface each
warning to the user. `slack_reauthorization_required` means the destination
project's Slack channel must be reauthorized.

## Commands

| Command                                                            | What it does                                                                                                                                                              |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open <target>`                                                    | First command for agents opening a shared URL; ensures skills, then reads or suggests download                                                                            |
| `share <path>`                                                     | Share a file or folder as a new shared file (`--project`, `--home`, `--visibility`, `--key`, link expiry options)                                                         |
| `update <target> <path>`                                           | Add a new version to an existing file (ID or share URL)                                                                                                                   |
| `append <target> <path>`                                           | Append a non-empty UTF-8 file without a separator: at Markdown source end or before `</body>` in HTML, falling back to source end                                         |
| `edit <target>`                                                    | Change title, sharing, link expiry, explicit viewers, or project placement                                                                                                |
| `delete <target>`                                                  | Permanently delete a file you shared                                                                                                                                      |
| `resolve <value>`                                                  | Find files by URL, ID, title, or project name                                                                                                                             |
| `artifacts get <target>`                                           | Read a file's content and metadata back                                                                                                                                   |
| `download <target>`                                                | Save a file or a whole static site locally                                                                                                                                |
| `comments list / post / edit / resolve / reopen / delete <target>` | Read, write, edit, resolve, reopen, and permanently delete comments                                                                                                       |
| `projects list / create / edit`                                    | List, create, and edit project destinations and audience                                                                                                                  |
| `move <target>`                                                    | Move an existing file into a project or back home; `edit` is preferred for new automation                                                                                 |
| `preview <file>` (alias of `preview start`)                        | Serve a local Markdown or HTML file with the product viewer look for browser annotation; local only, no sign-in, nothing uploaded                                         |
| `preview next` / `preview done` / `preview reply` / `preview stop` | Agent loop for a live preview: poll submitted annotation batches, report fixed/skipped outcomes from stdin, reply into a thread, and stop the session                     |
| `login` / `logout` / `whoami`                                      | Sign in, revoke a device-login credential before removing it locally, and check who you are                                                                               |
| `doctor`                                                           | Diagnose token storage, auth, destination, network, and upload readiness — tells you the next command to run                                                              |
| `changelog`                                                        | Show the installed version, this release's notes, and the public updates page                                                                                             |
| `profiles list / use / import-token / delete`                      | Switch between local account profiles, import an issued token from stdin, and delete profile entries                                                                      |
| `init`                                                             | Set up this directory: detect Claude Code, Codex, or Cursor and install the skill in user scope, then show next steps; or save defaults with `--profile` / `--project-id` |
| `skills ensure / install / list / update / remove`                 | Install or update the bundled usage guide in your AI agent's skills                                                                                                       |

Public command paths covered by this reference:

`append`, `artifacts`, `artifacts get`, `artifacts list`, `changelog`, `comments`, `comments delete`, `comments edit`, `comments list`, `comments post`, `comments reopen`, `comments resolve`, `config`, `config get`, `config set`, `config unset`, `delete`, `doctor`, `download`, `edit`, `init`, `login`, `logout`, `move`, `open`, `preview`, `preview done`, `preview next`, `preview reply`, `preview start`, `preview stop`, `profiles`, `profiles delete`, `profiles import-token`, `profiles list`, `profiles use`, `projects`, `projects create`, `projects edit`, `projects list`, `resolve`, `share`, `skills`, `skills ensure`, `skills install`, `skills list`, `skills remove`, `skills update`, `update`, `whoami`.

Saved credentials use macOS Keychain, Linux Secret Service, or Windows
Credential Manager. If no native store is available, the explicit
`--allow-plaintext-token-store` fallback writes under the resolved user config
directory with mode `0600` on POSIX systems. It is unavailable on Windows,
where saved profiles require Credential Manager. Run `doctor --json` to inspect
the resolved config home, available native store, and plaintext credential
count.

## Local preview and annotation

`preview <file>` serves one local `.md` or `.html` file at a `127.0.0.1` URL
with the same rendering as the product viewer. It is a local feature: it works
without signing in, and previewing uploads nothing. In the browser, you select
an element or a text range, write a note, and send your notes to the agent as
one explicit batch. Saving the file reloads the page.

```sh
npx --yes @artifactshare/cli preview ./report.html
npx --yes @artifactshare/cli preview next ./report.html --wait 90
npx --yes @artifactshare/cli preview stop ./report.html
```

The first command prints one ready JSON line (`url`, `session`,
`share_origin`, `reused`, and a sanitized `agent` notification projection) and keeps serving; pass `--no-open` to skip opening
the browser. The agent collects submitted batches with `preview next`
(long-polling with `--wait <sec>`; `timed_out` and `session_ended` are normal
results, while `preview_session_not_found` means no session is live), fixes
the file, and reports outcomes by piping
`{"items":[{"thread":...,"generation":...,"outcome":"fixed"|"skipped","note":...}]}`
into `preview done --stdin`. Reporting is idempotent per thread generation.
Only one long-poll may reserve a preview session at a time. Submitted comments
stay in the local mode-`0600` store when notification fails or no waiter is
connected, and a later `preview next` retrieves the same batch. Provider
notifications carry only the event kind, preview session id, and batch id;
comment text and anchors are read through `preview next` instead.
`preview reply --thread <id> --body <text>` adds a reply without changing
thread state, and `preview stop` ends the session while keeping annotations
saved on disk. Sharing a snapshot happens only from the page's own share
dialog, and local annotations are not included in what is shared.

## Where shared files are delivered

Posting to a project delivers to the audience defined by that project. With no destination, `share` posts to home. Choose the home audience by purpose:

```sh
npx --yes @artifactshare/cli config set home_audience private --scope user --json
npx --yes @artifactshare/cli config set home_audience workspace --scope repository --json
npx --yes @artifactshare/cli share ./report.html --visibility private --json
npx --yes @artifactshare/cli config get home_audience --scope effective --json
```

Use `--scope repository` only for a policy agreed by all repository participants, and pass `--visibility private|workspace|link` for a one-time home override. For link sharing, pass exactly one of `--link-expires-at <RFC3339 UTC>` or `--no-link-expiry`; omit both to use the workspace default. For project creation, pass `projects create <name> --visibility private|workspace`; persistent project defaults are documented in `projects create --help`. Pass `--no-slack-notify` to suppress the project Slack notification for one post.

Link sharing is available on Plus and Team. A workspace policy may allow a finite expiry from 1 to 365 days or no expiration; the initial default is 30 days and the initial maximum is 90 days. Share and edit results include the confirmed `link_expires_at` UTC timestamp or `null`. If a link command fails, use `link_sharing_plan_required` to explain the plan limit, `link_sharing_disabled` to ask a Team owner or admin to enable the workspace setting, or `link_expiry_invalid` to correct the timestamp or choose `--no-link-expiry` when allowed. Follow `error.recovery` instead of retrying unchanged input.

For the complete settings reference, `home_audience` is the canonical home key. `default_artifact_visibility` remains a compatibility alias, and `default_project_visibility` is the advanced default for `projects create`. User and repository settings are resolved with repository taking precedence, followed by user and product default `workspace`; home also checks the compatibility alias at each scope. Use `config get home_audience --scope effective --json` to confirm the resolved audience. Keyless `config get --json` returns only `home_audience`; pass an explicit key to read either other setting. These settings only affect new home posts and project creation; update, edit, Web, and MCP defaults are unchanged.

## For AI agents

For first-time setup in a project, start here:

```sh
npx --yes @artifactshare/cli init --json
```

`init` detects Claude Code, Codex, or Cursor in the working directory, installs or updates the bundled skill in user scope, and reports the next steps (sign in, then share). With no agent detected, it installs user-scope Codex, Claude Code, and Cursor skills. Cursor project scope is not auto-installed; use `skills install --tool cursor --scope project`. Existing project-scope skills are not modified. Add `--dry-run` to preview without writing.

When an agent receives an Artifact Share URL instead, start with `open`:

```sh
npx --yes @artifactshare/cli open <artifact-id-or-url> --json
```

This installs or updates the local skill first, then reads single-file artifacts. Static sites and multi-file artifacts return a `download` next command.

To target a specific tool manually, use `skills install --tool <codex|claude|cursor> [--scope project|user]`; project scope is opt-in for team commits. `skills ensure --tool auto` is the same user-scope detection `init` and `open` use (omit `--scope` or pass `--scope user`; `--scope project` fails). Regular successful commands also update outdated managed user-scope Codex, Claude Code, and Cursor skills when they are already installed, but do not create a missing Cursor user-scope skill.

Comment deletion is permanent. Use `comments delete <target> --thread-id <id> --message-id <id> --json` for one message, or omit `--message-id` only when deleting the whole thread.

All commands emit stable JSON when run non-interactively, piped, or with `--json`: success on stdout as `{ "schema_version": 2, "ok": true, "command": ..., "data": ... }`, failures on stderr as `{ "schema_version": 2, "ok": false, "command": ..., "error": ... }` with exit code 1. The `error` object carries a machine-readable `code`, a `hint`, and a structured `recovery` field (for example `{ "kind": "run_command", ... }`), so agents and scripts can branch and recover without parsing prose.

```sh
npx --yes @artifactshare/cli share ./dist --json
```

Quote paths and free-form text before passing them through a shell. Artifact Share route files and user files can contain `$`, spaces, or glob characters, so prefer single quotes such as `'apps/web/app/routes/a.$id/index.tsx'` and `--body 'Looks good'`.

## Links

- Setup guide for AI tools and terminals: https://artifactshare.com/connect
- Public updates (Web, CLI, Agent, MCP): https://artifactshare.com/updates
- Artifact Share: https://artifactshare.com

## License

The npm package through version 0.9.0 is licensed under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0). From version 0.10.0 onward, `@artifactshare/cli` is covered by the [source-available license](LICENSE). Version 0.10.0 was intentionally not published; version 0.10.1 is the first npm release under the new license.
