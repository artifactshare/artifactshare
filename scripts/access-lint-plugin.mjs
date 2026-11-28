import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  collectKyselyImports,
  FUNCTION_TYPES,
  isSqlTag,
  propertyName,
  staticStrings,
  templateShapes,
  walk,
} from './lib/kysely-ast.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

const READ_METHODS = new Set([
  'selectFrom',
  'innerJoin',
  'leftJoin',
  'rightJoin',
  'fullJoin',
  'crossJoin',
])
const SHAREABLES_TABLE = /^shareables(?:\s+as\s+\w+)?$/u
const SHAREABLES_SQL = /\b(?:from|join)\s+shareables\b/iu

export const SHAREABLE_READ_EXEMPTIONS = {
  migrating: [
    'apps/web/app/routes/_home/_protected/files.tsx#loader',
    'apps/web/app/routes/_protected/+lib/project-subpage.server.ts#projectFileRowsQuery',
    'apps/web/app/routes/_protected/projects.$id.files.tsx#loader',
    'apps/web/app/routes/_protected/projects.$id.tsx#action',
    'apps/web/app/routes/a.$id.og-image.tsx#loader',
    'apps/web/app/routes/a.$id/+loader.server.ts#loader',
    'apps/web/app/routes/api.shareables.$id.current-version.tsx#loader',
    'apps/web/app/routes/api.shareables.$id.versions.tsx#loader',
    'apps/web/app/services/access-requests.server.ts#createAccessRequest',
    'apps/web/app/services/agent-scope.server.ts#authorizeAgentArtifactRead',
    'apps/web/app/services/artifact-version-summary.server.ts#loadArtifactVersionSummaries',
    'apps/web/app/services/cli-artifacts.server.ts#listAgentReadableArtifacts',
    'apps/web/app/services/cli-artifacts.server.ts#listCliArtifacts',
    'apps/web/app/services/cli-artifacts.server.ts#searchCliArtifacts',
    'apps/web/app/services/cli-resolve.server.ts#artifactCandidates',
    'apps/web/app/services/cli-resolve.server.ts#versionCandidates',
    'apps/web/app/services/comments.server.ts#loadShareableViewAccess',
    'apps/web/app/services/events.server.ts#listFeedEvents',
    'apps/web/app/services/events.server.ts#listProjectViewRanking',
    'apps/web/app/services/home.server.ts#artifactSelectQuery',
    'apps/web/app/services/home.server.ts#recentArtifactsQuery',
    'apps/web/app/services/link-sharing.server.ts#checkAnonymousLinkAccess',
    'apps/web/app/services/mcp/artifact-resource.server.ts#list',
    'apps/web/app/services/project-membership.server.ts#listJoinedProjectsForDropdown',
    'apps/web/app/services/project-membership.server.ts#listProjectsForIndex',
    'apps/web/app/services/project-pins.server.ts#listProjectPins',
    'apps/web/app/services/projects.server.ts#listWorkspaceProjects',
    'apps/web/app/services/projects.server.ts#projectSummaryQuery',
    'apps/web/app/services/projects.server.ts#sharedProjectSummaryQuery',
    'apps/web/app/services/sandbox-delivery.server.ts#authorizeSandboxDelivery',
    'apps/web/app/services/search-discovery.server.ts#buildSparseDiscoveryQuery',
    'apps/web/app/services/search-discovery.server.ts#discoveryQuery',
    'apps/web/app/services/search-discovery.server.ts#enumerateSuggestionIds',
    'apps/web/app/services/search-logs.server.ts#readSearchLogs',
    'apps/web/app/services/search-logs.server.ts#recordSearchOpen',
    'apps/web/app/services/search-palette.server.ts#searchPalette',
    'apps/web/app/services/search-visibility.server.ts#searchVisibilitySources',
    'apps/web/app/services/search.server.ts#metadata',
    'apps/web/app/services/search.server.ts#recentSuggestions',
    'apps/web/app/services/search.server.ts#searchGroup',
    'apps/web/app/services/shareables.server.ts#ownedShareableSummaryQuery',
    'apps/web/app/services/slack-notifications.server.ts#processSlackNotificationOutbox',
    'apps/web/app/services/slack.server.ts#getShareableForUnfurl',
    'apps/web/workers/bundle-sandbox.ts#publishedEntrypoint',
    'apps/web/workers/bundle-sandbox.ts#serveAnonymousLinkBundleAsset',
    'apps/web/workers/bundle-sandbox.ts#serveBundleAsset',
    'apps/web/workers/bundle-sandbox.ts#serveViewerResource',
  ],
  management: [
    'apps/web/app/lib/static-site-version-upload.server.ts#runStaticSiteVersionUpload',
    'apps/web/app/modules/publish/operations.server.ts#appendShareable',
    'apps/web/app/modules/publish/operations.server.ts#findWritableShareable',
    'apps/web/app/modules/publish/static-site-request.server.ts#publishStaticSiteUpdate',
    'apps/web/app/routes/api.artifacts.$id.sharing-context.tsx#loader',
    'apps/web/app/routes/api.cli.shareables.$id.edit.tsx#action',
    'apps/web/app/routes/api.shareables.$id.abuse-check.tsx#action',
    'apps/web/app/routes/api.shareables.$id.versions.tsx#action',
    'apps/web/app/services/access-requests.server.ts#currentHandlerQuery',
    'apps/web/app/services/access-requests.server.ts#grantCapacityPredicate',
    'apps/web/app/services/access-requests.server.ts#loadRequestContext',
    'apps/web/app/services/access-requests.server.ts#receivedBaseQuery',
    'apps/web/app/services/access-requests.server.ts#scopeCapabilityPredicate',
    'apps/web/app/services/artifact-keys.server.ts#resolveArtifactKey',
    'apps/web/app/services/bridge-publish-session.server.ts#bridgeGrantQuery',
    'apps/web/app/services/bridge-publish-session.server.ts#ensureReplayGrant',
    'apps/web/app/services/bridge-publish-session.server.ts#readBridgeResult',
    'apps/web/app/services/bridge-publish-session.server.ts#resolveBridgeTarget',
    'apps/web/app/services/bridge-publish-session.server.ts#setBridgeVisibility',
    'apps/web/app/services/cli-download.server.ts#getPublisherDownloadFile',
    'apps/web/app/services/link-sharing.server.ts#reopenExpiredLink',
    'apps/web/app/services/link-suspension.server.ts#appealLinkSuspension',
    'apps/web/app/services/link-suspension.server.ts#linkSuspensionState',
    'apps/web/app/services/link-suspension.server.ts#ownerOf',
    'apps/web/app/services/projects.server.ts#countProjectVisibilityArtifacts',
    'apps/web/app/services/projects.server.ts#deleteProjectContainer',
    'apps/web/app/services/publisher-adoption.server.ts#adoptPublisherArtifact',
    'apps/web/app/services/publisher-scope.server.ts#isPublisherArtifact',
    'apps/web/app/services/publisher-scope.server.ts#loadPublisherArtifact',
    'apps/web/app/services/recipient-suggestions.server.ts#canUseSuggestionContext',
    'apps/web/app/services/retention-settings.server.ts#ownerQuery',
    'apps/web/app/services/retention-settings.server.ts#snapshot',
    'apps/web/app/services/shareables.server.ts#canUpdateShareableVersion',
    'apps/web/app/services/shareables.server.ts#commitSharingChanges',
    'apps/web/app/services/shareables.server.ts#commitVersion',
    'apps/web/app/services/shareables.server.ts#deleteShareableWithAuthority',
    'apps/web/app/services/shareables.server.ts#editShareableSettings',
    'apps/web/app/services/shareables.server.ts#findOwnedShareable',
    'apps/web/app/services/shareables.server.ts#findOwnedShareableForGrants',
    'apps/web/app/services/shareables.server.ts#findWritableShareable',
    'apps/web/app/services/shareables.server.ts#getShareableSummaryById',
    'apps/web/app/services/shareables.server.ts#listMoveDestinations',
    'apps/web/app/services/shareables.server.ts#moveShareableContainer',
    'apps/web/app/services/shareables.server.ts#updateShareableMetadata',
    'apps/web/app/services/team-management.server.ts#loadRemovedWorkspaceMembers',
    'apps/web/app/services/team-management.server.ts#loadWorkspaceInventoryArtifactsPage',
    'apps/web/app/services/team-management.server.ts#loadWorkspaceInventoryProjectsPage',
    'apps/web/app/services/team-management.server.ts#transferRemovedMemberAssets',
    'apps/web/app/services/viewer-list.server.ts#audienceConditions',
    'apps/web/app/services/viewer-list.server.ts#internalAudienceCondition',
  ],
  system: [
    'apps/web/app/services/access-request-resolution-notifications.server.ts#loadResolutionContext',
    'apps/web/app/services/bot-members.server.ts#botCancellationEligible',
    'apps/web/app/services/events.server.ts#artifactCreatedEventQuery',
    'apps/web/app/services/events.server.ts#artifactViewedEventQuery',
    'apps/web/app/services/events.server.ts#commentPostedEventQuery',
    'apps/web/app/services/events.server.ts#versionPublishedEventQuery',
    'apps/web/app/services/events.server.ts#visibilityChangedEvent',
    'apps/web/app/services/link-reports.server.ts#recordLinkReport',
    'apps/web/app/services/link-sharing.server.ts#buildLinkPublishRateLimitFailure',
    'apps/web/app/services/link-sharing.server.ts#countShortenedLinks',
    'apps/web/app/services/link-suspension.server.ts#transitionLink',
    'apps/web/app/services/link-trust.server.ts#anonymousLinkLowTrust',
    'apps/web/app/services/oauth-workspace-integration.server.ts#applyOAuthWorkspaceIntegration',
    'apps/web/app/services/oauth-workspace-integration.server.ts#buildPlan',
    'apps/web/app/services/oauth-workspace-integration.server.ts#disposableEmptyWorkspaceCondition',
    'apps/web/app/services/oauth-workspace-integration.server.ts#findTargetSlugConflicts',
    'apps/web/app/services/reconcile.server.ts#reconcileQuota',
    'apps/web/app/services/sandbox-block-report.server.ts#finishSandboxBlockReport',
    'apps/web/app/services/search-index/inventory.server.ts#inventory',
    'apps/web/app/services/version-retention.server.ts#candidates',
    'apps/web/app/services/version-retention.server.ts#hasExtraProtectedCurrentVersion',
    'apps/web/app/services/version-retention.server.ts#pruneVersions',
    'apps/web/app/services/views.server.ts#recordViewAndNotifyViewCount',
    'apps/web/app/services/workspace-domain-claims.server.ts#deleteWorkspaceIfUnreferenced',
    'apps/web/app/services/workspace-domain-claims.server.ts#listWorkspaceMigrationCandidates',
    'apps/web/app/services/workspace-domain-claims.server.ts#moveUserToWorkspaceIfSafe',
    'apps/web/app/services/workspace-domain-claims.server.ts#resolveMicrosoftClaimWorkspace',
    'apps/web/app/services/workspace-domain-claims.server.ts#userWorkspaceChangeBlockReasons',
    'apps/web/app/services/workspace-domain-claims.server.ts#workspaceMigrationBlockReasons',
    'apps/web/workers/link-abuse-judgment-workflow.ts#run',
    'apps/web/workers/workspace-search-index.ts#refreshFilePolicy',
  ],
  write: [
    'apps/web/app/modules/publish/operations.server.ts#createVersion',
    'apps/web/app/modules/publish/operations.server.ts#didShareableIdAppearAfterBatchFailure',
    'apps/web/app/services/bridge-conversation-binding.server.ts#deleteEmptyProject',
    'apps/web/app/services/bridge-publish-session.server.ts#guardedVersionInsert',
    'apps/web/app/services/comments.server.ts#createCommentThread',
    'apps/web/app/services/project-pins.server.ts#pinShareable',
    'apps/web/app/services/shareables.server.ts#didShareableIdAppearAfterBatchFailure',
    'apps/web/app/services/shareables.server.ts#generateUniqueShareableId',
    'apps/web/app/services/views.server.ts#upsertViewerRecency',
  ],
}

