---
title: Scope AI agent CLI access to one project
date: 2026-08-12
products: [web, cli]
kind: improve
---

Artifact Share CLI 0.11.0 adds a login preset for AI agents. Run `artifactshare login --preset agent` and choose one project in your browser to create a CLI session limited to that project.

<!-- more -->

The session can view shared files, post and update files created by the agent, and comment on files it can access. It cannot delete or move files, change who can view them, or manage the project. These permissions are also enforced by the server.

For a new profile, omitting `--preset` keeps the CLI's existing access to everything allowed for your account. Signing in again to an existing profile keeps its previous preset. To restore unrestricted access, pass `--preset unrestricted` explicitly. To separate credentials by use case, add `--profile <name>` and sign in to a different profile.

After switching to a restricted profile, revoke credentials you no longer need. For a browser-authenticated CLI session, run `artifactshare logout --profile <name>` or revoke it from Settings → Tokens. Revoke API tokens from Settings → Tokens.
