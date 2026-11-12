# Comment synchronization contracts

The viewer retains bounded comment windows while selection, local mutations,
remote notifications, and authorization recovery proceed concurrently.
`CommentSession` is the only comment data owner for each committed display.
`useViewerComments` is the public hook; it has no selectable engine or missing-
provider fallback. Loader access checks and authenticated, anonymous, historical
and unsupported-format display eligibility remain unchanged.

## Owners and lifetimes

`comment-session.ts` owns summary membership, retained pages, selected-thread
lookup, dirty ranges, errors, mutation-result adoption, anchor-result adoption
and retained recovery data. Construction is resource-free. The viewer attaches
its Session in the committed layout lifecycle and detaches it on artifact change
or unmount. StrictMode cleanup is reversible. An abandoned render cannot acquire
subscriptions or mutate the committed Session.

The same committed artifact keeps its Session across loader revalidation and
version-prop changes. Existing eligibility controls still hide or disable
comments where appropriate. Committing another artifact creates a new Session;
returning to the first artifact creates another display owner. Initial rows seed
that owner; later loader props do not overwrite accepted pages or drafts.

`comment-runtime.ts` owns artifact/thread invalidation epochs, pending mutation
identities, overlap tracking and settlement subscriptions. The browser owner in
`comment-runtime-browser.ts` supplies leases to displays, reads and mutation
producers. Reads retain their record through completion. A mutation captures its
job before the POST and settles that original job even after its producer has
unmounted. A record is collectible only after all leases and pending mutations
finish. Server rendering must never create or share a browser registry.

A settled job notifies the record's current subscribers. Disposed subscribers
receive nothing; an exception in one subscriber cannot block another. Runtime
settlement does not decide whether HTTP rows or a submitted draft belong to a
display. Session and the keyed producer make those decisions separately.

The viewer owns presentation state: panel visibility, selection and focus
requests, inline placement, presence and pending text anchors. Its reducer is a
projection of Session replacement events, not an independent data reconciler.
Equal-row replacements and explicit deletions still reach the reducer so they
can close obsolete inline or selected targets. Error-only notifications do not
pretend that data was replaced.

The existing socket lifecycle owns transport authorization, reconnect/renewal
attempts, visibility, heartbeat and bounded deadlines. It requests Session
refreshes and retains authorized recovery rows in Session. A refresh result may
stop only its still-current owning socket. Current-user changes reauthorize the
socket even when artifact and Session remain fixed. No second socket or shadow
HTTP path exists.

`CommentPageSessionContext` provides that same Session to page consumers.
`useCommentPage` requires it; standalone tests must also attach a real Session.
Consumer activation and cleanup own page requests, target attempts and queued
work. Queued pages resume after the React settlement render. Page 401/403 results
enter the existing refresh/auth recovery path, preserving cached history while
authorization is checked.

## Adoption and ordering invariants

| Path or event                                    | Adoption                                                     | Continuation owner                                             |
| ------------------------------------------------ | ------------------------------------------------------------ | -------------------------------------------------------------- |
| Newer summary supersedes an older request        | Ignore the superseded response                               | Newer request                                                  |
| Same-thread change during a page request         | Merge into existing membership                               | Mark and revalidate affected ranges                            |
| Summary removes a thread before its page returns | Page cannot restore membership                               | Explicit selected-thread lookup may add it separately          |
| Selected thread lies outside the summary window  | Fetch explicitly; keep accepted selection across URL cleanup | Existing target retry UI on failure                            |
| Around-message lookup returns 404/410            | Check whether the thread survives                            | Missing-target or thread-removal path                          |
| Ordinary page returns 404/410                    | Remove the thread                                            | Authoritative replacement event                                |
| Local mutations overlap                          | Suppress partial response application                        | Reconcile after all overlapping posts settle                   |
| Recovery predates a settled mutation             | Reject the stale snapshot                                    | Existing recovery/reconciliation path                          |
| Authentication fails                             | Preserve existing classification                             | Only the current owning socket may be stopped                  |
| Transient summary failure                        | Preserve cache and dirty intent                              | Future operation or notification, with no added infinite retry |
| Artifact changes during a request                | Never apply rows to another artifact                         | Original job settles; current display reconciles independently |

Request generation, page request identity, attachment generation, dirty revision,
Runtime invalidation epochs, settlement revision and socket authorization sequence
protect different races:

- Summary generations and cancellation prevent older reads from winning after a
  mutation, page adoption or newer refresh. Explicit queued refreshes survive
  data adoption; lifecycle cancellation cancels their queue.
- Each page consumer has its own request identity. A page merges into the current
  membership, never the list captured when its request began.
- Attachment generations reject detached work, including work from a previous
  attachment of the same Session during StrictMode replay.
- Thread epochs affect their own thread; artifact epochs affect all threads.
  Dirty revisions preserve changes observed after a refresh captured its scope.
  A successful older refresh cannot clear newer dirty intent.
- Recovery tickets contain Session identity, attachment generation and Runtime
  settlement revision. Authorization can remain valid while the returned rows
  require revalidation. Retained recovery is consumed once and cleared on
  teardown; it cannot cross a display boundary.
- Socket recovery sequence and owning-socket checks reject obsolete authorization
  attempts independently of data adoption.

