---
name: artifactshare
description: Share, publish, upload, host, update, open, or read back existing files and Artifact Share URLs; or show a local file in the browser for review before sharing. Use when the user wants a browser link for an HTML/Markdown report, folder, static site, or generated file; wants to update the same URL; wants to look at, check, preview, or comment on a file you just generated before it is shared; says Artifact Share, artifactshare, or contextual "as"; or asks to read comments from a shared URL.
---

<!-- artifactshare-skill
version: 37
managed: true
-->

# Artifact Share CLI

Artifact Share is for the last step after a file already exists: share,
publish, upload, or host HTML pages, Markdown documents, folders, and static
sites; return a browser link; update the same URL; open or read back an
Artifact Share URL; and read or post comments. The CLI is designed for agents:
every command supports `--json` with a stable contract.

Use this skill for Artifact Share, artifactshare, and contextual "as" requests.
Japanese requests such as `as でアップして` or `as に上げて` are strong
Artifact Share intents. In English, treat "as" as a user shorthand only when
the surrounding request is about sharing, publishing, updating, opening, or
reading a shared URL; bare English "as" alone is not an Artifact Share trigger.

Do not use this skill just because the user says "artifact". Claude Artifact is
for creating or designing an artifact inside the chat. Artifact Share is for
sharing, updating, opening, or reading back existing files, folders, static
sites, and Artifact Share URLs.

Run commands with `npm exec --yes --package=@artifactshare/cli -- artifactshare`. When unsure about a
command or flag, run `npm exec --yes --package=@artifactshare/cli -- artifactshare <command> --help` first.

Honor an explicit user request to use CLI or MCP before selecting the default
below. Use the CLI when a coding agent can access a user-controlled workspace,
install the CLI package, and reach Artifact Share, even when MCP tools are also
available. Use remote MCP for source text in chat or a temporary sandbox when
CLI network access is unavailable or uncertain; a temporary file alone is not
enough to try `npm exec`. MCP OAuth is not CLI authentication: follow the CLI
`auth_required` recovery for first setup, then reuse the saved CLI profile.

When passing paths or free-form text through a shell, quote them. Paths may
contain `$`, spaces, `*`, or `?`; use single quotes such as
`'apps/web/app/routes/a.$id/index.tsx'` so the shell does not expand them.

## Quick reference

| Task                     | Command                                                                   |
| ------------------------ | ------------------------------------------------------------------------- |
| Share a file or folder   | `share <path> --json`                                                     |
| Share a link with expiry | `share <path> --visibility link --link-expires-at '<RFC3339 UTC>' --json` |
| Replace with same URL    | `update <target> <path> --json`                                           |
| Append to same URL       | `append <target> <path> --json`                                           |
| Read back source         | `artifacts get <target> --json`                                           |
| Download a site bundle   | `download <target> --output ./out --json`                                 |
| Download a whole project | `download --project-id <id> --output ./out --json`                        |
| List your artifacts      | `artifacts list --json`                                                   |
| Post a comment           | `comments post <target> --body '<text>' --json`                           |
| Read comments            | `comments list <target> --json`                                           |
| Change title or sharing  | `edit <target> --title 'New' --json`                                      |
| Move to a project        | `edit <target> --project-id <id> --json`                                  |
| Create a project         | `projects create 'Name' --json`                                           |
| Find an ID from a title  | `resolve <value> --json`                                                  |
| Open a share URL         | `open <url> --json`                                                       |
| Preview a local file     | `preview <file> --json` (local, no sign-in)                               |
| Log out                  | `logout --profile <name> --json`                                          |

## Authentication

- `login --profile <name> --preset agent --json` is for an attended coding
  agent on the user's own machine. It creates a project-scoped profile and may
  open the OS browser. Add `--project <exact-name-or-id>` to confirm one fixed
  eligible project; omit it to select a project in the browser. Omit `--preset`
  for unrestricted personal login. The pending event on stderr includes
  `browser_open`. Do not pass tokens to `login`. Device-login profiles renew
  expired CLI sessions automatically.
- In unattended CI or scripts without browser approval, ask the user to issue
  an API token at `https://artifactshare.com/settings/tokens`, then inject it
  with `ARTIFACTSHARE_TOKEN` or `--token`. A shared agent platform uses a
  workspace-managed bot credential in a trusted host service outside the model
  sandbox; never expose it to model shell commands.
