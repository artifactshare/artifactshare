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
  Codex, or Cursor in the working directory (also Claude at its resolved user
  root when CLAUDE_CONFIG_DIR is nonblank) and install or update this skill in user scope
  (`$CLAUDE_CONFIG_DIR/skills/` or `~/.claude/skills/` when unset, `~/.agents/skills/`, or
  `~/.cursor/skills/artifactshare/`). With no agent detected,
  user-scope Codex, Claude Code, and Cursor skills are prepared.
  Claude Code user-scope skills go to `$CLAUDE_CONFIG_DIR/skills` when set, otherwise `~/.claude/skills`. A blank value skips automatic writes; `doctor` explains why. Mutations explicitly selecting `--tool claude --scope user` fail with `validation_failed`. With `--tool claude` and no `--scope`, `skills update` and `skills remove` process the project target and report the user target as skipped.

- Cursor project scope is not auto-installed. Install the Cursor skill folder at `.cursor/skills/artifactshare/` explicitly
  with `skills install --tool cursor --scope project`; managed legacy rules migrate automatically.
- Use `skills install --tool cursor --scope user` to install or manage the
  Cursor user-scope skill explicitly.
- `skills ensure --tool auto` accepts omitted `--scope` or `--scope user`;
  `--scope project` fails with `validation_failed`. Project-scope skills are
  opt-in via `skills install --tool <tool> --scope project`.
- `skills update` updates installed managed skills to the bundled version.
- `--force` overwrites an unmanaged file on install.
- Run `skills --help` for all subcommands.
