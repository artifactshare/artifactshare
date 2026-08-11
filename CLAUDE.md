# Public repository instructions

- Product-development constraints: see [`docs/reference/development-constraints.md`](docs/reference/development-constraints.md).

- Work only with files and context available in this repository. Do not use production operations, secrets, customer context, private paths, or private URLs.
- Install dependencies with `pnpm install --frozen-lockfile`. Before declaring a change complete, run the local validation selected by `docs/development-workflow.md`; the merge queue remains the source of truth for full validation. Product UI changes must keep React Doctor at zero warnings and errors.
- Review implementation, user-visible behavior, tests, security boundaries, and maintainability. Keep pull-request descriptions to the implementation, its generalized visible effect, and validation results.
- Classify and run maintainer changes with `docs/development-workflow.md`, which is the source of truth for proportional specification, review, and validation. Every review must use a committed, clean worktree; spec review records the clean checkout as reference context for a fixed Artifact Share version.
- Follow the writing and contribution rules in `CONTRIBUTING.md`, `SECURITY.md`, and the nearest directory instructions.