- `logout --profile <name> --json` revokes a device-login refresh credential
  before removing it locally and leaves profile metadata in `config.json`.
  If remote revoke fails, the local credential is kept and logout fails.
  API-token profiles are removed locally only and are not revoked on the server.
- To keep using an issued token as a named profile without TTY or browser
  login, pipe it on standard input:
  `printf '%s' "$TOKEN" | npm exec --yes --package=@artifactshare/cli -- artifactshare profiles import-token --profile <name> --json`.
  Bot tokens (`asb_` prefix, issued by a workspace admin) use the same command; the first
  refresh consumes the displayed token, overwriting an existing profile credential requires
  `--force`, and a revoked or superseded bot token fails with `bot_token_invalid` (ask the
  admin to reissue).
  Imported API-token profiles are not renewed by the CLI.
  Use `--allow-plaintext-token-store` only on a trusted machine without a native token store.
  That fallback is mode `0600` on POSIX and unavailable on Windows, where saved profiles require Credential Manager.
- Check the current state with `whoami --json`, or `doctor --json` for token
  storage, authentication, destination, network, upload access, and skill update status.

## Share

Use `share` for new files. Use `update` to replace an existing artifact. Use
`append` to add a non-empty UTF-8 file exactly as-is to a single-file artifact;
Markdown is appended at source end, while HTML is inserted before an ASCII
case-insensitive `</body>` when present, or at source end otherwise. It adds no
newline or separator and does not support sites.

```bash
npm exec --yes --package=@artifactshare/cli -- artifactshare share ./report.html --json
npm exec --yes --package=@artifactshare/cli -- artifactshare share ./site-dir --project-id <id> --json
```

- `share` accepts a single `.html` / `.md` file or a static-site directory.
  If a successful result contains `data.warnings`, tell the user each warning
  explicitly. `slack_reauthorization_required` means project Slack
  notifications are not being delivered until the channel is reauthorized.
  In JSON output, give the user `data.artifact.url`; the artifact ID is
  `data.artifact.id`.
  Do not rerun `share` just to inspect the JSON shape: without `--key`, each
  successful run creates a new artifact.
- Pick the destination with `--project-id <id>`, `--project <name>` (by exact
  name, no prior `resolve` needed), the saved default from `init`, or `--home`.
  Posting to a project delivers to the audience defined by that project.
  Without any destination it posts to home.
- Choose `home_audience` by purpose: use `config set home_audience private
--scope user --json` for a personal safe default in this CLI environment,
  use `--scope repository` only for a policy agreed by all participants, and
  use `--visibility private|workspace|link` for one home post.
- Confirm the resolved home audience before posting with
  `config get home_audience --scope effective --json`.
- Set visibility at share time with `--visibility private|workspace|project|link`.
  This is a per-post override; `--grant-email` does not change the resolved
  default visibility.
- For link sharing, pass exactly one of `--link-expires-at <RFC3339 UTC>` or
  `--no-link-expiry`. Omit both to use the workspace default.
- Pass `--no-slack-notify` only when the user explicitly does not want the
  project Slack notification for this post.
- A workspace policy may allow a finite expiry from 1 to 365 days or unlimited
  expiry. The initial default is 30 days and the initial maximum is 90 days.
  `link_expires_at` in the result is the confirmed UTC timestamp or `null`.
- For repeat jobs with a stable caller-owned name, use
  `share <path> --key <key> --json`: the first run creates the artifact, later
  runs add versions to the same artifact.
- Run `share --help` for all flags.

## Audience and visibility settings

Posting to a project delivers to the audience defined by that project. Without
a destination, `share` posts to home. Choose the home audience by purpose:

```bash
npm exec --yes --package=@artifactshare/cli -- artifactshare config set home_audience private --scope user --json
npm exec --yes --package=@artifactshare/cli -- artifactshare config set home_audience workspace --scope repository --json
npm exec --yes --package=@artifactshare/cli -- artifactshare share ./report.html --visibility private --json
npm exec --yes --package=@artifactshare/cli -- artifactshare config get home_audience --scope effective --json
```

Use the user scope for a personal safe default in this CLI environment, the
repository scope only for a policy agreed by all participants, and
`--visibility` for a one-time audience.

Use `--visibility private|workspace|project|link` as a per-post override. For new
projects, pass `projects create --visibility private|workspace`; persistent
project defaults are documented in `projects create --help`.

