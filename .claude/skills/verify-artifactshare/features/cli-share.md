# Share with the CLI and view

A user creates an API token in Settings, shares a local HTML or Markdown file with `artifactshare share`, and opens the returned `/a/<id>` URL. The file's content renders inside the sandboxed viewer frame, the file shows up on Home, and `update` adds a new version at the same URL.

## Sub-features

- `token-create` issues an API token from Settings › AI tools and CLI and shows its value once.
- `cli-whoami` reports the signed-in dev persona for that token.
- `cli-share` creates an artifact and returns its URL on the run's app origin.
- `viewer-render` renders the shared content inside the sandbox iframe.
- `home-list` lists the new file on Home (Recently seen and the My files rail).
- `cli-update` adds a new version at the same URL (the version badge moves from `v1` to `v2`).

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
- **Share.** `runCli(..., ['share', file, '--visibility', 'private', '--json'], { token })` exits `0`. `data.artifact.url` starts with the run's `appOrigin`, and `data.result.created` is `true`.
- **View.** `page.goto(url)`, then `page.frameLocator('iframe').first().getByRole('heading', { name: marker })` becomes visible. The top bar shows `Private · Change who can view` and `Version status: v1`.
- **Home.** `page.goto(run.appOrigin)`. A link named with the marker title appears under `Recently seen` and in the `My files` rail.
- **Update.** `runCli(..., ['update', url, changedFile, '--json'], { token })` exits `0`. Reload the viewer. The frame shows the changed heading, and the version button reads `Version status: v2`.
- **Second view.** `runCli(..., ['artifacts', 'list', '--json'], { token })` stdout includes the marker title.

## Gotchas

- `share --json` puts the URL at `data.artifact.url`, not `data.url`.
- Without `--visibility`, a Free persona's Home share is `private`, and a team persona may default to workspace. Pass the visibility you mean to assert.
- The viewer shell (title, `Copy link`) renders even when the sandbox is down. Only the heading inside the iframe proves the content rendered.
- The CLI defaults to production. `runCli` always sets `ARTIFACTSHARE_BASE_URL`, so never call `packages/cli/dist/index.js` directly without it.
- The token value is in the `01-token-created` evidence. It is valid only for this run's local state, which `down` deletes.
