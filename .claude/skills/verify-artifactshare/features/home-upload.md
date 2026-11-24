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
- **Whole journey.** Run `node .claude/skills/verify-artifactshare/scripts/journeys/home-upload.mjs`. It prints one `ok` line per step and ends with `PASS home-upload`. The evidence is in `evidence/home-upload/`.
- **Choose a file.** Start `page.waitForEvent('filechooser')`, click the button whose name starts with `Drop an HTML / Markdown / PDF / MP4 file` (a single-file chooser), then call `chooser.setFiles(path)` with a file containing a unique marker heading.
- **Result.** Without another click, the page navigates to the new file's viewer (`/a/<id>`). A toast `Uploaded` appears in `Notifications`, the title button reads `Edit title: <marker>`, the visibility button reads `Private · Change who can view`, and the iframe heading matches the marker.
- **Second view.** `page.goto(run.appOrigin)`. A link named with the marker title appears on Home.
- **Choose a folder.** Same as a file, but with `getByRole('button', { name: 'Upload site folder' })`. The chooser accepts a directory (`setFiles(dir)`), and `index.html` must be at its root. The page moves to `/a/<id>`, the title comes from the site's `<title>`, and the iframe renders the site. The journey's folder writes its heading from `assets/app.js`, which proves the folder's other files load.

## Gotchas

- The dialog contains two `input[type=file]` elements (file and folder). Use the file chooser from the visible button rather than guessing which input to fill.
- The dialog copy says uploading needs Google or Microsoft sign-in. Locally, the dev persona session satisfies that requirement.
- Folder upload needs `index.html` at the folder root. The fixtures under `fixtures/static-sites/` (git-ignored, built by `pnpm fixtures:build`) all have the same title, `Vite + React`, so do not use them when you need to tell uploads apart.
- The page title comes from the HTML `<title>`. Use the marker there as well as in the heading, or the title assertion fails.
