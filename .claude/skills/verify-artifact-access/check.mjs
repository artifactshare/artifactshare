#!/usr/bin/env node
// Model-checks what each artifact and project list shows a viewer against what
// that viewer can open, with TLC.
// Usage: node .claude/skills/verify-artifact-access/check.mjs [--keep]
// The runner is scripts/lib/tlc-check.mjs; this file records what to expect.
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runModelChecks } from '../../../scripts/lib/tlc-check.mjs'

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
    find: '    /\\ ~WorkspaceProjectFound /\\ SharedProjectFound\n    /\\ SharedVisible',
    replace: '    /\\ ~WorkspaceProjectFound /\\ SharedProjectFound',
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
    name: 'activity-feed-cross-workspace-unfiltered',
    code: "listFeedEvents 'mine' drops visibleSharedProjectShareableToViewerSql from the cross-workspace branch",
    find: '       \\/ ~sameWs /\\ joined /\\ (SharedVisible \\/ (owner /\\ ~Revoked))',
    replace: '       \\/ ~sameWs /\\ joined',
    breaks: 'ActivityFeedOpens',
  },
  {
    name: 'recent-cross-workspace-any-visibility',
    code: "recentShareableAccessPredicate: crossProject loses shareables.visibility = 'project'",
    find: '            \\/ ~ArchivedContainer /\\ vis = "project" /\\ projectGrant /\\ verified',
    replace: '            \\/ ~ArchivedContainer /\\ projectGrant /\\ verified',
    breaks: 'RecentOpens',
  },
  {
    name: 'recent-grant-ignores-email-verification',
    code: 'recentShareableAccessPredicate: direct matches shareable_grants without grantMatchEmail',
    find: '       \\/ shareGrant /\\ verified                                     \\* direct',
    replace: '       \\/ shareGrant',
    breaks: 'RecentOpens',
  },
  {
    name: 'activity-feed-trusts-project-members-row',
    code: "visibleSharedProjectShareableToViewer lists every 'project' artifact without a project_share_defaults row, so the feed trusts the project_members row left after audience removal",
    find: '    \\/ vis = "project" /\\ verified /\\ projectGrant\n    \\/ shareGrant /\\ verified\nSharedProjectFiles',
    replace: '    \\/ vis = "project"\n    \\/ shareGrant /\\ verified\nSharedProjectFiles',
    breaks: 'ActivityFeedOpens',
  },
  {
    name: 'recent-trusts-project-members-row',
    code: 'recentShareableAccessPredicate: crossProject accepts a project_members row in place of the audience entry',
    find: '            \\/ ~ArchivedContainer /\\ vis = "project" /\\ projectGrant /\\ verified',
    replace: '            \\/ ~ArchivedContainer /\\ vis = "project" /\\ ((~Revoked /\\ joined) \\/ (projectGrant /\\ verified))',
    breaks: 'RecentOpens',
  },
  {
    name: 'activity-feed-owner-ignores-revocation',
    code: "mineFeedVisibleSql: the owner clause loses NOT workspaceAccessRevoked",
    find: '       \\/ ~sameWs /\\ joined /\\ (SharedVisible \\/ (owner /\\ ~Revoked))',
    replace: '       \\/ ~sameWs /\\ joined /\\ (SharedVisible \\/ owner)',
    breaks: 'ActivityFeedOpens',
  },
]

await runModelChecks({
  modelDir: join(dirname(fileURLToPath(import.meta.url)), 'model'),
  module: 'ArtifactAccess',
  mutations: MUTATIONS,
})
