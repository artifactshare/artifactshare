## Change

Describe the implementation and its generalized user-visible effect. Describe any workaround, the root cause it leaves in place, and why the cause cannot be removed in this repository. Record this in the commit message (repeated in the PR description).

## Validation

List the tests, lint checks, builds, and runtime smoke checks you ran, with their results. Do not include private URLs, customer names, internal specification links, or information that identifies a customer environment.

## Workflow usage

Optional. If included, ask the maintainer task-usage operation for a sanitized report targeting this checkout's `HEAD`. Keep this `## Workflow usage` heading and replace its contents with the report's generated `markdown` block exactly once; do not hand-fill a second workflow-usage table. The public `pr:ready` gate validates the report target, row and total arithmetic, coverage reasons, and the single marker block when present.

## Review

Introduced workarounds are always blockers; neither an author record nor an owner decision is an exemption. Record the cause and removing change with `workaround: true`. Follow the [workaround consultation and Ready policy](../docs/development-workflow.md) for `--consult-workarounds`, early `PROCEED`, and persistent `FIX HERE` refusal.

`pr:ready` refuses unless the implementation gate (`pnpm review:implementation`) recorded, for the final HEAD, a completed Codex/Claude pair that reported no blocker or has an eligible early workaround PROCEED, and whose reviewed range reaches the branch's merge base (directly or through earlier completed pairs), or a round-cap consultation for that HEAD that decided PROCEED. A persistent FIX HERE refusal takes precedence over all approvals. For a UI change it also requires a completed `pnpm critique:tasks` record for that HEAD. If the consultation decided PROCEED, list the remaining findings as deferred. A change to this workflow policy must receive the Codex/Claude deep-review pair before landing, or once the round cap is spent the PROCEED consultation above. Summarize follow-ups and deferred findings honestly, and do not include private specification or issue references.
