---------------------------- MODULE ArtifactAccess ----------------------------
(***************************************************************************)
(* One signed-in viewer, one artifact (a shareables row), and the         *)
(* container it sits in, as stored in D1. Every variable is one database  *)
(* fact that a list or an open check reads. Each step is one write that   *)
(* the product makes to that fact. The rules compare, in every reachable  *)
(* state, what each list shows the viewer with what the viewer can open.  *)
(*                                                                         *)
(* Open (what the artifact page and the sandbox delivery allow):          *)
(*   apps/web/app/services/access.server.ts      viewerAccessAllowed      *)
(*   apps/web/app/modules/access/facts.ts        facts                    *)
(* Lists, one operator each (the code is quoted next to each):            *)
(*   WorkspaceList      projects.server.ts visibleShareableToViewer       *)
(*   SharedProjectFiles projects.$id.tsx loadSharedProject                *)
(*   ProjectFileCount   project-membership.server.ts listProjectsForIndex *)
(*   ActivityFeed       events.server.ts, slice 'mine'                    *)
(*   Search             search-discovery.server.ts discoveryEligibility   *)
(*   Recent             home.server.ts recentShareableAccessPredicate     *)
(* Projects: projectAccessAllowed, findWorkspaceProject,                  *)
(*   findSharedProjectForViewer, listSharedProjects, suggestProjects,     *)
(*   listJoinedProjectsForDropdown, visibleProjectContainerToViewerSql.   *)
(*                                                                         *)
(* The artifact and its container are in the same workspace, the          *)
(* "artifact workspace". sameWs says whether the viewer's users.workspace_id *)
(* is that workspace. Every list caller that scopes by                     *)
(* shareables.workspace_id = user.workspaceId is written as sameWs /\ ... *)
(* Email matching (lowerEmail, grantMatchEmail) is one boolean per grant.  *)
(***************************************************************************)

Visibilities == {"private", "workspace", "project", "link"}
(* link_expires_at, by how activeLinkExpiry (SQL) reads it at "now".       *)
(*   none        NULL                                                      *)
(*   future      a later instant with 0 or 3 fraction digits               *)
(*   futureFrac  a later instant with another number of fraction digits,   *)
(*               such as 2026-06-15T00:00:00.5Z                            *)
(*   past        now or earlier, or a value activeLinkExpiry rejects       *)
Expiries == {"none", "future", "futureFrac", "past"}
(* workspace_members row of the viewer in the artifact workspace.          *)
(*   admin = status 'active' and role owner or admin                       *)
Memberships == {"none", "member", "admin", "removed"}

VARIABLES
    vis,           \* shareables.visibility
    owner,         \* shareables.owner_user_id = viewer
    sameWs,        \* users.workspace_id of the viewer = the artifact workspace
    kind,          \* artifact_containers.kind: "inbox" or "project"
    baseVis,       \* artifact_containers.base_visibility: "workspace" or "private"
    creator,       \* artifact_containers.created_by_id = viewer
    archived,      \* artifact_containers.archived_at IS NOT NULL
    member,        \* workspace_members row of the viewer (see Memberships)
    teamPlan,      \* workspaces.plan is in the team tier (planInTierSql ['team'])
    botStopped,    \* the viewer is a bot with bot_stopped_at set
    verified,      \* users.email_verified = 1
    shareGrant,    \* a shareable_grants row for the viewer's email
    projectGrant,  \* a project_share_defaults row for the viewer's email (the audience)
    suspended,     \* shareables.link_suspended_at IS NOT NULL
    expiry,        \* shareables.link_expires_at (see Expiries)
    linkSharing,   \* workspaces.link_sharing_enabled = 1
    joined,        \* a project_members row for the viewer
    recency        \* a shareable_viewer_recency row for the viewer

vars == <<vis, owner, sameWs, kind, baseVis, creator, archived, member,
          teamPlan, botStopped, verified, shareGrant, projectGrant, suspended,
          expiry, linkSharing, joined, recency>>

(* Facts that the schema and the product keep together. *)
Valid ==
    /\ kind = "inbox" => (baseVis = "workspace" /\ ~creator /\ ~archived
                          /\ ~projectGrant /\ ~joined)
    /\ sameWs => member # "none"
    (* createProject puts the container in the creator's workspace, and no
       write in this model moves a user to another workspace. *)
    /\ creator => sameWs

TypeOK ==
    /\ vis \in Visibilities
    /\ owner \in BOOLEAN /\ sameWs \in BOOLEAN
    /\ kind \in {"inbox", "project"} /\ baseVis \in {"workspace", "private"}
    /\ creator \in BOOLEAN /\ archived \in BOOLEAN
    /\ member \in Memberships /\ teamPlan \in BOOLEAN /\ botStopped \in BOOLEAN
    /\ verified \in BOOLEAN /\ shareGrant \in BOOLEAN /\ projectGrant \in BOOLEAN
    /\ suspended \in BOOLEAN /\ expiry \in Expiries /\ linkSharing \in BOOLEAN
    /\ joined \in BOOLEAN /\ recency \in BOOLEAN
    /\ Valid

-----------------------------------------------------------------------------
(* Shared pieces, each one function in the code. *)

(* modules/access/facts.ts activeLinkExpiry *)
ActiveLinkExpiry(e) == e \in {"none", "future", "futureFrac"}

(* modules/access/facts.ts workspaceAccessRevokedSql / isWorkspaceAccessRevoked:
   a removed member, or a stopped bot. *)
Revoked == member = "removed" \/ botStopped

(* EXISTS workspace_members ... status = 'active' AND role IN ('owner','admin')
   AND planInTierSql(plan, ['team']), in the artifact workspace. *)
ActiveAdminRow == member = "admin" /\ teamPlan

(* projects.server.ts shareableLinkAccessToViewer *)
ListLinkAccess ==
    /\ vis = "link"
    /\ ~suspended                          \* link_suspended_at IS NULL
    /\ linkSharing                         \* link_sharing_enabled = 1
    /\ ActiveLinkExpiry(expiry)            \* activeLinkExpiry(now)

-----------------------------------------------------------------------------
(* Opening the artifact. facts.ts facts -> access.server.ts viewerAccessAllowed *)

(* facts: anonymous_link_allowed *)
AnonymousLinkAllowed ==
    vis = "link" /\ ~suspended /\ ActiveLinkExpiry(expiry) /\ linkSharing
(* facts: is_team_admin also requires access_viewer.workspace_id = shareables.workspace_id *)
IsTeamAdmin == sameWs /\ ActiveAdminRow
(* projectAccessFactSelections: access_is_project_creator / access_is_project_admin *)
IsProjectCreator == kind = "project" /\ creator
IsProjectAdmin == kind = "project" /\ sameWs /\ ActiveAdminRow

Open ==
    \/ vis = "link" /\ AnonymousLinkAllowed
    \/ owner /\ ~Revoked
    \/ vis = "link" /\ IsTeamAdmin
    \/ vis = "workspace" /\ sameWs /\ ~Revoked
    \/ vis = "project" /\ kind = "project" /\
         \/ ~Revoked /\ baseVis = "workspace" /\ sameWs
         \/ IsProjectCreator /\ ~Revoked
         \/ IsProjectAdmin
         \/ verified /\ projectGrant
    \/ verified /\ shareGrant

-----------------------------------------------------------------------------
(* Lists of artifacts. *)

(* projects.server.ts visibleShareableToViewer, under the caller's
   shareables.workspace_id = user.workspaceId (home, project page files for a
   member, CLI list and resolve, MCP, activity feed 'all'). *)
WorkspaceListPredicate ==
    \/ ListLinkAccess
    \/ vis = "workspace" /\ ~Revoked
    \/ owner /\ ~Revoked
    \/ shareGrant /\ verified                                  \* grantMatchEmail(viewer)
    \/ vis = "project" /\                                      \* workspaceScopedProjectVisibility
         \/ kind = "project" /\
              \/ ~Revoked /\ baseVis = "workspace"
              \/ ~Revoked /\ creator
              \/ ActiveAdminRow
         \/ projectGrant /\ verified
    \/ vis = "link" /\ ActiveAdminRow
WorkspaceList == sameWs /\ WorkspaceListPredicate

(* Project lookups. modules/access/facts.ts projectAccessAllowed / projectAccessAllowedSql *)
ProjectAccessAllowed ==
    /\ kind = "project"
    /\ IF sameWs
         THEN \/ ~Revoked /\ (baseVis = "workspace" \/ creator)
              \/ IsProjectAdmin
              \/ verified /\ projectGrant
         ELSE ~archived /\ verified /\ projectGrant
(* projects.server.ts findWorkspaceProject (projectSummaryQuery, archived = false) *)
WorkspaceProjectFound == sameWs /\ kind = "project" /\ ~archived /\ ProjectAccessAllowed
(* projects.server.ts findSharedProjectForViewer (sharedProjectSummaryQuery) *)
SharedProjectFound == kind = "project" /\ ~archived /\ verified /\ projectGrant
(* projects.$id.tsx loader: findWorkspaceProject, else findSharedProjectForViewer, else 404 *)
ProjectOpen == WorkspaceProjectFound \/ SharedProjectFound

(* projects.$id.tsx loadSharedProject: visibleSharedProjectShareableToViewer *)
SharedVisible ==
    \/ vis = "project" /\ verified /\ projectGrant
    \/ shareGrant /\ verified
SharedProjectFiles ==
    /\ ~WorkspaceProjectFound /\ SharedProjectFound
    /\ SharedVisible

(* project-membership.server.ts listProjectsForIndex fileCount:
   visibleShareableToDatabaseViewerSql in the viewer's workspace,
   visibleSharedProjectShareableToDatabaseViewerSql outside it. *)
MemberVisibleInIndex ==
    \/ vis = "link" /\ ~suspended /\ linkSharing /\ ActiveLinkExpiry(expiry)
    \/ vis = "workspace" /\ sameWs /\ ~Revoked
    \/ owner /\ ~Revoked
    \/ verified /\ shareGrant
    \/ sameWs /\ vis = "project" /\
         \/ ~Revoked /\ (baseVis = "workspace" \/ creator)
         \/ ActiveAdminRow
         \/ verified /\ projectGrant
    \/ vis = "link" /\ sameWs /\ ActiveAdminRow
SharedVisibleInIndex ==
    \/ owner /\ ~Revoked
    \/ vis = "project" /\ verified /\ projectGrant
    \/ verified /\ shareGrant
ProjectFileCount ==
    /\ ProjectAccessAllowed
    /\ \/ sameWs /\ MemberVisibleInIndex
       \/ ~sameWs /\ SharedVisibleInIndex

(* events.server.ts listFeedEvents, slice 'mine': the scope
   (shareables.workspace_id = user.workspaceId OR a project_members row), then
   visibleShareableToViewerSql in the workspace, and outside it
   (mineFeedVisibleSql) a project_members row AND either
   visibleSharedProjectShareableToViewerSql, which asks a 'project' artifact
   for a current audience entry, or the viewer's own artifact. *)
ActivityFeed ==
    /\ sameWs \/ joined
    /\ \/ sameWs /\ WorkspaceListPredicate
       \/ ~sameWs /\ joined /\ (SharedVisible \/ (owner /\ ~Revoked))

(* search-discovery.server.ts discoveryEligibility, with the
   includeArchived = false filter (c.kind IS NOT 'project' OR c.archived_at IS NULL). *)
Search ==
    /\ kind # "project" \/ ~archived
    /\ \/ owner /\ ~Revoked
       \/ shareGrant /\ verified
       \/ vis = "workspace" /\ sameWs /\ ~Revoked
       \/ vis = "project" /\ kind = "project" /\
            \/ projectGrant /\ verified
            \/ baseVis = "workspace" /\ sameWs /\ ~Revoked
            \/ creator /\ ~Revoked /\ joined
       \/ vis = "link" /\ ~suspended /\ ActiveLinkExpiry(expiry)
            /\ recency /\ linkSharing

(* home.server.ts recentShareableAccessPredicate (recent page, home recents,
   search palette). The callers join shareable_viewer_recency, so a row is needed. *)
ArchivedContainer == kind = "project" /\ archived
Recent ==
    /\ recency
    /\ \/ owner /\ ~Revoked
       \/ shareGrant /\ verified                                     \* direct
       \/ sameWs /\ WorkspaceListPredicate /\                        \* sameWorkspaceAccess
            \/ vis = "workspace" /\ ~ArchivedContainer
            \/ vis = "private"
            \/ ListLinkAccess
            \/ vis = "project" /\ ~ArchivedContainer
       \/ ~sameWs /\                                                 \* crossProject / activeLink
            \/ ~ArchivedContainer /\ vis = "project" /\ projectGrant /\ verified
            \/ ListLinkAccess

-----------------------------------------------------------------------------
(* Lists of projects. *)

(* listProjectsForIndex: projectAccessAllowedSql. Archived rows link to
   /projects/archived, not to the project page. *)
IndexListed == ProjectAccessAllowed
(* projects.server.ts listSharedProjects *)
SharedListed == ~sameWs /\ SharedProjectFound
(* project-membership.server.ts suggestProjects (includeArchived = false) *)
SuggestListed == ProjectAccessAllowed /\ ~archived
(* project-membership.server.ts listJoinedProjectsForDropdown *)
DropdownListed ==
    /\ joined /\ kind = "project" /\ ~archived
    /\ \/ sameWs /\
            \/ ~Revoked /\ (baseVis = "workspace" \/ creator)
            \/ projectGrant /\ verified
            \/ ActiveAdminRow
       \/ ~sameWs /\ projectGrant /\ verified
(* project-membership.server.ts visibleProjectContainerToViewerSql: join and
   leave (accessibleProject) and the membership resource route. *)
Joinable ==
    /\ kind = "project" /\ ~archived
    /\ \/ sameWs /\
            \/ ~Revoked /\ (baseVis = "workspace" \/ creator)
            \/ projectGrant /\ verified
            \/ ActiveAdminRow
       \/ ~sameWs /\ projectGrant /\ verified

-----------------------------------------------------------------------------
(* Rules. Each is checked in every reachable state. *)

(* Whatever a list shows, the viewer can open. *)
WorkspaceListOpens == WorkspaceList => Open
SharedProjectFilesOpen == SharedProjectFiles => Open
ProjectFileCountOpens == ProjectFileCount => Open
ActivityFeedOpens == ActivityFeed => Open
SearchOpens == Search => Open
RecentOpens == Recent => Open

(* Whatever the viewer can open in their own workspace, the workspace lists show. *)
WorkspaceOpenIsListed == (sameWs /\ Open) => WorkspaceList

(* Every project list links only to projects whose page opens, and every
   project whose page opens is on the projects page. *)
ProjectListsOpen ==
    /\ (IndexListed /\ ~archived) => ProjectOpen
    /\ SharedListed => ProjectOpen
    /\ SuggestListed => ProjectOpen
    /\ DropdownListed => ProjectOpen
    /\ Joinable => ProjectOpen
ProjectOpenIsListed == ProjectOpen => (IndexListed \/ SharedListed)

-----------------------------------------------------------------------------
(* Writes. Each changes one fact; UNCHANGED covers the rest. *)

Facts == <<vis, owner, sameWs, kind, baseVis, creator, archived, member,
           teamPlan, botStopped, verified, shareGrant, projectGrant, suspended,
           expiry, linkSharing>>

(* Start from any valid set of facts. A project's creator joins it when it is
   created (projects.server.ts insertCreatorMembershipOrRollback). *)
Init ==
    /\ vis \in Visibilities /\ owner \in BOOLEAN /\ sameWs \in BOOLEAN
    /\ kind \in {"inbox", "project"} /\ baseVis \in {"workspace", "private"}
    /\ creator \in BOOLEAN /\ archived \in BOOLEAN /\ member \in Memberships
    /\ teamPlan \in BOOLEAN /\ botStopped \in BOOLEAN /\ verified \in BOOLEAN
    /\ shareGrant \in BOOLEAN /\ projectGrant \in BOOLEAN
    /\ suspended \in BOOLEAN /\ expiry \in Expiries /\ linkSharing \in BOOLEAN
    /\ joined = (kind = "project" /\ creator)
    /\ recency = FALSE
    /\ Valid

ChangeVisibility == \E x \in Visibilities : vis' = x
    /\ UNCHANGED <<owner, sameWs, kind, baseVis, creator, archived, member, teamPlan,
                   botStopped, verified, shareGrant, projectGrant, suspended, expiry,
                   linkSharing, joined, recency>>
SuspendOrResumeLink == suspended' = ~suspended
    /\ UNCHANGED <<vis, owner, sameWs, kind, baseVis, creator, archived, member, teamPlan,
                   botStopped, verified, shareGrant, projectGrant, expiry,
                   linkSharing, joined, recency>>
(* Setting or reopening an expiry, or time passing it. *)
ChangeExpiry == \E x \in Expiries : expiry' = x
    /\ UNCHANGED <<vis, owner, sameWs, kind, baseVis, creator, archived, member, teamPlan,
                   botStopped, verified, shareGrant, projectGrant, suspended,
                   linkSharing, joined, recency>>
ToggleLinkSharing == linkSharing' = ~linkSharing
    /\ UNCHANGED <<vis, owner, sameWs, kind, baseVis, creator, archived, member, teamPlan,
                   botStopped, verified, shareGrant, projectGrant, suspended, expiry,
                   joined, recency>>
ChangeBaseVisibility == kind = "project"
    /\ baseVis' = (IF baseVis = "workspace" THEN "private" ELSE "workspace")
    /\ UNCHANGED <<vis, owner, sameWs, kind, creator, archived, member, teamPlan,
                   botStopped, verified, shareGrant, projectGrant, suspended, expiry,
                   linkSharing, joined, recency>>
ArchiveOrRestoreProject == kind = "project" /\ archived' = ~archived
    /\ UNCHANGED <<vis, owner, sameWs, kind, baseVis, creator, member, teamPlan,
                   botStopped, verified, shareGrant, projectGrant, suspended, expiry,
                   linkSharing, joined, recency>>
ChangeAudience == kind = "project" /\ projectGrant' = ~projectGrant
    /\ UNCHANGED <<vis, owner, sameWs, kind, baseVis, creator, archived, member, teamPlan,
                   botStopped, verified, shareGrant, suspended, expiry,
                   linkSharing, joined, recency>>
ChangeArtifactGrant == shareGrant' = ~shareGrant
    /\ UNCHANGED <<vis, owner, sameWs, kind, baseVis, creator, archived, member, teamPlan,
                   botStopped, verified, projectGrant, suspended, expiry,
                   linkSharing, joined, recency>>
(* Removing, restoring, promoting or demoting the member. *)
ChangeMembership == \E m \in Memberships : member' = m /\ (sameWs => m # "none")
    /\ UNCHANGED <<vis, owner, sameWs, kind, baseVis, creator, archived, teamPlan,
                   botStopped, verified, shareGrant, projectGrant, suspended, expiry,
                   linkSharing, joined, recency>>
ChangePlan == teamPlan' = ~teamPlan
    /\ UNCHANGED <<vis, owner, sameWs, kind, baseVis, creator, archived, member,
                   botStopped, verified, shareGrant, projectGrant, suspended, expiry,
                   linkSharing, joined, recency>>
StopOrRestartBot == botStopped' = ~botStopped
    /\ UNCHANGED <<vis, owner, sameWs, kind, baseVis, creator, archived, member, teamPlan,
                   verified, shareGrant, projectGrant, suspended, expiry,
                   linkSharing, joined, recency>>
(* Sign-in with a provider that does or does not assert a verified email. *)
ChangeEmailVerification == verified' = ~verified
    /\ UNCHANGED <<vis, owner, sameWs, kind, baseVis, creator, archived, member, teamPlan,
                   botStopped, shareGrant, projectGrant, suspended, expiry,
                   linkSharing, joined, recency>>
(* project-membership.server.ts joinProject / leaveProject: both call
   accessibleProject first and return 'not-found' without it. *)
JoinProject == Joinable /\ ~joined /\ joined' = TRUE
    /\ UNCHANGED <<Facts, recency>>
LeaveProject == Joinable /\ joined /\ joined' = FALSE
    /\ UNCHANGED <<Facts, recency>>
(* views.server.ts records a shareable_viewer_recency row when the viewer
   opens the artifact page. *)
ViewArtifact == Open /\ ~recency /\ recency' = TRUE
    /\ UNCHANGED <<Facts, joined>>

Next ==
    \/ ChangeVisibility \/ SuspendOrResumeLink \/ ChangeExpiry \/ ToggleLinkSharing
    \/ ChangeBaseVisibility \/ ArchiveOrRestoreProject \/ ChangeAudience
    \/ ChangeArtifactGrant \/ ChangeMembership \/ ChangePlan \/ StopOrRestartBot
    \/ ChangeEmailVerification \/ JoinProject \/ LeaveProject \/ ViewArtifact

Spec == Init /\ [][Next]_vars
=============================================================================
