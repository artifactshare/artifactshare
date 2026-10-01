---
title: Browser edits are protected from stale uploads
date: 2026-10-01
products: [web, cli, agent]
kind: improve
---

A browser replacement is now protected from an agent uploading an older local copy without a base version. The update stops with a version conflict, leaving the current content unchanged.

<!-- more -->

Before replacing content, get the full latest source and its version. Reapply your change and send that version with CLI `--expected-version`, API `expected_version`, or MCP `expected_version_id`. A stale base also stops the update. On conflict, the error identifies the current version and a `read_target`: get the latest source again, reapply your change, and resend with that version. Use CLI `artifacts get` for a single file, `download` for a static site, or MCP `get_artifact`; retrieve the full source before editing it.

For an intentional overwrite, CLI `update --force` and `share --key <key> --force`, or API `force=true`, skip the version check. Do not combine force with a base version. Permissions, storage limits, and content checks still apply. MCP has no force input.

Updates without a base to versions created by CLI, MCP, or API continue as before, without new warnings. Older versions have unknown provenance and also retain that behavior. Profiles created with `login --preset agent` still need a base unless an intentional force override is used. The CLI does not track versions in local files.
