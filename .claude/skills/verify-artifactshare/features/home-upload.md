# Upload from Home

A signed-in user chooses `Add a file` on Home, picks a single HTML, Markdown, PDF, or MP4 file (or a built site folder), chooses who can view it, and gets a new file that opens in the viewer and appears on Home.

## Sub-features

- `upload-open` opens the `Turn AI-generated files into shareable links` dialog with the destination `Save to <persona>'s home`.
- `upload-file` uploads one file from the file chooser.
- `upload-folder` uploads a built static-site folder via `Upload site folder`.
- `upload-audience` sets who can view before uploading (`Who can view`, default `Specific people`).

## How to get to it (user POV)

- Home (`/`) › `Add a file` button.
- Dragging a file onto the drop area in that dialog.

## Driving it with Playwright and the CLI

Preconditions:

- Signed in with `signIn(run, { next: '/' })`, and the `Home` heading is visible.

- **Open dialog.** Click `getByRole('button', { name: 'Add a file' })`. A dialog named `Turn AI-generated files into shareable links` shows `Save to` › `Free owner's home`.
- [unobserved] **Choose a file.** Start `page.waitForEvent('filechooser')`, click the button whose name starts with `Drop an HTML / Markdown / PDF / MP4 file`, then call `chooser.setFiles(path)` with a file containing a unique marker heading.
- [unobserved] **Choose a folder.** Same as above with `getByRole('button', { name: 'Upload site folder' })`. Use a built site from `fixtures/static-sites/` (`pnpm fixtures:build` creates them).
- [unobserved] **Result.** The app opens the new file's viewer (`/a/<id>`), or offers a link to it. The iframe heading matches the marker. Capture before and after.
- [unobserved] **Second view.** `page.goto(run.appOrigin)`. The marker title is listed under `Recently seen` and `My files`.

## Gotchas

- The dialog contains two `input[type=file]` elements (file and folder). Use the file chooser from the visible button rather than guessing which input to fill.
- The dialog copy says uploading needs Google or Microsoft sign-in. Locally, the dev persona session satisfies that requirement.
- Folder upload needs `index.html` at the folder root. The fixtures under `fixtures/static-sites/` are git-ignored and need `pnpm fixtures:build`.
- Not yet proven end to end in this map. The first run that drives it should record the exact post-upload state here.
