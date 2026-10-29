---
name: artifactshare
description: Share, publish, upload, host, update, open, or read back existing files and Artifact Share URLs; or show a local file in the browser for review before sharing. Use when the user wants a browser link for an HTML/Markdown report, folder, static site, or generated file; wants to update the same URL; wants to look at, check, preview, or comment on a file you just generated before it is shared; says Artifact Share, artifactshare, or contextual "as"; or asks to read comments from a shared URL.
---

<!-- artifactshare-skill
version: 52
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

`npm exec --yes --package=@artifactshare/cli -- artifactshare init --json` detects the agent, installs or updates
this skill, and reports the next steps (sign in, then share). When you receive
a share URL instead, start with `open <artifact-id-or-url> --json`. It ensures
this skill is installed or updated, then reads single-file artifacts or returns
a `download` next command for static sites and multi-file artifacts.

For attended setup, use `login --profile <name> --preset agent --json` and approve
the browser request. Omit `--preset` for unrestricted personal login. Check
`whoami --json` or `doctor --json`; follow `auth_required` recovery.

Read [authentication, profiles and skills](references/authentication-profiles-skills.md)
when choosing credentials, importing tokens, changing profiles, or managing installations.

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
- Inspect the home audience policy before posting with
  `config get home_audience --scope effective --json`.
- An unconfigured Home share checks the server: workspace-capable accounts use workspace; personal accounts use private. Keep explicit/configured values, including workspace rejections. Never retry as link without the user choosing --visibility link.
  Offline config output leaves the product_default workspace policy unresolved. The account determines the audience during share or preview; an older server that omits visibility_available keeps the legacy workspace behavior.
  Private fallback results include `data.share.visibility_source: "product_default_private"` and `visibility_hint`.
- Set visibility at share time with `--visibility private|workspace|project|link`.
  This is a per-post override; `--grant-email` does not change the resolved
  default visibility.
- For link sharing, pass exactly one of `--link-expires-at <RFC3339 UTC>` or
  `--no-link-expiry`. Omit both to use the workspace default.
- Pass `--no-slack-notify` only when the user explicitly does not want the
  project Slack notification for this post.
- A workspace policy may allow a finite expiry from 1 to 365 days or unlimited
  expiry. The initial default is 30 days and the initial maximum is unlimited.
  `link_expires_at` in the result is the confirmed UTC timestamp or `null`.
- For repeat jobs with a stable caller-owned name, use
  `share <path> --key <key> --json`: the first run creates the artifact, later
  runs add versions to the same artifact.
- Run `share --help` for all flags.

Read [upload path safety](references/upload-path-safety.md) when selecting linked paths or recovering from upload filesystem errors.
Read [static-site scripts and data](references/static-sites.md) when a folder uses workers, WebAssembly, fonts, or data files.

## Update

Use `update` to add a new version to an existing artifact while keeping its URL.

```bash
npm exec --yes --package=@artifactshare/cli -- artifactshare update <artifact-id-or-url> ./report.html --json
```

- Pass `--expected-version <version-id>` to reject an update when another
  version became current first. Project-scoped agent profiles must pass it.
  Repeat `share --key` updates accept the same option; initial creation does
  not require it.
- After `login --preset agent`, updates require `--expected-version <version-id>` using `data.version.id` from the previous successful `share` or `update` output. If omitted, `expected_version_required` reports `recovery.kind: change_input`; retry with that value. `artifacts get` instead returns the current version as `data.version_id`.

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

- A signed-in external human whose verified email is explicitly granted on an
  artifact can update it when the artifact workspace allows external posting.
  Link access alone does not grant update access.

- To keep an existing share URL, do not run `share --artifact-id`; use `update`.
- Pass the same kind of input (single file vs directory) it was created with.
- `update` does not change title, visibility, viewers, or placement. Use `edit`
  for those.
- Run `update --help` for all flags.

Use `--label <label>` for an immutable version note. Read [version labels](references/version-labels.md) when adding labels or interpreting version history.

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

The browser share page opens HTML, Markdown, and static sites with its URL fragment (`#…`) and follows fragment changes inside the frame. Copy link includes the current fragment, so filtered views and Markdown headings can be shared. For static sites, only the entrypoint updates the share fragment; subpages leave it unchanged. This does not change CLI local preview.