const EXEMPT_KEYS = new Set(Object.values(SHAREABLE_READ_EXEMPTIONS).flat())

export function isAccessLintScope(file) {
  return (
    /^apps\/web\/(?:app|workers)\//u.test(file) &&
    /\.[cm]?[jt]sx?$/u.test(file) &&
    !/\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file) &&
    !/\/(?:test|tests|d1-tests|__tests__)\//u.test(file) &&
    !file.startsWith('apps/web/app/modules/access/')
  )
}

function functionName(node, parent) {
  if (node.id?.type === 'Identifier') return node.id.name
  if (parent?.type === 'VariableDeclarator') return propertyName(parent.id)
  if (
    ['MethodDefinition', 'Property', 'PropertyDefinition'].includes(
      parent?.type,
    )
  )
    return propertyName(parent.key)
  return null
}

function enclosingFunction(ancestors) {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    if (!FUNCTION_TYPES.has(ancestors[index].type)) continue
    const name = functionName(ancestors[index], ancestors[index - 1])
    if (name) return name
  }
  return '(module)'
}

function shareableRead(node, imports, scope) {
  if (node.type === 'TaggedTemplateExpression') {
    const text = node.quasi.quasis
      .map((quasi) => quasi.value.cooked ?? quasi.value.raw)
      .join(' ? ')
    return isSqlTag(node.tag, imports) && SHAREABLES_SQL.test(text)
      ? node
      : null
  }
  if (
    node.type !== 'CallExpression' ||
    node.callee?.type !== 'MemberExpression'
  )
    return null
  const method = propertyName(node.callee.property)
  const [source] = node.arguments
  const tables = READ_METHODS.has(method)
    ? (source?.type === 'ArrayExpression' ? source.elements : [source]).flatMap(
        (table) => staticStrings(table, scope) ?? [],
      )
    : []
  if (tables.some((table) => SHAREABLES_TABLE.test(table)))
    return node.callee.property
  const rawSql =
    method === 'prepare' ||
    (method === 'raw' && isSqlTag(node.callee.object, imports))
  if (
    rawSql &&
    templateShapes(source, scope)?.some((text) => SHAREABLES_SQL.test(text))
  )
    return source
  return null
}

