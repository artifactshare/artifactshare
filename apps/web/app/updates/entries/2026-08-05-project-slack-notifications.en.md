---
title: Slack notifications for project uploads
date: 2026-08-05
products: [web, cli, mcp]
kind: new
---

Teams post files to a shared project but only the people who go check the project notice new work. Sharing a link manually in Slack every time is easy to forget.

A project can now be linked to one Slack channel. Start from Project detail → "…" menu → "Slack notification", and pick the channel on Slack's own authorization screen. Any channel you belong to works, including private ones. When a new file is posted to a linked project, the channel gets an automatic message with the title, uploader, and link. Multiple uploads posted in a short window are combined into a single message.

<!-- more -->

Anyone who doesn't want a specific upload announced can suppress it: check "Don't notify Slack this time" on the web upload screen, pass `--no-slack-notify` in the CLI, or set `slack_notify: false` when calling `share_artifact` via MCP. Version updates to an existing file never trigger a notification — only new posts do. Files shared with specific people only are never announced, regardless of the setting. Notifications are sent in batches every few minutes, so a message can arrive a few minutes after the upload.
