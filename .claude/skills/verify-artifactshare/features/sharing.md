# Who can view

The owner changes who can view a file: only specific people (the default for a Free Home file), everyone in the workspace, or anyone with the link. The owner also adds specific people by email. The same change is available from the CLI.

## Sub-features

- `share-dialog` opens `Change who can view this file` from the visibility button in the viewer top bar.
- `share-people` adds a person by email to the specific-people list.
- `share-link` switches to link sharing, with or without expiry.
- `share-cli` changes visibility with `artifactshare edit <id> --visibility <value>`.
- `share-copy` copies the file URL with `Copy link`.

## How to get to it (user POV)

- Viewer top bar › the visibility button (`Private · Change who can view` for a private file).
- `Add a file` dialog › `Who can view` (before uploading).
- Terminal: `artifactshare edit <id> --visibility private|workspace|project|link`, `artifactshare share <path> --grant-email <email>`.

## Driving it with Playwright and the CLI

Preconditions:

- A private file shared on this run by `Free owner`.

- **Open dialog.** Click `getByRole('button', { name: 'Private · Change who can view' })`. A dialog named `Change who can view this file` shows `Specific people` with `People including you: 1` and the owner row (`Free owner(you)`, `· Owner`).
- [unobserved] **Add a person.** Fill `getByRole('combobox', { name: 'Enter a name or email address' })` with the `Plus owner` persona email (`dev-plus-owner` at the `artifactshare.local` domain, as its account button shows). `Add` becomes enabled. Click it, and the list grows to 2.
- [unobserved] **Prove access.** In a second browser context, `signIn(run, { persona: 'Plus owner', next: '/a/<id>' })`. The iframe content renders. Before the grant, the same persona sees the permission-denied or access-request page. Capture both states.
- [unobserved] **CLI change.** `runCli(..., ['edit', id, '--visibility', 'link', '--json'], { token })` exits `0`, and the top-bar visibility button label changes after a reload.

## Gotchas

- The button's accessible name is `<current audience> · Change who can view`, so it changes with the state. Match on the `Change who can view` suffix when the state is unknown.
- Free plan limits apply. Some audiences need a Plus or Team persona, so check the plan before treating a disabled option as a bug.
- Email invitations are not delivered locally. Prove access by signing in as the other persona, not by checking an inbox.
- Not yet proven end to end in this map.
