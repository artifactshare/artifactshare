# Maintainer development workflow

This repository is the source of truth for product development. A maintainer must be able to take a change from its rationale through a ready pull request using only a public checkout. External contributors continue to use the proposal-only process in `CONTRIBUTING.md`.

## Keep the workflow proportional

The workflow exists to find plausible defects and protect expensive boundaries. Prefer native tool output and session history over repository-specific bookkeeping. Add a guard or wrapper only for a concrete, likely failure that is costly to recover from.

Choose specification, review, and local validation from the actual change. Do not encode the choice in a risk matrix, classifier, receipt, or depth gate. When setup, bookkeeping, or repeated gates cost more than examining and fixing the change, simplify them.

The merge queue always runs the complete product validation. Local validation gives fast, relevant evidence before publication; it does not need to duplicate the queue for every change.

## Choose the work needed

Typos and explanatory documentation changes need a careful self-review but no separate specification or agent review. This applies only when the change does not alter shipped content, product behavior, normative policy, workflow guards, CI, security boundaries, dependencies, or configuration.

Write a specification when behavior, requirements, UI states, or acceptance criteria need a design decision before implementation. Routine fixes and contained maintenance may proceed directly when the desired behavior is already clear.

For an ordinary code, workflow, or normative documentation change, use one independent reviewer: Codex or Claude. Add a second reviewer when it has concrete value, including changes to authentication, billing, a security or repository boundary, migrations, production operations, or when the first review leaves meaningful uncertainty. Do not add a second review merely because a category label says so.

After addressing findings, repeat review only when the fix changes behavior, the meaning of the finding, or a safety property. Formatting, naming, and other mechanical corrections do not invalidate an otherwise applicable review.

## Choose local validation

Run the smallest command set that can detect a plausible defect in the changed area:

- Explanatory documentation: `pnpm format`, `pnpm public:scan .`, and any checker that owns the edited document or generated reference.
- Workflow scripts and guards: `pnpm format`, `pnpm lint`, the changed script tests (or `pnpm test:scripts` when the boundary is broad), and `pnpm public:scan .`.
- Product code: typecheck and the tests closest to the changed behavior. Add build, browser, integration, runtime, visual, migration, schema, or React Doctor checks only when the change can affect them.
- Dependencies, CI, release, deployment, and repository boundaries: run their dedicated contract checks plus the relevant static or build checks.

Record the commands and results in the pull request. If the affected surface is unclear, broaden validation or run `pnpm validate`. Never reduce production, credential, migration, billing, authentication, or public/private boundary checks on the basis that the merge queue will catch them later.

## Delivery sequence

1. Confirm the intended behavior and write a specification when design is needed.
2. If UI changes, capture the current state or prepare a static mock and use the UI critique below before implementation.
3. Implement and commit the complete change.
4. Run the selected local validation. If validation changes files, commit them and rerun the affected checks. Keep the worktree clean before review or publication.
5. Run the selected independent review, if required, against the committed local `HEAD`. Address actionable findings and repeat only after a material fix.
6. Publish a Draft PR with `pnpm pr:publish -- --body-file <path> --title <title>`. Further fixes use normal commits and pushes; the pre-push boundary guard scans every push.
7. If UI changed, capture every affected state and repeat UI critique after material visual fixes.
8. Push the final commit normally and run `pnpm pr:ready`. It verifies the Draft targets `main`, the remote PR head equals local `HEAD`, and required PR checks have succeeded before calling `gh pr ready`.
9. Use the merge queue. Its unit, CLI, browser, build, integration, runtime, and visual lanes are the final validation record.

## UI critique

UI critique is required only for UI changes and supplements code review. Use `pnpm screens:capture`, [Screen capture](./reference/screen-capture.md), and [the design-system critique criteria](./reference/design-system.md#14-エージェント批評の観点). Supply existing PNG captures and relevant source; the reviewer must return `NEEDS INPUT` rather than launch another browser or guess when evidence is missing.

## Review commands

`review:codex` checks a clean committed checkout, runs native `codex review --base origin/main`, and verifies that `HEAD` and the worktree did not change. Process lifetime and session history remain owned by the native CLI.

`review:claude` is a thin launcher with a 30-minute limit. Its implementation phase runs Claude Code's built-in `/code-review high` against `origin/main...HEAD`. Its spec phase reads the current Artifact Share version and unresolved comments; the supplied version id prevents review of a stale revision. Use `--level low` only for a quick intermediate pass.

Normal session history is the review record and the source for elapsed time, review count, and findings. The repository does not duplicate it in receipts or attempt logs.

## Safety boundaries

- Use a committed, clean worktree for every review and never review a stale remote branch.
- Keep only one open PR in this repository at a time.
- A Draft PR is the review workspace; commit and push fixes normally.
- `pr:ready` requires a clean worktree, a Draft for the current branch targeting `main`, a pushed local `HEAD`, and successful required checks.
- Keep private URLs, issue numbers, customer context, credentials, and private repository paths out of commits and PR metadata.
- The public PR guard treats same-repository maintainer branches as implementation work. Fork PRs may add exactly one proposal document and cannot change code, workflows, or repository-boundary policy.
- Production writes use only the protected deployment workflow. Local validation selection never authorizes a production operation.

If a required local tool (`codex`, `claude`, `gh`, or the Artifact Share CLI used for spec readback) is unavailable, stop before any remote write and report the missing dependency.
