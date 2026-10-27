# Organize Settings

## Contents

- [Audience and visibility settings](#audience-and-visibility-settings)
- [Organize and settings](#organize-and-settings)

## Audience and visibility settings

Destination lists include only active projects you can post into. A private project permits its creator, a current workspace owner/admin on the team plan, or a verified contributor/manager. On free and plus, admin status alone does not permit placement in another member’s private project. Viewer access and individual artifact grants do not authorize placement. Agents and bots still require their fixed project and a verified contributor/manager grant for private projects; publisher credentials cannot select projects.

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
effective resolution, and the canonical `home_audience` key. `default_artifact_visibility` is a compatibility alias, while
`default_project_visibility` is the advanced `projects create` default. Home
resolution checks repository then user settings (including the alias at each
scope), then product default `workspace`; project defaults use repository,
user, then `workspace`. Keyless `config get --json` returns only
`home_audience`; pass an explicit key for either other setting. These settings
only affect new home posts and project creation; update, edit, Web, and MCP
defaults are unchanged.

## Organize and settings

Use `edit` for post-share changes. Use `projects list/create/edit` for
project management.

```bash
npm exec --yes --package=@artifactshare/cli -- artifactshare edit <artifact-id-or-url> --title 'New title' --json
npm exec --yes --package=@artifactshare/cli -- artifactshare edit <artifact-id-or-url> --visibility private --grant-email viewer@example.com --json
npm exec --yes --package=@artifactshare/cli -- artifactshare edit <artifact-id-or-url> --project-id <id> --json
npm exec --yes --package=@artifactshare/cli -- artifactshare edit <artifact-id-or-url> --visibility project --json
npm exec --yes --package=@artifactshare/cli -- artifactshare edit <artifact-id-or-url> --home --json
npm exec --yes --package=@artifactshare/cli -- artifactshare delete <artifact-id-or-url> --json
```

- Owners with unrestricted credentials can set `edit <target> --retain-versions N`
  to keep the latest N eligible published versions, or `--retain-versions all` to keep all
  future versions. For files created by or assigned to a publisher client, this counts only published publisher versions (including earlier clients) and keeps every version people added, even when an unrestricted owner changes the setting. Other files keep counting all published versions. The current version is always kept. Setting or lowering retention immediately deletes older eligible
  versions; the response reports `retain_versions` and `deleted_versions`.
  Owners can also use the file history panel, which confirms existing removals.
  Authorized viewers of versions removed by retention see an explanation and
  a latest-version link (HTTP 410). Unknown IDs still return 404 for signed-in
  viewers. Clearing the limit never restores deleted content. Comments and
  surviving version numbers remain. Agent-preset credentials cannot change retention.
- `edit` changes title, visibility, explicit viewers, or project placement
  without adding a new version.
- Set `--visibility link` with `--link-expires-at <RFC3339 UTC>` for a finite
  expiry or `--no-link-expiry` for unlimited expiry. The expiry options are
  mutually exclusive; omit both to preserve an existing link expiry.
- If `edit` changes visibility away from `link`, the link expiry is cleared.
  If a link operation fails, use
  `link_sharing_plan_required` as a legacy code,
  `link_sharing_disabled` to ask the workspace owner or a Team admin to resume link sharing,
  `link_expiry_invalid` to pass a future RFC3339 UTC timestamp within policy
  (or use `--no-link-expiry` when the policy allows it), or
  `link_publish_rate_limited` when, under the default thresholds, the service
  observes 20 counted files before a publication in a Free workspace less than
  14 days old during its rolling 24-hour window. A file counts once for its
  most recent change to link visibility, or for creation with link visibility.
  Making an artifact private, hiding it, or
  deleting it does not erase its publication history during the 24-hour window,
  so those actions do not restore a slot. A concurrent publication may be
  refused even if an earlier preflight saw room. Share with specific people.
  `error.recovery` indicates `retry_later`; use `error.message` and
  `error.hint` for when to retry, and honor the returned retry duration. Retry
  the link publication later instead of retrying immediately with unchanged
  input.
- edit accepts --visibility private|workspace|project|link. Project visibility requires the artifact to be in a project after the edit; use --project-id <id> in the same request if needed. An explicit --visibility project at home (including --home) is refused without changes. Moving a project-visible artifact home makes it private only when project visibility is not explicitly requested.
- The `move` command is available for placement-only automation, but
  prefer `edit` for new flows.
- `artifacts delete <artifact-id-or-url>` is an alias of `delete`; both return JSON `command: "delete"`. Keep using top-level `delete` in deletion workflows.
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