The complete `config --help` reference covers user and repository scopes,
effective resolution, and the canonical `home_audience` key. The old
`default_artifact_visibility` remains a compatibility alias, while
`default_project_visibility` is the advanced `projects create` default. Home
resolution checks repository then user settings (including the alias at each
scope), then product default `workspace`; project defaults use repository,
user, then `workspace`. Keyless `config get --json` returns only
`home_audience`; pass an explicit key for either other setting. These settings
only affect new home posts and project creation; update, edit, Web, and MCP
defaults are unchanged.

## Update

Use `update` to add a new version to an existing artifact while keeping its URL.

```bash
npm exec --yes --package=@artifactshare/cli -- artifactshare update <artifact-id-or-url> ./report.html --json
```

- Pass `--expected-version <version-id>` to reject an update when another
  version became current first. Project-scoped agent profiles must pass it.
  Repeat `share --key` updates accept the same option; initial creation does
  not require it.

- To keep an existing share URL, do not run `share --artifact-id`; use `update`.
- Pass the same kind of input (single file vs directory) it was created with.
- `update` does not change title, visibility, viewers, or placement. Use `edit`
  for those.
- Run `update --help` for all flags.

## Read back and download

Use `artifacts get` for single-file sources. Use `download` for static sites.

```bash
npm exec --yes --package=@artifactshare/cli -- artifactshare artifacts get <artifact-id-or-url> --json
npm exec --yes --package=@artifactshare/cli -- artifactshare artifacts get <artifact-id-or-url> --include versions --include comments --json
npm exec --yes --package=@artifactshare/cli -- artifactshare download <artifact-id-or-url> --output ./out --json
npm exec --yes --package=@artifactshare/cli -- artifactshare download --project-id <id> --output ./out --json
```

- In the successful JSON response, read the source from `data.content` and the current version from `data.version_id`.
- If `artifacts get` returns `truncated: true`, call again with `--offset` set
  to `next_offset`.
- `--include versions` and `--include comments` fetch version history or
  inline comments in one call.
- `download` saves static-site bundles. Pass `--force` to overwrite an existing
  output directory.
- To fetch every document in a project (for example to feed a whole project
  into an editor as context), run
  `download --project-id <id> --output <dir> --json`. It saves each artifact
  under `<dir>/<artifactId>/` and writes `<dir>/index.json` mapping ids to
  titles, owners, and statuses. The listing covers all artifacts you can view
  in the project, including ones uploaded by other members; `spa` and
  `workspace_app` artifacts are skipped. Pass `--force` to replace previously
  downloaded artifact directories. A partial failure prints `ok: true` with
  the failure list on stdout and exits 1 — check both `index.json` and the
  exit code. Re-running against the same `<dir>` is an incremental sync:
  artifacts whose version is unchanged are reported as `unchanged` and not
  fetched again.
- Find artifact IDs with `artifacts list --json`. Filter with `--project-id`,
  `--home`, or `--query <text>`. With `--project-id`, the list includes other
  members' artifacts you can view (with `owner_email`); when `has_more` is
  true, continue with `--cursor <next_cursor>`.
- When the user gives a title, project name, or URL instead of an ID, run
  `resolve <value> --json` first and use the returned ID.
- Run `artifacts get --help` or `download --help` for all flags.

## Comment

Use `comments list` to read, `comments post` to write. IDs from `list` feed
into `edit`, `resolve`, `reopen`, and `delete`.

```bash
npm exec --yes --package=@artifactshare/cli -- artifactshare comments list <artifact-id-or-url> --json
npm exec --yes --package=@artifactshare/cli -- artifactshare comments post <artifact-id-or-url> --body '<text>' --json
npm exec --yes --package=@artifactshare/cli -- artifactshare comments post <artifact-id-or-url> --body '<text>' --reply-to <thread-id> --json
npm exec --yes --package=@artifactshare/cli -- artifactshare comments post <artifact-id-or-url> --body '<text>' --quote 'exact text' --json
npm exec --yes --package=@artifactshare/cli -- artifactshare comments post <artifact-id-or-url> --body '<text>' --agent 'Claude' --json
```

- `--reply-to <thread-id>` replies to an existing thread from `comments list`.
- `--quote <text>` anchors a new thread to the quoted text. Copy the text from
  `artifacts get` so it matches exactly. When the same text appears more than
  once, add `--quote-before` and/or `--quote-after` to pick the right one.
  Do not combine `--quote` with `--reply-to`.
- `--agent <name>` declares the posting agent (e.g. `Claude`, `Cursor`).
  The comment shows an agent badge in the viewer. Omit to post without a badge.
  `comments list` returns an `agent` field on messages posted with this flag.

