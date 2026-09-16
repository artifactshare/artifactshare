# Project-list access resolution

The project index uses the existing database-facts access policy directly.
Its viewer is loaded from the current database row keyed by the session user ID;
session workspace, email, and verification fields do not override those facts.
A missing database viewer row therefore cannot see a project.

The list keeps the database-owned file and new-file counts, membership state,
external-sharing indicator, ordering, and response shape that were already used
by the facts-policy path. Other project operations retain their own existing
authorization helpers.

This direct cutover supersedes the previous `off`, `shadow`, `canary`, and `on`
modes and the proposed 14-day observation procedure. The temporary legacy
predicate, comparison logging and alert, feature-flag registration, targeting
evidence workflow, and collector have been retired. This decision does not
assert that the former observation window was completed.
