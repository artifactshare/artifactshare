# Screen capture harness

The screen capture harness creates review material from the real local application. It shares the screen ledger and development personas with automated checks but does not compare image baselines.

## Task ledger

[`scripts/task-ledger.mjs`](../../scripts/task-ledger.mjs) is the source of truth for the main journeys in the publish → react → republish loop. The screen ledger owns individual screens and representative visual states; the task ledger owns user context and the sequence through start, action, pending, success, failure, recovery, and next action. The walkthrough harness reproduces those transitions and collects their evidence.

The task ledger also owns the persona registry: each task references one persona, and each persona records who the user is, whether the flow is operated directly or delegated to an AI agent (`mediation`), and the sign-in context that reproduces its default state (`auth`) — a development sign-in persona, or `anonymous` for flows that begin signed out. Update the persona definitions first when observed usage stops matching them.

The task data also owns its selection criteria and update procedure. Run `pnpm check:task-ledger` after changing either ledger; it validates the task contract, the persona registry, and the screen references.

## Task walkthroughs

Start the full development topology, then capture one registered task or the
four champion-loop tasks. The command refuses to create output unless the app,
sandbox, built CLI, and dependency-optimization convergence checks all pass.

```sh
pnpm dev
pnpm walkthroughs:capture -- --task return-to-recent-file
pnpm walkthroughs:capture -- --champion-loop --label champion-loop
```

Each task runs at desktop and mobile viewports and writes one chronological
page under `screen-captures/<label>/<task-id>/`. Every phase includes a PNG and
machine-readable evidence for notifications, iframe URLs and load status,
failed requests, clipboard output, and local CLI commands where the persona is
agent-mediated. A video of each full seven-phase run is retained so short-lived
pending states can be reviewed; authenticated network traces are not retained,
and signed URL query values are redacted.
`evidence.json` contains the same task, persona, mediation,
authentication, and phase data for agent critique.

Walkthrough authentication comes from the task persona and the existing local
development sign-in API. Scenario setup reuses the screen scenario mechanism;
the harness does not own a second fixture registry. Agent-mediated publish and
update steps run the built local CLI against the local app and retain its JSON
result. Output remains untracked review material and is not an image-baseline
gate.

## Run

Start the full development topology, then choose registered screens:

```sh
pnpm dev
pnpm screens:capture -- --screen viewer --screen about
pnpm screens:capture -- --all
pnpm screens:capture -- --screen about --label before
pnpm screens:capture -- --all --audit-gaps
```

`SCREEN_CAPTURE_BASE_URL` overrides the default `https://localhost:5173`. `SCREEN_CAPTURE_CONCURRENCY` controls parallel pages and must be a positive integer. A screen may declare a lower concurrency limit when its matrix shares a runtime resource; the viewer is captured serially because every state loads the same seeded artifact. `PLAYWRIGHT_CHANNEL=chrome` uses an installed Chrome; otherwise install Chromium from the web workspace.

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
