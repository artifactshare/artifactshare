# Public repository instructions

Introduced workarounds are always blockers; neither an author record nor an owner decision is an exemption. Record the cause and removing change with `workaround: true`. Follow the [workaround consultation and Ready policy](docs/development-workflow.md) for `--consult-workarounds`, early `PROCEED`, and persistent `FIX HERE` refusal.

- Product-development constraints: see [`docs/reference/development-constraints.md`](docs/reference/development-constraints.md).

- Work only with files and context available in this repository, plus public web sources a review needs, such as dependency releases and advisories. Do not use production operations, secrets, customer context, private paths, or private URLs.
- Install dependencies with `pnpm install --frozen-lockfile`. Before declaring a change complete, run the local validation selected by `docs/development-workflow.md`; the merge queue remains the source of truth for full validation. Product UI changes must keep React Doctor at zero warnings and errors.
- Use the repository [Controlled Review skill](.agents/skills/controlled-review/SKILL.md) for orchestrated reviews, including when a personal skill with the same name is installed. The implementation gate's Claude side runs Claude Code's `/code-review` instead, as `docs/development-workflow.md` describes. The calling orchestrator owns conditions, role assignments, and finding dispositions.
- Review implementation, user-visible behavior, tests, security boundaries, and maintainability. Keep pull-request descriptions to the implementation, its generalized visible effect, validation results, any workflow usage included, and any workaround with the root cause it leaves in place and why the cause cannot be removed in this repository, recorded in the commit message (repeated in the PR description).
- Classify and run maintainer changes with `docs/development-workflow.md`, which is the source of truth for proportional specification, review, and validation. Every pull request branch initializes its objective scope before its implementation gate, and `pr:ready` requires a completed implementation pair for the exact HEAD with no blockers or an eligible early workaround `PROCEED` (and, for a UI diff, a completed critique record for that HEAD), or, once the review round cap is spent, a `PROCEED` round-cap consultation for that HEAD in place of the pair. A persistent `FIX HERE` refuses all these paths; every review must use a committed, clean worktree, and spec review records the clean checkout as reference context for a fixed Artifact Share version.
- Follow the writing and contribution rules in `CONTRIBUTING.md`, `SECURITY.md`, and the nearest directory instructions.

## UI design context

Use the Impeccable skill for UI design and review. Read `apps/web/PRODUCT.md` and `apps/web/DESIGN.md` first, then follow the existing design system, component catalog, and tokens they reference. Keep local Impeccable working files out of Git.
