# Comments

People viewing a file open the Comments panel to read threads, select text inside the file to start an inline comment, reply, and resolve. Agents and scripts do the same through `artifactshare comments`.

## Sub-features

- `comments-panel` opens the `Comments` dialog with `Open` / `All` / `Resolved` tabs.
- `comments-inline` starts a thread by selecting text in the rendered file.
- `comments-cli-post` posts a comment (optionally anchored with `--quote`) from the CLI.
- `comments-reply-resolve` replies to a thread and resolves or reopens it.

## How to get to it (user POV)

- Viewer (`/a/<id>`) › `Comments` button in the top bar.
- Select text inside the file content, then use the comment popover.
- Terminal: `artifactshare comments list|post|resolve|reopen|edit|delete <id-or-url>`.

## Driving it with Playwright and the CLI

Preconditions:

- A file shared on this run (run the `cli-share` journey first, or share one with `runCli`), and its URL and token.

- **Open panel.** On the viewer, click `getByRole('button', { name: 'Comments' })`. A dialog named `Comments` shows the `Comment filter` tablist (`Open` selected) and, on a new file, `No comments here` / `Select text in the file to add a comment.`
- [unobserved] **CLI post.** `runCli(..., ['comments', 'post', url, '--body', marker, '--quote', '<text from the file>', '--json'], { token })` exits `0`.
- [unobserved] **See it in the UI.** Reload the viewer and open `Comments`. The thread with the marker body is listed under `Open`. Capture it.
- [unobserved] **Inline comment.** Inside `page.frameLocator('iframe').first()`, select a word in the heading (triple-click or drag), then use the comment popover that appears in the shell to type and submit. The new thread appears in the panel.
- [unobserved] **Resolve.** Resolve via the thread's control in the panel, or via `comments resolve`. The thread moves from `Open` to `Resolved`. Confirm with `comments list --json`.

## Gotchas

- The selection happens inside the sandbox iframe, on a different origin. Focus the iframe before selecting, and expect the popover in the parent page, not in the frame.
- A comment's body is the proof. Assert on the marker text, not on a count, because other journeys on the same run may have added threads.
- Run `comments post --help` for the flag list. There is no `comments add`.
- Not yet proven end to end in this map.
