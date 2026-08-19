# Changelog

All notable changes to `@artifactshare/cli` are documented here.
For user-facing announcements, see https://artifactshare.com/updates?product=cli.

## Unreleased

## 0.11.3 - 2026-08-20

- Support Windows Credential Manager for saved profiles, resolve Windows config homes without `HOME`, and expose token-store diagnostics from `doctor --json`. The explicit plaintext fallback is now limited to POSIX systems with mode `0600` instead of implying Windows protection from ignored mode bits.
- `profiles import-token` detects workspace-issued bot tokens (`asb_` prefix), imports them as rotating refresh credentials (the first refresh consumes the displayed token; the rotated credential is stored before success is reported), persists `kind: "bot"` in the profile, and adds `--force` to replace an existing profile credential (no-op for API tokens). Rejected bot tokens report `bot_token_invalid`; runtime 401s on bot profiles now point to an admin reissue instead of login/preset/API-token recovery. `profiles list` and `doctor` surface bot profiles.

## 0.11.2 - 2026-08-12

- Direct agents with a user present to project-scoped browser login, and reserve API-token guidance for unattended CI or scripts without browser approval.

## 0.11.1 - 2026-08-12

- Warn in `doctor` when an agent credential's approved project differs from the configured default destination, and provide an `init` command to align them.

## 0.11.0 - 2026-08-12

- Add `login --preset agent` for browser-approved credentials restricted to one project, with scoped defaults and guidance across login, `whoami`, and `doctor`.
- Identify CLI device sessions across login and refresh rotation so users can manage and revoke them from Settings.

## 0.10.2 - 2026-08-09

- Rotate device-login refresh credentials after use and revoke their credential family during `logout`; a failed remote revoke now leaves the local credential intact.

## 0.10.1 - 2026-08-09

- Publish the first npm release covered by the Artifact Share source-available license.

## 0.10.0 - 2026-08-07

- Switch the repository and CLI license to the source-available license. Version 0.10.0 is not published to npm.

## 0.9.0 - 2026-08-05

- `artifacts list --project-id` now lists every artifact you can view in the project, including other members' uploads, with `owner_email`; continue past 50 items with `--cursor`.
- Add `download --project-id <id> --output <dir>` to save a whole project locally, one directory per artifact plus an `index.json` summary.
- Re-running the project download against the same output directory is an incremental sync: unchanged versions are skipped and reported as `unchanged`.
- Add `share --no-slack-notify` to skip the Slack channel announcement for a single post when the destination project has notifications configured.

## 0.8.4 - 2026-07-27

- Route capable coding agents to the CLI even when MCP is available; use remote MCP for chat and temporary sandboxes with uncertain CLI network access.

## 0.8.3 - 2026-07-26

- HTML append inserts content before the closing body tag when present, while Markdown and HTML fragments without that tag still append at the source end.

## 0.8.2 - 2026-07-26

- Add `append` for appending UTF-8 content to single-file Markdown and HTML artifacts.

## 0.8.1 - 2026-07-26

- Document the `artifacts get --json` readback contract in help, bundled skills, and MCP tool descriptions, including `content`, `version_id`, and continuation fields.

## 0.8.0 - 2026-07-15

- Remove the `request-access` command. Sharing is open to everyone at sign-up, so there is no waitlist to join.

## 0.7.1 - 2026-07-14

- Rework `home_audience` guidance in command help and the bundled skill: purpose-based examples for user and repository scopes, the `--visibility` one-time override, and checking the resolved audience with `--scope effective`.

## 0.7.0 - 2026-07-13

- Share without a destination now posts to home, so agents and automation have a predictable first destination.
- Configure `home_audience` for a user or repository to choose whether home posts are private or visible to the workspace.
- Repository settings take precedence over user settings, giving teams a shared default while preserving a personal fallback.

## 0.6.1 - 2026-07-12

- Fix `--insecure-localhost` failing every command with `network_failed` on Node 22/24 by routing all CLI HTTP requests through undici's own fetch

## 0.6.0 - 2026-07-11

- Add Cursor user-scope skill install and update support
- Move automatic skill install and update to user scope by default

## 0.5.2 - 2026-07-09

- Auto-update outdated managed user-scope skills after successful commands

## 0.5.1 - 2026-07-09

- Refresh expired session profiles automatically across authenticated API calls

## 0.5.0 - 2026-06-23

- Add `logout` to remove saved local credentials

## 0.4.1 - 2026-06-22

- Start browser approval automatically during non-interactive JSON login

## 0.4.0 - 2026-06-21

- Expand bundled skill coverage to match current CLI commands
- Refresh CLI login sessions during normal use
- Report outdated managed skills from `doctor`

## 0.1.0 - 2026-06-11

- Initial public releases (0.1.x through 0.3.x): npm publish, agent onboarding with `init` and `open`, bundled skills, `request-access`, and core share, update, download, and comment commands
