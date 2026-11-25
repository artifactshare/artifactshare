# Who can view

The owner changes who can view a file: only specific people (the default for a Free Home file) or anyone with the link. The owner adds specific people by email. The same change is available from the CLI. People without access get a refusal page instead of the file.

## Sub-features

- `share-dialog` opens `Change who can view this file` from the visibility button in the viewer top bar: the audience menu, the pending-change footer, the link expiry field, and the copy actions for a link-shared file.
- `share-people` adds a person by email, and the change applies after `Save`.
- `share-denied` shows a refusal page to a signed-in person without access and a sign-in page to a signed-out visitor.
- `share-link` turns on link sharing, so a signed-out visitor can open the URL.
- `share-cli` changes visibility with `artifactshare edit <id-or-url> --visibility <value>`.

## How to get to it (user POV)

- Viewer top bar › the visibility button (`Private · Change who can view` for a private file).
- In the dialog, the audience button (`Specific people …`) opens a menu with `Specific people` and `Anyone with the link`.
- The `Add a file` dialog › `Who can view` (before uploading).
- Terminal: `artifactshare edit <id-or-url> --visibility private|workspace|project|link` (link needs `--no-link-expiry` or `--link-expires-at`), and `artifactshare share <path> --grant-email <email>`.

## Driving it with Playwright and the CLI

Preconditions:

- `stack.mjs doctor` is all `ok`. The journey shares its own private file as `Free owner`.

- **Whole journey.** Run `node .claude/skills/verify-artifactshare/scripts/journeys/sharing.mjs`. It prints one `ok` line per step and ends with `PASS sharing`. The evidence is in `evidence/sharing/`.
- **Refused member.** `signIn(run, { persona: 'Plus owner', next: '/a/<id>' })`. The page shows the heading `You can't view this file`, the signed-in email, and the `Request access` and `Switch account` buttons. No viewer frame.
- **Open dialog.** As the owner, click `Private · Change who can view`. A dialog named `Change who can view this file` shows `Specific people` with `People including you: 1` and the owner row (`Free owner(you)`, `· Owner`).
- **Add a person.** Fill the `Enter a name or email address` combobox with the `Plus owner` persona email (`dev-plus-owner` at the `artifactshare.local` domain), then click `Add` (exact). The count becomes 2, and the new row reads `Plus owner … · Viewer Unsaved` with a `Remove …` button. `Cancel` and `Save` buttons appear. Click `Save`, and `Unsaved` disappears.
- **Allowed member.** Reload the member's page. The file content renders in the iframe.
- **Signed-out visitor.** Use `launchBrowser()` (no cookies) and open the URL. The page shows `Sign in to view this file` with `Continue with Google`, `Sign in with Microsoft`, and `Sign in with email`. No viewer frame.
- **Dialog footer.** With nothing changed the footer (`[data-slot="dialog-footer"]`) holds one button, `Close`. A pending change adds `Cancel` before `Save`. Clicking `Close` with nothing pending posts no save.
- **Audience menu.** The audience button is named after the current audience, so locate it as the dialog's collapsed menu button (`getByRole('button', { expanded: false })`), then pick a `menuitemradio` named after `upload.visibility.<visibility>`. The people list is shown for `private`, `workspace` and `project`, not for `link`.
- **Link expiry.** Choosing `Anyone with the link` shows the `Link expiry date` textbox filled with the policy default (30 days out on a Free workspace) and a `No expiration` checkbox. Emptying the date disables `Save`, sets `aria-invalid`, and fills the `aria-describedby` element with the required-date message. Abandoning an expiry edit by switching the audience back leaves nothing to save.
- **What Save posts.** The journey watches `POST /api/shareables/<id>/save`. Switching to link and saving posts `{"visibility":"link"}`; adding a person and restoring the expiry date posts only `{"addEmails":[…]}`; `No expiration` posts `{"link_expires_at":null}`, and unchecking it restores the finite default and posts that date. While the save is in flight (held with `page.route`), the audience button, the expiry field and `Save` are disabled and the footer's `status` announces the save.
- **Copy actions.** A link-shared file's dialog shows the read-only `Share link` field, `Copy link`, and `Open as a recipient` (`target="_blank"`, `rel="noopener noreferrer"`) with the same URL. With clipboard permissions granted, `Copy link` writes that URL to the clipboard, the already-mounted `[data-copy-status]` live region announces it, and a signed-out visitor opens the copied URL. The announcement clears after 2.2s.
- **Link sharing via CLI.** `runCli(..., ['edit', url, '--visibility', 'link', '--no-link-expiry', '--json'], { token })` exits `0`. The signed-out visitor now sees the content at the same `/a/<id>` URL. The owner's top-bar button reads `Link sharing · Change who can view`.

## Gotchas

- The visibility button's accessible name is `<current audience> · Change who can view`, so it changes with the state. Match on the `Change who can view` suffix when the state is unknown.
- Adding a person does nothing until `Save`. A test that stops at `Add` proves nothing.
- `edit --visibility link` without an expiry option is rejected. Pass `--no-link-expiry` or `--link-expires-at`.
- Email invitations are not delivered locally. Prove access by signing in as the other persona, not by checking an inbox.
- A save that leaves the file private closes the dialog, so read the saved state by reopening it. A save that leaves the file link-shared keeps it open.
- The grant input commits a valid address on blur, so after the audience menu restores focus, press `Enter` in the input instead of clicking `Add`.
- The local link URL is `https://<id>.localhost:<app port>/`, which Chromium resolves to loopback.
- The public repo scan rejects literal email addresses in tracked files. Build persona emails in code (the journey joins the two parts).
