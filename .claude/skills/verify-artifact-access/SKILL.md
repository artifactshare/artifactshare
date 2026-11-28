---
name: verify-artifact-access
description: Model-check with TLA+ (TLC) that the artifact and project lists show a viewer only what that viewer can open, and that lists keep up with project audience, link suspension, link expiry, archive, and membership changes. Use after a change to an access predicate in apps/web/app/modules/access/facts.ts, access.server.ts, projects.server.ts, project-membership.server.ts, events.server.ts, search-discovery.server.ts, or home.server.ts, and when a list and the artifact page disagree.
---

# Verify artifact access

A viewer meets an artifact in many lists: the home and project pages, the CLI and MCP, the activity feed, search, recents, and project counts. Opening the artifact goes through one decision, `viewerAccessAllowed`. Each list has its own SQL copy of that decision, so a change to one copy, or a fact that a list keeps after access ends (a `project_members` row, a `shareable_viewer_recency` row), makes a list and the artifact page disagree. That happened with link expiry before. Unit tests cover the cases someone wrote down. This check is a TLA+ model of the facts these decisions read and the writes that change them, and TLC tries every combination of facts and every order of writes within the scope below.

## The rules

Each rule is an INVARIANT in `model/ArtifactAccess.tla`. "Open" means `viewerAccessAllowed` on the facts that `facts` loads.

| Rule | Plain sentence | Harm if broken |
| --- | --- | --- |
| `WorkspaceListOpens` | An artifact that `visibleShareableToViewer` lists in the viewer's workspace opens for the viewer. | Titles and owners of artifacts the viewer may not see appear in the home, project page, CLI, and MCP lists. |
| `WorkspaceOpenIsListed` | An artifact in the viewer's workspace that the viewer can open is in those lists. | A live artifact disappears from lists, as a live link with an unusual expiry format did. |
| `SharedProjectFilesOpen` | Each file on a project page opened by an audience member from another workspace opens for them. | The shared project page leaks files outside the audience's reach. |
| `ProjectFileCountOpens` | The file count on the projects page counts only files that open for the viewer. | The count reveals that hidden files exist. |
| `ActivityFeedOpens` | Each artifact in the activity feed (`listFeedEvents`, slice `mine`) opens for the viewer. | The feed shows titles, and comment text, of artifacts the viewer may not see. |
| `ProjectActivityOpens` | Each artifact in a project page's activity and view ranking (`listFeedEvents` slice `project`, `listProjectViewRanking`) opens for the viewer. | The project page shows titles, comment text and view counts of files the viewer may not open, including an outside audience member seeing the host workspace's own files. |
| `SearchOpens` | Each artifact that search (`discoveryEligibility`) returns opens for the viewer. | Search shows hidden artifacts. |
| `RecentOpens` | Each artifact in recents (`recentShareableAccessPredicate`) opens for the viewer. | Recents show a live row (current title, owner, version and unread counts) for an artifact the viewer may not open, and the search palette matches its current title. |
| `ProjectListsOpen` | Every unarchived project on the projects page, the shared list, the suggestions, the joined dropdown, and every project the viewer may join or leave has a project page that opens. | Project names leak, or links lead to 404. |
| `ProjectOpenIsListed` | Every project whose page opens is on the projects page. | A project the viewer can use cannot be found. |

`TypeOK` holds the facts to the combinations the schema and product allow.

## When to use

Run the check when a change touches any of these. The model describes them as of the sync commit below. All paths are under `apps/web/app/`.

