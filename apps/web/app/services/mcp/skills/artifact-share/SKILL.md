---
name: artifact-share
description: Share, update, find, read, comment on, and organize HTML or Markdown artifacts with Artifact Share. Use when the user asks to save or manage content in Artifact Share or wants a durable Artifact Share link.
---

# Artifact Share

Use the connected Artifact Share MCP tools for live data and changes. Do not
claim that an operation succeeded unless the tool result confirms it.

The browser share page opens HTML, Markdown, and static sites with its URL fragment (`#…`) and follows fragment changes inside the frame. Copy link includes the current fragment, so filtered views and Markdown headings can be shared. For static sites, only the entrypoint updates the share fragment; subpages leave it unchanged. This does not change CLI local preview.

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

## Comment windows and posting limits

`list_comments({id})` returns at most 50 threads, open first. Each
thread contains its current first message and latest three replies, plus
`message_count`, `reply_count` and `older_cursor`. These are partial histories.
Use `list_comments({id, thread_id, before: older_cursor, limit: 50})` for older replies. Repeat with the returned cursor until it is null;
merge by message ID and display in `(created_at, message_id)` order. Each page
also includes the current first message. Cursors remain usable after their
boundary message is deleted. `around_message_id` selects a bounded page
containing a message; do not combine it with `before`.

A thread holds 500 currently stored messages, including its first message.
`thread-capacity` means start a new thread. Existing excess messages are kept;
deletions can restore space. Deleting the first message promotes the next
earliest message; deleting the last removes the thread and anchor. Resolved
threads still refuse replies.

Creation and replies share 20 admissions per authenticated user and artifact
per fixed UTC minute across browser, CLI, MCP and API tokens. Adjacent minute
boundaries can admit 40 posts within a sliding 60 seconds. `rate-limited`
includes `retry_after_seconds` and UTC `retry_at`; HTTP also sends `Retry-After`.
Keep unsent content and retry after that time. Invalid requests, capacity refusals
and closed-thread refusals observed before admission consume nothing. Rate
refusals do not increment the counter; quota storage failures refuse the post.
Once admitted, commit failures and status/version/capacity races consume the admission without a
refund. Edits, deletions, resolve/reopen and anchor reports consume nothing.
Mutation readback contains only the affected thread window and changed message.
`refresh_required: true` means the write committed but advisory readback failed:
read that thread by ID; do not replay the write automatically.
