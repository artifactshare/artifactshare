# Viewer controller coverage

Prepare with `pnpm fixtures:build && pnpm --filter @artifactshare/contract build`,
then run `pnpm --filter @artifactshare/web test:unit:viewer`. This discovers the
whole `app/routes/a.$id/+components` directory through `vitest.config.ts`, including
new tests. CI's `source-units` uses that same scope with the native Vitest reporter,
before `source-plan` can load browser configuration. Documentation-only selection
loads neither configuration. The directory is ownership, not a fixed file/count registry.

## Authorization migration

Cases formerly in `live-authorization.behavior.browser.test.tsx` now live in
[`live-authorization.test.tsx`](../routes/a.$id/+components/live-authorization.test.tsx).
Test titles and parameter values are retained except the two retained-page duplicates consolidated below. The following rows identify every
expanded case; a row's parameters expand only as stated. The final runtime is Happy
DOM throughout this table. Each test mounts real `useViewerComments`, with
`createCommentRuntime`, `createCommentSession`, its reconciliation/page hooks and live connection lifecycle. Renewal, socket and budget rows protect `useViewerComments`; membership/page rows protect `createCommentSession` and `createCommentRefreshScheduler`; auth-denial rows also protect `classifyLiveRecoveryResponse` and `isCommentAuthErrorStatus`.
Only fetch/WebSocket delivery, visibility, clocks and randomness are controlled.
Native JSON reads are observed before stale-result assertions; controlled transport
in either runtime does not establish a real socket or API guarantee.

