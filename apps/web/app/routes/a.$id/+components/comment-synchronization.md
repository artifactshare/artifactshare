# Comment synchronization contracts

The viewer retains bounded comment windows while selection, local mutations,
remote notifications, and authorization recovery may proceed concurrently.
This reference describes the behavior preserved by the runtime migration.

## Scope lock

### Owner decisions

- Keep comment membership, retained pages, selection, drafts, and anchor merge
  precedence unchanged while moving mutation tracking to an explicit runtime.
- One browser environment shares the runtime. Server requests must not create
  or share it. Display subscriptions and read operations retain artifact records;
  pending mutations retain their captured records independently.
- A record is collectible only after its last lease and mutation finish.
  Returning to an artifact during a pending post observes the original job.
- Typed subscriptions replace window mutation-settled events. Disposed viewers
  receive no further callbacks; a subscriber failure cannot prevent delivery to
  another viewer.

### Non-goals

No changes to server response formats, authorization decisions, database schema,
socket authorization/retry policy, anchor precedence, history retention, or draft
ownership. No new global network retry guarantee. Engine rollout is separate
from this shared-runtime change.

### Acceptance criteria

- Posting in A, visiting B, returning to A, and completing the post cannot update
  B, erase a newer draft, duplicate the post, or leave pending state behind.
- Overlapping posts suppress response application until reconciliation, retaining
  the existing overlap policy until all concurrent posts settle.
- Thread epochs affect only their thread; artifact epochs affect every thread.
- StrictMode and abandoned renders do not subscribe, invalidate, or dispose a
  committed display. Version changes do not unconditionally remount the viewer.
- Independent sequential test scenarios have isolated requests and subscriptions
  without a production reset API.

## Ownership and delivery

`comment-runtime.ts` owns artifact/thread epochs, pending mutation identities,
overlap tracking, and settlement subscriptions. `comment-runtime-browser.ts`
provides the browser owner. React effects acquire display leases; reads hold
leases through completion, and mutations capture jobs before making requests.

A settled job updates its original record and notifies its current subscribers.
It does not decide whether its HTTP result may update a particular display or
draft. Those guards remain with the caller. A detached display cannot reclaim a
released lease; a pending job can complete after that lease is released.

## Response adoption and continuation

| Path or event                                    | Adoption                                                         | Continuation owner                                                 |
| ------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------ |
| A newer summary supersedes an older request      | Ignore the superseded response                                   | Newer request                                                      |
| Same-thread change during a page request         | Merge into an existing thread                                    | Mark and revalidate affected ranges                                |
| Summary removes a thread before its page returns | Page cannot restore membership                                   | Explicit selected-thread lookup may add it separately              |
| Selected thread lies outside the summary window  | Fetch it explicitly; retain current selection across URL cleanup | Existing target retry UI on failure                                |
| Around-message lookup returns 404/410            | Check whether its thread survives                                | Missing-target or thread-removal path                              |
| Ordinary page returns 404/410                    | Remove the thread                                                | Existing authoritative replacement path                            |
| A local mutation overlaps another                | Do not blindly apply its returned threads                        | Settlement requests reconciliation                                 |
| Recovery snapshot predates a settled mutation    | Do not apply the stale snapshot                                  | Existing recovery/reconciliation path                              |
| Authentication fails                             | Preserve existing recovery classification                        | Only the current owning socket may be stopped                      |
| Transient summary failure                        | Preserve current cache and dirty state                           | Existing future operation or notification; no added infinite retry |
| Artifact changes during a request                | Do not apply its result to the new artifact                      | Original job settles; current display reconciles independently     |

Request sequence numbers establish response ownership, while dirty revisions
track outstanding observed changes. Neither is a server revision. A successful
older refresh must not clear dirtiness recorded after it began.

Anchor results still use the existing thread merge precedence. Retained window
coverage is established by server results, not by adjacency in the local cache.
The socket recovery state machine remains responsible for connection ownership
and authorization, separately from whether recovered rows can be adopted.

## Executable comparison boundary

`app/test/comment-sync-harness.tsx` accepts the viewer hook as its engine. A run
owns one React root, two independent mutation hooks (panel and popover), the
production reply reducer, deferred HTTP responses, and request/cancellation
traces. Run the same input script sequentially with each engine; do not mount
the engines together. Each run has explicit expected snapshots as well as the
cross-run equality check, so two equally wrong results do not constitute a pass.

Disposal unmounts every display, requires all HTTP gates and mutations to have
finished, and verifies that the touched Runtime records have been collected.
Failure cleanup drains unresolved HTTP gates before restoring the original
fetch, then fails the test; it does not accept unfinished work as success.
There is no production reset function. The harness currently exercises the
legacy engine twice. This proves repeatability, not equivalence to an engine
that has not yet been implemented.

The input surface includes artifact/target navigation, draft edits, independently
started posts, controlled responses, explicit target recovery, and unmounting.
Snapshots expose rows, drafts, UI pending keys and target failure. Traces retain
HTTP method/path and cancellation. Socket authorization/reconnect tests remain
real hook/browser integration tests; the target-retry scenario does not replace
or claim to cover that state machine.

| Contract                                                                        | Executable evidence                                                                                                         |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| A post → B → A → settlement preserves a newer draft                             | `comment-runtime.integration.test.tsx`: navigation and new draft scenario                                                   |
| Independent panel/popover posts suppress partial responses until both settle    | `comment-runtime.integration.test.tsx`: independent panel and popover posts                                                 |
| Completion after every display unmounts does not notify the next display        | `comment-runtime.integration.test.tsx`: post can finish after every display unmounts                                        |
| Failed target fetch can recover explicitly; artifact switch cancels its request | `comment-runtime.integration.test.tsx`: target failure, explicit recovery and request cancellation                          |
| Same-thread dirtiness during a page requires revalidation                       | `comment-reconciliation.test.tsx`: `same-thread change` / `socket reopen` delayed page cases                                |
| A late page cannot restore removed membership                                   | `comment-reconciliation.test.tsx`: late page cannot restore a thread dropped from the unselected panel                      |
| A selected thread can survive URL cleanup outside the summary window            | `comment-reconciliation.test.tsx`: accepted outside-window navigation survives URL cleanup                                  |
| Missing target/range errors retain accessible history and expose retry          | `comment-reconciliation.test.tsx`: invalid range keeps accessible cached replies; missing target exposes retry              |
| A newer generation supersedes an older refresh                                  | `comment-reconciliation.test.tsx`: page winning the mutation reconciliation race; selection changing during a delayed range |
| Render attempts cannot mutate committed scope                                   | `comment-reconciliation.test.tsx`: committed artifact changes, StrictMode and suspended renders                             |
| Thread/all epochs preserve page retry scope                                     | `use-comment-page.test.tsx`: thread/all/other invalidation cases                                                            |
| Runtime records survive pending reads/jobs and are released afterwards          | `comment-runtime.test.ts`: read leases; reacquiring during settlement                                                       |

The comparison harness tests externally observable hook operations. Existing
scope/epoch and scheduler unit tests additionally inspect internal contracts;
they are useful diagnostics but do not replace the hook or browser scenarios.
