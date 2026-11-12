# Screen capture harness

The screen capture harness creates review material from the real local application. It shares the screen ledger and development personas with automated checks but does not compare image baselines.

## Task ledger

[`scripts/task-ledger.mjs`](../../scripts/task-ledger.mjs) is the source of truth for the main journeys in the publish → react → republish loop. The screen ledger owns individual screens and representative visual states; the task ledger owns user context and the sequence through start, action, pending, success, failure, recovery, and next action. The walkthrough harness reproduces those transitions and collects their evidence.

The task ledger also owns the persona registry: each task references one persona, and each persona records who the user is, whether the flow is operated directly or delegated to an AI agent (`mediation`), and the sign-in context that reproduces its default state (`auth`) — a development sign-in persona, or `anonymous` for flows that begin signed out. Update the persona definitions first when observed usage stops matching them.

The task data also owns its selection criteria and update procedure. Run `pnpm check:task-ledger` after changing either ledger; it validates the task contract, the persona registry, and the screen references. A task that has no walkthrough may record why in `walkthroughGap`; `pnpm check:task-walkthroughs` rejects a gap on a task that has one.

## Task walkthroughs

Start the full development topology, then capture one registered task or the
five champion-loop tasks. The command refuses to create output unless the app,
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
Immediately after sheet-opening clicks and before every phase PNG, capture waits
for sheet content and overlay subtree animations to finish, sharing one 2 s
deadline per wait. Infinite-iteration animations are ignored; empty or absent
animations complete immediately.
Each phase records `evidence.sheetAnimationWait`; clicks also retain
`evidence.clicked.sheetAnimationWait`. Both contain `status` (`completed`,
`timed-out`, or `context-replaced`), `elapsedMs`, and `timeoutMs: 2000`.
`context-replaced` records navigation destroying the browser execution context;
capture still takes the PNG. Other unexpected browser errors propagate.
A timeout is diagnostic:
capture still takes the PNG, and a later successful wait does not overwrite it.

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

When no registered task is affected, omit `--walkthrough-root` and supply
at least one `--screen-root`, a nonblank `--scope-judgment` explaining that
decision, and the relevant `--source` files:

```sh
pnpm critique:tasks -- \
  --screen-root "$capture_output_root/viewer" \
  --scope-judgment "Only standalone screen presentation changed; no registered task is affected." \
  --source 'apps/web/app/routes/a.$shareableId.tsx'
```

Screen-only mode rejects `--task` and runs exactly one Claude visual reviewer.
With `--provider codex`, the existing combined reviewer runs once with only
visual responsibility and all validated screen PNGs attached. The scope judgment
is included in either prompt. Sources and captures retain the same existence,
containment, successful-status, and matching-commit requirements.
`--scope-judgment` must be nonblank and cannot be used with `--walkthrough-root`.

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

## Readable section crops

A screen may declare ordered `sections: [{ id: 'introduction', selector: '#introduction' }]` metadata. IDs must be unique within the screen and match `^[a-z0-9][a-z0-9-]{0,63}$` (1–64 lowercase letters, digits, or hyphens, starting with a letter or digit); selectors must be nonblank. Omitted or empty lists keep the existing full-page-only behavior.

After each successful full-page capture, the harness captures each element's width and top, capped at two viewport heights (1800 CSS pixels on desktop, 1688 on mobile), without scaling text. Clips use document coordinates, including scroll offsets, without scrolling targets under sticky navigation or mutating the page. Missing, ambiguous, invisible, and zero-area targets fail individually; the full-page image and remaining crops survive, and the command returns nonzero after writing output.

Crop filenames append `--section-<id>.png` to the existing `<screen>--<state>--<viewport>--<theme>--<locale>` stem. Additive manifest entries carry `section` and the same capture metadata, including HEAD; failures carry the section ID and selector details. The browsing index labels each section separately.

`guides-cli` declares `introduction`, `basics`, `commands`, and `recovery`, using the matching element IDs in both locales. Its default matrix produces 8 full-page images and 32 crops. The introduction crop excludes the page hero; the full-page image supplies that context. Long sections show only their first two viewport heights.

Normal critique receives full-page images and labelled crops. `--copy-only` selects crops from each root containing section entries and excludes walkthrough PNGs when section crops are supplied; task/evidence context remains available. Roots without section entries retain legacy manual-crop selection. Every manifest entry is validated before selection, including excluded full-page images.

Reuse the generated root directly, without a hand-written manifest (after capture at the final clean commit):

```sh
pnpm screens:capture -- --screen guides-cli --label guides-cli
pnpm critique:tasks -- --screen-root "$capture_output_root/guides-cli" --scope-judgment "Guide capture material changed; recover-interrupted-publish references this screen but has an existing walkthrough gap. No registered walkthrough is affected; this review makes no task-completion claim." --source 'apps/web/app/routes/_public/($locale)/guides.cli.tsx' --source apps/web/app/components/app/cli-reference-page.tsx
pnpm critique:tasks -- --screen-root "$capture_output_root/guides-cli" --scope-judgment "Guide capture material changed; recover-interrupted-publish has an existing walkthrough gap and no registered walkthrough is affected." --source 'apps/web/app/routes/_public/($locale)/guides.cli.tsx' --source apps/web/app/components/app/cli-reference-page.tsx --copy-only
```

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

## Walkthrough provenance and continuous reactions