Targets accept artifact IDs, app share URLs, per-ID `artifactshare.link` viewer URLs, and `a-<id>--v-<hex-version>.artifactshareusercontent.com` or `l-<id>--v-<hex-version>.artifactshareusercontent.com` execution URLs. Legacy sandbox and link-content URLs also resolve to IDs through the API.

Read [local write recovery](references/local-write-recovery.md) before overwriting downloads or recovering from filesystem or config-write failures.

## Comments

Use `comments list <target> --json` to pick up feedback and
`comments post <target> --body '<text>' --json` to respond. List results contain
partial thread histories. Read [comments](references/comments.md) when reading
older replies, anchoring feedback, editing or resolving threads, or handling posting limits.

## Preview (local annotate-and-fix loop)

Preview serves one local HTML or Markdown file without sign-in or uploading.
Read [preview](references/preview.md) before starting: it explains process ownership,
agent-specific notifications, manual pickup, recovery, and local isolation.

Start `preview <file> --json` once using the environment's long-running task
mechanism. Keep the process handle. Wait for the ready JSON line with `url` and
`session` before telling the user it opened; a running task alone is not readiness.
Do not launch duplicates while startup is indeterminate.

When the user submits feedback, read the whole batch with `preview next --json`,
fix it in one editing pass, save once, and report the batch with
`preview done --stdin --json`. Skip orphaned anchors with an explanatory note.
Saving reloads the preview. Sharing happens only when the user opens its share dialog.

## Audience and visibility settings

Project posts use the project's audience; without a destination, share posts to home.
Use `--visibility private|workspace|project|link` for a per-post override.
Use `config set home_audience private --scope user --json` for a personal default;
use repository scope only for an agreed policy. Confirm with
`config get home_audience --scope effective --json` before posting.

Use `edit` to change title, audience, expiry or placement without creating a version.
Read [organize and settings](references/organize-settings.md) when managing projects,
access, expiry, retention, deletion, or persistent defaults. Delete only on explicit request.

## Skills and profiles

`skills ensure --tool auto --json` prepares user-scope skills;
`skills update --json` updates managed installations, preserving versions installed by a newer CLI unless `--force` explicitly requests a downgrade. User-added links are ignored; protected-path links are refused. Project installation is opt-in.
`profiles list --json` shows saved profiles; `profiles use <name> --json` switches
selection. Use `logout --profile <name> --json` to revoke a device-login credential.
The authentication, profiles and skills reference above covers tools, scopes, storage,
removal and unattended token imports.

## REST API integrations

Read [REST API only](references/rest-api-only.md) when working directly with
static-site inheritance or publisher device credentials. These have no supported
CLI workflows; do not invent flags for them.

## Quick reference

| Task                     | Command                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------- |
| Share a file or folder   | `share <path> --json`                                                               |
| Share a link with expiry | `share <path> --visibility link --link-expires-at '<RFC3339 UTC>' --json`           |
| Replace with same URL    | `update <target> <path> --json`                                                     |
| Append to same URL       | `append <target> <path> --json`                                                     |
| Read back source         | `artifacts get <target> --json`                                                     |
| Download a site bundle   | `download <target> --output ./out --json`                                           |
| Download a whole project | `download --project-id <id> --output ./out --json`                                  |
| List your artifacts      | `artifacts list --json`                                                             |
| Post a comment           | `comments post <target> --body '<text>' --json`                                     |
| Read comments            | `comments list <target> --json`                                                     |
| Read older replies       | `comments list <target> --thread-id <id> --before <older_cursor> --limit 50 --json` |
| Change title or sharing  | `edit <target> --title 'New' --json`                                                |
| Move to a project        | `edit <target> --project-id <id> --json`                                            |
| Create a project         | `projects create 'Name' --json`                                                     |
| Find an ID from a title  | `resolve <value> --json`                                                            |
| Open a share URL         | `open <url> --json`                                                                 |
| Preview a local file     | `preview <file> --json` (local, no sign-in)                                         |
| Log out                  | `logout --profile <name> --json`                                                    |
