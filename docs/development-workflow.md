# Maintainer development workflow

This repository is the source of truth for product development. A maintainer must be able to take a change from specification through a ready pull request using only a public checkout. External contributors continue to use the proposal-only process in `CONTRIBUTING.md`.

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
3. Ask both Codex and Claude to review that exact specification revision. Address findings and repeat until both return GO.
4. Implement the approved specification. Commit the complete change and run `pnpm validate`. If validation changes files, commit those changes and rerun validation. Do not publish the Draft PR until validation succeeds and the worktree is clean.
5. Publish the first committed version as a Draft PR with `pnpm pr:publish -- --body-file <path> --title <title>`.
6. If the PR changes UI, capture every affected state and run the UI critique before code review. Record the disposition of each finding in the PR. After material visual fixes, recapture and repeat the critique.
7. Review the committed local HEAD with both `pnpm review:codex` and `pnpm review:claude -- --depth loop`. Use `--depth gate` for the normal final gate, or `--depth gate --risk high` for high-risk changes. Keep fixes in local commits while the PR remains Draft. Each review request must identify the exact SHA. Repeat the loop after every material fix until both reviewers return GO for the same final SHA; only the gate GO is valid for the final Claude approval.
8. Push that final SHA once with `AS_PUSH_AFTER_GO=1 git push`. Poll `gh pr checks` every 5 seconds for at most 2 minutes until it reports at least one check for the current branch; if none appears, stop and investigate. Then run `gh pr checks --watch`, wait for all checks reported for that PR to succeed, and run `pnpm pr:ready -- --codex-go <SHA> --claude-go <SHA>`. Full validation runs separately in the merge queue after the PR is ready.

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

The review commands wait for up to 30 minutes. Silence before that limit is not a reason to interrupt them. `review:codex` isolates optional Codex integrations and terminates its process tree on timeout. `review:claude` reuses its persistent reviewer and correlates every response with a request ID so a delayed response cannot be mistaken for the current round.

Claude review depth is an explicit cost and quality control:

- `--depth loop` uses risk `normal`, effort `low`, and reviewer `claude-reviewer-loop-low` for focused correction rounds.
- `--depth gate` uses risk `normal`, effort `high`, and reviewer `claude-reviewer-gate-high` for the normal final gate.
- `--depth gate --risk high` uses effort `xhigh` and reviewer `claude-reviewer`.

The model remains `opus`. High risk includes authentication, authorization, billing, cryptography, data migration, concurrency, and material design change. When uncertain, classify the change as high risk. The risk and rationale, selected gate, and result belong in the public PR validation section.

The Claude wrapper fixes the full local HEAD SHA and target (`origin/main...<full SHA>`) for every depth. It rejects undefined values and `--risk high` with `loop`, and rejects replies from another reviewer, request ID, or SHA. A clean worktree and unchanged SHA are rechecked before accepting a reply. Dry-runs do not start reviewers, change delivery, send requests, or create a receipt.

Only a `gate` reply whose body is `GO`, followed by the clean final recheck, creates the repository-local Git-path receipt. `pr:ready` fails closed unless that receipt contains the same SHA, `depth: gate`, the matching risk/effort/reviewer combination, and a non-empty request ID. Loop GO, missing, malformed, stale, or inconsistent receipts cannot satisfy the final gate.

For 10 Ready PR trials, keep detailed per-round records and the 10-item aggregation in the private control plane. Public PRs contain only risk rationale, executed gate, and result. Record trial number, risk and rationale, loop and gate timings/SHA/effort/results, findings first discovered at gate, Codex rounds and final SHA, added rounds, timeout/restart/exception reasons, Ready time, post-gate CI or fix escapes through merge, and escapes found within seven days after merge. Seven days after the tenth merge, compare medians and maxima for Ready lead time, Claude review time, loop count, gate reruns, timeouts, medium-or-higher gate findings, and post-gate escapes. Reconsider the mapping, including returning normal gate to `xhigh`, after one medium-or-higher gate escape or two same-kind normal-gate escapes; do not omit quality gates during the trial.

## Safety boundaries

- Review committed SHAs, never an uncommitted worktree or a stale remote branch.
- A Draft PR is a review workspace. Its pre-push hook blocks later pushes unless the final-GO override is explicit.
- Keep only one open PR in this repository at a time. `pr:ready` requires a clean worktree, that one Draft PR to belong to the current branch, a pushed local HEAD, and the maintainer's explicit confirmation that both reviewers returned GO for that SHA. This is an accidental-mix-up guard for a single-maintainer repository, not proof against a dishonest caller.
- Keep private URLs, issue numbers, customer context, credentials, and private repository paths out of commits and PR metadata.
- The public PR guard treats same-repository maintainer branches as implementation work. Fork PRs may add exactly one proposal document and cannot change code, workflows, or repository-boundary policy.

If a required local tool (`codex`, `gh`, or the cross-agent messenger used by the review wrapper) is unavailable, stop before any remote write and report the missing dependency.
