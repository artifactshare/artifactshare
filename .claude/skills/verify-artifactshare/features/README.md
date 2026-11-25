# Artifact Share verification map

This directory is the maintained source for verifying Artifact Share's user-facing behavior. Read this index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- A stack started by this run with `stack.mjs up` and a clean `stack.mjs doctor`. The app and sandbox are on the ports printed by `up` (written to `run.json`), not 5173/5174.
- The state starts empty: the fixed dev personas (`Free owner`, `Plus owner`, `Team owner`, `Team member`) exist after their first sign-in, and nobody has files, projects, or tokens yet.
- `packages/cli/dist/index.js` is built, and Playwright Chromium is installed for `apps/web`.
- Never drive a stack that this run did not start, including the developer's `pnpm dev` on 5173.

## Driving conventions

- Browser: `signIn(run, { persona, next })` from `scripts/harness.mjs`, then role + accessible name locators. Artifact content is inside `page.frameLocator('iframe').first()`.
- CLI: `runCli(run, feature, name, args, { token })` with a token from `createApiToken`. Always confirm `whoami --json` reports `@artifactshare.local` before a write.
- Use a unique marker string (e.g. `Verify <feature> <Date.now()>`) in titles and content so assertions never match leftovers from an earlier journey on the same run.
- Mutations stay in the run's own state, and `stack.mjs down` deletes that state. There is no shared data to restore.

## Observed and unobserved steps

Every driving bullet in this map was observed on a live run: the handles and end states it names were seen. When you add a step you have not run yet, tag it `[unobserved]` and state the expected end state. The first run that drives it confirms or corrects the bullet and removes the tag.

## Proof and skip reporting

- UI proof: `capture()` output (screenshot + ARIA snapshot with the URL) before and after the action.
- CLI proof: the `.cli.json` record (command, base URL, exit code, stdout, stderr).
- Mutation proof: a second, read-only view of the stored result (Home, a reload, or a CLI read).
- Record the feature file and entry point with each artifact (the evidence subfolder is the feature ID).
- When a path cannot be reached (e.g. Google/Microsoft sign-in, Stripe checkout, Slack, email delivery: none are configured locally), report it as unverified, with the attempted step and the missing precondition. Do not report it as verified through a different entry point.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior, then exactly four H2 sections in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with Playwright and the CLI`, `Gotchas`.

## Features

Each feature has a shipped journey in `scripts/journeys/` that proves it end to end.

- [Share with the CLI and view](./cli-share.md) covers token creation, `share`, `update`, the sandboxed viewer, and Home listing.
- [Upload from Home](./home-upload.md) covers the `Add a file` dialog for a single file and a site folder.
- [Comments](./comments.md) covers the viewer Comments panel, inline comments on selected text, replies, resolving, and the `comments` CLI.
- [Who can view](./sharing.md) covers the visibility dialog, adding specific people, refusal pages, link sharing, and `edit --visibility`.
- [Projects](./projects.md) covers creating a project from the UI and the CLI, sharing into it, and its file list.
- [Viewer notices](./viewer-notices.md) covers the sandbox security banner and where toasts sit when the comment sheet is open on a phone.