```bash
npm exec --yes --package=@artifactshare/cli -- artifactshare comments edit <artifact-id-or-url> --message-id <id> --body '<text>' --json
npm exec --yes --package=@artifactshare/cli -- artifactshare comments resolve <artifact-id-or-url> --thread-id <id> --json
npm exec --yes --package=@artifactshare/cli -- artifactshare comments reopen <artifact-id-or-url> --thread-id <id> --json
npm exec --yes --package=@artifactshare/cli -- artifactshare comments delete <artifact-id-or-url> --thread-id <id> --message-id <id> --json
```

- Comment deletion cannot be undone. Omit `--message-id` only when the user
  wants the whole thread deleted.
- Run `comments post --help` for all flags.

## Organize and settings

Use `edit` for post-share changes. Use `projects list/create/edit` for
project management.

```bash
npm exec --yes --package=@artifactshare/cli -- artifactshare edit <artifact-id-or-url> --title 'New title' --json
npm exec --yes --package=@artifactshare/cli -- artifactshare edit <artifact-id-or-url> --visibility private --grant-email viewer@example.com --json
npm exec --yes --package=@artifactshare/cli -- artifactshare edit <artifact-id-or-url> --project-id <id> --json
npm exec --yes --package=@artifactshare/cli -- artifactshare edit <artifact-id-or-url> --home --json
npm exec --yes --package=@artifactshare/cli -- artifactshare delete <artifact-id-or-url> --json
```

- `edit` changes title, visibility, explicit viewers, or project placement
  without adding a new version.
- Set `--visibility link` with `--link-expires-at <RFC3339 UTC>` for a finite
  expiry or `--no-link-expiry` for unlimited expiry. The expiry options are
  mutually exclusive; omit both to preserve an existing link expiry.
- If `edit` changes visibility away from `link`, the link expiry is cleared.
  If a link operation fails, do not retry unchanged input: use
  `link_sharing_plan_required` to report that Plus or Team is required,
  `link_sharing_disabled` to ask a Team owner or admin to enable link sharing,
  or `link_expiry_invalid` to pass a future RFC3339 UTC timestamp within policy
  (or use `--no-link-expiry` when the policy allows it).
- Moving a `project` visibility artifact home makes it `private`, because home
  has no project audience.
- The older `move` command remains available for placement-only automation, but
  prefer `edit` for new flows.
- `delete` permanently removes an artifact and its version history. Use only
  when the user explicitly asks.

```bash
npm exec --yes --package=@artifactshare/cli -- artifactshare projects list --json
npm exec --yes --package=@artifactshare/cli -- artifactshare projects create 'Client reports' --json
npm exec --yes --package=@artifactshare/cli -- artifactshare projects create 'Internal' --visibility private --json
npm exec --yes --package=@artifactshare/cli -- artifactshare projects edit <id> --add-email viewer@example.com --json
npm exec --yes --package=@artifactshare/cli -- artifactshare projects edit <id> --archive --json
```

- `projects create` uses `default_project_visibility` when saved, otherwise
  `workspace`. Pass `--visibility private` for a confidential project.
- `projects edit` changes name, description, visibility, audience
  (`--add-email` / `--remove-email`), and archive state (`--archive` /
  `--unarchive`).
- `init --project-id <id> --json` saves a default project for the working
  directory. `init --dry-run --json` previews the setup without side effects.
- Run `edit --help`, `projects create --help`, or `projects edit --help` for
  all flags.

## Profiles

```bash
npm exec --yes --package=@artifactshare/cli -- artifactshare profiles list --json
npm exec --yes --package=@artifactshare/cli -- artifactshare profiles use <name> --json
npm exec --yes --package=@artifactshare/cli -- artifactshare profiles delete <name> --json
```

- `profiles list` shows saved profiles and the default.
- `profiles use` switches the default profile.
- `profiles delete` removes the profile entry and its saved credential. Use
  `logout --profile <name>` when you only want to remove the credential.
- To create a profile, use `login --profile <name>` (interactive) or
  `profiles import-token` (non-interactive, see Authentication).

## Skills

```bash
npm exec --yes --package=@artifactshare/cli -- artifactshare skills ensure --tool auto --json
npm exec --yes --package=@artifactshare/cli -- artifactshare skills update --json
npm exec --yes --package=@artifactshare/cli -- artifactshare skills list --json
```

