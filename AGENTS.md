# Public repository instructions

- Product-development constraints: see [`docs/reference/development-constraints.md`](docs/reference/development-constraints.md).

- Keep credentials, secret values, customer context, private documents, and private-only URLs out of this repository. Production topology, non-secret resource identifiers, deployment configuration, and deployment automation may be reviewed and maintained here when they are intended to be public.
- Production writes must use the protected GitHub `production` Environment and the staged deployment workflow. Do not run production commands from an ordinary development shell.
- Install dependencies with `pnpm install --frozen-lockfile`. Before declaring a change complete, run `pnpm validate` and keep React Doctor at zero warnings and errors.
- Review implementation, user-visible behavior, tests, security boundaries, and maintainability. Keep pull-request descriptions to the implementation, its generalized visible effect, and validation results.
- Maintainer changes follow `docs/development-workflow.md`: review the specification with both reviewers, implement, publish a Draft PR, repeat both reviews against committed SHAs until both return GO, then make the PR ready. Do not skip a stage or review an uncommitted worktree.
- Follow the writing and contribution rules in `CONTRIBUTING.md`, `SECURITY.md`, and the nearest directory instructions.
