# Maintainer development workflow

This repository is the source of truth for product development. A maintainer must be able to take a change from its rationale through a ready pull request using only a public checkout. External contributors continue to use the proposal-only process in `CONTRIBUTING.md`.

## Keep the workflow proportional

The workflow exists to find plausible defects and protect expensive boundaries. Prefer native tool output and session history over repository-specific bookkeeping. Add a guard or wrapper only for a concrete, likely failure that is costly to recover from.

Choose specification, review, and local validation from the actual change. Do not encode the choice in a risk matrix, classifier, receipt, or multi-stage review protocol. The final gate is a convergence condition on one fixed artifact, not a bookkeeping system: the latest specification version or implementation commit has no unresolved blocker.

Reviews should remove unnecessary work as readily as they find missing work. Before accepting a proposed requirement, abstraction, compatibility layer, persistence field, management surface, or new test harness, identify the observed user problem or current acceptance criterion it protects. If the failure is hypothetical, belongs to a possible future expansion, or is already handled by an existing mechanism, classify the proposal as a follow-up or non-actionable rather than expanding the current change. Prefer the smallest reversible design that solves the observed case.

When a reviewer only repeats a different tradeoff from an explicit owner decision already recorded in the specification, and identifies no new conflict with correctness, safety, or a current acceptance criterion, the implementer should classify the observation as non-actionable and continue. If contradictory findings become the dominant review result, stop appending exceptions and rewrite the specification as one coherent statement before reviewing it again.

Treat PoC and migration machinery as temporary. State what decision or rollout milestone makes it removable, and do not turn a comparison route, feature flag, fallback renderer, generation field, or rollout UI into a permanent product concept without current evidence that it must remain. Once the decision is made and rollback is no longer required, include removal of the temporary path in the work and check for leftover code, dependencies, configuration, and tests before Ready.

The merge queue always runs the complete product validation. Local validation gives fast, relevant evidence before publication; it does not need to duplicate the queue for every change.

## Choose the work needed

Typos and explanatory documentation changes need a careful self-review but no separate specification or agent review. This applies only when the change does not alter shipped content, product behavior, normative policy, workflow guards, CI, security boundaries, dependencies, or configuration.

Write a specification when behavior, requirements, UI states, or acceptance criteria need a design decision before implementation. Routine fixes and contained maintenance may proceed directly when the desired behavior is already clear.

When a specification is required, start Codex and Claude deep reviews in parallel against the exact Artifact Share version that will be handed to implementation. Let both independent reviews finish before classifying findings or changing the specification. Implementation starts only after every finding from both reviewers is classified and neither has an unresolved blocker on that version.

For an ordinary code, workflow, or normative documentation change, start Codex and Claude deep reviews in parallel against the exact commit intended for Ready. Let both independent reviews finish before classifying findings or changing the implementation. Their different exploration paths are a permanent part of the gate, not a risk category selected per change.

Classify every review finding by its effect on the current change:

- **Blocker:** leaving it unresolved would compromise user value, correctness, safety, or an acceptance criterion.
- **Follow-up:** useful work that is not required for the current artifact to be sound.
- **Non-actionable:** a duplicate, false positive, preference, or out-of-scope observation.

The gate passes when neither reviewer has an unresolved blocker on the reviewed target, not when both reviewers report zero findings. A quick `low` review or a single-reviewer pass may help during development but never replaces the dual deep final gate. A specification may have its initial review and at most two correction reviews. A fourth review is refused and requires a coherent rewrite from the original scope lock and acceptance criteria.

Do not promote a finding to blocker merely because it would make the design more general, more future-proof, or more internally complete. A blocker must protect present user value, correctness, safety, or an agreed acceptance criterion. Review the total design after applying findings; if the correction adds more machinery than the observed problem warrants, reduce the design before starting another review round.

Changing the specification after its gate invalidates that gate. Changing the implementation after its gate invalidates that gate. Finish mechanical corrections before the final review; if the version or commit changes afterward, start both deep reviews again in parallel against the new target. Do not stop or restart one reviewer merely because the other finishes first or reports a blocker: wait for both results so one correction pass can address the complete finding set. Keep finding dispositions in the normal task or reviewer session, and summarize the final gate and any follow-ups in the pull request. Do not create review receipts, digests, attempt logs, or review-specific push guards.

A required review or validation remains unfinished while its command is running or its result is pending. Keep the task active and do not give a final response such as "waiting for review" before every required gate has completed and its result has been evaluated. If a required process disappears before producing a result, treat the gate as incomplete and run that process again; absence of a result is never success.