| Final test title (distinctive prefix) / parameters                                                                                                                                                           | Protected fault and decisive assertion                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| reconciles local `$intent` at the 50-thread boundary                                                                                                                                                         | create-thread/delete-thread/resolve for disabled, live, stopped; additionally create-thread/delete-thread while stopped+hidden. Server-selected membership, retained expanded replies and drafts survive real mutation settlement; exact 50-row membership and fetch/socket counts. |
| reconciles displaced rows in a `%i`-reply page / 3, 50                                                                                                                                                       | Later/stale refreshes cannot lose displaced rows; message IDs/bodies, cursor and request counts remain correct.                                                                                                                                                                     |
| authorized recovery revalidates expanded history after a remote edit and deletion                                                                                                                            | Authorized recovery updates edited/deleted retained replies and membership, with one page request.                                                                                                                                                                                  |
| `%s` refreshes all retained pages / reconnect, unidentified notification → `comment-reconciliation.test.tsx`: `%s refreshes a retained range outside an existing dirty set` / reconnect, unidentified change | Consolidated duplicate: deleted reply absent, retained reply present, exact membership, two total range reads, preserved draft, deterministic 1-second reconnect.                                                                                                                   |
| reconciles selected membership and refreshes only the changed thread history                                                                                                                                 | Targeted notification refreshes only the changed page and retains selected membership.                                                                                                                                                                                              |
| keeps the server-selected 50 threads across new-thread and status notifications                                                                                                                              | Notification cannot append beyond the server window or use stale status.                                                                                                                                                                                                            |
| revalidates replies displaced from the latest window                                                                                                                                                         | Remote edits/deletes must reach previously loaded replies, not merely latest summaries.                                                                                                                                                                                             |
| reconciles a comment with its notification withheld once per direct renewal                                                                                                                                  | Renewal reads missing remote data exactly once, without a separate recovery check.                                                                                                                                                                                                  |
| preserves newer applied threads across a delayed direct-renewal GET                                                                                                                                          | Release the older GET after mutation; consume its body, then assert newer threads survive.                                                                                                                                                                                          |
| replaces an aborted renewal GET once                                                                                                                                                                         | Mutation snapshot missing remote data causes one replacement GET, whose newer data applies.                                                                                                                                                                                         |
| reconciles membership after an applied mutation without deferred work                                                                                                                                        | Membership applies with exactly two fetches.                                                                                                                                                                                                                                        |
| ignores an old ordinary `%s` completion / success, denied, rejected                                                                                                                                          | Pending direct renewal is not cancelled or overwritten by old ordinary results.                                                                                                                                                                                                     |
| closes the renewed socket after its own ordinary reconciliation repeats an auth error                                                                                                                        | `isCommentAuthErrorStatus` retains 403: exactly two fetches, renewed socket CLOSED, disconnected output, exactly two sockets.                                                                                                                                                       |
| keeps the `$kind` recovery snapshot / bounded, renewal × success, denied, rejected                                                                                                                           | Old completion after recovery cannot overwrite authorized data or close the new connection.                                                                                                                                                                                         |
| caps a pending `%s` episode across repeated hide-while-connecting / bounded, renewal                                                                                                                         | Hiding cannot reset consumed attempt budget; socket/check counts stay bounded.                                                                                                                                                                                                      |
| reconciles once on `%s` open after a newer applied mutation / renewal, bounded                                                                                                                               | Newer mutation requires one open reconciliation; its echoed notification cannot duplicate it.                                                                                                                                                                                       |
| reconciles once on `%s` open after a mutation settles during its check / renewal, bounded                                                                                                                    | Explicit event order preserves mutation freshness while permitting one replacement reconciliation.                                                                                                                                                                                  |
| preserves consumed attempts when hiding aborts an in-flight explicit check                                                                                                                                   | Aborting a check on hide cannot grant fresh attempts.                                                                                                                                                                                                                               |
| ignores a superseded explicit `$oldResult` completion / authorized, rejected × open, exhaust                                                                                                                 | Old check cannot interfere with pending replacement, successful opening or exhausted state.                                                                                                                                                                                         |
| uses one dedicated check and caps a denied renewal                                                                                                                                                           | Denial stops after the first failed attempt and one dedicated check.                                                                                                                                                                                                                |
| uses a fresh dedicated check for explicit mutation recovery after a stop                                                                                                                                     | A fresh mutation can recover; denial is not a permanent latch.                                                                                                                                                                                                                      |
| uses exact two and four second delays with a three-attempt authorized renewal cap                                                                                                                            | No socket before 2/4 seconds; socket at boundary; no fourth attempt.                                                                                                                                                                                                                |
| preserves the correct budget after hiding / opened→3, connecting→1, retry scheduled→2                                                                                                                        | Only a completed/open episode permits a fresh budget.                                                                                                                                                                                                                               |
| times out stalled renewal attempts once / synchronous close, silent close, throwing close                                                                                                                    | Timeout counted once; late open/message/close ignored; explicit recovery remains possible.                                                                                                                                                                                          |
| controlled opaque handshake retries use bounded jitter / random 0, 1                                                                                                                                         | No retry before each base+jitter delay; retry exactly at boundary.                                                                                                                                                                                                                  |
| controlled renewal retries jitter without adding attempts / random 0, 1                                                                                                                                      | 2/4-second jitter boundaries retain three-attempt cap.                                                                                                                                                                                                                              |
| accounts for silent ordinary failures and exhausts three stalled authorized recovery attempts                                                                                                                | Silent socket failures still consume bounded recovery attempts.                                                                                                                                                                                                                     |
| enforces the absolute ordinary boundary / timeout, late open                                                                                                                                                 | Stalled socket cannot extend the 120-second absolute deadline or reopen after it.                                                                                                                                                                                                   |
| keeps a same-sequence ordinary boundary abort indeterminate                                                                                                                                                  | Late Authorized body is consumed but cannot reset elapsed budget or apply stale data.                                                                                                                                                                                               |
| clears a stalled bounded timer on hide                                                                                                                                                                       | Hidden timer clears without refunding consumed attempt.                                                                                                                                                                                                                             |
| grants all three fresh attempts / mutation, visibility return                                                                                                                                                | Exhausted hidden episode allows a genuinely fresh recovery.                                                                                                                                                                                                                         |
| clears pre-open timers on open, artifact replacement, and teardown                                                                                                                                           | No leaked timer or stale socket work after lifecycle transitions.                                                                                                                                                                                                                   |
| keeps ordinary backoff for sixty seconds before its sole denial check                                                                                                                                        | Exact ordinary backoff and one denial check at the boundary.                                                                                                                                                                                                                        |
| stops ordinary indeterminate recovery at 120 seconds                                                                                                                                                         | No more sockets after stop; fresh authorized mutation recovery connects and reconciles.                                                                                                                                                                                             |

