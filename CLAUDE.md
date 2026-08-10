# Public repository instructions

- Product-development constraints: see [`docs/reference/development-constraints.md`](docs/reference/development-constraints.md).

- Work only with files and context available in this repository. Do not use production operations, secrets, customer context, private paths, or private URLs.
- Install dependencies with `pnpm install --frozen-lockfile`. Before declaring a change complete, run `pnpm validate` and keep React Doctor at zero warnings and errors.
- Review implementation, user-visible behavior, tests, security boundaries, and maintainability. Keep pull-request descriptions to the implementation, its generalized visible effect, and validation results.
- Maintainer changes follow `docs/development-workflow.md`: review the specification with both reviewers, implement, publish a Draft PR, repeat both reviews against committed SHAs until both return GO, then make the PR ready. Do not skip a stage or review an uncommitted worktree.
- Follow the writing and contribution rules in `CONTRIBUTING.md`, `SECURITY.md`, and the nearest directory instructions.
