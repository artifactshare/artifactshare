## Change

Describe the implementation and its generalized user-visible effect.

## Validation

List the tests, lint checks, builds, and runtime smoke checks you ran, with their results. Do not include private URLs, customer names, internal specification links, or information that identifies a customer environment.

## Workflow usage

Before Ready, ask the private maintainer control-plane `task-usage report --format public-json --repository <public-root>` operation for the sanitized report targeting this checkout's `HEAD`. Replace this section with the report's generated `markdown` block exactly once; do not hand-fill a second workflow-usage table. The public `pr:ready` gate checks the report target, row and total arithmetic, coverage reasons, and the single marker block.

## Review

For a substantive change, confirm that Codex and Claude both deeply reviewed the final HEAD with no unresolved blockers, and summarize any follow-ups or non-actionable findings. For an exempt typo or explanatory-documentation change, state why no independent review was needed. Do not include private specification or issue references.