| Code | Model operators |
| --- | --- |
| `services/access.server.ts` `viewerAccessAllowed`; `modules/access/facts.ts` `facts` | `Open`, `AnonymousLinkAllowed`, `IsTeamAdmin`, `IsProjectCreator`, `IsProjectAdmin` |
| `modules/access/facts.ts` `activeLinkExpiry` | `ActiveLinkExpiry` |
| `modules/access/facts.ts` `workspaceAccessRevokedSql`, `isWorkspaceAccessRevoked` | `Revoked` |
| `modules/access/facts.ts` `projectAccessAllowed`, `projectAccessAllowedSql` | `ProjectAccessAllowed` |
| `services/projects.server.ts` `shareableLinkAccessToViewer` | `ListLinkAccess` |
| same file, `visibleShareableToViewer`; `services/access.server.ts` `workspaceScopedProjectVisibility` | `WorkspaceListPredicate`, `WorkspaceList` |
| same file, `projectSummaryQuery` via `findWorkspaceProject`, and `sharedProjectSummaryQuery` via `findSharedProjectForViewer` and `listSharedProjects` | `WorkspaceProjectFound`, `SharedProjectFound`, `SharedListed` |
| same file, `visibleSharedProjectShareableToViewer`; `routes/_protected/projects.$id.tsx` `loader` and `loadSharedProject` | `ProjectOpen`, `SharedProjectFiles` |
| `routes/_protected/projects.$id.tsx` `loadProjectActivity` and `routes/_protected/+lib/project-subpage.server.ts` `projectSubpageVisibleFilter`, which pick the `visibleTo` the project activity takes | `ProjectActivity` |
| `services/project-membership.server.ts` `listProjectsForIndex` with `visibleShareableToDatabaseViewerSql` (its own copy of the link clause) and `visibleSharedProjectShareableToDatabaseViewerSql` | `IndexListed`, `MemberVisibleInIndex`, `SharedVisibleInIndex`, `ProjectFileCount` |
| same file, `suggestProjects`, `listJoinedProjectsForDropdown`, `visibleProjectContainerToViewerSql` | `SuggestListed`, `DropdownListed`, `Joinable` |
| same file, `joinProject`, `leaveProject` | `JoinProject`, `LeaveProject` |
| `services/events.server.ts` `listFeedEvents`, slice `mine`: the scope filter and the access predicate `mineFeedVisibleSql` | `ActivityFeed` |
| same file, `listFeedEvents` slice `project` and `listProjectViewRanking`: the `shareables.container_id` scope and the `visibleTo` the caller passes | `ProjectActivity` |
| `services/search-discovery.server.ts` `discoveryEligibility` and the `includeArchived` filter in `discoveryQuery` | `Search` |
| `services/home.server.ts` `recentShareableAccessPredicate` | `Recent` |
| `services/views.server.ts` `recordViewerRecency` (a row when the viewer opens the page) | `ViewArtifact` |

**Sync commit: `e8d95c84b165ea557077df58b59319f790d021f4`.** `ProjectActivity` was written against the project activity as it is now, when `listFeedEvents` slice `project` and `listProjectViewRanking` started taking `visibleTo` from the caller. The commit is not moved with it, because the other operators were not re-read at that point and the covered files have changed since. To see whether covered code moved since then:

```sh
git diff --stat e8d95c84b165ea557077df58b59319f790d021f4 -- apps/web/app/modules/access apps/web/app/services/access.server.ts apps/web/app/services/projects.server.ts apps/web/app/services/project-membership.server.ts apps/web/app/services/events.server.ts apps/web/app/services/search-discovery.server.ts apps/web/app/services/home.server.ts apps/web/app/services/views.server.ts 'apps/web/app/routes/_protected/projects.$id.tsx'
```

These files are large, so a diff there does not always touch a covered function. Read the diff of each covered function against its operator before you trust a pass. A pass on a model that no longer matches the code proves nothing.

## Run

From the repository root:

```sh
pnpm check:access-model
```

It needs Java 11 or later and `curl` on PATH. The runner is `scripts/lib/tlc-check.mjs`; `check.mjs` records what each check should do. The first run downloads `tla2tools.jar` v1.7.4, checks its SHA-256, and caches it in `~/.cache/artifactshare/`. A run takes about 50 seconds on 4 cores. Pass `--keep` (`node .claude/skills/verify-artifact-access/check.mjs --keep`) to keep the TLC output folders.

The command runs three kinds of check and prints one line each:

1. **baseline**: one full exploration with every rule that should hold. Expect `ok ... pass`.
2. **known finding**: each rule in `KNOWN_FINDINGS` in `check.mjs`, which the current code breaks. Expect `ok ... violated` with the recorded path.
3. **mutation**: each entry in `MUTATIONS` is a broken copy of one guard in the code, written as a text change to the model. Expect `ok ... violated` on the rule that guards it. This shows that each rule can still fail.

It ends with `All checks behaved as recorded.` and exit code 0, or names each check that did not, with the path TLC found and its output file, and exits 1.

## Read a result

Read every TLC result with the pstack `/statechart` skill. Give it `model/ArtifactAccess.tla`, the config, and `model/statechart-view.mjs` as the view. The model has more states than a chart can show, so the report gives the shortest path to each broken rule in the viewer's words. It reports the first broken rule and stops checking the rest, so to read a second finding, list only that rule under INVARIANTS in a scratch copy of the config.

Then decide whether the path is a real bug or a modeling error. Replay it against the code as a test on SQLite: `createMigratedInMemoryDb` from `~/test/sqlite-fixture` gives a migrated database. Insert the facts of the path's first state as rows, run each step through the service the coverage table names (or the row write it makes), and compare the list function with `viewerAccessAllowed(await facts(db, { shareableId, viewerUserId, now }))`. `vi.mock('cloudflare:workers', () => ({ env: {} }))` is needed before the service imports. `services/project-audience-removal.server.test.ts` replays the findings below this way.

