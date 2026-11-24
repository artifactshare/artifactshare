# Comments

People viewing a file open the Comments panel to read threads, select text inside the file to start an inline comment, reply, and resolve. Agents and scripts do the same through `artifactshare comments`.

## Sub-features

- `comments-panel` opens the `Comments` dialog with `Open` / `All` / `Resolved` tabs.
- `comments-inline` starts a thread by selecting text in the rendered file.
- `comments-cli-post` posts a comment, optionally anchored with `--quote`, from the CLI.
- `comments-reply-resolve` replies to a thread and resolves it.

## How to get to it (user POV)

- Viewer (`/a/<id>`) › the `Comments` button in the top bar.
- Select text inside the file content, then `Add comment` (a `Comment` button at the bottom of the viewer).
- Terminal: `artifactshare comments list|post|resolve|reopen|edit|delete <id-or-url>`.

## Driving it with Playwright and the CLI

Preconditions:

- `stack.mjs doctor` is all `ok`. The journey shares its own file and creates its own token.

- **Whole journey.** Run `node .claude/skills/verify-artifactshare/scripts/journeys/comments.mjs`. It prints one `ok` line per step and ends with `PASS comments`. The evidence is in `evidence/comments/`.
- **CLI post.** `runCli(..., ['comments', 'post', url, '--body', body, '--quote', 'brown fox', '--json'], { token })` exits `0`. `data.thread.status` is `open`, and `data.thread.anchor.quoted_text` is the quote.
- **Open panel.** Click `getByRole('button', { name: 'Comments', exact: true })`. A dialog named `Comments` shows the `Comment filter` tablist with `Open` selected. Each thread is an `article` showing the quote in curly quotes (`“brown fox”`), the author (`Free owner`), the body, and the `Resolve`, `More actions`, `Comment actions`, and `Reply` buttons. A new file shows `No comments here` / `Select text in the file to add a comment.`
- **Inline comment.** Close the panel, then triple-click a paragraph inside `page.frameLocator('iframe').first()`. A `Add comment` button appears. Click it to open a region named `Add comment` with a blockquote of the selection, a `New comment` textbox, and a `Comment` button that stays disabled until you type. Fill the textbox and click `Comment` (exact). The region closes, and the panel lists the new thread.
- **Reply.** In the thread, click `Reply`. A `Reply` textbox (placeholder `Write a reply`), `Cancel`, and a second `Reply` button appear, and `Resolve` is disabled while the draft is open. Submit with the last `Reply` button. The textbox closes, and the reply shows as a paragraph in the thread.
- **Resolve.** Click `Resolve`. The thread leaves the `Open` tab and is listed under the `Resolved` tab.
- **Second view.** `runCli(..., ['comments', 'list', url, '--json'], { token })` exits `0`, and its stdout contains both thread bodies and the reply.

## Gotchas

- `getByRole('button', { name: 'Comments' })` without `exact: true` also matches the title button when the file title contains "comments". The `Comment` button in the composer needs `exact: true` too.
- `Meta+Enter` in the reply box does not submit. Use the box's own `Reply` button.
- While a reply draft is open, `Resolve` is disabled. Submit or cancel the draft first.
- The selection happens inside the sandbox iframe, on another origin. The `Add comment` button and the composer appear in the parent page, not in the frame.
- Assert on unique body text, not on counts. Other journeys on the same run may have added threads.
- There is no `comments add`. The command is `comments post`.
