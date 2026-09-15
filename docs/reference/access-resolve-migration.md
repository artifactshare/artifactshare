# Access resolver shadow evidence

The `access-resolve` migration keeps the legacy project-list predicate as the
effective authorization path. In `shadow`, `canary`, and `on` modes, the same
candidate set is also evaluated from database-owned viewer and project facts.
The returned project rows still come only from the legacy result until the
separate B2-6 removal step.

The producer emits one `artifactshare_access_resolve_shadow` structured log per
comparison. Its public-safe fields are:

- `surface`: currently `projects_list`.
- `mode`: the evaluated `access-resolve` mode.
- `comparedCount`: project candidates evaluated by both paths.
- `legacyAllowedCount` and `factsAllowedCount`: allowed rows from each path.
- `migrationDiff`: the symmetric-difference count.

A nonzero difference also emits `migration_diff` with `surface`,
`legacyOnlyCount`, and `factsOnlyCount`. The alerts tail Worker validates these
fields, aggregates all valid markers in one producer trace, and sends a
cooldown-controlled alert. Logs contain counts only; they do not contain user,
workspace, project, or email identifiers.

## Two-week zero-difference evidence

Before a later cutover can rely on this shadow, retain an evidence package made
from Workers Logs exports covering exactly 14 consecutive, complete UTC days
during which the comparison mode was continuously enabled. Export each day
while it is still inside the account's log-retention window; absence after
retention is not evidence. The package must contain the UTC start and exclusive
end, every source export, the query/filter definition, and these daily
aggregates for `surface = projects_list`:

1. Count of `artifactshare_access_resolve_shadow` events and sum of
   `comparedCount`. Each day must have at least one comparison event and at least
   one compared candidate; a missing day or a zero-candidate day is missing
   evidence, not a measured zero.
2. Sum of `migrationDiff`, which must be zero on every day and over the full
   window. Independently confirm that no `migration_diff` marker was emitted.
3. Counts of `access_resolve_flagship_evaluation_failed` and
   `access_resolve_flagship_binding_missing_in_production`, both of which must
   be zero. A fallback to `off` is not shadow evidence.
4. Count of `slack_alert_event_failed` for the alerts Worker and the health of
   its deployment over the same window. Alert delivery is a detection guard;
   it does not replace the producer-log comparison evidence.

Record the deployed commit and the evaluated mode with the export. Any code or
configuration change that affects the facts projection, either predicate, the
mode evaluation, or the logging schema restarts the 14-day window. A nonzero
difference blocks cutover until it is explained and corrected, after which a
new complete window is required.

Production Flagship creation, targeting changes, mode changes, and deletion
require explicit production approval and the protected staged deployment
workflow. This implementation does not perform any of those operations. Local
and CI checks may exercise the path with `DEV_FLAGS=access-resolve=shadow`.
