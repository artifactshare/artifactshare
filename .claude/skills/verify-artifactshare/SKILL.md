---
name: verify-artifactshare
description: Launch a private local Artifact Share stack (web app + sandbox Worker, empty D1/R2) and prove behavior the way a user sees it, through the browser UI (Playwright, dev persona sign-in) and the artifactshare CLI. Use when you need evidence that a change to apps/web or packages/cli works in the real app, not just in unit tests, or to reproduce a user-facing bug.
---

# Verify Artifact Share

Artifact Share's primary surface is the web app (`apps/web`, React Router on the Cloudflare Vite plugin). Users reach it two ways: the browser UI and the `artifactshare` CLI (`packages/cli`). Shared HTML and Markdown render inside a sandbox Worker on a second origin, so a viewer proof needs both processes. This skill starts both on free ports with their own state, so it never touches a developer's `pnpm dev` on 5173/5174 or the checkout's `.wrangler/state`.

All paths below are relative to the repository root (`public/`). The helpers live in `.claude/skills/verify-artifactshare/scripts/`.

## Prerequisites

```sh
pnpm install --frozen-lockfile                             # after every lockfile change
pnpm --filter @artifactshare/web exec playwright install chromium   # once per checkout
pnpm --filter @artifactshare/cli build                     # after every change under packages/cli/src or packages/contract/src
```

The journeys run `packages/cli/dist`. `runCli` refuses to run when any file in `packages/cli/src` or `packages/contract/src` is newer than the build, so a CLI change is never proven with the previous build. The web app needs no build, because Vite serves the current source.

`stack.mjs up` runs the repo's own `prepareDevEnvironment` (from `scripts/dev-setup.mjs`), which creates `.dev-certs/` (mkcert) and `.dev.vars` if they are missing. If it fails, it prints the recovery command. Run that command and do not work around it.

## Launch

```sh
node .claude/skills/verify-artifactshare/scripts/stack.mjs up [--run <id>]
```

