# Access resolver migration evidence

The B2 migration keeps the legacy project-list predicate, the
`access-resolve` flag, comparison logging, and the alerts consumer. It does not
change the underlying access rules. The returned-row policy is:

| Effective mode | Returned rows | Comparison evidence |
| --- | --- | --- |
| `off` | Legacy predicate | None |
| `shadow` | Legacy predicate | Legacy and database-facts predicates |
| `canary` | Database-facts SQL predicate | Legacy and database-facts predicates |
| `on` | Database-facts SQL predicate | Legacy and database-facts predicates |

The table is the integrated B2 behavior. Earlier rollout tables and procedures
that described shadow as the only facts-evaluating mode are historical and
superseded.

Flagship evaluation uses the request-start workspace as `targetingKey` and
`workspaceId`. A successful Flagship result takes precedence. A missing
binding outside production may use the local development override; a missing
production binding or an evaluation failure fails back to the registered safe
default (`off`) and emits its existing error marker. `ACCESS_RESOLVE_FLAG`
does not carry expiry metadata; generic registration and expiry helpers remain
separate.

## Comparison log contract

Each comparison emits `artifactshare_access_resolve_shadow` with only:

- `surface` (`projects_list`), `mode`, and `comparedCount`;
- `legacyAllowedCount`, `factsAllowedCount`, and `migrationDiff`.

A nonzero symmetric difference also emits `migration_diff` with `surface`,
`legacyOnlyCount`, and `factsOnlyCount`. No event contains a user, workspace,
project, or email identifier. The alerts Worker remains the consumer of the
nonzero marker.

## Protected targeting evidence

`.github/workflows/flagship-access-resolve-evidence.yml` is the only B2
targeting-evidence workflow. It is manually dispatched, runs in the protected
`production` Environment, and uses an app-scoped token with only **Flagship App
Evaluate** permission. Account ID, app ID, token, targeting keys, and the HMAC
key are protected Environment secrets. The workflow does not mutate Flagship,
dispatch another workflow, read Workers or D1, or print identifiers.

The operator supplies the exact validated SHA and expected target count. The
workflow fails unless the checked-out SHA matches, the protected target set is
unique and complete, every Evaluate response is structurally valid, and every
target receives `shadow`. Its artifact contains the source SHA, count,
evaluation reason/variant, keyed target digests, and an HMAC-SHA-256 integrity
digest;
it contains no workspace IDs or credentials. Operators verify the keyed target
set against the protected source before accepting coverage.

## Observation gate

The former standalone 14-day collection procedure is obsolete. The reviewed
gate is one integrated contract: observation may start only after the deployed
served-project SQL predicate passes the complete deterministic SQLite/oracle
matrix and the protected workflow proves full target coverage.

Cutover still requires **14 consecutive complete UTC days** of shadow evidence.
For every day, retained producer logs must show at least one comparison and at
least one compared candidate, zero total `migrationDiff`, no `migration_diff`
marker, no Flagship evaluation/binding failure marker, and a healthy alerts
consumer. Missing events, zero-candidate days, retention gaps, an `off`
assignment, or incomplete targeting history are missing evidence rather than a
measured zero.

Any change to evidence generation, evaluation, detection, delivery, integrity,
or targeting restarts the full 14-day window. Changes to either predicate, the
facts projection, mode evaluation, fallback precedence, or logging schema also
restart it. Production configuration or mode changes remain separately
approved protected operations; this branch neither performs nor dispatches
them.
