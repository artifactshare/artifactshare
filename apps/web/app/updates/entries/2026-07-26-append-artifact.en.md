---
title: Append content without resending a shared file
date: 2026-07-26
products: [cli, mcp]
kind: new
---

Artifact Share CLI 0.8.2’s `artifactshare append <target> <path>` and remote MCP’s `append_artifact` append content to a single shared file and create a new version at the same share link. For Markdown, they append to the end of the current source. For HTML, they append immediately before the closing `body` tag when present, or at the end otherwise. Neither adds a newline or separator.

If another update lands first, the operation preserves it and returns `version_conflict` with the current version ID. Run the operation again to append to the latest version. Static sites are not supported. To replace the full source, use CLI `update` or MCP `update_artifact`.
