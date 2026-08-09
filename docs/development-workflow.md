# Maintainer development workflow

This repository is the source of truth for product development. A maintainer must be able to take a change from specification through a ready pull request using only a public checkout. External contributors continue to use the proposal-only process in `CONTRIBUTING.md`.

## Required sequence

1. Write a specification with explicit scope and acceptance criteria.
2. Ask both Codex and Claude to review that exact specification revision. Address findings and repeat until both return GO.
3. Implement the approved specification. Commit the complete change and run `pnpm validate`.
4. Publish the first committed version as a Draft PR with `pnpm pr:publish -- --body-file <path> --title <title>`.
5. Review the committed local HEAD with both `pnpm review:codex` and `pnpm review:claude`. Keep fixes in local commits while the PR remains Draft. Each review request must identify the exact SHA. Repeat the loop after every material fix until both reviewers return GO for the same final SHA.
6. Push that final SHA once with `AS_PUSH_AFTER_GO=1 git push`, wait for the applicable checks, and run `pnpm pr:ready -- --codex-go <SHA> --claude-go <SHA>`.

The review commands wait for up to 30 minutes. Silence before that limit is not a reason to interrupt them. `review:codex` isolates optional Codex integrations and terminates its process tree on timeout. `review:claude` reuses its persistent reviewer and correlates every response with a request ID so a delayed response cannot be mistaken for the current round.

## Safety boundaries

- Review committed SHAs, never an uncommitted worktree or a stale remote branch.
- A Draft PR is a review workspace. Its pre-push hook blocks later pushes unless the final-GO override is explicit.
- Keep only one open PR in this repository at a time. `pr:ready` requires a clean worktree, that one Draft PR to belong to the current branch, a pushed local HEAD, and the maintainer's explicit confirmation that both reviewers returned GO for that SHA. This is an accidental-mix-up guard for a single-maintainer repository, not proof against a dishonest caller.
- Keep private URLs, issue numbers, customer context, credentials, and private repository paths out of commits and PR metadata.
- The public PR guard treats same-repository maintainer branches as implementation work. Fork PRs may add exactly one proposal document and cannot change code, workflows, or repository-boundary policy.

If a required local tool (`codex`, `gh`, or the cross-agent messenger used by the review wrapper) is unavailable, stop before any remote write and report the missing dependency.
