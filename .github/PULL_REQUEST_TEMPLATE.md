## Change

Describe the implementation and its generalized user-visible effect. Describe any workaround, the root cause it leaves in place, and a reason other than size or effort. Record this in the commit message (repeated in the PR description).

## Validation

List the tests, lint checks, builds, and runtime smoke checks you ran, with their results. Do not include private URLs, customer names, internal specification links, or information that identifies a customer environment.

## Workflow usage

Optional. If included, ask the maintainer task-usage operation for a sanitized report targeting this checkout's `HEAD`. Keep this `## Workflow usage` heading and replace its contents with the report's generated `markdown` block exactly once; do not hand-fill a second workflow-usage table. The public `pr:ready` gate validates the report target, row and total arithmetic, coverage reasons, and the single marker block when present.

## Review

Confirm that the implementation gate (`pnpm review:implementation`) completed a Codex/Claude pair on the final HEAD with no unresolved blockers; `pr:ready` refuses without it. For a UI change, confirm that `pnpm critique:tasks` completed on that HEAD. A change to this workflow policy must receive the Codex/Claude deep-review pair before landing. Summarize follow-ups and deferred findings honestly, and do not include private specification or issue references.