- `open`, flag-less `init`, and `skills ensure --tool auto` detect Claude Code,
  Codex, or Cursor in the working directory and install or update this skill in
  user scope (`~/.claude/skills/`, `~/.agents/skills/`, or
  `~/.cursor/skills/artifactshare/SKILL.md`). With no agent detected,
  user-scope Codex, Claude Code, and Cursor skills are prepared.
- Cursor project scope is not auto-installed. Install the Cursor rule explicitly
  with `skills install --tool cursor --scope project`.
- Use `skills install --tool cursor --scope user` to install or manage the
  Cursor user-scope skill explicitly.
- `skills ensure --tool auto` accepts omitted `--scope` or `--scope user`;
  `--scope project` fails with `validation_failed`. Project-scope skills are
  opt-in via `skills install --tool <tool> --scope project`.
- `skills update` updates installed managed skills to the bundled version.
- `--force` overwrites an unmanaged file on install.
- Run `skills --help` for all subcommands.

## Preview (local annotate-and-fix loop)

`preview` is a local, unauthenticated feature: it serves one local `.md` or
`.html` file with the same rendering as the product viewer, the user annotates
elements or text selections in the browser and submits them as an explicit
batch, and the agent fixes the file. Nothing is uploaded by previewing;
an upload happens only if the user opens the share dialog from the page.

### Start and own one preview

`preview` starts a long-lived local service; process exit is not its success
condition. Start it once for the file using the environment's supported
long-running or background process mechanism. Keep that process or task handle
for the lifetime of the preview.

```bash
npm exec --yes --package=@artifactshare/cli -- artifactshare preview ./lp.html
npm exec --yes --package=@artifactshare/cli -- artifactshare preview start ./lp.html --no-open
```

- Run the CLI invocation itself as the long-running task. Do not add shell
  pipelines, redirections, command substitutions, or wrappers that wait for
  output or process exit; output capture managed by the agent's background-task
  tool is part of that tool's contract. Extra shell layers change ownership and
  the service's output contract.
- Bare `preview <file>` is rewritten to `preview start <file>`. Start prints
  exactly one ready JSON line with `url`, `session`, `share_origin`, `reused`,
  and a sanitized `agent` notification projection, then keeps serving.
  `--no-open` skips opening the browser.
- The ready JSON is the startup handshake. A background task id or running PID
  only proves that launch began. Treat the preview as ready, retain its `url`
  and `session`, and tell the user it opened only after reading that line.
- `session` is generated by start. Use the returned value only with
  `preview next`, `done`, `reply`, or `stop`; do not pass `--session` to start.
- After one launch begins, do not launch another copy until that attempt either
  returns a CLI failure or exits without a ready line. If the task is still
  running but its ready output cannot be read, the state is indeterminate:
  keep the task, report that startup could not be verified, and ask the user
  how to proceed. Do not infer a preview URL from ports or unrelated processes.
- A later deliberate start for the same file may return `reused: true`. Its
  ready JSON is a valid handshake, but that invocation exits because the
  original preview process still owns the service. Do not treat the reused
  invocation's task or process handle as the server owner.
- Editing and saving the file reloads the page automatically; annotations
  stay anchored where possible.
- `preview next` returns every batch the user has submitted; it is
  non-claiming (calling it again returns the same open items) and with
  `--wait <sec>` it long-polls. `timed_out: true` and `session_ended: true`
  are normal empty results, not errors. The error
  `preview_session_not_found` means no live session exists; ask the user to
  start one. `preview_wait_conflict` means another long poll owns the session;
  use that wait or retry after it returns. `preview_request_failed` means the session is alive but rejected
  the request, so fix the payload (thread id, generation, size) and retry.
  `preview_session_unverified` on startup means a recorded session did not
  answer, or it was started before the current notification contract. Retry a
  temporarily unresponsive session; for an older session, ask the user to stop
  that preview process and start it again with the current CLI. The `--force`
  fallback clears an unresponsive record only once the process is gone.
- Report outcomes with `preview done --stdin`; reply into a thread with
  `preview reply --thread <id> --body <text>` (state unchanged); end the
  session with `preview stop` (annotations stay saved on disk).

### Waking up when the user submits a batch

Pick the first mode your environment supports:

1. In Codex, start preview from the session that owns the work. Current Codex
   environments expose the session UUID to the trusted local preview process;
   Artifact Share registers it and uses `codex queue` to send a fixed
   batch-ready notice. End your turn after preview is ready. When the notice
   resumes the session, run `preview next`, fix the whole batch, and report it
   with `preview done`. A `queued` state means Codex accepted the notice, not
   that it started processing. If it remains queued, the session may have
   ended: use `codex resume`, then run `preview next`. Never copy comments into
   a queue message; `preview next` is their source of truth.
2. In Claude Code, if `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` is neither `1` nor
   `true` and Bash exposes `run_in_background`, run the preview start command
   itself as one Bash background task and read it through Claude Code's
   task-output mechanism until the ready JSON arrives; add no shell pipeline or
   redirection. Keep a non-reused task alive as the server owner. After the
   handshake,
   use the background-wait path only if starting
   `preview next --wait 3600` in a separate background task returns a task ID.
   End your turn. A submitted batch completes the wait and resumes you; fix the
   file, report with `preview done`, then arm one new wait. If the wait returns
   `timed_out: true`, do not re-arm it automatically. If background waiting is
   unavailable or rejected after start, use manual pickup and do not describe
   the session as waiting. If background Bash tasks are unavailable before
   start, ask the user to run and keep the preview command open in their own
   terminal; that user-owned process is the server owner, and comment pickup is
   manual.
3. For an Artifact Share-managed Cursor ACP session, start with
   `npm exec --yes --package=@artifactshare/cli -- artifactshare-preview-cursor <file>`.
   Run one managed launcher per workspace. The launcher creates or loads the
   workspace's managed conversation and sends a fixed batch-ready prompt only
   while that session is idle. Read all comment content with `preview next`;
   never place it in the ACP prompt. Keep the launcher attended and approve
   Cursor tool permissions only after checking the request shown in its
   terminal.
4. In the interactive Cursor Agent CLI, start preview with
   `ARTIFACTSHARE_CURSOR_FOREGROUND_WAIT=1`, then block in the foreground on
   `preview next --wait 90` and repeat. Do not use that marker for a normal
   Cursor IDE chat: IDE chats are manual pickup and must not be described as
   automatically resumable.
5. Fallback: run `preview next` only when the user tells you a batch is
   ready.

If `preview next` immediately returns the same item set as the previous
call, do not re-arm; report the situation to the user instead.

### Working through a batch

```bash
npm exec --yes --package=@artifactshare/cli -- artifactshare preview next ./lp.html --wait 90
npm exec --yes --package=@artifactshare/cli -- artifactshare preview next --session 0123456789abcdef
```

- Read the whole batch first, then fix everything in one editing pass and
  save once, then report the whole batch with a single `preview done` call.
- Successful `preview next` and `preview done` results include the same
  sanitized `agent` notification projection as the ready result.
- Each done item is `{thread, generation, outcome, note}` with outcome
  `fixed` (you changed the file) or `skipped` (`note` explaining why is
  required). The `note` is shown to the user as the thread summary, so
  write it for them.
- An item whose `anchor.state` is `orphaned` lost its place in the document;
  do not try to re-fix it — report it as `skipped` with a note.
- `done` is idempotent per generation: each item comes back as `accepted`,
  `stale` (the thread was reopened with a newer generation), or
  `already_reported`, plus `unknown_thread` for ids the session does not
  know.

```bash
printf '%s' '{"items":[{"thread":"t1","generation":1,"outcome":"fixed","note":"Tightened the headline"}]}' | npm exec --yes --package=@artifactshare/cli -- artifactshare preview done ./lp.html --stdin
```

Sharing is user-driven: the page's share button opens a separate-origin
dialog that publishes the snapshot bytes; local annotations are never
carried into the shared copy.

## Output contract

- Always pass `--json`. Success prints
  `{"schema_version":2,"ok":true,"command":...,"data":...}` to stdout; failure
  prints `{"schema_version":2,"ok":false,"error":...}` to stderr with exit
  code 1.
- On failure, read `error.code`, `error.hint`, and `error.recovery`.
  `recovery.kind` is one of `change_input`, `run_command`, `retry_later`,
  `ask_human`, `report_issue`. When `error.requires_human` is true, report to
  the user instead of retrying.

## First-time setup

`npm exec --yes --package=@artifactshare/cli -- artifactshare init` detects the agent, installs or updates
this skill, and reports the next steps (sign in, then share). When you receive
a share URL instead, start with `open <artifact-id-or-url> --json`. It ensures
this skill is installed or updated, then reads single-file artifacts or returns
a `download` next command for static sites and multi-file artifacts.