The existing `comment-runtime.integration.test.tsx` owns cross-navigation draft,
pending POST and overlapping panel/popover settlement. `comment-reconciliation.test.tsx`
owns page/target races and authorization recovery without a replacement socket.
`use-comment-mutations.test.tsx` owns producer error/draft isolation and mutation
intents. The retained-page reconnect/unidentified-notification duplicates were consolidated into `comment-reconciliation.test.tsx`, preserving their draft and timing assertions. The remaining migrated selected-window and mutation cases
add socket renewal/open/check ordering through the real combined runtime. Similar
names alone do not make those event-order faults equivalent.

## Versions and browser witnesses

[`latest-version.test.tsx`](../routes/a.$id/+components/latest-version.test.tsx)
mounts real `ViewerShell`/`useLatestVersionNotice`. Its published matrix uses the
actual `+published-viewer-loader-fixture` loader, with persistence/services mocked,
for en/ja × scheduled/ordinary × owner/member (current/historical) or anonymous
(current): 20 combinations. It consolidates the former browser and Node matrices.
Assertions protect displayed version, history capability, scheduled label, hidden
anonymous chrome and absence of freshness text. Other loader access/grant assertions
remain in `published-viewer-loader.test.tsx`.

Fetch/clock-controlled units also protect endpoint eligibility, six ineligible
anonymous states with a healthy transition, actual AbortSignal cancellation, late
cancellation-ignoring responses, pending cooldown cancellation, anonymous 404 lifetime
stop (including later visibility/interval/pointer changes), signed-in 404 polling,
29,999/30,000 ms cooldown, original 300,000 ms cadence and newer-result notices.
The 404 and stale-result tests are decisive assertions for source faults, rather
than tests of copied hook logic.

`a.$id/latest-version.behavior.browser.test.tsx` retains real loader-to-render
wiring, anonymous Show latest focus return to the stable viewer, history viewer
focus preservation, stable live-region identity and computed visibility with
collapsed chrome. `a.$id/link-root.behavior.browser.test.tsx` retains actual browser
history and SSR/hydration. `comment-session` retains panel/native tasks and
SSR/hydration; `comment-frame-recovery` retains frame recovery; `sandbox-frame-recovery`
retains native and streamed Response body completion under fake clocks, including
real elapsed-time and cleanup assertions. Happy DOM is not evidence for these
focus/CSS/history/iframe/native-task contracts. No full matrix remains in browsers.

Run these witnesses with `pnpm --filter @artifactshare/web exec vitest --config
vitest.behavior.browser.config.ts --run` followed by those five route paths. Use
all applicable configured projects (Chromium, Firefox and WebKit); project
applicability is unchanged. The source lane still has a 180,000 ms admission clock
and 600,000 ms process deadline, and changed-browser repetitions still run five times.
Preparation/unit time is additional, not part of a three-minute total promise.

Gate tests in `scripts/changed-browser-repetitions.test.mjs` use cheap injected
process/discovery boundaries for invalid reports and interruption. One temporary
real Vitest subprocess fixture verifies native healthy/failing assertion reporting;
it is outside app discovery and removed after the test. No browser/database is
needed to establish report validation. A successful process alone cannot unlock
browser discovery; the report must match the dynamically discovered modules and
fixed head, complete without errors, and contain passing assertions.

Migration check: removing `status === 403` from `isCommentAuthErrorStatus`
made the original browser case and its moved unit case fail at the same
`fetchMock` assertion (expected two calls, observed one). Restoring it passed
both controls. This establishes that fault only; the other source-fault probes
remain separate verification, not an assumption of native API equivalence.
No retry/timeout increases, skipped cases or reduced rendering fixture loads
were introduced by the migration.
