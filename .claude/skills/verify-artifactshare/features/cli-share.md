# Share with the CLI and view

A user creates an API token in Settings, shares a local HTML or Markdown file with `artifactshare share`, and opens the returned `/a/<id>` URL. The file's content renders inside the sandboxed viewer frame, the file shows up on Home, and `update` adds a new version at the same URL.

## Sub-features

- `token-create` issues an API token from Settings › AI tools and CLI and shows its value once.
- `cli-whoami` reports the signed-in dev persona for that token.
- `cli-share` creates an artifact and returns its URL on the run's app origin.
- `viewer-render` renders the shared content inside the sandbox iframe.
- `home-list` lists the new file on Home (Recently seen and the My files rail).
- `cli-update` adds a new version at the same URL (the version badge moves from `v1` to `v2`).
- `cli-share-directory` uploads a folder in one request, each file under its path inside it (`assets/style.css`).
- `cli-insecure-localhost` is what lets the CLI talk to a local HTTPS run at all; without it the request never leaves.

## How to get to it (user POV)

- Settings › `AI tools and CLI` (`/settings/tokens`) › `Name` textbox › `Create token`.
- Terminal: `artifactshare whoami`, `artifactshare share <path>`, `artifactshare update <id-or-url> <path>`, `artifactshare artifacts list`.
- Open the URL printed by `share` in a browser, or choose the file's link on Home.

## Driving it with Playwright and the CLI

Preconditions:

- `stack.mjs doctor` is all `ok`.
- The persona (`Free owner` by default) has no token named `verify-<run id>` yet.

- **Whole journey.** Run `node .claude/skills/verify-artifactshare/scripts/journeys/cli-share-view.mjs`. It prints one `ok` line per step and ends with `PASS cli-share`. The evidence is in `evidence/cli-share/`.
- **Create token.** `signIn(run, { next: '/settings/tokens' })`, fill `getByRole('textbox', { name: 'Name' })`, click `getByRole('button', { name: 'Create token' })`. A `status` region with heading `Token created: <name>` shows the token in a `code` element (`ast_…`), and a row `<name> now — Revoke <name>` appears in the API tokens table.
- **Whoami.** `runCli(..., ['whoami', '--json'], { token })` exits `0`, and stdout reports the `dev-free-owner` persona (email domain `artifactshare.local`).
- **Without the flag.** The same call with `{ insecureLocalhost: false }` exits non-zero and prints `{ ok: false, error: { code: 'network_failed', why: 'fetch failed' } }` on stderr: the run's development certificate is not one the CLI trusts, so the app never answers. With the flag and a bad token the app answers `token_invalid` instead, which is the difference between "not reached" and "rejected".
- **Share.** `runCli(..., ['share', file, '--visibility', 'private', '--json'], { token })` exits `0`. `data.artifact.url` starts with the run's `appOrigin`, and `data.result.created` is `true`.
- **View.** `page.goto(url)`, then `page.frameLocator('iframe').first().getByRole('heading', { name: marker })` becomes visible. The top bar shows `Private · Change who can view` and `Version status: v1`.
- **Home.** `page.goto(run.appOrigin)`. A link named with the marker title appears under `Recently seen` and in the `My files` rail.
- **Update.** `runCli(..., ['update', url, changedFile, '--json'], { token })` exits `0`. Reload the viewer. The frame shows the changed heading, and the version button reads `Version status: v2`.
- **Share a directory.** `runCli(..., ['share', dir, '--visibility', 'private', '--json'], { token })` exits `0`. Open the URL: the frame shows `index.html`'s heading, and `getComputedStyle(document.querySelector('h1')).color` inside the frame is the colour from `assets/style.css`, which only holds if the stylesheet arrived under its path in the directory.
- **Share Markdown.** `share notes.md` renders as a heading in the frame, so it was stored and served as Markdown, not as a download.
- **Second view.** `runCli(..., ['artifacts', 'list', '--json'], { token })` stdout includes the marker title.

## Gotchas

- `share --json` puts the URL at `data.artifact.url`, not `data.url`.
- Without `--visibility`, a Free persona's Home share is `private`, and a team persona may default to workspace. Pass the visibility you mean to assert.
- The viewer shell (title, `Copy link`) renders even when the sandbox is down. Only the heading inside the iframe proves the content rendered.
- The CLI defaults to production. `runCli` always sets `ARTIFACTSHARE_BASE_URL`, so never call `packages/cli/dist/index.js` directly without it.
- The token value never reaches the evidence: `capture` masks it in `01-token-created.png` and writes `[redacted api token]` in its ARIA text, and `runCli` redacts it from the recorded command and streams. It lives only in the journey's memory and the run's local state, which `down` deletes.
- `--json` prints a success to stdout and a failure to stderr. `runCli` parses whichever one is JSON, so read `result.json.error` for a failure.
- The CLI reports a refused certificate as `network_failed` with `why: fetch failed`; undici does not pass the TLS reason through. The proof is the contrast with the same call that carries the flag.
