# Comment synchronization contracts

The viewer retains bounded comment windows while selection, local mutations,
remote notifications, and authorization recovery may proceed concurrently.
This reference describes the behavior preserved by the runtime migration and
the temporary, server-selected rollout of its Session owner.

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
ownership. No new global network retry guarantee, telemetry service, durable
comparison store, URL/anchor change, or permanent product setting.

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

`useViewerComments` selects exactly one data owner from the loader's temporary
`commentSync: { mode, build }` assignment. Missing assignments in old fixtures
use `legacy` / `unknown`. `useSessionViewerComments` remains an independent
comparison seam. It selects `CommentSession` for summaries, page consumers,
mutation results, anchor results, errors, dirty ranges and recovery-data adoption.

The string flag `comment-sync-engine` accepts only `legacy` and `session`, with
`legacy` as its default. The loader evaluates it only after access is granted,
for authenticated, current-version displays of formats supported by
`artifactSupportsComments`: HTML, Markdown, static sites, PDF and video.
Static-site comment locations remain supported. Anonymous, historical and
unsupported displays receive `legacy` without flag evaluation, even with a local
override. Production missing binding, invalid value and evaluation failure return
`legacy`, even with `DEV_FLAGS` present. The existing Flagship fallback helper
permits an explicit local `DEV_FLAGS=comment-sync-engine=session` developer
override only for a nonproduction missing binding. Absent or invalid local
settings remain `legacy`. A real binding is authoritative, including its invalid
value/error fallback; `DEV_FLAGS` cannot override it. This developer override is
not a production missing-binding exception.
Authorization and comment eligibility decisions remain unchanged.

Flagship receives the artifact owner's `shareable.workspace_id` as both
`targetingKey` and `workspaceId`, never the viewer's workspace. The client receives
only the selected mode and safe build identity; no new workspace targeting fields,
provider result or provider error crosses the loader boundary. `+viewer` forwards
the typed artifact to `ViewerShell`, including this assignment.

An owner captures its assignment when constructed for an artifact. It is attached
only after commit. The same committed artifact keeps that owner and assignment
through loader revalidation and version-prop changes, including a newly returned
legacy assignment for a historical version. Existing eligibility controls still
hide/disable comments as before. A genuinely different committed artifact uses
its new loader assignment; returning to the original artifact then creates a new
owner with the current assignment. Aborted renders cannot change the committed
owner. StrictMode cleanup is reversible. SSR and hydration use the same loader
value without a client flag request, conditional hook, or whole-viewer remount.

Only that owner performs reads and Runtime subscriptions. The existing socket
lifecycle serves that owner; there is no shadow HTTP request or second socket.
Both engines share Runtime so pending mutations outlive navigation across engines.
Stable callbacks resolve the actual committed owner when applying a response.
A same-mount A → B → A post can still apply before a failing reconciliation GET;
a detached full-viewer post can only notify the new viewer to reconcile. Keyed
producers retain their own draft and pending-state rules.

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

## Temporary rollout and recovery

The registration in `app/lib/comment-sync.server.ts` expires on **2026-12-10**,
four weeks after the 2026-11-12 migration start. This permits bounded comparison,
a controlled cohort expansion and a recovery exercise without making the flag a
permanent setting. Fixed-clock registration tests exercise the existing expiry
helper; there is no current-date monitoring tool. The operator owns checking the
actual 2026-12-10 removal deadline. The helper is deliberately not called on live
requests; there is no runtime flip or CI time bomb. Passing that date must not
crash a viewer or silently flip an already open display. By the
deadline, remove the flag and legacy owner after the evidence below is confirmed,
or make an explicit, reviewed short extension with the missing evidence and new
deadline. Do not leave an unowned expired registration running indefinitely.