## Choose local validation

Run the smallest command set that can detect a plausible defect in the changed area:

Always run `pnpm public:scan .` before the first push. Public/private boundary validation must finish before content becomes visible in a Draft PR.

Before any push intended for review or Ready, run `pnpm validate:static` exactly as CI does. Do not substitute a hand-picked subset: the static lane also carries checks that per-area command lists tend to miss, such as the copy glossary. Note that `pnpm format` only checks formatting; it does not rewrite files.

Before each push, also reproduce the pull-request boundary check over every commit in `merge-base(origin/main, HEAD)..HEAD`. Run the guard script and manifest from a clean checkout of `origin/main`; otherwise a guard or allowlist added by the branch under review could authorize its own content. From the working checkout, run:

```sh
set -eu
trusted_main="$(mktemp -d)/main"
git fetch origin main
git worktree add --detach "$trusted_main" origin/main
base=$(git merge-base origin/main HEAD)
head=$(git rev-parse HEAD)
repo=$(git rev-parse --show-toplevel)
name=$(gh repo view --json nameWithOwner --jq .nameWithOwner)
test -n "$name"
trusted_head=$(git -C "$trusted_main" rev-parse HEAD)
guard_status=0
node "$trusted_main/scripts/public-development-guard.mjs" --ci-pr --repo "$repo" --manifest-repo "$trusted_main" --base "$base" --head "$head" --trusted-head "$trusted_head" --head-repo-full-name "$name" --base-repo-full-name "$name" </dev/null || guard_status=$?
git worktree remove "$trusted_main"
test "$guard_status" -eq 0
```

- Explanatory documentation: `pnpm format` and any checker that owns the edited document or generated reference.
- Workflow scripts and guards: `git add` the new files, then `pnpm verify` (format check, lint, `public:scan .`, the boundary manifest and pre-push hook checks, `audit:tests`, and `test:scripts` in order, stopping at the first failure and naming the stage and what did not run). While iterating, run the changed script tests directly; `verify` is the pre-commit run. Join it to the commit with `&&`, never `;`, so a failed stage cannot be committed or reviewed.
- Product code: typecheck and the tests closest to the changed behavior. Add build, browser, integration, runtime, visual, migration, schema, or React Doctor checks only when the change can affect them. A change that touches page chrome or the dev-scenario surface also runs `pnpm check:scenario-routes`; its click-driven navigation exercises a path the browser-mode scenario tests do not.
- After a commit changes product UI, run `pnpm visual:compose` and inspect the baseline diff before publishing or adding another commit.
- Dependencies, CI, release, deployment, and repository boundaries: run their dedicated contract checks plus the relevant static or build checks.

Record the commands and results in the pull request. If the affected surface is unclear, broaden validation or run `pnpm validate`. Never reduce production, credential, migration, billing, authentication, or public/private boundary checks on the basis that the merge queue will catch them later.

## Delivery sequence

1. Confirm the intended behavior and write a specification when design is needed.
2. If a specification is required, start Codex and Claude deep reviews of its fixed final version in parallel, wait for both, classify every finding together, and repeat both reviews in parallel on each new version until no blocker remains. `review:spec` returns nonzero after three rounds with `ROUND_CAP` and an unreviewed target; rewrite the specification from the original scope lock before continuing.
3. If UI changes, capture the current state or prepare a static mock and use the UI critique below before implementation.
4. Implement and commit the complete change. For workflow scripts and guards, the commit follows `pnpm verify &&`.
5. Run the selected local validation. If validation changes files, commit them and rerun the affected checks. Keep the worktree clean before review or publication.
6. Initialize the branch's immutable objective scope, then start Codex and Claude deep reviews of the committed Ready candidate in parallel and wait for both. A blocker must name one of the scope's failures, a supported scenario within its trusted inputs, and the wrong result. Classify broader requests as follow-ups or non-actionable.

   The gate admits the initial commit and one distinct correction commit. A failed review still consumes that commit's admission; rerunning the same commit does not. A third distinct commit stops before reviewer launch with `OBJECTIVE_REBASE_REQUIRED`. Recover manually by starting a fresh branch and scope from the same objective instead of extending the correction chain. The coordinator still narrows the reviewed range only from a matching completed pair; pass `--base` to choose the base explicitly.

