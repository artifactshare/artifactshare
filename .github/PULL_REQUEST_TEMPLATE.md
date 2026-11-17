## Change

Introduced workarounds are always blockers, even when recorded or owner-approved; neither an author record nor an owner decision is an exemption. Reviewers mark them with `workaround: true`, `root_cause` and `removing_change`. The commit message and PR description must record the workaround, the remaining root cause and why it cannot be removed in this repository. Run `pnpm review:implementation -- --consult-workarounds` explicitly for an exact-HEAD latest pair under the current profile with at least one blocker, all blockers marked, valid retained findings and coverage reaching the branch merge base. This consultation-only path works before or after the five-pair cap, refuses `--base`, and accepts optional supplementary `--dispositions-file`. It reads the actual marked findings, commit record, objective scope and full fixed diff. It returns `FIX HERE` when any cause can be removed in this repository, otherwise `PROCEED`; it never returns to the owner. `FIX HERE` persistently refuses that exact HEAD before any Ready ledger or GitHub mutation, even after another consultation, replacement pair, profile change or visiting another HEAD. Correct the cause in a new commit and obtain fresh evidence; returning to the refused SHA still refuses. Early `PROCEED` authorizes only the exact latest pair identity, HEAD, profile and valid all-marked evidence with complete range coverage. Record remaining findings as deferred after `PROCEED`. The separate round-cap path retains `PROCEED` / `RETURN TO OWNER` and its unreviewed-change coverage, subject to the persistent `FIX HERE` refusal. UI critique and all other Ready prerequisites still apply.

Describe the implementation and its generalized user-visible effect. Describe any workaround, the root cause it leaves in place, and why the cause cannot be removed in this repository. Record this in the commit message (repeated in the PR description).

## Validation

List the tests, lint checks, builds, and runtime smoke checks you ran, with their results. Do not include private URLs, customer names, internal specification links, or information that identifies a customer environment.

## Workflow usage

Optional. If included, ask the maintainer task-usage operation for a sanitized report targeting this checkout's `HEAD`. Keep this `## Workflow usage` heading and replace its contents with the report's generated `markdown` block exactly once; do not hand-fill a second workflow-usage table. The public `pr:ready` gate validates the report target, row and total arithmetic, coverage reasons, and the single marker block when present.

## Review

`pr:ready` refuses unless the implementation gate (`pnpm review:implementation`) recorded, for the final HEAD, a completed Codex/Claude pair that reported no blocker and whose reviewed range reaches the branch's merge base (directly or through earlier completed pairs), or a round-cap consultation for that HEAD that decided PROCEED. For a UI change it also requires a completed `pnpm critique:tasks` record for that HEAD. If the consultation decided PROCEED, list the remaining findings as deferred. A change to this workflow policy must receive the Codex/Claude deep-review pair before landing, or once the round cap is spent the PROCEED consultation above. Summarize follow-ups and deferred findings honestly, and do not include private specification or issue references.