If the code does what the path says, it is a real bug: report it with that test, and add it to `KNOWN_FINDINGS` only if the user decides not to fix it now. If the code does not, the model is wrong: fix the model so it matches the code. Never weaken a rule or remove a step to make a check pass.

## Update the model for an intended change

1. Find the operators that the changed functions map to in the table above.
2. Each operator copies one SQL predicate or one TypeScript decision. Copy the guards clause by clause, in the code's order, not a summary of them, and keep the code comment next to a guard that has one. A caller's scope, such as `shareables.workspace_id = user.workspaceId`, becomes `sameWs` in the operator.
3. A new fact a decision reads becomes a variable with a write action that changes it. A new list becomes an operator and a `...Opens` rule.
4. If a guard text that a mutation targets changed, update its `find` and `replace` in `MUTATIONS`. The run refuses a mutation whose text is missing. If you add a guard that a rule depends on, add a mutation for it and confirm it breaks that rule.
5. If you add a rule, add it to the INVARIANTS in `model/ArtifactAccess.cfg`, add a row to the rules table, and show it failing on a mutation.
6. Run `pnpm check:access-model` until it reports `All checks behaved as recorded.`
7. Move the sync commit in this file to the commit you checked, only after you confirm that the model describes every covered function at that commit. Update the coverage table if functions were renamed or moved.

## Scope

Verified: every reachable combination of the facts below for one signed-in viewer, one artifact, and its container, and every order of the writes that change them: visibility (private, workspace, project, link), owner, inbox or project container, project base visibility, project creator, archive, workspace membership (none, member, owner or admin, removed), team plan, stopped bot, email verification, artifact grant, project audience, link suspension, link expiry, workspace link sharing, a `project_members` row, and a `shareable_viewer_recency` row. Viewers in the artifact workspace and from another workspace are both covered. About 684,000 states.

Assumed:

- The artifact and its container are in one workspace, and a project's creator is in that workspace. The model does not move users between workspaces.
- Email matching is exact. `lowerEmail`, `grantMatchEmail`, and the session's `emailVerified` against the database's `email_verified` are one boolean each.
- Link expiry is one of four classes, read by `activeLinkExpiry`. The string formats behind them are not in the model. Each list and `facts` read expiry with `activeLinkExpiry`, and `checkAnonymousLinkAccess` reads it with `isValidUtcIso` and `Date.parse`.
- Every caller of `visibleShareableToViewer` in the coverage table applies `shareables.workspace_id = user.workspaceId`, as its comment demands. The model does not check other callers. The project activity scopes by `shareables.container_id` instead, and `ProjectActivity` treats that as the same scope, because the container is in the viewer's workspace whenever `findWorkspaceProject` resolved the page, and the model keeps an artifact in its container's workspace. Nothing in the schema enforces that last part.
- The viewer's own `users.workspace_id` is what `sameWs` means, not a `workspace_members` row. The product does write an active `workspace_members` row outside the holder's own workspace: `reserveContributorSlot` writes one in the host workspace when an external contributor posts into a shared project. `events.server.test.ts` covers that viewer.

Left out:

- Anonymous viewers (they open only through `AnonymousLinkAllowed`), agent credential scopes (`agentReadableShareableSql`), bot-specific grants, Slack and the comment and access-request paths that call `viewerDisplayCheck`.
- The activity feed's relation filter (the `artifact_created`, owner, and recency branches of slice `mine`). Leaving it out makes the model list more than the code, so it cannot hide a breach of `ActivityFeedOpens`.
- The search palette's own filters and `listRailProjects`. Search index freshness: the model checks the eligibility SQL, not the index.
- Who may write: the authority checks on visibility, audience, and archive changes. Every write is allowed in the model.
- Time windows other than link expiry, and the `unread` and `relation` filters on recents.

Observed, not a rule: `activeLinkExpiry` (SQL) and `checkAnonymousLinkAccess` (TypeScript) disagree on an expiry with more than three fraction digits that falls less than one millisecond after now, such as `2026-09-15T00:00:00.0005Z` at `2026-09-15T00:00:00.000Z`. SQL reads it as live and TypeScript as expired, because `Date.parse` drops digits past milliseconds. The window is under one millisecond.

## Fixed findings

The first run of this check found that a viewer from another workspace who joined a project and was then removed from its audience kept seeing the project's artifacts in the activity feed (slice `mine`) and in recents and the search palette, while the artifact page denied them. The `project_members` row stays after removal, and both lists accepted it in place of a current audience entry. `visibleSharedProjectShareableToViewer` and the `crossProject` branch of `recentShareableAccessPredicate` now ask for the audience entry, as `viewerAccessAllowed` does. The mutations `activity-feed-trusts-project-members-row` and `recent-trusts-project-members-row` restore the old guards and break `ActivityFeedOpens` and `RecentOpens`.
