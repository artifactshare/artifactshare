---
title: Collaborators can now add a new version at the same URL
date: 2026-09-02
products: [web, cli, agent]
kind: new
notice: true
---

Collaborators can now add a new version at the same URL instead of asking the file's owner to update it. This applies to workspace members when a file is shared with its workspace or project. When the file's workspace allows uploads from external members, someone whose email address was added directly can also update it after signing in with Google or Microsoft.

In the browser, add a version from the version control in the lower-right corner of the file. In the CLI, use the same `artifactshare update` command as before.

<!-- more -->

The URL and owner do not change. Earlier content stays in version history, which also shows who added each version. Adding a version does not transfer ownership or grant access to sharing controls. When an external person's access is removed, they can no longer view or update the file.

Workspace members can also rename files shared with their workspace or project and move them to projects they can access. People outside the workspace can only add a new version.

An agent assigned to a project can also add versions to files in that project when they are shared with the project or workspace. This access does not extend to the inbox, files shared only with specific people or by link, or other projects.

When several people may be working at once, pass the version you started from with the CLI's `--expected-version` option. If another update landed first, Artifact Share stops with a conflict instead of overwriting it. This option is required for agent updates.