7. Publish a Draft PR with `pnpm pr:publish -- --body-file <path> --title <title>`. Further fixes use normal commits and pushes; the pre-push boundary guard scans every push.
8. If UI changed, capture every affected state and repeat UI critique after material visual fixes. Commit any resulting change and return to the implementation gate.
9. Push the final commit normally and run `pnpm pr:ready -- --task-usage-report <path>`. The path must point to a sanitized workflow-usage report produced by the private maintainer control-plane `task-usage report --format public-json --repository <public-root>` operation for this checkout's `HEAD`. The report contains only public-safe rows, totals, coverage, the target commit SHA, and the generated markdown block. `pr:ready` validates its coverage and arithmetic, rejects unreasoned unknown rows, verifies the report target against local and remote `HEAD`, and requires exactly that generated usage block in the PR body before it verifies the Draft targets `main` and required PR checks have succeeded before calling `gh pr ready`. When the diff contains UI changes, it stops until you confirm that affected states and registered tasks were captured at desktop and mobile on the reviewed commit, the walkthrough evidence, standalone captures, and relevant source were critiqued, and no UI changed afterward; after those checks, rerun it with `pnpm pr:ready -- --task-usage-report <path> --ui-gate-complete`. It also requires every finding the change deferred, named with `--deferred <text>` (or `--deferred-file <path>`), or `--no-deferred` when there were none.
10. Queue with `pnpm pr:queue -- --pr <number>`. It rebuilds the queue entry (`--disable-auto` then `--auto`, so a queued PR runs the current head rather than an old snapshot), then watches the merge-group run that entry creates until the PR merges or the run fails. A failed run is reported with its failed jobs and the failing log lines, and the command exits nonzero; a run the queue cancelled or replaced is skipped in favour of its successor. The command also exits nonzero when the PR is closed, when `gh` keeps failing, or after `--timeout` minutes (default 90, polling every `--interval` seconds, default 30) while the entry may still be running; `--no-wait` only queues. The PR itself stays OPEN after a queue failure, so waiting on the PR state alone hides it. The queue's unit, CLI, browser, build, integration, runtime, and visual lanes are the final validation record.
11. After the PR lands, run `pnpm pr:landed -- --pr <number> --disposition <kind>:<note> ...`. It fast-forwards `main` in whichever worktree has it checked out (the main checkout checks it out when nothing holds it), parks the current worktree on main's commit (detached) when it holds the merged branch, deletes the merged branch unless another worktree still has it checked out, reports each of those moves, and requires one disposition per deferred finding: `issue` (filed, with the reference), `promoted` (turned into a rule or check), `fixed` (the change addressed it after all, with the commit), or `dropped` (with why it is not worth doing). Recording a deferral is not a fix and must not be reported as one; this is where it becomes a decision.

## UI critique