This source change does **not** authorize live Flagship operations. Before each
provider change, an operator must explicitly approve the environment, exact target
workspace or cohort, the flag key, intended value/default and rollback value.
Keep real target identifiers and operator records out of this public repository.
Production code deployments follow the protected GitHub `production` Environment
and staged deployment workflow. Flag administration is a separately, explicitly
approved operator action through its approved administrative channel, with the
exact target, key, value and rollback recorded outside this public repository.
`deploy-production.yml` has no Flagship administration job. An ordinary
development shell is not an operations channel for either action.
Production verification uses only explicitly approved targets, normal synthetic
actions and naturally observed transitions. Do not inject faults, force HTTP
errors or expiry, intercept/hold requests, or change provider faults in production.
Held POSTs, failing GETs, forced 401/403/expiry and aborted-render cases belong
only to local/CI integration checks.

1. Deploy the reviewed code through that workflow with the provider default
   `legacy`. Record the actual Worker version identity and confirm missing-binding,
   invalid-value and error fallback in local tests. On an approved test artifact,
   establish a legacy baseline with the operation checklist below.
2. After explicit approval for the target and values, set only the approved owner
   workspace/cohort to `session`. Open **new** displays for comparison. An existing
   display is not evidence that a provider update was applied. Compare each mode
   sequentially on equivalent synthetic content, browser and network conditions;
   retain exact operation counts and visible-state verdicts, not content or tokens.
3. Complete the recovery exercise before expansion: after approval, restore that
   target to `legacy`, open a new display and verify its actual diagnostics. Leave
   an old Session display with an unsent draft open and revalidate it: its draft
   and Session owner must remain. Use normal synthetic posting and navigation;
   if a pending-post transition occurs naturally, verify one POST, correct
   destination data and settlement. Retain local/CI evidence for controlled
   pending-post races and record any unobserved production path as a gap.
   Do not force-reload a user's unsaved draft to apply a rollback. A fresh display
   adopts rollback; an existing display switches only after leaving the artifact
   or a user-chosen fresh load.
4. Expand only with explicit approval for the next cohort and comparable evidence.
   Any lost/duplicated comment, wrong-artifact adoption, lost draft, duplicate POST
   or active socket, or unexplained extra GET stops expansion and calls for the
   approved legacy recovery change. A lower elapsed duration cannot override a
   correctness failure. Missing or interrupted observations are unknown, not pass.
5. After confirmed full eligible rollout **and** the recovery exercise, remove
   `comment-sync-engine`, its registration/evaluation, mode plumbing, comparison
   seam and legacy owner together. Remove temporary comparison-only tests/diagnostic
   dimensions then, while retaining behavioral regression tests and shared Runtime.
   Provider cleanup also needs explicit operator approval. No permanent user-facing
   engine control or new workflow guard is introduced.

### Comparable diagnostics and measurable checks

The existing `artifactshare_viewer_network` console pathway emits a bounded typed
`channel: comment-sync` start/terminal pair per actual fetch or socket attempt.
Fields are frozen owner `mode`, `build`, operation, state, result, elapsed
milliseconds, fetch count and socket count, plus an HTTP status when available.
Every attempted fetch contributes `fetchCount: 1` at start, even when it fails;
terminal events contribute zero. Already-aborted calls that never fetch contribute
nothing. Socket starts similarly contribute `socketCount: 1`; their terminal
result is open/success, failure or cancellation. Start-minus-terminal counts expose
unfinished observations. Existing socket lifecycle events also carry the frozen
mode/build, so reconnect and auth recovery can be interpreted together.

Operations distinguish summary, retained/page reads, selected-thread reads,
recovery authorization reads and each mutation intent. Around-message reads are
page reads. Success describes protocol completion (for sockets, an open accepted
by the existing socket policy), **not** proof of data adoption or a raw TCP
connection accepted after the policy deadline;
state assertions and the exact request trace provide that proof. Cancelled late
responses are reported as aborts and cannot act as successful adoption evidence.
Compute error/abort counts over starts, completion coverage over starts, and
latency distributions over completed attempts per operation, mode and build.
Compare total GETs/POSTs/socket starts for the same finite input script, including
retries and recovery reads; do not compare only successful or fast requests.

