---
name: artifactshare
description: Share, publish, upload, host, update, open, or read back existing files and Artifact Share URLs. Use when the user wants a browser link for an HTML/Markdown report, folder, static site, or generated file; wants to update the same URL; says Artifact Share, artifactshare, or contextual "as"; or asks to read comments from a shared URL.
---

<!-- artifactshare-skill
version: 33
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

Run commands with `npx --yes @artifactshare/cli`. When unsure about a
command or flag, run `npx --yes @artifactshare/cli <command> --help` first.

Honor an explicit user request to use CLI or MCP before selecting the default
below. Use the CLI when a coding agent can access a user-controlled workspace,
install the CLI package, and reach Artifact Share, even when MCP tools are also
available. Use remote MCP for source text in chat or a temporary sandbox when
CLI network access is unavailable or uncertain; a temporary file alone is not
enough to try `npx`. MCP OAuth is not CLI authentication: follow the CLI
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
| Log out                  | `logout --profile <name> --json`                                          |

## Authentication

- `login --profile <name> --preset agent --json` starts device login for a
  project-scoped agent profile. Omit `--preset` for unrestricted login. It may
  open the OS browser for approval. Use it when a user is present; the pending
  event on stderr includes `browser_open`. Do not pass API tokens to `login`.
  Profiles created by `login` renew expired CLI sessions automatically.
- In unattended CI or scripts without browser approval, ask the user to issue
  an API token at `https://artifactshare.com/settings/tokens`, then use
  `ARTIFACTSHARE_TOKEN` or `--token` for normal commands.
- `logout --profile <name> --json` revokes a device-login refresh credential
  before removing it locally and leaves profile metadata in `config.json`.
  If remote revoke fails, the local credential is kept and logout fails.
  API-token profiles are removed locally only and are not revoked on the server.
- To keep using an issued token as a named profile without TTY or browser
  login, pipe it on standard input:
  `printf '%s' "$TOKEN" | npx --yes @artifactshare/cli profiles import-token --profile <name> --json`.
  Bot tokens (`asb_` prefix, issued by a workspace admin) use the same command; the first
  refresh consumes the displayed token, overwriting an existing profile credential requires
  `--force`, and a revoked or superseded bot token fails with `bot_token_invalid` (ask the
  admin to reissue).
  Imported API-token profiles are not renewed by the CLI.
  Use `--allow-plaintext-token-store` only on a trusted machine without a native token store.
  That fallback is mode `0600` on POSIX; on Windows it is accepted only inside the user profile directory so its ACL boundary applies.
- Check the current state with `whoami --json`, or `doctor --json` for token
  storage, authentication, destination, network, upload access, and skill update status.

## Share

Use `share` for new files. Use `update` to replace an existing artifact. Use
`append` to add a non-empty UTF-8 file exactly as-is to a single-file artifact;
Markdown is appended at source end, while HTML is inserted before an ASCII
case-insensitive `</body>` when present, or at source end otherwise. It adds no
newline or separator and does not support sites.

```bash
npx --yes @artifactshare/cli share ./report.html --json
npx --yes @artifactshare/cli share ./site-dir --project-id <id> --json
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
npx --yes @artifactshare/cli config set home_audience private --scope user --json
npx --yes @artifactshare/cli config set home_audience workspace --scope repository --json
npx --yes @artifactshare/cli share ./report.html --visibility private --json
npx --yes @artifactshare/cli config get home_audience --scope effective --json
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
npx --yes @artifactshare/cli update <artifact-id-or-url> ./report.html --json
```

- To keep an existing share URL, do not run `share --artifact-id`; use `update`.
- Pass the same kind of input (single file vs directory) it was created with.
- `update` does not change title, visibility, viewers, or placement. Use `edit`
  for those.
- Run `update --help` for all flags.

## Read back and download

Use `artifacts get` for single-file sources. Use `download` for static sites.

```bash
npx --yes @artifactshare/cli artifacts get <artifact-id-or-url> --json
npx --yes @artifactshare/cli artifacts get <artifact-id-or-url> --include versions --include comments --json
npx --yes @artifactshare/cli download <artifact-id-or-url> --output ./out --json
npx --yes @artifactshare/cli download --project-id <id> --output ./out --json
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
npx --yes @artifactshare/cli comments list <artifact-id-or-url> --json
npx --yes @artifactshare/cli comments post <artifact-id-or-url> --body '<text>' --json
npx --yes @artifactshare/cli comments post <artifact-id-or-url> --body '<text>' --reply-to <thread-id> --json
npx --yes @artifactshare/cli comments post <artifact-id-or-url> --body '<text>' --quote 'exact text' --json
npx --yes @artifactshare/cli comments post <artifact-id-or-url> --body '<text>' --agent 'Claude' --json
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
npx --yes @artifactshare/cli comments edit <artifact-id-or-url> --message-id <id> --body '<text>' --json
npx --yes @artifactshare/cli comments resolve <artifact-id-or-url> --thread-id <id> --json
npx --yes @artifactshare/cli comments reopen <artifact-id-or-url> --thread-id <id> --json
npx --yes @artifactshare/cli comments delete <artifact-id-or-url> --thread-id <id> --message-id <id> --json
```

- Comment deletion cannot be undone. Omit `--message-id` only when the user
  wants the whole thread deleted.
- Run `comments post --help` for all flags.

## Organize and settings

Use `edit` for post-share changes. Use `projects list/create/edit` for
project management.

```bash
npx --yes @artifactshare/cli edit <artifact-id-or-url> --title 'New title' --json
npx --yes @artifactshare/cli edit <artifact-id-or-url> --visibility private --grant-email viewer@example.com --json
npx --yes @artifactshare/cli edit <artifact-id-or-url> --project-id <id> --json
npx --yes @artifactshare/cli edit <artifact-id-or-url> --home --json
npx --yes @artifactshare/cli delete <artifact-id-or-url> --json
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
npx --yes @artifactshare/cli projects list --json
npx --yes @artifactshare/cli projects create 'Client reports' --json
npx --yes @artifactshare/cli projects create 'Internal' --visibility private --json
npx --yes @artifactshare/cli projects edit <id> --add-email viewer@example.com --json
npx --yes @artifactshare/cli projects edit <id> --archive --json
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
npx --yes @artifactshare/cli profiles list --json
npx --yes @artifactshare/cli profiles use <name> --json
npx --yes @artifactshare/cli profiles delete <name> --json
```

- `profiles list` shows saved profiles and the default.
- `profiles use` switches the default profile.
- `profiles delete` removes the profile entry and its saved credential. Use
  `logout --profile <name>` when you only want to remove the credential.
- To create a profile, use `login --profile <name>` (interactive) or
  `profiles import-token` (non-interactive, see Authentication).

## Skills

```bash
npx --yes @artifactshare/cli skills ensure --tool auto --json
npx --yes @artifactshare/cli skills update --json
npx --yes @artifactshare/cli skills list --json
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

`npx --yes @artifactshare/cli init` detects the agent, installs or updates
this skill, and reports the next steps (sign in, then share). When you receive
a share URL instead, start with `open <artifact-id-or-url> --json`. It ensures
this skill is installed or updated, then reads single-file artifacts or returns
a `download` next command for static sites and multi-file artifacts.
