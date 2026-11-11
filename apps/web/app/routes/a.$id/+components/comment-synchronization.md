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

## Viewer data modes

`useViewerComments` remains the production default and uses the independent
legacy implementation. `useSessionViewerComments` has the same hook contract
and selects `CommentSession` for summaries, page consumers, mutation results,
anchor results, errors, dirty ranges and recovery-data adoption. There is no
Flagship or server selection yet. This comparison seam is temporary: remove the
legacy owner and mode selection once rollout and rollback decisions permit it.

Both exports share presentation callbacks and the socket lifecycle. The selected
`CommentDataPort` owns settlement marking/abort/echo handling, retained recovery
rows and their adoption, and refresh results. Socket code retains authorization,
connection retries, visibility, renewal, bounded deadlines and the owning-socket
check before stopping a connection. Only the selected owner subscribes to Runtime;
settlement follows mark → abort → invalidate recovery data → remember echo →
socket continuation → pending check → GET. Session uses Runtime settlementRevision
for recovery tickets; legacy retains its local counter. These tokens remain
separate from request generations, dirty revisions and page request identity.
Session request generations replace the legacy summary sequence; attachment
generations reject detached work, and page identities isolate consumers. The
write-only `deferredCommentRefreshDuringMutationRef` has been removed: existing
pending guards and settlement/recovery scheduling remain the continuation
mechanism, without a new global retry policy.

Owners are constructed without resources and attached in the committed artifact
lifecycle, with reversible StrictMode cleanup. Returned mutation, anchor and retry
callbacks resolve the committed owner at call time within one hook mount. The
applied-echo cache belongs to that mount (30 seconds, 20 entries), survives A → B → A,
and is never shared across viewers. The reducer receives replacement events,
including equal-row mutations and explicit deletion, while Session stores data
and errors. Error-only publications do not synthesize replacement events.

`CommentPageSessionContext` covers the product panel and inline tree. With a
Session, `useCommentPage` activates a Session page consumer; its legacy transport
and subscription stay disabled. Queued page reads resume after the React
settlement render, preserving the historical ordering with summary refresh.
401/403 pages request the existing refresh/auth result path. Composer APIs and
socket policy remain unchanged.

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

`app/test/comment-sync-harness.ts` accepts the viewer hook as its engine. A run
owns one React root, two independent mutation hooks (panel and popover), the
production reply reducer, deferred HTTP responses, and request/cancellation
traces. The producer subtree is keyed by artifact, like the product's panel;
the viewer hook retains its actual lifetime across artifact navigation. Run the
same input script sequentially with each engine; do not mount
the engines together. Each run has explicit expected snapshots as well as the
cross-run equality check, so two equally wrong results do not constitute a pass.

Disposal unmounts every display, requires all HTTP gates and mutations to have
finished, and verifies that the touched Runtime records have been collected.
Before unmounting it marks the records with a probe epoch, so a leaked lease
with no prior mutation cannot masquerade as a fresh zero-epoch record. A
deliberately leaking engine verifies this oracle's detection power.
Failure cleanup drains unresolved HTTP gates before restoring the original
fetch, then fails the test; it does not accept unfinished work as success. If
both the scenario and cleanup fail, the aggregate error preserves both causes.
All cleanup assertions run and report their failures together. An engine-owned
React cleanup exception is also recorded while driver-owned HTTP gates and
POSTs are still drained; a controlled throwing-cleanup case verifies that path.
An engine-owned
leaked lease is a failing run, not a successful comparison: the harness cannot
forcibly release an unknown owner's lease or promise isolation after a broken
engine without a reset API. The intentional leak fixture releases its own
captured lease before the next valid run.
Requests made during disposal are rejected and recorded rather than opening
another unresolved HTTP gate.
There is no production reset function. Shared navigation, mutation, draft and
target scenarios run the legacy and Session exports sequentially and compare
explicit expected snapshots and HTTP traces. Reconciliation scenarios run with
each export and the real page-consumer adapter, including selection changes,
anchor/page races, recovery windows, echo retention and StrictMode replay.
This is focused unit integration evidence, not final browser parity or fault
injection evidence.

Run the comparison suites from the repository root:

```sh
pnpm --filter @artifactshare/web test:unit comment-runtime.integration.test.tsx comment-reconciliation.test.tsx
```

