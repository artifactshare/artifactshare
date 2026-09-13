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
page under the capture root at `<label>/<task-id>/`. Every phase includes a PNG and
machine-readable evidence for notifications, iframe URLs and load status,
failed requests, clipboard output, and local CLI commands where the persona is
agent-mediated. Videos retain the success path and the separately seeded
failure/recovery branch so short-lived pending states can be reviewed without
mixing alternative outcomes; authenticated network traces are not retained, and
signed URL query values are redacted.
`evidence.json` contains the same task, persona, mediation,
authentication, and phase data for agent critique.

Use the completed output with the task critique launcher. Pass every source file
that owns the affected UI; the launcher rejects stale task/persona snapshots,
missing phases, failed runs, and either a desktop or mobile gap before starting
a reviewer.

```sh
capture_output_root="$(node --input-type=module -e 'import { screenCaptureOutputRoot } from "./scripts/screen-capture-output.mjs"; console.log(screenCaptureOutputRoot())')"
pnpm critique:tasks -- \
  --walkthrough-root "$capture_output_root/champion-loop" \
  --task share-file-link \
  --screen-root "$capture_output_root/viewer" \
  --source 'apps/web/app/routes/a.$shareableId.tsx'
```

The visual layer owns the PNG/source comparison. The task layer owns the
persona, decision, completion, and recovery evaluation. Neither layer writes
findings back into the screen ledger, task ledger, or walkthrough evidence.
Both capture manifests record the current commit, and the launcher requires a
clean checkout at that same commit. Pass `--screen-root` for affected states
captured outside the selected walkthroughs.

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

`SCREEN_CAPTURE_BASE_URL` overrides the default `https://localhost:5173`. `SCREEN_CAPTURE_CONCURRENCY` controls parallel pages and must be a positive integer. `SCREEN_CAPTURE_RETRIES` bounds retries of a readiness timeout (see Retries below). A screen may declare a lower concurrency limit when its matrix shares a runtime resource; the viewer is captured serially because every state loads the same seeded artifact. `PLAYWRIGHT_CHANNEL=chrome` uses an installed Chrome; otherwise install Chromium from the web workspace.

## Matrix and output

Each selected ledger entry expands across its declared locales and states, desktop and mobile viewports, and light and dark themes. Scenario state is seeded once before parallel capture so browser jobs do not race through sign-in or data creation.

Output is written to
`<checkout-parent>/.<checkout-name>-screen-captures/<worktree-id>/<label>/`.
The worktree ID is the SHA-256 hex digest of the absolute Git directory returned
by `git rev-parse --absolute-git-dir`. The checkout parent comes from
`git rev-parse --show-toplevel`. This gives primary and linked worktrees distinct,
deterministic output roots outside their checkout, including when the primary
worktree's Git directory is `<checkout>/.git`. The parent must be writable;
a checkout at the filesystem root is rejected. Moving a checkout or its Git
directory changes the output root; previous captures remain at the old location.
`critique:tasks` accepts those previous paths when their resolved location is
inside the repository or the external `.<checkout-name>-screen-captures/`
directory followed by a 64-character lowercase hexadecimal worktree ID.
The directory name does not establish capture provenance: the manifest must
still match the reviewed HEAD, and manifest, evidence, and PNG files must resolve
inside the declared capture root (walkthrough PNGs inside their task directory).

- one full-page PNG for each matrix item;
- `manifest.json` with the exact capture metadata and a `success` or `failed`
  status for every matrix item;
- `index.html` for visual browsing.

Before a capture is marked successful, the harness rejects the shared route
error boundary and waits for any screen-specific `ready` condition declared in
the screen ledger; a state whose page has no such element (a paused link, for
example) declares its own `setup.ready` selector, which replaces the screen's. Failed entries distinguish navigation, rendered screen
errors, readiness timeouts, missing interaction prerequisites, and interaction
failures. When possible, a `--failed.png` diagnostic image is retained, but it
is never counted as a successful review capture.

The output directory is external review material. A new run removes only the selected label directory before writing it. The command prints the resolved absolute output path after each run; pass that path to `critique:tasks` when using the captures.

## Existing captures

The root-level `screen-captures/` and `.tmp-task-walkthrough/` ignore entries
remain for compatibility with captures made before external output was introduced.
Updating the checkout therefore leaves old captures intact without making clean
checkout gates fail. New runs never write to or clean these legacy directories.
Keep these entries until support for checkouts with pre-migration output ends.

To retain old evidence outside the checkout, run the following from the checkout
root after setting `capture_output_root` with the command above. Each migration
uses a fresh archive directory, so it cannot overwrite earlier evidence. Inspect
the archive before deleting any files you no longer need; this procedure does not
make old evidence eligible for critique against a different commit.

```sh
mkdir -p "$capture_output_root"
legacy_archive="$(mktemp -d "$capture_output_root/legacy-XXXXXXXX")"
for legacy in screen-captures .tmp-task-walkthrough; do
  if [ -e "$legacy" ]; then
    mv -i "$legacy" "$legacy_archive/"
  fi
done
```

## Gap audit

`--audit-gaps` runs the public geometry audit inside each page before capture. It reports unexpected touching or overlapping visual blocks and interactive controls after all screenshots finish. Images and the manifest remain available when the audit fails.

## Safety and ownership

- Authentication uses only the local development persona API.
- Seed uploads use local D1 and R2 bindings.
- Playwright is resolved from the web workspace dependency; the harness does not install a second toolchain.
- The command is manual review tooling. Linux image-baseline validation remains in the Compose visual test and is not replaced by these captures.

## Retries

A capture that fails only because the screen's ready condition timed out before any interaction ran (`readiness_timeout`) is retried up to `SCREEN_CAPTURE_RETRIES` times (an integer from 0 to 10; default 2; `0` disables). Each retry starts a new browser context and is logged to stderr as `capture retry n/m: <screen>/<state>/<viewport>/<theme>/<locale> [readiness_timeout]: <message>`. A capture that needed retries records `attempts` in `manifest.json` (on success and on final failure), and the end-of-run summary counts captures that were retried (once per capture, whatever the number of attempts). A readiness timeout after an interaction, and every other failure kind, is reported at once.
