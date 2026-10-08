---
title: Choose how many versions each file keeps
date: 2026-10-08
products: [cli]
kind: new
---

File owners can now choose how many versions each file keeps. For files that gain a version on every run, such as a dashboard updated on a schedule, older versions are deleted automatically and their storage is released.

In the CLI, `artifactshare edit <file> --retain-versions 24` keeps only the latest 24 versions. `--retain-versions all` removes the limit and keeps every version again.

<!-- more -->

Versions beyond the limit are deleted as soon as you set or lower it, and again each time a new version is added. The current version is always kept. The result reports how many versions were deleted (`deleted_versions`). Deleted versions cannot be restored.

Version numbers stay the same when older versions are deleted. Comments on a deleted version remain with their quoted text. Opening a deleted version through its version URL shows the not-found page.

Only the file's owner can change this, and it requires unrestricted credentials; agent credentials cannot change it. In the API, pass a positive integer or `null` as `retain_versions` to `POST /api/cli/shareables/:id/edit`. When a file has a limit, its version history shows a note such as "Keeping the latest 24 versions".