The input surface includes artifact/target navigation, draft edits, independently
started posts, controlled responses, explicit target recovery, and unmounting.
Snapshots expose rows, drafts, UI pending keys and target failure. Traces retain
HTTP method/path and cancellation. Socket authorization/reconnect tests remain
real hook/browser integration tests; the target-retry scenario does not replace
or claim to cover that state machine.

| Contract                                                                                  | Executable evidence                                                                                                         |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| A post → B → A → settlement preserves a newer draft                                       | `comment-runtime.integration.test.tsx`: navigation and new draft scenario                                                   |
| Independent panel/popover posts suppress partial responses until both settle              | `comment-runtime.integration.test.tsx`: independent panel and popover posts                                                 |
| Detached completion releases its record before the next display opens                     | `comment-runtime.integration.test.tsx`: detached post releases its record before a fresh display                            |
| A new display opened during a pending post reconciles without old-response/draft adoption | `comment-runtime.integration.test.tsx`: fresh display reconciles a detached post                                            |
| Failed target fetch can recover explicitly; artifact switch cancels its request           | `comment-runtime.integration.test.tsx`: target failure, explicit recovery and request cancellation                          |
| Same-thread dirtiness during a page requires revalidation                                 | `comment-reconciliation.test.tsx`: `same-thread change` / `socket reopen` delayed page cases                                |
| A late page cannot restore removed membership                                             | `comment-reconciliation.test.tsx`: late page cannot restore a thread dropped from the unselected panel                      |
| A selected thread can survive URL cleanup outside the summary window                      | `comment-reconciliation.test.tsx`: accepted outside-window navigation survives URL cleanup                                  |
| Missing target/range errors retain accessible history and expose retry                    | `comment-reconciliation.test.tsx`: invalid range keeps accessible cached replies; missing target exposes retry              |
| A newer generation supersedes an older refresh                                            | `comment-reconciliation.test.tsx`: page winning the mutation reconciliation race; selection changing during a delayed range |
| Render attempts cannot mutate committed scope                                             | `comment-reconciliation.test.tsx`: committed artifact changes, StrictMode and suspended renders                             |
| Thread/all epochs preserve page retry scope                                               | `use-comment-page.test.tsx`: thread/all/other invalidation cases                                                            |
| Runtime records survive pending reads/jobs and are released afterwards                    | `comment-runtime.test.ts`: read leases; reacquiring during settlement                                                       |

The comparison harness tests externally observable hook operations. Existing
scope/epoch and scheduler unit tests additionally inspect internal contracts;
they are useful diagnostics but do not replace the hook or browser scenarios.

### Returning to an artifact versus remounting a viewer

The legacy viewer's stable callbacks use the currently committed artifact ID.
Within the same viewer mount, a POST started in A may therefore apply directly
after A → B → A, then settlement requests reconciliation. Preserve this behavior:
making the post visible only after a successful GET would introduce a new
failure mode when that GET fails transiently. UI pending state and drafts belong
to the keyed producer, so the new A panel is idle while the old Runtime job
remains pending; its draft survives even when its text matches the old post.

If the entire viewer unmounts, its old callbacks must not directly update a
separately mounted viewer. A new display subscribes to the retained Runtime job
and reconciles when it settles. Both cases have separate explicit snapshot and
request oracles. These hook fixtures model the existing panel reply wiring;
they do not claim to replace real panel/browser interaction tests.

The socket lifecycle still reauthorizes on a current-user change even when the
artifact and data owner stay fixed. Recovery checks require the current committed
owner before capture and on completion. A settlement observed between layout
attachment and socket-policy registration retains one consumed continuation;
teardown discards it. Data adoption interrupts superseded reads while retaining
explicit queued refreshes; lifecycle cancellation still cancels the queue.

## Mutation checks for the comparison oracles

The Session tests were checked against three temporary faults, restoring the
source after each run. Disabling both summary supersession fences (generation
advance and abort) made the authoritative-summary test observe `stale` instead
of `posted`. Appending absent page rows before the membership-preserving merge
made all three late-page cases revive `one` after patch, summary or recovery
removal. Clearing refresh scope without checking the captured revision prevented
the newer-dirty-intent test from issuing its required retained-range read.

These are test sensitivity checks, not production fault switches. Run
`comment-session.test.ts` with the original guards restored for the positive
case; the shared hook scenarios additionally exercise both data owners in
independent runs. No sleep, retry or timeout was added to make these checks pass.
