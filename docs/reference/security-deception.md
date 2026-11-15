# Authenticated exploration signal

The application has one inert authenticated exploration decoy. Its only public
breadcrumb is a comment in generated robots.txt. An eligible hit is a suspicion
signal requiring investigation, never proof of AI use, malice, compromise, or
that the caller read robots.txt. Approved testing, curious users, scanners and
same-origin automation can all trigger it. No credential inventory exists behind
this handler. It returns an empty private, no-store 404, never cookies or data.

Only an exact-path POST with the exact public probe header is considered.
Prefetch/prerender hints, cross-site fetch hints and a supplied foreign Origin
are rejected before authentication. These hints reduce noise; they establish no
identity. The application host and maintenance gates run first. Link and sandbox
hosts retain their existing behavior. The React Router root session middleware
does not run for this path.

## Identity and privacy

Signed session cookies are verified with HMAC and checked against live sessions;
cached session-data cookies are ignored. API tokens use a read-only hash lookup.
CLI sessions share the existing authority policy through an identifier-only SQL
projection. OAuth uses the same MCP resource audience, signature, issuer, scope,
version and optional session-owner checks as MCP. The decoy reads stored public
JWKS only and cannot generate keys. Explicit Authorization always takes precedence
without cookie fallback. Current workspace existence and active membership are
required. Bot cookie, API-token and OAuth identities are not accepted; valid
restricted bot CLI authorities retain their normal authority checks.

The handler reads only authentication, workspace and authority metadata. It does
not read artifact content, integration credentials, names or email addresses, and
does not refresh/delete sessions, touch token last-use times, repair membership,
move users, or mutate product data. All feature writes are confined to its two
security tables. It never revokes access or changes files or permissions.

`security_deception_signals` is an operator-only security-audit extension, not a
workspace-admin artifact event. It stores verified actor/workspace/client IDs,
authentication route, validated authority IDs, first detection time, correlation
ID, and delivery state. No request body, raw URL/query, cookie, bearer, token hash,
IP, user agent, email, name, provider body or destination is retained. Payloads
and structured logs use closed field lists. Displayed IDs are escaped, bounded
at 128 characters or less, and truncation is marked; storage retains full IDs.
Unknown client attribution stays null and does not identify a browser or AI.

## Admission, delivery and retention

One atomic conditional D1 insert admits at most 1,000 signals per full UTC day.
The uniqueness key is actor/workspace/auth-route/decoy/full UTC date-hour
(`YYYY-MM-DDTHH`); rotating clients does not create another row. Duplicates do not
increment counters, notify again or rearm terminal rows. Suppression sets the
fixed control row's saturated day; it does not evict observations or grow storage.
There is no individual trace or exact count of suppressed duplicates.

The existing five-minute cron drains this table independently of project Slack
notifications. A single durable control row reserves budget only when eligible
due work exists. Reservations use actual time and are at least 300 seconds apart,
retain that budget on every outcome, and expire after 60 seconds. One reservation
claims at most ten rows and permits one HTTP call with a five-second timeout,
no redirect following and no automatic retries. HTTP attempts are persisted
before dispatch. An explicitly observed skipped dispatch restores the unsent
attempt under the matching row token and records `dispatch_expired`; unknown
crash outcomes still consume attempts. The control reservation is never released.
Missing configuration consumes a reservation but no HTTP attempt.
Acknowledgements require the row lease; dispatch also checks the control lease.

Allowed attempt starts are at least 240 seconds apart, with at most two in any
rolling 300 seconds under the reservation/lease checks. This is a reservation
bound, not exact HTTP timing or receipt spacing: suspension after the final
fence and before dispatch remains an external-side-effect race. Slack has no
exactly-once acknowledgement protocol. Acceptance followed by a crash or D1
acknowledgement failure can produce a duplicate with the same correlation ID.
Delivered means HTTP acceptance, not human receipt.

Retry delays are 5, 10, 20, 40 and then 60 minutes. Non-429 permanent 4xx failures
are terminal. Network errors, timeouts, 429 and server errors retry, stopping at
12 HTTP attempts or 24 hours from admission. Missing configuration is durably
recorded and checked again after five minutes without using an HTTP attempt;
it still expires after 24 hours while retaining `configuration_missing` as its
cause. Overdue work is expired in bounded batches.
Terminal records remain available for investigation and duplicates never rearm
them. Safe cron summaries expose active count, oldest age, configuration state,
current-run newly failed/expired counts and saturated day. The summary queries
only indexed active rows; it does not scan retained terminal history every five
minutes. Historical terminal totals remain available through existing authorized
operator database access when needed. Current drain, transport or D1 faults,
new terminal outcomes, active age over ten minutes or missing configuration fail
the cron after both notification jobs are attempted. Historical terminal rows and
old saturation alone do not keep failing cron.

First acceptance within ten minutes is a healthy timing objective only: it assumes
healthy D1/Slack, five-minute scheduling, no backlog and at most ten new signals
per five minutes. A 1,000-row burst has an ideal throughput estimate of about
8 hours 20 minutes. Neither value is a delivery promise. Actual-time 300-second
budgeting combined with five-minute scheduling jitter can skip a cron; backlog,
platform delay, rate limiting and outages extend latency and can cause expiry.

Daily reconciliation deletes in batches of 1,000 with the inclusive cutoff
`first_detected_at <= now - 400 days`, regardless of delivery or lease state.
There are no product foreign keys, so normal account/workspace deletion does not
erase attribution. At the admission cap, normal retention is roughly 401,000
rows including daily-cleanup lag. Cleanup outages extend physical retention and
storage; cleanup failure is reported through reconciliation aggregation. The
control table stays one row. Slack's separate retention policy applies to external
messages; D1 cleanup cannot delete them.

## Deployment prerequisite and investigation

The app Worker must receive the same existing operator webhook secret,
`SLACK_ALERT_WEBHOOK_URL`, as the tail Worker. The tail Worker's binding alone
does not configure the app Worker. The existing optional app Env declaration is
not evidence of provisioning. This is a protected deployment prerequisite through
the GitHub `production` Environment and staged deployment workflow, alongside
verification of production scheduling. No secret inspection or configuration is
part of this implementation. Project/workspace Slack subscriptions are never used.

Use existing restricted operator database access to inspect a correlation ID and
its delivery row. Compare independently authorized authentication/security-audit
records by actor, workspace, client and time. Verify context with the responsible
operator or user before any separate human-led response. Approved diagnostics
must not hit the decoy; use synthetic local tests for health checks.

A correlation represents one admitted observation per dedup bucket. It cannot
reliably join different credentials/clients, earlier ordinary API calls or caller
intent. Existing MCP audit covers selected mutations, not every authenticated read;
sampled logs cannot fill that gap. Inspect saturation, pending age and terminal
state when assessing coverage and false positives.

D1 failure before admission cannot be made durable; the handler returns a generic
503 and logs only a new safe correlation ID. Existing tail-Worker cron alerts are
best-effort secondary visibility. Logging/tail failures or a common Slack outage
can also prevent failure notification. There is no zero-loss claim before durable
admission, during cap suppression or after delivery expiry.
