---
name: artifact-share
description: Share, update, find, read, comment on, and organize HTML or Markdown artifacts with Artifact Share. Use when the user asks to save or manage content in Artifact Share or wants a durable Artifact Share link.
---

# Artifact Share

Use the connected Artifact Share MCP tools for live data and changes. Do not
claim that an operation succeeded unless the tool result confirms it.

## Choose the workflow

- For a new artifact, call `share_artifact` with complete HTML or Markdown
  source. Respect an explicit visibility, project, audience, expiry, or Slack
  notification choice. Do not invent recipients or widen visibility.
- To replace content at the same URL, find the artifact if necessary, then call
  `update_artifact` with the complete replacement source. Use
  `append_artifact` only when the user explicitly wants to add exact content to
  the existing source.
- When the user identifies an artifact by title, use `list_artifacts` and
  require one exact match before a read or mutation. Ask the user to choose if
  there is no unique exact match.
- Use `get_artifact` for source and version history, `preview_artifact` for the
  interactive card, and `list_comments` before acting on an existing comment
  thread.
- Use project and settings tools only for the requested organizational or
  sharing change. Never infer email addresses, project IDs, or access changes.

## Unsupported inputs

`share_artifact` accepts source text for one HTML or Markdown document. It
cannot upload PDFs, office documents, arbitrary binary files, local paths, or
static-site folders. Explain the limitation instead of converting the content
or calling the tool unless the user explicitly asks for an HTML or Markdown
alternative.

## Confirm results and risky changes

- After sharing, updating, appending, or editing an artifact, include the full
  returned `share_url` and the returned visibility when present in the final
  response.
- For destructive or access-changing tools, preserve the host confirmation
  step. Call them only when the user clearly requested that exact change.
- If a tool reports that authentication, permission, plan, storage, or a
  destination prevents the operation, report that reason and the stated next
  step. Do not retry an unchanged destructive request.