UI critique is required only for UI changes and supplements code review. Use `pnpm screens:capture`, `pnpm walkthroughs:capture`, [Screen capture](./reference/screen-capture.md), and [the design-system critique criteria](./reference/design-system.md#14-エージェント批評の観点). Capture every affected screen state and every affected registered task at desktop and mobile. Run `pnpm critique:tasks` with the walkthrough output and relevant source so the default Claude visual and task layers receive PNGs, task/persona context, notifications, frames, failed requests, clipboard evidence, and applicable CLI results. `--provider codex` runs one Astra/medium critique with every validated walkthrough and standalone screen PNG attached and the same combined task/source context. If no registered task is affected, record that scope judgment in the critique input and perform the screen critique directly. The reviewer must return `NEEDS INPUT` rather than launch another browser or guess when evidence is missing.

Each resolved finding receives a cause classification and a separate disposition: `fix-now`, `measure-first`, or `do-not-pursue`. A `needs-verification` finding receives no disposition: return `NEEDS INPUT`, name the evidence to recapture or supply, and resume disposition only after verification. Use `fix-now` for reproducible task failure, correctness, safety, accessibility, data loss, established impact with a proportional fix, or a verified `product-defect` with a proportional fix that adds no product complexity; measurement must not delay that work. Use `measure-first` when evidence supports a plausible product problem but its frequency, dominant cause, or user impact is unknown and remediation would add product complexity. Before adding instrumentation, define the observable outcome, numerator and denominator, privacy boundary, decision checkpoint, and the decision rule that will trigger remediation or no change. At the checkpoint, record the decision before opening remediation work. Use `do-not-pursue` for verified capture/environment or artificial-seed defects, unsupported preferences, and claims with no evidence of a product problem; a capture/environment defect may receive it only when the remaining evidence is sufficient to complete the critique. After a fix, repeat the affected walkthrough and critique; when measurement exists, compare the result with its baseline.

## Review commands

Executable model and effort defaults live in [`scripts/agent-role-settings.mjs`](../scripts/agent-role-settings.mjs). Keep the procedural responsibility and handoff rules here; use the module when launching a role so session defaults do not silently replace the approved pairing.

Every delegation gives the receiving agent a compact input: purpose, boundary, dependencies, current acceptance criteria, necessary verification, and the selected model/effort. A repair handoff also names the adopted findings, evidence, minimal repair scope, and checks. A routine change with clear desired behavior does not need a second specification. The parent reruns or expands validation only when code changed, a check failed, or coverage remains unresolved.

The orchestrator owns coordination and adjudication. For initial implementation, it chooses between two approved profiles by scope judgment: routine, local, and pattern-following changes use Luna at max; changes involving concurrency, state, migration, recovery, or integrity across multiple conditions use Sol at medium. This choice is not a classifier and does not authorize unilateral escalation. Reviewers receive repair work only after the parent adopts a concrete finding. The final gate remains an independent Codex/Claude pair on one fixed target.

The repository [Controlled Review skill](../.agents/skills/controlled-review/SKILL.md) is the shared review procedure for Codex and Claude Code. Codex discovers the canonical `.agents/skills/controlled-review/` directory; Claude's `.claude/skills/controlled-review/SKILL.md` entry reads that same source. Prefer the repository copy over an installed personal copy. The caller fixes the target, purpose, acceptance criteria, non-goals, prior finding dispositions, model/effort, and execution bounds before dispatch, and decides adoption after receiving the complete results.

`review:codex` and `review:claude` use ordinary provider sessions with the skill's generated role prompts. They do not invoke `codex review` or `/code-review`. The repository command recipe explicitly groups all eight skill lenses into one finder per provider because they inspect the same target and surrounding code. Each provider may then run one fresh-session batch verifier over its candidates. The two providers never receive each other's findings. The finder and verifier both receive the complete fixed task context and existing dispositions; they may neither delegate nor edit, execute product code, run tests, or publish. The launcher materializes the tracked base and head files and their diff outside the reviewed tree and supplies those paths to both roles. Claude uses only Read, Grep, and Glob; neither role needs Git access to compare the fixed code. The temporary evidence is removed after the provider pipeline finishes. This recipe allows no automatic retries and has a 30-minute total deadline per provider review. The skill remains available for caller-selected assignments outside this command recipe.

A candidate's technical verdict (`CONFIRMED`, `PLAUSIBLE`, or `REFUTED`) is separate from its applicability to the current change and the caller's adoption decision. Missing context, a failed role, incomplete coverage, or an incomplete verification leaves the gate incomplete. A successful process exit is not evidence that a finding is sound or resolved. Keep all candidate outcomes available when making the final classification.

Both standalone launchers require a clean committed checkout and verify that HEAD and the worktree stay unchanged. Standalone implementation review does not update coordinated final history. Use `--context-file` to supply the current change's purpose, criteria, non-goals, and a Dispositions section. `review:claude --level` remains a compatibility alias for `--effort`; conflicting explicit values fail. The spec phase reads the fixed Artifact Share version and unresolved comments, or the coordinator's immutable snapshot when launched by `review:spec`.

For a specification gate, use `review:spec`. It acquires a per-spec local lock, reads the fixed Artifact Share version and unresolved comments once, writes a mode-`0600` temporary snapshot, and starts both commands concurrently from that exact snapshot. After both results are available, it reads the specification once more and refuses to commit the result if the version, content, unresolved comments, or project placement changed during review.

The specification must contain a short `## Scope lock` with `### Owner decisions`, `### Non-goals`, and `### Acceptance criteria`. Both commands return that lock, normalized findings, and the complete controlled-review candidate and verification details. Provider progress logs and repeated specification text stay captured and are not printed on success. The gate prints the details for caller classification but does not persist them in its bounded state. A cache hit reports that the provider pair completed; it does not replay candidate details or replace caller classification. If output delivery fails, stop and recover the role results from native session history before classifying; keep the completed round counted. Do not infer adoption from a cached verdict. A blocker must include a nonempty minimal fix and a nonempty description of either the broken current acceptance criterion or new correctness/safety evidence. Missing fields make the controlled review incomplete.

The coordinator stores its bounded state under `artifactshare/spec-review` in the repository's shared Git common directory. Main and linked-worktree checkouts therefore use one state and lock namespace. A SHA-256 of the canonical Artifact id selects the state and lock names; the Artifact URL itself is never used as a filename, and equivalent URL spellings cannot split the review history. The state contains only generation, revision, the original baseline metrics, the final model/effort profile, a lifetime round count, at most three reviewed version/fingerprint entries, the latest finding ids, reviewers, and severities, and whether profile invalidation prevents that latest evidence from satisfying the current gate. It does not contain the specification body, reviewer prose, credentials, tokens, an attempt log, or a permanent receipt. A model/effort or review-method profile change invalidates cached review evidence while retaining the generation's original baseline, spent round count, and latest finding obligations. Updates use a same-directory temporary file and atomic rename, so a failed reviewer or interrupted process leaves the last completed state intact. The per-spec OS file lock rejects a second coordinator before duplicate reviews start and is released by the operating system if the holder process exits; lock-file contents and stale PID cleanup are not part of correctness.

On the first run after this storage change, the coordinator recognizes an existing trusted review-state comment, reads its referenced record when needed, and writes only bounded metadata locally. It never deletes or edits the legacy record or comment, and legacy or profile-mismatched review evidence cannot satisfy the current gate. Once local state exists, ordinary review has exactly two Artifact Share accesses: the initial snapshot read and the final unchanged-input readback. The coordinator prints the baseline metrics needed for the next correction. For correction reviews, pass an untracked temporary `--dispositions-file`. It contains `baseline_metrics`, a `prior_findings` array exactly covering the persisted Codex and Claude ids (including an explicitly empty array), and a same-length `dispositions` array keyed by those ids. Each disposition is `fixed`, `follow_up`, `non_actionable`, or `rewrite`; set `repeated` or `contradiction` to `true` when applicable. The coordinator refuses incomplete classification. It returns nonzero at the third-round cap with `ROUND_CAP` and marks the target unreviewed; the cap cannot defer a blocker or authorize a fourth review. Starting a new generation with `--reset` still requires owner approval. After an approved full rewrite, start a new local generation with `--reset`. Do not commit the temporary dispositions file.

```sh
pnpm review:spec -- --artifact-url <url> --version-id <id>
pnpm review:spec -- --artifact-url <url> --version-id <corrected-id> --dispositions-file <path>
# Owner-approved full rewrite only:
pnpm review:spec -- --artifact-url <url> --version-id <rewrite-id> --reset
```

Classify the combined findings before editing the specification. The gate passes only when neither result has an unresolved blocker.

For an implementation gate, create a strict JSON scope no larger than 4 KiB with exactly these fields: `schema_version` (`1`), `objective`, one to three `failures` named contiguously `I1` through `I3`, one to three `trusted_inputs`, `manual_recovery`, and `max_corrections` (`1`). Initialize it once on an attached task branch and inspect the persisted scope after a session change or compaction:

```sh
pnpm task:scope -- init --scope-file <path>
pnpm task:scope -- status
pnpm review:implementation
pnpm review:implementation -- --base <ref>
pnpm review:implementation -- --dispositions-file <path>
```

The scope is immutable for that exact branch name and lives under `artifactshare/task-scopes` in the shared Git common directory, so linked worktrees and later sessions read the same state. Status reads the atomically replaced state without waiting for an in-progress review's branch lock. Changing scope requires a fresh branch. Missing scope and detached HEAD fail with `NO_ACTIVE_SCOPE`.

Before launching either reviewer, the coordinator reserves the clean committed HEAD under the branch's OS lock. It admits the initial HEAD and one distinct correction HEAD; failed or interrupted review attempts remain admitted, while a same-HEAD rerun is allowed. A third distinct HEAD returns `OBJECTIVE_REBASE_REQUIRED` before reviewer launch. The generated reviewer context contains the immutable objective, named failures, trusted inputs, manual recovery, and caller-supplied finding dispositions. The first candidate defaults to `None yet`; a correction candidate requires `--dispositions-file`. This untracked UTF-8 Markdown file contains the body of the Dispositions section, with an outcome and rationale for every prior finding (`fixed`, `follow-up`, `non-actionable`, `deferred`, or `stop`). If the earlier review had no findings, state `None yet` explicitly. The coordinator reads this file once and gives both providers the same immutable snapshot. Raw reviewer prose and finding dispositions remain in the task session rather than accumulating in shared state.

Both reviewers receive the same immutable temporary context snapshot, resolved base SHA, expected HEAD SHA, final role profile, and activity-lock capability. The coordinator starts them concurrently, waits for both, verifies the clean target before delivery and history recording, and prints only complete paired results. The existing profile also identifies the controlled-review method, so earlier built-in review evidence does not satisfy or narrow this gate. Pair history narrows only from a matching completed pair; standalone, partial, or mismatched-profile reviews cannot satisfy the gate. The implementation and spec gates, standalone reviews, captures, walkthroughs, and critiques share one activity lock per worktree.

Again, successful command exit only establishes that both review results are available. Classify the findings from both results together before deciding whether the implementation gate passes.

Normal session history is the review record and the source for elapsed time, review count, and findings. The repository does not duplicate it in receipts or attempt logs.

Before Ready, retain a small, safe workflow-usage table in the PR and update it after every execution, retry, repair, failed or interrupted run, and re-review. One row is one execution (implementation, one Codex review, one Claude review, or similar); a paired review is two rows, and conversational topic phases are not separate rows. The private maintainer task-usage operation reads native logs and session records, emits the sanitized report, and the canonical `pr:ready` validator checks that report; do not add separate scripts, collectors, receipts, CI checks, or schema systems for this record. Keep requested and reported model/effort values distinct, and record start/end, elapsed time, normalized input, cache-read/cache-write detail, output, total tokens, and result. Normalized input is raw `input_tokens` for Codex; for Claude it is `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. Cache read/write values are subsets of normalized input. Provider-reported reasoning is included in output; do not add reasoning or other nested token fields again. Total is normalized input plus output. Sum token categories and total. Summed run durations add every row's elapsed duration, including parallel runs, and are not wall-clock elapsed time. Calculate wall span from the earliest included start to latest included end, including gaps. Mark missing boundaries or usage `partial` or `unknown`, never zero. Publish only safe summaries; omit local log paths, session IDs, and private data.

Claude review launchers also write one-line diagnostics to stderr with the prefix `ARTIFACTSHARE_REVIEW_USAGE `. Redirect stderr when a durable local capture is needed. Delivery is best-effort and never changes provider execution or the review result. A start record identifies the invocation, phase, finder or verifier role, requested model and effort, and caller timestamp. Its matching completion record repeats that identity and adds the caller end and elapsed time, provider and adapter outcomes, safe native session/duration/status fields, and each native `modelUsage` model bucket projected to numeric `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, and `output_tokens`. A missing or unreliable final value is described by `usage_missing_reason` and is never replaced with zero. `review_output_outcome: "accepted"` means only that the adapter handed the envelope to the controlled-review runner; finder/verifier validation and the overall gate can still fail. The launcher does not copy prompts, result prose, structured output, permission details, costs, credentials, or the raw envelope into these records. This uses Claude Code's documented [JSON print output for structured results, session ids, and usage](https://code.claude.com/docs/en/sessions) and whole-tree [`modelUsage` accounting](https://code.claude.com/docs/en/agent-sdk/cost-tracking), rather than its internal on-disk session format.

## Safety boundaries

- Use a committed, clean worktree for every review and never review a stale remote branch.
- Start the Codex and Claude reviews concurrently through the gate (standalone reviews in one worktree run one at a time under the activity lock), and do not run commands that can change HEAD or the worktree until both finish.
- A specification gate applies to one exact Artifact Share version. Any new version requires new Codex and Claude deep reviews before implementation.
- An implementation gate applies to one exact commit. Any later commit requires new Codex and Claude deep reviews before Ready.
- Keep only one open PR in this repository at a time.
- A Draft PR is the review workspace; commit and push fixes normally.
- `pr:ready` requires a clean worktree, a Draft for the current branch targeting `main`, a pushed local `HEAD`, a sanitized task-usage report targeting that `HEAD` whose single generated block is the one in the PR body, and successful required checks.
- Keep private URLs, issue numbers, customer context, credentials, and private repository paths out of commits and PR metadata.
- The public PR guard treats same-repository maintainer branches as implementation work. Fork PRs may add exactly one proposal document and cannot change code, workflows, or repository-boundary policy.
- Production writes use only the protected deployment workflow. Local validation selection never authorizes a production operation.

If a required local tool (`codex`, `claude`, `python3`, `gh`, the platform's `lockf`/`flock` utility, or the Artifact Share CLI used for spec readback) is unavailable, stop before any remote write and report the missing dependency.