Build identity is the UUID from the official Workers
[version metadata binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/version-metadata/),
configured as `WORKER_VERSION` in both app configurations. It identifies the
Worker version that served this artifact's assignment, not the browser asset or
JavaScript bundle identity (nor a source commit). After a deployment, SPA
navigation can receive an assignment from a new Worker while older JavaScript
remains loaded. For finite deployment comparisons, record and pin the tested
deployment and begin each run with a fresh top-level load of its current bundle.
If the deployment changes during a run, separate that observation from the pinned
comparison. Do not aggregate `build` alone as proof of client code identity.
Tags, timestamps and dev screen-capture revision parameters are not exported.
Missing, zero UUID or malformed metadata is `unknown`. Local emulators may also
provide syntactically valid nonzero Worker version UUIDs; these are local/emulated
identities, never evidence of a deployed production build. Exclude emulator runs
and unknown builds from deployment comparisons. There is no automatic analytics upload,
new backend or durable collection. Operators can inspect/capture these existing
browser diagnostics for an approved synthetic test session; console observations
are not a population-wide production health claim. New fields contain no artifact
URL/ID, workspace/user ID, draft/body, token or raw error. Existing diagnostic
fields elsewhere retain their existing policy.

Before each proposed expansion, retain at least one complete local/CI paired run
for every row below on the intended deployment/browser. Record attempted/completed
counts and exact request/socket totals; require zero correctness mismatches and
zero unexplained count increases. The controlled cases in this table are local/CI
checks, not instructions to inject production faults.

Production verification uses the same state/count criteria for approved normal
synthetic actions and transitions that occur naturally. Record production results
separately from local/CI evidence, including unobserved races, failures and recovery
paths as gaps, never successes. There is no promise that every race will occur
naturally in a finite run. Outstanding gaps must be explicit in the next expansion
decision; do not silently enlarge approval or expand the cohort. Repetition or
elapsed time alone is insufficient. These are functional rollout checks, not a
statistical performance claim.

### Local/CI paired integration checklist

| Operation              | Required observed result and count check                                                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| List/summary           | Remote change or settlement updates the bounded open-first summary; one expected summary GET per unsuppressed refresh, with every additional recovery/retry accounted for.                                                                                                     |
| Page/history           | Earlier and interior ranges retain existing replies and drafts; each requested range has one GET, and dirty-range revalidation follows the same finite baseline trace.                                                                                                         |
| Selected target        | A thread outside the summary remains selected after URL cleanup; one explicit lookup for the selected thread, with failure/retry counted and stale targets never adopted.                                                                                                      |
| Post/mutations         | Create, reply, edit, resolve/reopen and delete each issue exactly one POST per submitted action; successful changes and failed-draft retention match legacy, with reconciliation GETs separately counted.                                                                      |
| Pending navigation     | Hold POST in A, commit B with the other engine, return A, then settle: B is unchanged, A adopts directly in the same mount even before a failed GET, the new keyed draft survives, and the old pending job clears. Also unmount/remount to prove reconciliation-only adoption. |
| Socket reconnect       | One active socket per display; count each attempt/close and summary refresh. Reopening updates missed rows without dropping a draft or duplicating a mutation.                                                                                                                 |
| Authorization recovery | Exercise 401/403, expiry renewal and bounded reconnect using the existing browser tests; preserved authorization decisions, bounded attempts, current-owner recovery adoption and exact GET totals must match.                                                                 |

`comment-sync-rollout.behavior.browser.test.tsx` exercises production shell/panel
posting and cross-engine router navigation, revalidation, SSR/hydration and
aborted render behavior. `comment-runtime.integration.test.tsx` uses the existing
independent sequential harness with absolute state/request oracles and drained
HTTP gates. Pagination and live-authorization browser comparisons use the
production assignment entry point in both modes. Loader tests cover access,
owner-workspace targeting and no-evaluation cases; helper tests cover fallbacks
and safe metadata. These local checks are evidence for the implementation, not
permission for a provider change or a claim that rollout has occurred.
