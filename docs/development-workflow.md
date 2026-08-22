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

Changing the specification after its gate invalidates that gate. Changing the implementation after its gate invalidates that gate. Finish mechanical corrections before the final review; if the version or commit changes afterward, start both deep reviews again in parallel against the new target. Do not stop or restart one reviewer merely because the other finishes first or reports a blocker: wait for both results so one correction pass can address the complete finding set. Keep dispositions in the normal task or reviewer session, and summarize the final gate and any follow-ups in the pull request. Do not create receipts, digests, locks, attempt logs, or review-specific push guards.

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
- Workflow scripts and guards: `pnpm format`, `pnpm lint`, and the changed script tests (or `pnpm test:scripts` when the boundary is broad).
- Product code: typecheck and the tests closest to the changed behavior. Add build, browser, integration, runtime, visual, migration, schema, or React Doctor checks only when the change can affect them. A change that touches page chrome or the dev-scenario surface also runs `pnpm check:scenario-routes`; its click-driven navigation exercises a path the browser-mode scenario tests do not.
- After a commit changes product UI, run `pnpm visual:compose` and inspect the baseline diff before publishing or adding another commit.
- Dependencies, CI, release, deployment, and repository boundaries: run their dedicated contract checks plus the relevant static or build checks.

Record the commands and results in the pull request. If the affected surface is unclear, broaden validation or run `pnpm validate`. Never reduce production, credential, migration, billing, authentication, or public/private boundary checks on the basis that the merge queue will catch them later.

## Delivery sequence

1. Confirm the intended behavior and write a specification when design is needed.
2. If a specification is required, start Codex and Claude deep reviews of its fixed final version in parallel, wait for both, classify every finding together, and repeat both reviews in parallel on each new version until no blocker remains.
3. If UI changes, capture the current state or prepare a static mock and use the UI critique below before implementation.
4. Implement and commit the complete change.
5. Run the selected local validation. If validation changes files, commit them and rerun the affected checks. Keep the worktree clean before review or publication.
6. Start Codex and Claude deep reviews of the committed Ready candidate in parallel, wait for both, classify every finding together, and repeat both reviews in parallel on each new commit until the latest commit has no unresolved blocker.
7. Publish a Draft PR with `pnpm pr:publish -- --body-file <path> --title <title>`. Further fixes use normal commits and pushes; the pre-push boundary guard scans every push.
8. If UI changed, capture every affected state and repeat UI critique after material visual fixes. Commit any resulting change and return to the implementation gate.
9. Push the final commit normally and run `pnpm pr:ready`. It verifies the Draft targets `main`, the remote PR head equals local `HEAD`, and required PR checks have succeeded before calling `gh pr ready`. When the diff contains UI changes, it stops until you confirm that affected states were captured, the captures and relevant source were critiqued, and no UI changed afterward; after those checks, rerun it with `pnpm pr:ready -- --ui-gate-complete`.
10. Use the merge queue. Its unit, CLI, browser, build, integration, runtime, and visual lanes are the final validation record. A queue entry runs the snapshot taken when it was added: after pushing a fix to a PR that failed in the queue, rebuild the entry with `gh pr merge <pr> --disable-auto` followed by `gh pr merge <pr> --auto` — an "already queued" response may still point at the old snapshot.

## UI critique

