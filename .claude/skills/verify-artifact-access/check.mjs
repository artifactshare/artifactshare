#!/usr/bin/env node
// Model-checks what each artifact and project list shows a viewer against what
// that viewer can open, with TLC.
// Usage: node .claude/skills/verify-artifact-access/check.mjs [--keep]
// The runner is scripts/lib/tlc-check.mjs; this file records what to expect.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runModelChecks } from '../../../scripts/lib/tlc-check.mjs'

// Invariants the current code is known to break. Each entry is a reported
// finding, not a pass. Remove the entry when the code is fixed.
const KNOWN_FINDINGS = {
  ActivityFeedOpens:
    'The activity feed keeps showing a project artifact to a viewer from another workspace who joined the project and was then removed from its audience.',
  RecentOpens:
    'Recent keeps showing a project artifact to a viewer from another workspace who joined the project, opened it, and was then removed from its audience.',
}

// Narrower scopes where a known finding cannot happen, so a mutation of the
// code that the finding's invariant guards still has a passing baseline to break.
const SCOPED_BASELINES = [
  { invariant: 'ActivityFeedOpens', constants: { JoinEnabled: 'FALSE' } },
  { invariant: 'RecentOpens', constants: { JoinEnabled: 'FALSE' } },
]

const MUTATIONS = [
  {
    name: 'list-link-ignores-suspension',
    code: "shareableLinkAccessToViewer loses eb('shareables.link_suspended_at', 'is', null)",
    find: '    /\\ ~suspended                          \\* link_suspended_at IS NULL',
    replace: '    /\\ TRUE',
    breaks: 'WorkspaceListOpens',
  },
  {
    name: 'list-link-old-expiry-rule',
    code: 'shareableLinkAccessToViewer reads expiry with the old validLinkExpirySql (0 or 3 fraction digits only)',
    find: '    /\\ ActiveLinkExpiry(expiry)            \\* activeLinkExpiry(now)',
    replace: '    /\\ expiry \\in {"none", "future"}',
    breaks: 'WorkspaceOpenIsListed',
  },
  {
    name: 'list-workspace-ignores-revocation',
    code: "visibleShareableToViewer: the visibility = 'workspace' branch loses NOT workspaceAccessRevoked",
    find: '    \\/ vis = "workspace" /\\ ~Revoked\n',
    replace: '    \\/ vis = "workspace"\n',
    breaks: 'WorkspaceListOpens',
  },
  {
    name: 'list-grant-ignores-email-verification',
    code: 'visibleShareableToViewer matches shareable_grants on the email without grantMatchEmail',
    find: '    \\/ shareGrant /\\ verified                                  \\* grantMatchEmail(viewer)',
    replace: '    \\/ shareGrant',
    breaks: 'WorkspaceListOpens',
  },
  {
    name: 'open-creator-ignores-revocation',
    code: 'viewerAccessAllowed: the project creator branch loses !facts.workspaceAccessRevoked',
    find: '         \\/ IsProjectCreator /\\ ~Revoked',
    replace: '         \\/ IsProjectCreator',
    breaks: 'WorkspaceOpenIsListed',
  },
  {
    name: 'search-link-ignores-expiry',
    code: 'discoveryEligibility: the link branch loses activeLinkExpiry',
    find: '       \\/ vis = "link" /\\ ~suspended /\\ ActiveLinkExpiry(expiry)\n            /\\ recency',
    replace: '       \\/ vis = "link" /\\ ~suspended\n            /\\ recency',
    breaks: 'SearchOpens',
  },
  {
    name: 'shared-project-lists-every-artifact',
    code: 'loadSharedProject drops visibleSharedProjectShareableToViewer',
    find: '    /\\ \\/ vis = "project"\n       \\/ shareGrant /\\ verified',
    replace: '    /\\ TRUE',
    breaks: 'SharedProjectFilesOpen',
  },
  {
    name: 'file-count-ignores-revocation',
    code: "visibleShareableToDatabaseViewerSql: the visibility = 'workspace' branch loses NOT workspaceAccessRevoked",
    find: '    \\/ vis = "workspace" /\\ sameWs /\\ ~Revoked\n    \\/ owner /\\ ~Revoked\n    \\/ verified /\\ shareGrant',
    replace: '    \\/ vis = "workspace" /\\ sameWs\n    \\/ owner /\\ ~Revoked\n    \\/ verified /\\ shareGrant',
    breaks: 'ProjectFileCountOpens',
  },
  {
    name: 'dropdown-lists-archived',
    code: "listJoinedProjectsForDropdown loses .where('c.archived_at', 'is', null)",
    find: '    /\\ joined /\\ kind = "project" /\\ ~archived',
    replace: '    /\\ joined /\\ kind = "project"',
    breaks: 'ProjectListsOpen',
  },
  {
    name: 'project-page-without-viewer',
    code: 'findWorkspaceProject calls projectSummaryQuery without the viewer, so projectAccessAllowedSql is skipped',
    find: 'WorkspaceProjectFound == sameWs /\\ kind = "project" /\\ ~archived /\\ ProjectAccessAllowed',
    replace: 'WorkspaceProjectFound == sameWs /\\ kind = "project" /\\ ~archived',
    breaks: 'ProjectOpenIsListed',
  },
  {
    name: 'activity-feed-unscoped',
    code: "listEvents 'mine' drops shareables.workspace_id = user.workspaceId before visibleShareableToViewerSql",
    find: '    \\/ sameWs /\\ WorkspaceListPredicate\n    \\/ ~sameWs /\\ joined',
    replace: '    \\/ WorkspaceListPredicate\n    \\/ ~sameWs /\\ joined',
    breaks: 'ActivityFeedOpens',
    constants: { JoinEnabled: 'FALSE' },
  },
  {
    name: 'recent-grant-ignores-email-verification',
    code: 'recentShareableAccessPredicate: direct matches shareable_grants without grantMatchEmail',
    find: '       \\/ shareGrant /\\ verified                                     \\* direct',
    replace: '       \\/ shareGrant',
    breaks: 'RecentOpens',
    constants: { JoinEnabled: 'FALSE' },
  },
]

await runModelChecks({
  modelDir: join(dirname(fileURLToPath(import.meta.url)), 'model'),
  module: 'ArtifactAccess',
  knownFindings: KNOWN_FINDINGS,
  scopedBaselines: SCOPED_BASELINES,
  mutations: MUTATIONS,
})
