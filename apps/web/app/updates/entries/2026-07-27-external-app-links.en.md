---
title: Open external app links from shared pages
date: 2026-07-27
products: [web]
kind: improve
---

Links using `cursor:`, `vscode:`, `codex:`, `claude:`, or `claude-cli:` in shared HTML, Markdown, and static sites can now open their corresponding apps from Artifact Share Viewer. A shared file can lead to Cursor MCP settings, files or settings in VS Code, or a new task in Codex, Claude, or Claude Code. Nothing launches automatically: the Viewer requires a real click on an existing link, followed by the browser's confirmation. This change does not add a new Viewer button, and URL schemes outside the allowlist remain blocked.
