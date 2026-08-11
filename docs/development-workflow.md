# Maintainer development workflow

This repository is the source of truth for product development. A maintainer must be able to take a change from specification through a ready pull request using only a public checkout. External contributors continue to use the proposal-only process in `CONTRIBUTING.md`.

## Keep the workflow proportional

The review workflow exists to find plausible defects, not to build a second system of record around the reviewers. Prefer the native command, output, and session history of an existing tool. Do not copy the same review state into receipts, attempt logs, correlation keys, locks, or repository-specific protocols.

Add a guard or wrapper only when it prevents a concrete failure that is likely in this single-maintainer workflow and costly to recover from. Keep deterministic checks for boundaries such as the reviewed commit, clean worktree, target branch, and remote-write authorization. Do not add machinery whose main purpose is to defend against a dishonest local caller, prove that a reviewer used good judgment, or anticipate an unobserved multi-user coordination problem.

When a workflow change is proposed, start with the smallest change to this document or an existing command. A new persistent artifact, state store, background process, or cross-agent transport needs a specific failure it prevents and evidence that the existing tool cannot cover it. If review setup, bookkeeping, or repeated gates take more time than reviewing and fixing the change, stop and simplify before continuing.

## Classify the change

Use the required sequence below unless every lightweight condition is true:

- Only explanatory documents at the repository root or under `docs/` change. Markdown rendered in the product, shipped in a package, used as legal content, or published as an Update is not eligible.
- The change only fixes a typo or clarifies wording without changing its meaning.
- The change does not affect source code or source comments, UI, product behavior, normative development, review, or deployment policy, workflow guards, CI, security boundaries, dependencies, or configuration.
- There is no uncertainty about the classification.

A lightweight change may omit the pre-implementation specification and its Codex and Claude reviews. It must still be self-reviewed, committed, validated with `pnpm validate`, published as a Draft PR, reviewed by both reviewers at the committed HEAD, approved by both reviewers at the same SHA, pushed with the explicit final-GO override, pass the checks reported for the PR, and be made ready. Record the lightweight classification and how every condition above is satisfied in the PR validation section. If any condition is false or uncertain, use the full required sequence.

## Required sequence

1. Write a specification with explicit scope and acceptance criteria.
2. If the specification changes UI, capture the current screen or prepare a static mock and run the UI critique described below. Address findings and repeat the critique after material visual changes.
3. Ask both Codex and Claude to review that exact specification revision. Run Claude with `pnpm review:claude -- --phase spec --artifact-url <url> --version-id <version>`. Address actionable findings, then continue.
4. Implement the approved specification. Commit the complete change and run `pnpm validate`. If validation changes files, commit those changes and rerun validation. Do not publish the Draft PR until validation succeeds and the worktree is clean.
5. Publish the first committed version as a Draft PR with `pnpm pr:publish -- --body-file <path> --title <title>`.
6. If the PR changes UI, capture every affected state and run the UI critique before code review. Record the disposition of each finding in the PR. After material visual fixes, recapture and repeat the critique.
7. Review the committed local HEAD with both `pnpm review:codex` and `pnpm review:claude -- --phase implementation`. Fix actionable findings and repeat after material changes until both reviewers have no actionable finding at the same SHA.
8. Push that final SHA with `AS_PUSH_AFTER_GO=1 git push`, wait for the PR checks to succeed, and run `pnpm pr:ready -- --codex-go <SHA> --claude-go <SHA>`. Full validation runs separately in the merge queue after the PR is ready.

## UI critique

UI critique supplements specification and code review; it does not replace either one. Use `pnpm screens:capture` and the capture rules in [Screen capture](./reference/screen-capture.md). Use [the design-system critique criteria](./reference/design-system.md#14-エージェント批評の観点) as the source of truth rather than copying the criteria into a request.

The agent performing the critique receives existing PNG captures and relevant mock or product source. It must not launch another browser to fill missing evidence. If an input is missing, it returns `NEEDS INPUT` and identifies the required capture or source. The maintainer obtains additional captures through the existing screen-capture harness.

Use this request template:

```text
UI critique requested.

Target:
- phase: <spec review or PR review>
- related proposal or PR: <public URL or identifier>
- capture PNGs: <absolute paths produced by pnpm screens:capture>
- mock source: <HTML/CSS source paths, or none>
- product source: <relevant component/style paths, or none>

Constraints:
- Use only the supplied PNGs, source files, and a local image viewer.
- Do not launch Chrome, a headless browser, or an external browser.
- If evidence is incomplete, return NEEDS INPUT with the missing captures or source instead of guessing.
- Evaluate against docs/reference/design-system.md section 14.

Response:
- Findings in priority order, or GO when there are no findings.
```

The review commands wait for up to 30 minutes. `review:claude` is a thin launcher: the implementation phase runs Claude Code's built-in `/code-review high` against `origin/main...HEAD`, and the spec phase reads the current Artifact Share version and passes it with unresolved comments to Claude. The supplied version id is a drift guard: if the artifact advances, review the new current version instead of the historical revision. Use `--level low` only for a quick intermediate pass. Claude's normal session history is the review record and is also the source for elapsed time, review count, and findings; the repository does not duplicate that history in receipts or attempt logs.

## Safety boundaries

- Use a committed, clean worktree for every review and never a stale remote branch. A fixed Artifact Share spec records that clean checkout as reference context.
- A Draft PR is a review workspace. Its pre-push hook blocks later pushes unless the final-GO override is explicit.
- Keep only one open PR in this repository at a time. `pr:ready` requires a clean worktree, that one Draft PR to belong to the current branch, a pushed local HEAD, and the maintainer's explicit confirmation that both reviewers returned GO for that SHA. This is an accidental-mix-up guard for a single-maintainer repository, not proof against a dishonest caller.
- Keep private URLs, issue numbers, customer context, credentials, and private repository paths out of commits and PR metadata.
- The public PR guard treats same-repository maintainer branches as implementation work. Fork PRs may add exactly one proposal document and cannot change code, workflows, or repository-boundary policy.

If a required local tool (`codex`, `claude`, `gh`, or the Artifact Share CLI used for spec readback) is unavailable, stop before any remote write and report the missing dependency.