These tokens are local race guards, not server revisions or a new backend retry
contract. Retained range coverage comes from server windows, not local message
adjacency. Anchor verdicts keep their existing merge priority over older page or
summary rows. Deletion, history, unread navigation and selected-target handling
continue to use the existing bounded-window rules in `comment-history.ts`.

Settlement marks dirty scope, aborts superseded reads and remembers applied
mutation echoes before notifying socket policy. The hook's bounded echo cache
(30 seconds, 20 entries) survives A → B → A within that mount and is never shared
across viewers. Pending mutation identity and remembered echoes suppress the
corresponding remote refresh. A settlement between layout attachment and socket
listener registration retains one coalesced continuation; detach discards it.

### Returning to an artifact versus mounting a new viewer

Stable mutation callbacks resolve the currently committed Session within one hook
mount. A POST started in A may apply directly after A → B → A before its
reconciliation GET succeeds. Requiring that GET to succeed first would lose the
existing immediate result when reconciliation fails transiently. B never adopts
A's response. The newly keyed A panel has its own pending state and draft, so an
old completion cannot erase the new draft, even if its text equals the old post.

After a full viewer unmount, old callbacks cannot directly update a separately
mounted viewer. The new display subscribes to the retained Runtime job and
reconciles on settlement. Detached completion must also release its record when
no display returns. Both lifetimes have explicit regression assertions.

## Executable contract

`app/test/comment-sync-harness.ts` drives the public `useViewerComments` hook.
Each run owns its React root, two independent mutation producers (panel and
popover), the production reply reducer, deferred HTTP responses and exact
request/cancellation traces. Its producer subtree is keyed by artifact like the
product panel; the viewer hook persists across navigation. Assertions specify
absolute rows, drafts, pending state, errors and request counts. There is no
second data implementation or equality-between-engines oracle.

Disposal unmounts the display, drains unfinished HTTP/POST work and fails if any
was left unfinished. A probe epoch detects leaked leases even when no mutation
advanced a record. Injected lease leaks and throwing React cleanup verify these
failure paths. Cleanup checks all invariants and preserves both scenario and
cleanup errors. Requests during disposal are rejected and recorded; there is no
production reset API and no retry-until-pass loop.

| Contract                                                                           | Executable evidence                                                                                                          |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| A post → B → A adopts before a failed GET and preserves a newer draft              | `comment-runtime.integration.test.tsx`                                                                                       |
| Panel/popover overlap, detached settlement and fresh-display reconciliation        | `comment-runtime.integration.test.tsx`                                                                                       |
| Target lookup/retry, membership removal, retained ranges, echo and anchor priority | `comment-reconciliation.test.tsx`                                                                                            |
| StrictMode, suspended renders, commit ownership and socket-user changes            | `comment-reconciliation.test.tsx`                                                                                            |
| Summary supersession, newer dirty intent, recovery tickets and page acceptance     | `comment-session.test.ts`                                                                                                    |
| Thread/all/other epochs, short around pages, missing-target authorization          | `use-comment-page.test.tsx`                                                                                                  |
| Record retention, mutation overlap and subscription cleanup                        | `comment-runtime.test.ts`, `comment-runtime-browser.test.ts`                                                                 |
| Actual panel posting/navigation, SSR/hydration and abandoned navigation            | `comment-session.behavior.browser.test.tsx`                                                                                  |
| Page/delete/history/unread interaction and anchor recovery                         | `comment-pagination.behavior.browser.test.tsx`, `comment-panel.test.tsx`, `comment-frame-recovery.behavior.browser.test.tsx` |
| Socket reconnect, renewal, bounded authorization and page auth recovery            | `live-authorization.test.tsx`                                                                                                |

Focused unit integration can run from the repository root:

```sh
pnpm --filter @artifactshare/web test:unit comment-runtime.integration.test.tsx comment-reconciliation.test.tsx comment-session.test.ts use-comment-page.test.tsx
```

Unit evidence does not replace the selected browser/visual validation or the
repository's final static and review gates. Held POSTs, forced errors, expiry and
aborted renders belong in local/CI fixtures; they are not production operations.

## Diagnostics and recovery

The existing `artifactshare_viewer_network` pathway retains generic viewer
fetch/socket timeout and error diagnostics. Comment operations emit bounded
start/terminal events with operation, result, elapsed time, attempted fetch/socket
counts and HTTP status where available. They contain no engine assignment or
comparison build metadata, artifact/user/workspace identifiers, content, tokens
or raw errors. Protocol success does not establish data adoption; the state and
request assertions above do. There is no automatic analytics upload or new
telemetry service.

Recovery from a code regression is a reviewed code fix or code revert, deployed
through the staged workflow and protected GitHub `production` Environment. There
is no flag-selected fallback in the viewer. Verify pending mutations, drafts,
page/history preservation and socket ownership on the recovery candidate before
deploying. Do not force reload a user's unsaved draft to apply a recovery release.
An already open display retains its loaded client code. SPA navigation alone
does not prove it loaded the recovery release; use a user-chosen fresh top-level
load to verify the replacement, after preserving unsaved drafts.

Removal of any obsolete live provider registration is a separate operator task
after the code deployment; source cleanup does not authorize provider changes.
No production operation belongs in an ordinary development shell. Unrelated
Flagship flags, fallback helpers and bindings remain independent of comment
synchronization. This consolidation changes no backend schema, authorization
contract, retry guarantee, viewer layout or user-facing setting.
