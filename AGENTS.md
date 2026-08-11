# Public repository instructions

- Product-development constraints: see [`docs/reference/development-constraints.md`](docs/reference/development-constraints.md).

- Keep credentials, secret values, customer context, private documents, and private-only URLs out of this repository. Production topology, non-secret resource identifiers, deployment configuration, and deployment automation may be reviewed and maintained here when they are intended to be public.
- Production writes must use the protected GitHub `production` Environment and the staged deployment workflow. Do not run production commands from an ordinary development shell.
- Install dependencies with `pnpm install --frozen-lockfile`. Before declaring a change complete, run the local validation selected by `docs/development-workflow.md`; the merge queue remains the source of truth for full validation. Product UI changes must keep React Doctor at zero warnings and errors.
- Review implementation, user-visible behavior, tests, security boundaries, and maintainability. Keep pull-request descriptions to the implementation, its generalized visible effect, and validation results.
- Classify and run maintainer changes with `docs/development-workflow.md`, which is the source of truth for proportional specification, review, and validation. Every review must use a committed, clean worktree; spec review records the clean checkout as reference context for a fixed Artifact Share version.
- Follow the writing and contribution rules in `CONTRIBUTING.md`, `SECURITY.md`, and the nearest directory instructions.