UI critique is required only for UI changes and supplements code review. Use `pnpm screens:capture`, [Screen capture](./reference/screen-capture.md), and [the design-system critique criteria](./reference/design-system.md#14-エージェント批評の観点). Supply existing PNG captures and relevant source; the reviewer must return `NEEDS INPUT` rather than launch another browser or guess when evidence is missing.

## Review commands

`review:codex` checks a clean committed checkout and verifies that `HEAD` and the worktree do not change. Its implementation phase runs native `codex review --base origin/main`. Its spec phase reads the fixed Artifact Share version and unresolved comments, then passes them to `codex exec` in a read-only sandbox.

`review:claude` is a thin launcher with a 30-minute limit. Its implementation phase runs Claude Code's built-in `/code-review high` against `origin/main...HEAD`. Its spec phase reads the current Artifact Share version and unresolved comments; the supplied version id prevents review of a stale revision. The default `high` review is the final gate. Use `--level low` only for a quick intermediate pass, never as gate evidence.

For a specification gate, use `review:spec`. It starts both commands concurrently with the same Artifact Share URL and version id, waits for both, and persists one combined state comment only after both valid results are available:

The specification must contain a short `## Scope lock` with `### Owner decisions`, `### Non-goals`, and `### Acceptance criteria`. Both commands print that lock followed by only the normalized finding JSON; reviewer exploration and repeated specification text stay captured and are not printed on success. Blockers without a broken current acceptance criterion or new correctness/safety evidence and a minimal fix are downgraded to non-actionable.

The coordinator stores baseline metrics, reviewed version ids, the unresolved-comment fingerprint, and the latest exact findings from both reviewers in one machine-readable Artifact Share comment thread. Older findings are removed after their dispositions are accepted so the state stays within the comment limit. Later sessions append state as replies using the same authenticated CLI profile; a different profile must not silently replace the trusted history. If the state thread was resolved, the next state starts a new thread. The coordinator prints the baseline metrics needed for the next correction. The repository contains no receipt or attempt log. For correction reviews, pass an untracked temporary `--dispositions-file`. It contains `baseline_metrics`, a `prior_findings` array exactly covering the persisted Codex and Claude ids (including an explicitly empty array), and a same-length `dispositions` array keyed by those ids. Each disposition is `fixed`, `follow_up`, `non_actionable`, or `rewrite`; set `repeated` or `contradiction` to `true` when applicable. The coordinator refuses a fourth version and incomplete classification. Only the owner may authorize `--reset`; an agent must stop at the circuit breaker until that approval is present. After an approved full rewrite or detected divergent write, reset the same comment with `--reset`. Do not commit the temporary dispositions file.

```sh
pnpm review:spec -- --artifact-url <url> --version-id <id>
pnpm review:spec -- --artifact-url <url> --version-id <corrected-id> --dispositions-file <path>
# Owner-approved full rewrite only:
pnpm review:spec -- --artifact-url <url> --version-id <rewrite-id> --reset
```

Classify the combined findings before editing the specification. The gate passes only when neither result has an unresolved blocker.

For an implementation gate, start both commands concurrently on the same clean commit. Wait for both to finish before acting on either result:

```sh
codex_log=$(mktemp); claude_log=$(mktemp)
pnpm review:codex -- --phase implementation >"$codex_log" 2>&1 & codex_pid=$!
pnpm review:claude -- --phase implementation >"$claude_log" 2>&1 & claude_pid=$!
codex_status=0; wait "$codex_pid" || codex_status=$?
claude_status=0; wait "$claude_pid" || claude_status=$?
cat "$codex_log"; cat "$claude_log"
rm -f "$codex_log" "$claude_log"
test "$codex_status" -eq 0 && test "$claude_status" -eq 0
```

Again, successful command exit only establishes that both review results are available. Classify the findings from both logs together before deciding whether the implementation gate passes.

Normal session history is the review record and the source for elapsed time, review count, and findings. The repository does not duplicate it in receipts or attempt logs.

## Safety boundaries

- Use a committed, clean worktree for every review and never review a stale remote branch.
- Start the Codex and Claude reviews concurrently, but do not run commands that can change HEAD or the worktree until both finish.
- A specification gate applies to one exact Artifact Share version. Any new version requires new Codex and Claude deep reviews before implementation.
- An implementation gate applies to one exact commit. Any later commit requires new Codex and Claude deep reviews before Ready.
- Keep only one open PR in this repository at a time.
- A Draft PR is the review workspace; commit and push fixes normally.
- `pr:ready` requires a clean worktree, a Draft for the current branch targeting `main`, a pushed local `HEAD`, and successful required checks.
- Keep private URLs, issue numbers, customer context, credentials, and private repository paths out of commits and PR metadata.
- The public PR guard treats same-repository maintainer branches as implementation work. Fork PRs may add exactly one proposal document and cannot change code, workflows, or repository-boundary policy.
- Production writes use only the protected deployment workflow. Local validation selection never authorizes a production operation.

If a required local tool (`codex`, `claude`, `gh`, or the Artifact Share CLI used for spec readback) is unavailable, stop before any remote write and report the missing dependency.