Fresh walkthrough manifests and evidence use `evidenceVersion: 1` and the same
opaque capture-local `captureId`. A successful scenario sign-in creates an
initialization identity; a scenario header alone does not establish a reset.
Setup sign-in is recorded separately. Each viewport has ordered success and
independent failure/recovery boundaries, each with its own initialization,
browser context and branch identity. These are random local identifiers, never
authentication session identifiers or credentials.

The seven phases remain unchanged. Every phase PNG and supplemental PNG records
its step identity, predecessor, continuity or reset reason, and matching branch
video. Videos list their steps. The review HTML displays these fields beside each
image. The first step in each viewport has no predecessor and explicitly starts
a newly initialized viewport. The failure step follows the successful branch's
last observation but explicitly resets context and initialization.

Only `review-new-reactions` adds a supplemental Home result after the original
comment-body success PNG. It observes a visible target row with both unread and
new-comment indicators, inspects nonempty marked comment content, clicks the
Viewer's own Home link, and observes the same visible target row without either
indicator. The new Home route and its target row rendered from the Home loader
are readiness conditions; no delay or retry stands in for them. A missing row,
remaining unread indicator, or missing comment body fails capture. A target
disappearing from an unread-only list would not count as read: this journey uses
unfiltered Home. Failure/recovery still signs in and reseeds independently.

All selected walkthroughs require fresh provenance, not only reactions. Old
captures remain historical evidence; do not fill unknown fields or overwrite an
archive. The validator rejects old evidence with this recapture instruction:

```sh
pnpm walkthroughs:capture -- --task <task-id> --label <fresh-label>
```

The validator checks lineage, observations, image purposes and containment,
video references, and fixed HEAD before either critique layer runs. Supplemental
images receive containment checks even when copy-only selection excludes them.
Both default layers and combined mode receive labeled observations, PNGs and
branch/video associations. Reviewers must inspect the actual Home/body result
and boundaries; a newly seeded unread failure fixture is independent evidence.
Schema equality does not authenticate pixels or prove a DOM assertion ran.
Copy-only input without walkthrough images cannot support continuous success.

### Coordinator acceptance after factory completion

Fixed checks use synthetic Node page doubles and temporary files; they do not
start the app or invoke models. Before Ready, the coordinator must independently
complete the following real-app and display checks at the clean fixed candidate.
Do not bypass the dirty-checkout or server-HEAD guards.

```sh
pnpm dev:setup
pnpm --filter @artifactshare/cli build
# In a separate terminal at the same clean candidate:
pnpm dev
# With that topology running:
pnpm walkthroughs:capture -- --champion-loop --label boundary-healthy
capture_output_root="$(node --input-type=module -e 'import { screenCaptureOutputRoot } from "./scripts/screen-capture-output.mjs"; console.log(screenCaptureOutputRoot())')"
pnpm critique:tasks -- --walkthrough-root "$capture_output_root/boundary-healthy" --task review-new-reactions --source scripts/task-walkthrough-capture.mjs --source scripts/task-walkthroughs.mjs --source scripts/task-critique.mjs --dry-run
```

`pnpm dev:setup` initializes the local schema. Do not follow it with
`pnpm db:apply:local` on a fresh checkout: replaying migrations against that
schema fails with existing-table errors.

A failed continuous Home return writes `failed-home-return-<viewport>.json`
and, when screenshot capture succeeds, `failed-home-return-<viewport>.png`.
The diagnostic is explicitly failed and includes the observed target state,
body inspection and branch/video identity; it is not successful walkthrough
evidence. Diagnostic write failures do not replace the journey error. The
original success-body PNG remains available for diagnosis.

Repeat the last command with `--provider codex` to inspect attached image
arguments. Confirm both default prompts and combined input contain the
supplemental observations/images and video boundaries. Run the normal default
critique by removing `--dry-run`; models are coordinator work only.

Inspect all five tasks' generated HTML at 1440×900 and 390×844. Verify readable
per-image identities/reset reasons, the supplemental Home result before failure,
the preserved body success image, and usable matching video links. Provide
desktop/mobile captures of this generated display as additional review material.
This surface has no product screen-ledger ID. No unrelated product recapture is
required; markup tests alone cannot establish readability.

For the negative control, use a disposable local checkout derived from the
candidate. Temporarily change only product source to preserve the existing
comment seen-through boundary in the shared recency upsert. Both
`recordViewerRecency` and subsequent view recording can advance it; disabling
only one caller is not sufficient evidence. Record the local-only fault diff
and clean fault commit SHA, restart topology there, and run:

```sh
pnpm walkthroughs:capture -- --task review-new-reactions --label boundary-fault
```

Through existing local storage tooling, record the target/user comment boundary
and latest relevant non-self comment timestamp before and after the visit.
Correlate those values with the same artifact's Home row. The fault must retain
a boundary behind that comment, successfully inspect its body, then exit
nonzero on the remaining-unread assertion. Startup, fixture, navigation and
revision failures do not qualify. Record reached viewports; when desktop fails
first, mobile was not reached.

Stop fault topology, restore the healthy candidate (never merge or publish the
fault), restart and recapture reactions with a fresh label. Record candidate
and fault SHAs, exact commands, exit statuses, before/after boundaries, unread
observations, fault diff and restoration, clean healthy HEAD, display/input
inspection results and limitations. Healthy evidence must cover both viewports.
The harness's self-reported result alone is insufficient acceptance evidence;
do not claim guaranteed reviewer conclusions or unmeasured time savings.