export function shareableReads(program) {
  const imports = collectKyselyImports(program)
  const reads = []
  walk(program, (node, ancestors, scope) => {
    const read = shareableRead(node, imports, scope)
    if (read)
      reads.push({ node: read, functionName: enclosingFunction(ancestors) })
  })
  return reads
}

const MESSAGE =
  "Whether a viewer may see a shareable is decided in ~/modules/access, and the exemption table for older reads only shrinks. To open one artifact, load `facts` from `~/modules/access` and pass the result to `viewerAccessAllowed` from `~/services/access.server`. To list artifacts, write the query in ~/modules/access and filter it with `visibleShareableToViewer` (the viewer's own workspace) or `visibleSharedProjectShareableToViewer` (shared projects elsewhere) from `~/services/projects.server`."

export default {
  meta: { name: 'access' },
  rules: {
    'no-direct-shareable-read': {
      meta: { type: 'problem', schema: [] },
      create(context) {
        const file = relative(root, context.filename).replaceAll('\\', '/')
        if (
          !isAccessLintScope(file) ||
          !context.sourceCode.text.includes('shareables')
        )
          return {}
        return {
          Program(program) {
            for (const { node, functionName: name } of shareableReads(
              program,
            )) {
              if (!EXEMPT_KEYS.has(`${file}#${name}`))
                context.report({ node, message: MESSAGE })
            }
          },
        }
      },
    },
  },
}
