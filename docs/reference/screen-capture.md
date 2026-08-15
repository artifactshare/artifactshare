# Screen capture harness

The screen capture harness creates review material from the real local application. It shares the screen ledger and development personas with automated checks but does not compare image baselines.

## Run

Start the full development topology, then choose registered screens:

```sh
pnpm dev
pnpm screens:capture -- --screen viewer --screen about
pnpm screens:capture -- --all
pnpm screens:capture -- --screen about --label before
pnpm screens:capture -- --all --audit-gaps
```

`SCREEN_CAPTURE_BASE_URL` overrides the default `https://localhost:5173`. `SCREEN_CAPTURE_CONCURRENCY` controls parallel pages and must be a positive integer. `PLAYWRIGHT_CHANNEL=chrome` uses an installed Chrome; otherwise install Chromium from the web workspace.

## Matrix and output

Each selected ledger entry expands across its declared locales and states, desktop and mobile viewports, and light and dark themes. Scenario state is seeded once before parallel capture so browser jobs do not race through sign-in or data creation.

Output is written to `screen-captures/<label>/`:

- one full-page PNG for each matrix item;
- `manifest.json` with the exact capture metadata and a `success` or `failed`
  status for every matrix item;
- `index.html` for visual browsing.

Before a capture is marked successful, the harness rejects the shared route
error boundary and waits for any screen-specific `ready` condition declared in
the screen ledger. Failed entries distinguish navigation, rendered screen
errors, readiness timeouts, missing interaction prerequisites, and interaction
failures. When possible, a `--failed.png` diagnostic image is retained, but it
is never counted as a successful review capture.

The output directory is untracked. A new run removes only the selected label directory before writing it.

## Gap audit

`--audit-gaps` runs the public geometry audit inside each page before capture. It reports unexpected touching or overlapping visual blocks and interactive controls after all screenshots finish. Images and the manifest remain available when the audit fails.

## Safety and ownership

- Authentication uses only the local development persona API.
- Seed uploads use local D1 and R2 bindings.
- Playwright is resolved from the web workspace dependency; the harness does not install a second toolchain.
- The command is manual review tooling. Linux image-baseline validation remains in the Compose visual test and is not replaced by these captures.
