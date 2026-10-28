# Artifact Share CLI

Copyright © TechTalk, Inc.

The official CLI to open, share, and update files, folders, and static sites on [Artifact Share](https://artifactshare.com) from terminals, AI agents, and automation. Share HTML, Markdown, and exported sites to stable URLs, update existing files, and emit `--json` for scripts and agents.

Artifact Share hosts AI-built reports, documents, and static sites so you can share them with teammates and clients. This CLI shares a single file or a whole folder (HTML, Markdown, exported SPAs, images included), updates versions, opens shared URLs for agents, reads content and comments back, and works the same for humans, terminal agents (Claude Code, Codex, Cursor Agent), and automation.

Targets accept artifact IDs, app share URLs, per-ID `artifactshare.link` viewer URLs, and `a-<id>--v-<hex-version>.artifactshareusercontent.com` or `l-<id>--v-<hex-version>.artifactshareusercontent.com` execution URLs. Legacy sandbox and link-content URLs still resolve to IDs through the API; they no longer serve file content. Public share URLs are unchanged.

## WebAssembly dashboards

Static sites can run WebAssembly and workers, such as DuckDB-WASM loaded from jsDelivr, and folder uploads accept `.wasm` and `.parquet`; extensions such as `parquet` load from `extensions.duckdb.org`, and the bundled skill describes the setup.

## Quick start

Requires Node.js 22 or later.

```sh
npm exec --yes --package=@artifactshare/cli -- artifactshare share ./report.html
```

`--yes` lets agents and CI fetch the package without stopping for an npm install prompt.

On the first run in an interactive terminal, the CLI prints a sign-in link — open it in your browser, and the share completes and prints the share URL. Folders work too:

```sh
npm exec --yes --package=@artifactshare/cli -- artifactshare open <artifact-id-or-url> --json
npm exec --yes --package=@artifactshare/cli -- artifactshare share ./dist --project 'Weekly Reports'
npm exec --yes --package=@artifactshare/cli -- artifactshare projects create 'Client reports' --json
npm exec --yes --package=@artifactshare/cli -- artifactshare projects edit <id> --add-email viewer@example.com --json
npm exec --yes --package=@artifactshare/cli -- artifactshare edit <artifact-id-or-url> --project-id <id> --json
npm exec --yes --package=@artifactshare/cli -- artifactshare edit <artifact-id-or-url> --visibility private --grant-email viewer@example.com --json
npm exec --yes --package=@artifactshare/cli -- artifactshare share ./report.html --visibility link --link-expires-at '2026-08-01T00:00:00Z' --json
npm exec --yes --package=@artifactshare/cli -- artifactshare edit <artifact-id-or-url> --visibility link --no-link-expiry --json
npm exec --yes --package=@artifactshare/cli -- artifactshare update <artifact-id-or-url> ./dist
npm exec --yes --package=@artifactshare/cli -- artifactshare append <artifact-id-or-url> ./new-section.md
npm exec --yes --package=@artifactshare/cli -- artifactshare delete <artifact-id-or-url> --json
npm exec --yes --package=@artifactshare/cli -- artifactshare logout --profile default --json
npm exec --yes --package=@artifactshare/cli -- artifactshare config set home_audience private --scope user --json
npm exec --yes --package=@artifactshare/cli -- artifactshare config get home_audience --scope effective --json
```

To keep an existing share URL, update it with
`npm exec --yes --package=@artifactshare/cli -- artifactshare update <artifact-id-or-url> <path>` instead of
sharing again. For CI, scheduled reports, or other repeat jobs, use
`share <path> --key <key>`: the first run creates the shared file, and later
runs add versions to the same file.
Pass `--expected-version <version-id>` to reject an update when another version
became current first. Project-scoped agent profiles must pass it to `update`
and to repeat `share --key` updates; initial key creation does not require it.
After `login --preset agent`, updates require `--expected-version <version-id>` using `data.version.id` from the previous successful `share` or `update` output. If omitted, `expected_version_required` reports `recovery.kind: change_input`; retry with that value. `artifacts get` instead returns the current version as `data.version_id`.

Unknown options fail locally with `unknown_option` before authentication, requests,
or writes. Correct `details.option`; the hint suggests a nearby option when one
exists. Use the selected command’s `--help` to see accepted options.
A digits-only `--expected-version` fails with `invalid_expected_version`: pass a
version id from `data.version.id` in the previous share or update output, or
`data.version_id` from `artifacts get <target> --json` for a single-file artifact.
Both errors have `recovery.kind: change_input` and are agent-recoverable.
`unsupported_node_version` requires upgrading Node.js to 22.19.0 or newer;
it reports the current version and uses `recovery.kind: ask_human` with
`agent_recoverable: false` and `requires_human: true`.
A signed-in external human whose verified email is explicitly granted on an
artifact can also update it when the artifact workspace allows external
posting. Link access alone does not grant update access.

## Authentication

- **Interactive person**: run `npm exec --yes --package=@artifactshare/cli -- artifactshare login`.
- **Attended local agent**: use `login --preset agent` on the user's own machine to authorize one project. Add `--project <exact-name-or-id>` to make the browser confirm that fixed project; omit it to use the project picker. Device-login profiles renew expired CLI sessions automatically during normal use, and `login` / `whoami` distinguish the session expiry from the rotating refresh-credential expiry.
- **CI / non-interactive**: issue a token at `https://artifactshare.com/settings/tokens`, then inject `ARTIFACTSHARE_TOKEN` (or pass `--token`). Without a token, non-interactive runs fail with `error.code: "auth_required"` instead of hanging.
- **Shared agent platform**: use a workspace-managed bot credential in a trusted host service outside the model sandbox. Do not store a user's device-login profile or expose the bot credential to model shell commands.

Running `share`, `update`, or `download` directly also starts interactive sign-in when unauthenticated (the CLI prints a link and code to open in your browser).

- Multiple accounts: keep one local profile per account (`profiles list` / `profiles use <name>`). In non-interactive agents, pipe an issued token into `profiles import-token --profile <name> --json` to create a saved API-token profile without browser login; API-token profiles are not renewed by the CLI. Workspace-issued bot tokens (`asb_` prefix) are imported the same way: the CLI detects the prefix, performs the first rotating refresh (which consumes the displayed token), and stores the rotated credential; replacing an existing profile credential with a bot token requires `--force` (a no-op for API tokens), and a rejected bot token reports `bot_token_invalid` (recovery is an admin reissue). Use `logout --profile <name>` to revoke a device-login credential before removing it locally while keeping profile metadata, or `profiles delete <name>` to remove the profile entry too. API-token profiles are only removed locally.

Successful `share --json` output may include `data.warnings`. Surface each
warning to the user. `slack_reauthorization_required` means the destination
project's Slack channel must be reauthorized.

## Commands

| Command                                                            | What it does                                                                                                                                                                                                                          |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open <target>`                                                    | First command for agents opening a share or artifactshareusercontent.com execution URL; ensures skills, then reads or suggests download                                                                                               |
| `share <path>`                                                     | Share a file or folder as a new shared file (`--project`, `--home`, `--visibility`, `--key`, link expiry options)                                                                                                                     |
| `update <target> <path>`                                           | Add a new version to an existing file (ID or share URL); optional `--label` adds a version note                                                                                                                                       |
| `append <target> <path>`                                           | Append a non-empty UTF-8 file without a separator: at Markdown source end or before `</body>` in HTML, falling back to source end                                                                                                     |
| `edit <target>`                                                    | Change title, sharing, link expiry, explicit viewers, or project placement                                                                                                                                                            |
| `delete <target>`                                                  | Permanently delete a file you shared                                                                                                                                                                                                  |
| `artifacts delete <target>`                                        | Alias of delete; permanently delete a file you shared                                                                                                                                                                                 |
| `resolve <value>`                                                  | Find files by URL, ID, title, or project name                                                                                                                                                                                         |
| `artifacts get <target>`                                           | Read a file's content and metadata back                                                                                                                                                                                               |
| `download <target>`                                                | Save a file or a whole static site locally                                                                                                                                                                                            |
| `comments list / post / edit / resolve / reopen / delete <target>` | Read, write, edit, resolve, reopen, and permanently delete comments                                                                                                                                                                   |
| `projects list / create / edit`                                    | List eligible project destinations; create and edit projects and audience                                                                                                                                                             |
| `move <target>`                                                    | Move an existing file into a project or back home; `edit` is preferred for new automation                                                                                                                                             |
| `preview <file>` (alias of `preview start`)                        | Serve a local Markdown or HTML file with the product viewer look for browser annotation; local only, no sign-in, nothing uploaded                                                                                                     |
| `preview next` / `preview done` / `preview reply` / `preview stop` | Agent loop for a live preview: poll submitted annotation batches, report fixed/skipped outcomes from stdin, reply into a thread, and stop the session                                                                                 |
| `login` / `logout` / `whoami`                                      | Sign in, revoke a device-login credential before removing it locally, and check who you are                                                                                                                                           |
| `doctor`                                                           | Diagnose token storage, auth, destination, network, and upload readiness — tells you the next command to run                                                                                                                          |
| `changelog`                                                        | Show the installed version, this release's notes, and the public updates page                                                                                                                                                         |
| `profiles list / use / import-token / delete`                      | Switch between local account profiles, import an issued token from stdin, and delete profile entries                                                                                                                                  |
| `init`                                                             | Set up this directory: detect Claude Code, Codex, or Cursor and install the full skill folder in user scope (migrating managed legacy Cursor project rules), then show next steps; or save defaults with `--profile` / `--project-id` |
| `skills ensure / install / list / update / remove`                 | Install or update the bundled usage guide; shared directory aliases are handled once, internal links are refused; Claude user scope follows CLAUDE_CONFIG_DIR (blank values are unavailable)                                          |

Public command paths covered by this reference:

`append`, `artifacts`, `artifacts delete`, `artifacts get`, `artifacts list`, `changelog`, `comments`, `comments delete`, `comments edit`, `comments list`, `comments post`, `comments reopen`, `comments resolve`, `config`, `config get`, `config set`, `config unset`, `delete`, `doctor`, `download`, `edit`, `init`, `login`, `logout`, `move`, `open`, `preview`, `preview done`, `preview next`, `preview reply`, `preview start`, `preview stop`, `profiles`, `profiles delete`, `profiles import-token`, `profiles list`, `profiles use`, `projects`, `projects create`, `projects edit`, `projects list`, `resolve`, `share`, `skills`, `skills ensure`, `skills install`, `skills list`, `skills remove`, `skills update`, `update`, `whoami`.

`artifacts delete <artifact-id-or-url>` is an alias of top-level `delete`, with the same options and output. Both paths use JSON `command: "delete"` and schema version `2`.

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
npm exec --yes --package=@artifactshare/cli -- artifactshare preview ./report.html
npm exec --yes --package=@artifactshare/cli -- artifactshare preview next ./report.html --wait 90
npm exec --yes --package=@artifactshare/cli -- artifactshare preview stop ./report.html
```

The first command prints one ready JSON line (`url`, `session`,
`share_origin`, `reused`, and a sanitized `agent` notification projection) and keeps serving; pass `--no-open` to skip opening
the browser. The agent collects submitted batches with `preview next`
(long-polling with `--wait <sec>`; `timed_out` and `session_ended` are normal
results, while `preview_session_not_found` means no session is live), fixes
the file, and reports outcomes by piping
`{"items":[{"thread":...,"generation":...,"outcome":"fixed"|"skipped","note":...}]}`
into `preview done --stdin`. Reporting is idempotent per thread generation.
Only one long-poll may reserve a preview session at a time. The CLI returns
`preview_wait_conflict` to a competing poll; use the existing wait or
retry after it returns. Successful `next` and `done` results include the same
sanitized `agent` projection as the ready result. Submitted comments
stay in the local mode-`0600` store when notification fails or no waiter is
connected, and a later `preview next` retrieves the same batch. Provider
notifications carry only the event kind, preview session id, and batch id;
comment text and anchors are read through `preview next` instead.
When preview starts inside a current Codex session with a valid trusted thread
UUID, the ready and command results report `provider: codex`,
`transport: codex_queue`, and `capability: push`. Submitting a batch queues the
fixed notice to that thread. Queue acceptance remains `queued` until the agent
actually calls `preview next`; if the session has ended, reopen it with
`codex resume` and the saved batch remains available.

Inside Claude Code, the default transport is one background
`preview next --wait 3600` task. The bundled skill checks that Bash exposes
`run_in_background` and that starting the wait returns a task ID. It re-arms
after processing a batch and reporting `preview done`, but does not re-arm a
timed-out wait. Setting `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` to `1` or
`true` selects manual pickup.

For an Artifact Share-managed Cursor conversation, start the preview with
`npm exec --yes --package=@artifactshare/cli -- artifactshare-preview-cursor <file>`.
The launcher uses the existing Cursor CLI login, creates an ACP session on the
first run, and loads that same session for the workspace after a bridge
restart. Run one managed launcher per workspace. It sends only a fixed
batch-ready prompt to an idle managed session;
the agent reads comments with `preview next`. Keep the launcher attended:
Cursor tool permissions are rejected unless you explicitly approve them in
its terminal. A busy or unavailable session keeps the batch saved. In a normal
Cursor Agent CLI turn, explicitly set `ARTIFACTSHARE_CURSOR_FOREGROUND_WAIT=1`
when starting preview and keep one `preview next --wait 90` command in the
foreground. Ordinary Cursor IDE chats are manual pickup and are never reported
as automatically resumable.

`preview reply --thread <id> --body <text>` adds a reply without changing
thread state, and `preview stop` ends the session while keeping annotations
saved on disk. Sharing a snapshot happens only from the page's own share
dialog, and local annotations are not included in what is shared.

## Where shared files are delivered

Destination lists include only active projects you can post into. A private project permits its creator, a current workspace owner/admin on the team plan, or a verified contributor/manager. On free and plus, admin status alone does not permit placement in another member’s private project. Viewer access and individual artifact grants do not authorize placement. Agents and bots still require their fixed project and a verified contributor/manager grant for private projects; publisher credentials cannot select projects.

Posting to a project delivers to the audience defined by that project. With no destination, `share` posts to home. Choose the home audience by purpose:

```sh
npm exec --yes --package=@artifactshare/cli -- artifactshare config set home_audience private --scope user --json
npm exec --yes --package=@artifactshare/cli -- artifactshare config set home_audience workspace --scope repository --json
npm exec --yes --package=@artifactshare/cli -- artifactshare share ./report.html --visibility private --json
npm exec --yes --package=@artifactshare/cli -- artifactshare config get home_audience --scope effective --json
```

Use `--scope repository` only for a policy agreed by all repository participants, and pass `--visibility private|workspace|link` for a one-time home override. For link sharing, pass exactly one of `--link-expires-at <RFC3339 UTC>` or `--no-link-expiry`; omit both to use the workspace default. For project creation, pass `projects create <name> --visibility private|workspace`; persistent project defaults are documented in `projects create --help`. Pass `--no-slack-notify` to suppress the project Slack notification for one post.

edit accepts --visibility private|workspace|project|link. Project visibility requires the artifact to be in a project after the edit; use --project-id <id> in the same request if needed. An explicit --visibility project at home (including --home) is refused without changes. Moving a project-visible artifact home makes it private only when project visibility is not explicitly requested.

Owners can run `edit <target> --retain-versions 24 --json` to keep the latest 24 eligible published versions, or `--retain-versions all` to clear the limit. For files created by or assigned to a publisher client, this counts only published publisher versions (including earlier clients) and keeps every version people added, even when an unrestricted owner changes the setting. Other files keep counting all published versions. The current version is always kept. Setting or lowering the limit immediately deletes older eligible versions and releases their storage. The response includes `retain_versions` and `deleted_versions`. Owners can also change this setting in the file history panel, with confirmation before removing existing versions. Authorized viewers opening a version removed by retention see an explanation and a latest-version link (HTTP 410); unknown version IDs still return 404 for signed-in viewers. Clearing the limit never restores deleted content. Comments and surviving version numbers remain. Unrestricted owner credentials can edit retention; publisher credentials can edit only retention on artifacts their client created or was assigned through the API. Agent credentials cannot change retention. The edit API accepts the same setting as `retain_versions` (a positive integer or `null`) at `POST /api/cli/shareables/:id/edit`.

Link sharing is available on every plan; Team workspaces can turn it off. A workspace policy may allow a finite expiry from 1 to 365 days or no expiration; the initial default is 30 days and the initial maximum is no limit. Share and edit results include the confirmed `link_expires_at` UTC timestamp or `null`. If a link command fails, use `link_sharing_plan_required` as a legacy code (no plan limit applies today), `link_sharing_disabled` to ask the workspace owner or a Team owner or admin to enable the workspace setting, or `link_expiry_invalid` to correct the timestamp or choose `--no-link-expiry` when allowed. Under the default thresholds, `link_publish_rate_limited` means the service observed 20 counted files before a publication in a Free workspace less than 14 days old during its rolling 24-hour window. A file counts once for its most recent change to link visibility, or for creation with link visibility while it remains link-shared. Share with specific people. `error.recovery` indicates `retry_later`; use `error.message` and `error.hint` for when to retry. Retry the link publication later instead of retrying immediately with unchanged input.

For the complete settings reference, `home_audience` is the canonical home key. `default_artifact_visibility` remains a compatibility alias, and `default_project_visibility` is the advanced default for `projects create`. User and repository settings are resolved with repository taking precedence, followed by user and product default `workspace`; home also checks the compatibility alias at each scope. Use `config get home_audience --scope effective --json` to confirm the resolved audience. Keyless `config get --json` returns only `home_audience`; pass an explicit key to read either other setting. These settings only affect new home posts and project creation; update, edit, Web, and MCP defaults are unchanged.

## For AI agents

For first-time setup in a project, start here:

```sh
npm exec --yes --package=@artifactshare/cli -- artifactshare init --json
```

`init` detects Claude Code, Codex, or Cursor in the working directory (and Claude Code at its resolved user root when CLAUDE_CONFIG_DIR is nonblank), installs or updates the bundled skill in user scope, and reports the next steps (sign in, then share). With no agent detected, it installs user-scope Codex, Claude Code, and Cursor skills. Cursor project scope is not auto-installed; use `skills install --tool cursor --scope project`. Existing project-scope skills are not modified, except managed legacy Cursor rules migrate to .cursor/skills/artifactshare/. Add `--dry-run` to preview without writing.

When an agent receives an Artifact Share URL instead, start with `open`:

```sh
npm exec --yes --package=@artifactshare/cli -- artifactshare open <artifact-id-or-url> --json
```

This installs or updates the local skill first, then reads single-file artifacts. Static sites and multi-file artifacts return a `download` next command.

Claude Code user skills use CLAUDE_CONFIG_DIR when set, otherwise ~/.claude. Relative values resolve against the CLI working directory without tilde expansion; surrounding spaces are preserved. Empty or whitespace-only values disable Claude user-scope writes: automatic setup skips them. Mutations explicitly selecting --tool claude --scope user fail with validation_failed. With --tool claude and no --scope, skills update and skills remove process the project target and report the user target as skipped. Set CLAUDE_CONFIG_DIR to a non-empty path or unset it to use ~/.claude. skills list and doctor report unavailable targets with path: null and the recovery hint. When CLAUDE_CONFIG_DIR is set to a nonblank value, an existing resolved root also detects Claude Code for automatic setup. Old ~/.claude skills are left untouched; project scope, Codex and Cursor paths are unchanged. The skill file is `<root>/skills/artifactshare/SKILL.md`. The variable must reach the CLI process; settings confined to another launcher are not visible.

To target a specific tool manually, use `skills install --tool <codex|claude|cursor> [--scope project|user]`; project scope is opt-in for team commits. `skills ensure --tool auto` is the same user-scope detection `init` and `open` use (omit `--scope` or pass `--scope user`; `--scope project` fails). Regular successful commands also update outdated managed user-scope Codex, Claude Code, and Cursor skills when they are already installed, but do not create a missing Cursor user-scope skill.

Comment deletion is permanent. Use `comments delete <target> --thread-id <id> --message-id <id> --json` for one message, or omit `--message-id` only when deleting the whole thread.

All commands emit stable JSON when run non-interactively, piped, or with `--json`: success on stdout as `{ "schema_version": 2, "ok": true, "command": ..., "data": ... }`, failures on stderr as `{ "schema_version": 2, "ok": false, "command": ..., "error": ... }` with exit code 1. The `error` object carries a machine-readable `code`, a `hint`, and a structured `recovery` field (for example `{ "kind": "run_command", ... }`), so agents and scripts can branch and recover without parsing prose.

```sh
npm exec --yes --package=@artifactshare/cli -- artifactshare share ./dist --json
```

Quote paths and free-form text before passing them through a shell. Artifact Share route files and user files can contain `$`, spaces, or glob characters, so prefer single quotes such as `'apps/web/app/routes/a.$id/index.tsx'` and `--body 'Looks good'`.

## Links

- Setup guide for AI tools and terminals: https://artifactshare.com/connect
- Public updates (Web, CLI, Agent, MCP): https://artifactshare.com/updates
- Artifact Share: https://artifactshare.com

## License

The npm package through version 0.9.0 is licensed under the [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0). From version 0.10.0 onward, `@artifactshare/cli` is covered by the [source-available license](LICENSE). Version 0.10.0 was intentionally not published; version 0.10.1 is the first npm release under the new license.

### Version labels

Successful update API responses include `number`, a positive integer matching the
Viewer’s `v{number}` for the created version. CLI JSON exposes it as
`data.version.number`, with or without a label. Older server responses may omit
`number`; the CLI accepts them and omits `data.version.number`.

The optional `--label <label>` option on `artifactshare update <target> <path>`
attaches an immutable note to the new version of an HTML file, Markdown file, or static-site
bundle. Labels are normalized to Unicode NFC, then leading and trailing Unicode
space separators (Zs) are trimmed. Internal spacing and case are preserved.
The result must contain 1–80 Unicode code points (not bytes or UTF-16 units).
Letters, marks, numbers, punctuation, symbols, space separators, and U+200D
(joined emoji) are allowed. Empty values, tabs, newlines, controls, bidi formatting
controls, and unpaired surrogates are rejected; labels are never truncated.
CLI validation happens before authentication or upload. For a value beginning
with a known flag, use `--label=--text` to pass it explicitly.

The update API accepts one optional `label` query parameter on
`POST /api/shareables/:id/versions`, including `artifact_kind=static_site` uploads.
Invalid or repeated labels return HTTP 400 `validation-failed` before upload work.
Omission stores NULL and never inherits a prior label. Successful update API responses include `label`, and CLI JSON includes
`data.version.label`: the normalized, stored label or `null` when omitted.
Existing unlabeled rows are unchanged. Authorized history at
`GET /api/cli/artifacts/:id?include=versions` includes `label` only when present;
`artifacts get <target> --include versions --json` preserves it. The viewer's
version menu and full history show the label as plain text.
`GET /api/shareables/:id/versions` remains a current-version lookup.
Labels are update-only: initial uploads, `share --key`, `append`, preview,
bridge publishing, and MCP update inputs do not accept them.

### Quoted comment positions

Quoted comments are resolved in the viewer using the exact quote and surrounding context, never the nearest repeated words. `--quote-before` and `--quote-after` accept up to 400 characters per side; preserve spaces next to the quote. Creation does not search the artifact. Optional `anchor.position_state` is `unchecked` until that version is viewed, then `attached` or `needs-check`. Only `attached` maps to `anchor.state: attached`; both other states map to `orphaned`. Older responses may omit `position_state`. Local preview uses the same strict resolution on every reload and preserves the original quote when its position needs checking.

Older comments may have lost spaces at the edges of their saved context. The viewer tries those boundary spaces only and attaches only at one unique position. It cannot reconstruct missing separators inside old context (for example, `ab` saved across list items now measured as `a b`); those comments need a position check.

### API-only static-site inheritance

`POST /api/shareables/:id/versions?artifact_kind=static_site` accepts one
`base_version` and repeated `delete_path` query parameters. For example,
`?artifact_kind=static_site&base_version=v1&delete_path=data/old.parquet&delete_path=old.js`
with multipart `file` parts for `data/a.parquet` replaces that data file, removes
the two listed paths, and inherits all other files without copying their objects.
The base must be the current published version; a stale base returns HTTP 409
`version_conflict`. It also supplies the expected version for agent credentials.
If `expected_version` is supplied, it must equal the base (otherwise HTTP 400
`validation-failed`). Neither parameter changes write permissions.

Deletion paths use the same normalization and validation as uploaded paths.
Sending and deleting the same path is invalid. A case-only addition requires
explicitly deleting the old spelling. An absent deletion path is harmless.
A base permits zero sent files, provided the resulting manifest still includes
`index.html` or `index.md`. Entrypoint precedence, file-count, total-size, and
case-collision checks apply to the complete resulting manifest. Without a base,
the existing full replacement behavior applies. Empty or repeated bases,
deletion without a base, and inheritance parameters on other artifact kinds
return HTTP 400 `validation-failed`.

Version size is the logical sum of that version's files. Workspace quota counts
physical objects once across retained versions; only sent files add bytes.
Pruning keeps objects referenced by remaining versions. Version URLs retain
immutable manifests. This is a REST API feature: there are no CLI `update`
flags, MCP inputs, or bridge inputs for inheritance.

### Publisher device credentials (API only)

Versions added with publisher credentials are scheduled updates: content and live viewers refresh, but list order, feeds, unread indicators, and human update labels do not change. Browser history marks Scheduled update without exposing client names. API `updated_at` remains the actual mutation time; internal `activity_at` controls human activity ordering. Initial creation and versions published through other credentials keep their existing behavior.

The device API accepts `preset: "publisher"` with a required `device_name`.
Names are trimmed, NFC-normalized, case-sensitive, and limited to 1–100 Unicode
letters, marks, numbers, ASCII spaces, or `._-()`. The browser approver explicitly
creates a new client or continues one of their existing clients in that workspace.
Names cannot be edited on the approval screen: if a name already exists, continue
that client or request login again with a different name. Only explicit continuation
restores access to earlier files; `device_id` never selects a client.

A publisher can create private HTML, Markdown, or static-site artifacts in the
approver's home. Static sites use `POST /api/shareables/uploads?artifact_kind=static_site`.
It can manage only artifacts created by or assigned to its client, still owned by
that approver in the same workspace, including after the owner shares or moves them.
Single-file versions require `expected_version`. Static-site versions accept
`artifact_kind=static_site` with either `expected_version` for replacement or
`base_version` for changed-files uploads and repeated `delete_path` removals.
The base must be current. Version uploads preserve audience, location and retention.

On artifacts created by or assigned to a publisher client, retention counts only published versions added with publisher credentials, including earlier clients, and keeps every other version. This also applies to unrestricted owner edits. The newest N publisher versions and every current version are kept; drafts do not count. Unmanaged artifacts continue to count all published versions.

The exact `GET /api/cli/artifacts/:id/download` returns raw source bytes for
single files and a JSON manifest with version id, paths and SHA-256 hashes for
static sites. Individual `download/*` requests are denied. `GET /api/cli/artifacts/:id`
includes visibility; static-site readback contains metadata only. No `include`
expansions are allowed. `DELETE /api/cli/artifacts/:id` deletes the artifact.
POST or PATCH `/api/cli/shareables/:id/edit` accepts only `retain_versions`, a
positive integer or null. Setting a limit prunes older versions immediately;
clearing it never restores deleted content. Other presets remain POST-only.

The owner can assign an existing artifact using an unrestricted credential or
browser session: `POST /api/cli/artifacts/:id/adopt` with
`{"publisher_client_id":"client1"}`. Obtain the verified client id from whoami or
doctor. Assignment replaces the previous client's access and is audited even when
repeated; historical creation attribution stays unchanged. Publisher credentials
cannot adopt. There is no adoption UI or CLI command.

Other clients' artifacts, list, resolve, comments, audience/title/expiry edits,
move, projects, append and upsert remain denied. Existing presets' download and
readback responses are unchanged. CLI publisher login/resume and publishing/download
workflows remain unsupported; use the API. Credentials retain their client across
rotation and can be revoked from Settings → CLI sessions.

## Comment windows and posting limits

`comments list <target> --json` returns at most 50 threads, open first. Each
thread contains its current first message and latest three replies, plus
`message_count`, `reply_count` and `older_cursor`. These are partial histories.
Use `comments list <target> --thread-id <id> --before <older_cursor> --limit 50
--json` for older replies. Repeat with the returned cursor until it is null;
merge by message ID and display in `(created_at, message_id)` order. Each page
also includes the current first message. Cursors remain usable after their
boundary message is deleted. `--around-message-id <id>` selects a bounded page
containing a message; do not combine it with `--before`.

A thread holds 500 currently stored messages, including its first message.
`thread_capacity` means start a new thread. Existing excess messages are kept;
deletions can restore space. Deleting the first message promotes the next
earliest message; deleting the last removes the thread and anchor. Resolved
threads still refuse replies.

Creation and replies share 20 admissions per authenticated user and artifact
per fixed UTC minute across browser, CLI, MCP and API tokens. Adjacent minute
boundaries can admit 40 posts within a sliding 60 seconds. `rate_limited`
includes `retry_after_seconds` and UTC `retry_at`; HTTP also sends `Retry-After`.
Keep unsent content and retry after that time. Invalid requests, capacity refusals
and closed-thread refusals observed before admission consume nothing. Rate
refusals do not increment the counter; quota storage failures refuse the post.
Once admitted, commit failures and status/version/capacity races consume the admission without a
refund. Edits, deletions, resolve/reopen and anchor reports consume nothing.
Mutation readback contains only the affected thread window and changed message.
`refresh_required: true` means the write committed but advisory readback failed:
read that thread by ID; do not replay the write automatically.

## Local upload boundaries

`share`, `append`, and `update` validate and read local content before credential
resolution or refresh, project lookup, or upload. Authentication retries reuse the
verified bytes; they do not reopen source paths. Append still accepts only a
nonempty UTF-8 file, and checks emptiness after the verified read.

Every literal `..` component is rejected, including absolute paths and Windows
separator or drive-relative forms. Pass a direct absolute path instead. Relative
paths stay within the physical current directory: each component is inspected
with `lstat`, links are rejected, and device/inode identity determines containment.
Case, Unicode normalization, trailing dot/space aliases, and a current directory
reached through an alias work when the filesystem resolves them to the same file.
Absolute paths (including Windows `C:report.html` and `D:report.html`, resolved by
the platform) trust their parents, but the selection itself must not be a link.
To select a link target, copy it into the selection or pass its absolute path.

Selected trees reject included symlinks, junctions, app execution aliases, dangling
links, and special files. Names starting with `.`, `__MACOSX`, `node_modules`,
`.git`, `.artifactshare`, `.turbo`, `.DS_Store`, `Thumbs.db`, and `desktop.ini` are
excluded before inspection. `build` and `dist` remain included. Remaining entries
are classified with `lstat`, not directory-entry link flags; cloud placeholders
serving their own content remain supported when stable identities are available.
Each included entry's physical parent must have the identity of the directory
it was reached from, catching redirects that `lstat` reports as ordinary
directories. Physical paths are resolved once per entry; repeated parent-chain
checks use `lstat` identities. This comparison uses device/inode identity, not
canonical path spelling. Absolute selections still trust their parent paths.

On POSIX, files are opened once with `O_NOFOLLOW` and `O_NONBLOCK` where available.
Nonblocking opens prevent a replacement FIFO from stalling before the handle
is checked to be a regular file. On Windows,
`lstat` link rejection and the same handle identity checks protect reads without
requiring POSIX no-follow support. Both compare handle device, inode, mode, and
size against the recorded file and recheck parent identities before/after entry
inspection, around opening, and after reading. Missing stable identities or an
available no-follow guarantee that cannot be provided fail closed. Device zero
alone is allowed. ctime and mtime are not compared: cloud hydration may change
ctime. Same-identity, same-size in-place edits are not detected. Node has no
directory-relative `openat`, so a transient swap-and-restore entirely between
checks cannot always be detected.

Boundary errors use `validation_failed`, name the offending `details.path`
(descendants are relative to the selection), and provide `details.reason`:

| Reason                  | Recovery                                                                  |
| ----------------------- | ------------------------------------------------------------------------- |
| `parent_traversal`      | Pass a direct absolute path without `..`.                                 |
| `link`                  | Copy into the selection or pass the target by absolute path.              |
| `outside_cwd`           | Pass an absolute path.                                                    |
| `not_found`             | Check the path.                                                           |
| `changed`               | Retry after the selection stops changing (`retry_later`).                 |
| `unsupported_guarantee` | Use a filesystem providing the named stable identity/no-follow guarantee. |
| `invalid_type`          | Select a regular file or directory.                                       |

Other filesystem failures, including EACCES, EMFILE, EIO, and EPERM, use
`upload_read_failed` with `details.errno` and `retry_later`. Check availability and
permissions, then retry. Raw exceptions remain internal; errors never include
credentials or file contents. Empty included directories report
“Directory has no shareable files.”

### Local download and init writes

Download artifact IDs must match `^[a-z0-9]{10}$`. Invalid, duplicate, or
case-colliding IDs in any list page or previous `index.json` are fatal before
writes. Single-download targets and manifest identities must agree.

Output parents may be links; their resolved directory identities are rechecked.
Linked output roots, indexes, and listed artifact trees are refused,
even with `--force`. Recorded directory identities are checked again before
writes and cleanup. Project preflight inspects every listed artifact tree,
including unchanged versions, and `index.json`; unrelated content is not walked.
Network failures and invalid manifest paths, bodies, or identities are recorded per artifact. Every boundary
violation stops further publication, including later artifacts and the final index.
Artifact IDs with surrounding whitespace are rejected, not trimmed, including
single-download targets. Remove the whitespace before retrying. Share URLs use
the usual URL-to-ID resolution; list and index IDs are never normalized.

Replacements do not merge stale files. Staging and backups share one private
directory inside the output root for project downloads, or in its parent for
single downloads. This keeps project publication on the output filesystem.
Displaced originals and previous indexes
remain there after success and are reported in `data.backup_paths` and human
output. Inspect those paths before manual cleanup. Failed recovery also names
retained paths in the error. Cleanup removes only CLI-created temporary entries
and never removes a container holding originals. Files use exclusive creation
and indexes use temporary-file publication.
Manifest path conflict checks fold case on macOS and Windows; Linux keeps
case-distinct names. New downloaded files, config files, and Git excludes use
the default file mode masked by the umask. Replaced config and exclude files
preserve their existing permission bits.
Identity checks detect observed swaps at operation checkpoints; Node path-based
operations cannot guarantee atomic confinement against arbitrary concurrent changes.

`init --profile` / `init --project-id` preserve unknown local config keys and
refuse linked or changed `.artifactshare` / `config.local.json` paths. Only a
real repository `.git` directory without redirect metadata or linked `info` /
`exclude` is eligible for an exclude update. Worktrees and submodules still save
config and return `git_exclude_warning` with the path and exact line to add
manually. Running `init` without config arguments still installs user-scope skills.

Upload aliases use the stored filename for artifact kind, multipart name, and
content type. An enumerated entry disappearing is `changed` (retry); a relative
path through a regular file is `not_found` (correct the path). `share --help`
and `append --help` list all upload boundary reasons and fixes.

### Local preview isolation

Local HTML and Markdown previews run scripts inside a frame with `sandbox="allow-scripts"`. Preview isolation cannot be disabled. `localStorage`, IndexedDB, and other same-origin features are unavailable; the review shell always shows this restriction. Reporter observations are bounded, document-scoped display data. Saving or submitting feedback requires an explicit action in the review shell.

Local preview and share-dialog HTTP routes still lack per-session authentication. Loopback binding, Host checks and fixed mutation headers do not authenticate other local clients. Do not treat knowledge of the local port as an access-control boundary. Session authentication and private browser launchers are deferred; the existing ready `url` and `--no-open` behavior are unchanged.

Skills are installed as folders: `.claude/skills/artifactshare/`, `.agents/skills/artifactshare/`, and `.cursor/skills/artifactshare/` at project or user scope (Claude user scope honors CLAUDE_CONFIG_DIR). Each folder contains SKILL.md and the bundled references tree. `.artifactshare-managed.json` records owned paths and SHA-256 hashes. Updates repair missing owned files and retire unchanged owned files. User additions and hash-detected edits, including retained bundled paths, are preserved unless an explicit force operation authorizes replacement. Use `skills update --force` to replace edited managed files. Unowned path collisions require explicit `skills install --force`; `skills update --force` never takes over an unmanaged entry. Invalid ownership metadata requires inspection before reinstalling.

Writes stage files in a private directory, replace references, retire owned files, commit the manifest, then replace SKILL.md last. Readers may briefly see mixed references during this bounded operation. Interrupted manifest/version mismatches are conflicts. Removal deletes only owned files and prunes empty directories.

`skills list --json` and `doctor --json` retain entry-file `path` and add `folder_path`, `complete`, `current`, `older_version`, sorted `missing_files`, `different_files`, `modified_files`, and `ownership_manifest` (valid/absent/invalid). Missing/different paths compare the current bundle; modified paths compare installed manifest hashes. Complete means every bundled file is regular. Current also requires matching managed version, bytes, and a valid manifest. Missing folders report all bundled paths missing; unavailable targets have null folder paths, false booleans and empty arrays. Unverified ownership has an empty modified list. Existing update_available retains version comparison semantics.

Project Cursor targets also report `legacy_rule` with path, present, managed, coexistence and hint. Managed `.cursor/rules/artifactshare.mdc` files migrate only after the skill folder succeeds, including during automatic setup/update. This is the only project-scope automatic migration; a user-owned rule never authorizes installation. User-owned rules remain with inspection/manual-removal guidance. Actions add folder_path and optional legacy_rule action (removed/would_remove/kept_unmanaged/remove_failed). Dry runs do not write; failed cleanup includes retry guidance. Project removal handles both managed forms.

Skill folders and their configured ancestors may be directory symlinks. The CLI resolves the folder with realpath and handles each shared destination once, in Codex, Claude, Cursor order (project before user); the first selected alias supplies the legacy fields. JSON target rows include `aliases` (tool, scope, path, folder_path) and `resolved_folder_path`. Explicit filters include only selected aliases. Internal links, including SKILL.md, references and the manifest, are refused even with force. Restore dangling links to a directory; preserve edits and replace internal links with ordinary content before retrying. A missing skill beneath a dangling ancestor is reported as not installed, with the broken ancestor path, and does not block other targets. Link and layout conflicts provide repair hints without a force command. Removal preserves configured links and their destination directory.

Writes prefer a private sibling `.artifactshare-staging-<uuid>` directory. If the parent is not writable or a commit crosses filesystems, the CLI stages inside the skill folder instead and still commits files by rename. Real install, update, ensure and automatic updates clean reserved staging directories and exact UUID-shaped `.artifactshare-<uuid>.tmp` regular files only when their modification times are more than ten minutes old before checking conflicts, including no-op selections. Diagnostics and dry runs never clean files. Unrelated names and symlink referents are never deleted. Failed writes roll back committed paths and remove staging; interrupted processes leave debris for the next mutation.