- Creates `.verify-artifactshare/runs/<id>/` (gitignored). The default id is a timestamp.
- Applies `apps/web/db/schema.sql` to an empty `state/` directory, then starts:
  - `app`: `pnpm dev:app` with `ARTIFACTSHARE_DEV_APP_PORT`, `ARTIFACTSHARE_DEV_SANDBOX_PORT`, `ARTIFACTSHARE_DEV_PERSIST_PATH`, and `ARTIFACTSHARE_DEV_VARS_PATH` pointing at a per-run copy of `.dev.vars` (its `BETTER_AUTH_URL` is rewritten to the run's port).
  - `sandbox`: `wrangler dev -c wrangler.sandbox.jsonc --persist-to state/` on its own port with the same vars.
  Each process runs in its own process group. Logs go to `logs/app.log` and `logs/sandbox.log`.
- **Ready** means all of these pass: both process groups are alive, `/dev/sign-in` returns the `Local dev sign-in` page, the sandbox answers `401 Invalid token` for a probe host, and a `free-owner` dev sign-in yields a session with a user. A port answering is not enough. The command prints `READY <id>` and exits 0. It usually takes 20–60 s, and it gives up after 180 s.
- The OG image worker (5175) is not started. Nothing in the mapped journeys needs it.
- Two runs can coexist (different ports and state, verified by running the journey on two stacks at once). Run journeys against the run you started. Without `--run <id>` or `VERIFY_RUN`, `doctor`, `down`, and `openRun()` pick the newest run by `startedAt` that is not stopped yet.

## Doctor

```sh
node .claude/skills/verify-artifactshare/scripts/stack.mjs doctor [--run <id>]
```

This read-only check prints `ok`/`FAIL` per line for both process groups (recorded in `run.json`), `/dev/sign-in`, and the sandbox probe, plus the run's origins and state and evidence paths. It also prints an `info source revision` line with the commit the dev server started from. `changed since start` only means the working tree is dirty or HEAD moved, and Vite still serves the edited files. Run it first whenever anything looks off. If a line shows `FAIL`, read `logs/*.log`. The persona sign-in check runs only in `up`, because it writes a session row.

## Drive

Two harnesses, both through `scripts/harness.mjs`:

- **Browser (Playwright, `require('playwright')` from `apps/web`)**: `signIn(run, { persona, next })` opens `/dev/sign-in?next=<path>` and clicks the persona button (`Free owner`, `Plus owner`, `Team owner`, `Team member`). That page is the dev-only stand-in for Google sign-in. Set `HEADED=1` to watch.
  - Locate by role and accessible name, as the feature files list them, e.g. `page.getByRole('button', { name: 'Add a file' })` or `getByRole('button', { name: 'Private · Change who can view' })`.
  - Artifact content lives in an iframe from `a-…usercontent.localhost:<sandbox port>`, so use `page.frameLocator('iframe').first()` to assert on it.
  - The signed-in top bar shows a button named after the persona email (`dev-<persona>@artifactshare.local`). `signIn` waits for it.
  - `launchBrowser()` opens a context with no cookies, for a signed-out visitor. For a second viewer of the same session (another locale, a phone viewport, scripting off), open a context from `browser.newContext({ storageState: await context.storageState(), … })`.
  - `stableBox(locator)` returns the box once it stops moving, for an assertion about where something sits: panels and toasts slide in, so a box read right after `waitFor` can be a frame of the animation. To ask what a user can see at a point, `page.evaluate` with `document.elementFromPoint` and `element.contains`.
  - `uiText(locale, key, vars)` and `countedLabel(locale, stem, n)` read the app's own catalog. Assert a value the app renders (a count, a state label) through them, so rewritten copy does not fail a journey, and keep literal English for the role names the feature files list as handles.
- **CLI**: `runCli(run, feature, name, args, { token, cwd })` runs `packages/cli/dist/index.js` with `ARTIFACTSHARE_BASE_URL=<run app origin>`, `--insecure-localhost`, a throwaway `HOME` and `ARTIFACTSHARE_CONFIG_HOME` under the run, and the native token store disabled. It never reads the developer's saved production credentials. Get the token the way a user does: `createApiToken(page, run, name)` creates it in Settings › AI tools and CLI and reads the value shown once.
  - The run serves HTTPS with the development certificate, so `runCli` passes `--insecure-localhost`. Pass `insecureLocalhost: false` to see what happens without it. `--json` prints a failure to stderr, and `result.json` is parsed from whichever stream holds it.
  - **Never run the CLI without `ARTIFACTSHARE_BASE_URL`.** Its default is production. Before any write, check that `whoami --json` reports an `@artifactshare.local` email.

Shipped journeys (proven end to end):

```sh
node .claude/skills/verify-artifactshare/scripts/journeys/cli-share-view.mjs [--run <id>]
node .claude/skills/verify-artifactshare/scripts/journeys/home-upload.mjs [--run <id>]
node .claude/skills/verify-artifactshare/scripts/journeys/comments.mjs [--run <id>]
node .claude/skills/verify-artifactshare/scripts/journeys/sharing.mjs [--run <id>]
node .claude/skills/verify-artifactshare/scripts/journeys/projects.mjs [--run <id>]
node .claude/skills/verify-artifactshare/scripts/journeys/viewer-notices.mjs [--run <id>]
```

Each journey uses unique names, so they can run one after another on the same stack.

Write new journeys as `scripts/journeys/<feature>.mjs` that import `harness.mjs`, following that file. The feature map in `features/` lists the handles for each feature.

## Evidence

Everything goes to `.verify-artifactshare/runs/<id>/evidence/<feature>/`:

- `NN-<step>.png` + `NN-<step>.aria.yml` (first line is the page URL) from `capture(run, feature, name, page)`.
- `NN-<step>.cli.json` from `runCli`, containing the exact command, base URL, exit code, stdout, and stderr.
- `steps.json`, which lists each step the journey passed (written even when it fails, so a failure shows how far it got).

Proof standards:

- Drive the real user path: persona sign-in, Settings for tokens, the visible buttons and dialogs, and the CLI. Do not POST to internal endpoints (`/api/shareables/uploads`, `/api/auth/dev/sign-in`) or reuse a session cookie as a Bearer token to skip the UI. The scripts in `scripts/*.mjs` do that for their own purposes, and it does not count as proof here.
- Capture the action and the resulting state. For a mutation, confirm it from a second, read-only view, e.g. a CLI `artifacts list` after a share, or Home after an upload.
- For viewer features, assert on content inside the sandbox iframe. The page shell rendering without the frame content is a failure, not a pass.
- No mocks. The stack is local and self-contained. Stripe, Google OAuth, Slack, and email are not configured, so features that need them are out of reach; report them as unverified and do not fake them.

## Cleanup

```sh
node .claude/skills/verify-artifactshare/scripts/stack.mjs down [--run <id>]
```

This sends SIGTERM (then SIGKILL after 15 s) to the process groups recorded in `run.json`, deletes `state/` and the per-run `dev.vars`, and marks the run stopped. It keeps `evidence/`, `logs/`, `cli-home/`, and `cli-work/`. It never kills by process name or port. Run it after every failed attempt too. To discard old proof, delete `.verify-artifactshare/runs/<id>/` by hand.

Check that the ports are free afterwards: `lsof -nP -iTCP:<app port>,<sandbox port> -sTCP:LISTEN` prints nothing.

## Helpers

| Script | Invocation |
| --- | --- |
| `scripts/stack.mjs` | `node .claude/skills/verify-artifactshare/scripts/stack.mjs up\|doctor\|down [--run <id>]` |
| `scripts/harness.mjs` | `import { openRun, signIn, launchBrowser, capture, countedLabel, createApiToken, runCli, evidenceDir, stableBox, uiText } from '../harness.mjs'` |
| `scripts/journeys/cli-share-view.mjs` | `node .claude/skills/verify-artifactshare/scripts/journeys/cli-share-view.mjs [--run <id>]` |
| `scripts/journeys/home-upload.mjs` | `node .claude/skills/verify-artifactshare/scripts/journeys/home-upload.mjs [--run <id>]` |
| `scripts/journeys/comments.mjs` | `node .claude/skills/verify-artifactshare/scripts/journeys/comments.mjs [--run <id>]` |
| `scripts/journeys/sharing.mjs` | `node .claude/skills/verify-artifactshare/scripts/journeys/sharing.mjs [--run <id>]` |
| `scripts/journeys/projects.mjs` | `node .claude/skills/verify-artifactshare/scripts/journeys/projects.mjs [--run <id>]` |
| `scripts/journeys/viewer-notices.mjs` | `node .claude/skills/verify-artifactshare/scripts/journeys/viewer-notices.mjs [--run <id>]` |

## Feature map

Read [`features/README.md`](features/README.md) before driving a feature. A proof that covers one entry point is incomplete when the map lists others.
