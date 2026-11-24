# Artifact Share

Read `docs/reference/development-constraints.md` before you change product code.

- Install dependencies with `pnpm install --frozen-lockfile`. Before you call a change done, run `pnpm lint`, `pnpm typecheck`, and the tests that cover the change. `pnpm validate` runs everything locally, and the merge queue runs the full validation.
- This repository is public. Keep credentials, customer context, private documents, and private URLs out of files, branches, commits, and pull requests.
- Production writes run only through the protected GitHub `production` Environment and its deploy workflow, never from a local shell.
- For UI work, read `apps/web/PRODUCT.md` and `apps/web/DESIGN.md` first, and use the existing components and tokens. Product UI changes keep React Doctor at zero warnings and errors.
