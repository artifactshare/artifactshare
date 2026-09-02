import { env } from 'cloudflare:workers'
import { nanoid } from 'nanoid'
import { sql } from 'kysely'
import { useState } from 'react'
import {
  data,
  isRouteErrorResponse,
  Link,
  useRouteLoaderData,
} from 'react-router'
import { Button } from '~/components/ui/button'
import { Empty, EmptyContent } from '~/components/ui/empty'
import { AgentDisclosure } from '~/components/app/agent-disclosure'
import { AuthBlock } from '~/components/app/auth-card'
import { BrandMark } from '~/components/app/brand-mark'
import {
  authEmailLinkClassName,
  preauthAgentBodyClassName,
  preauthCardClassName,
  preauthFooterLinksClassName,
  preauthLockIconClassName,
  preauthMainClassName,
  preauthSubClassName,
  preauthTitleClassName,
} from '~/components/app/auth-styles'
import { Inline } from '~/components/layout/inline'
import { Stack } from '~/components/layout/stack'
import { CopyableCodeBlock } from '~/components/app/copyable-code-block'
import { LastUsedBadge } from '~/components/app/last-used-badge'
import { SignInOptions } from '~/components/app/sign-in-options'
import { type VersionRow } from './+components/history-panel'
import { PermissionDenied } from './+components/permission-denied'
import { SourceMissing } from './+components/source-missing'
import { Unavailable } from '~/components/app/unavailable'
import { UnsupportedContent } from './+components/unsupported-content'
import { useT } from '~/hooks/use-t'
import { detectArtifactType, type ArtifactType } from '~/lib/artifact-type'
import { type CommentThreadView } from '~/lib/comments'
import { displayTitle } from '~/lib/display-title'
import { isReservedBotEmail, isExternalAuthorEmail } from '~/lib/grant-emails'
import { lowerEmail } from '~/lib/grant-emails.server'
import { artifactSandboxUrl as buildArtifactSandboxUrl } from '~/lib/hosts'
import { isPrefetchRequest } from '~/lib/prefetch-request.server'
import { signSandboxToken } from '~/lib/sandbox-token'
import { socialMeta } from '~/lib/social-meta'
import { normalizeEmailDomain } from '~/lib/workspace-domains'
import {
  availableVisibilitiesFor,
  type EditableVisibility,
  type Visibility,
} from '~/lib/shareable-types'
import {
  getOwnerInitial,
  isOrgWorkspace,
  toUserInfo,
  type SessionUser,
  type UserInfo,
} from '~/lib/user'
import { ctxContext, userContext } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import {
  commentAccessFromVerifiedShareable,
  latestOtherCommentCreatedAt,
  loadCommentThreads,
} from '~/services/comments.server'
import { countShareableViewers } from '~/services/viewer-list.server'
import { getRequesterAccessRequestStatus } from '~/services/access-requests.server'
import {
  viewerDisplayCheck,
  type ArtifactSnapshot,
  type ViewerDisplayCheck,
} from '~/services/access.server'
import {
  canUseLinkSharing,
  checkAnonymousLinkAccess,
  loadWorkspaceLinkPolicy,
} from '~/services/link-sharing.server'
import {
  canUpdateShareableVersion,
  listGrants,
  type GrantEntry,
} from '~/services/shareables.server'
import {
  anonymousViewIdentifier,
  recordViewerRecency,
  recordViewAndNotifyViewCount,
} from '~/services/views.server'
import { ViewerShell } from './+components/viewer-shell'
import { findWorkspaceIdByDomainClaim } from '~/services/workspace-domain-claims.server'
import {
  loadViewerRevisitContext,
  type ViewerRevisitContext,
} from '~/services/viewer-revisit.server'
import { isDevScreenStateRequest } from '~/services/dev-screen-state.server'
import { ArtifactViewTracker } from './+components/artifact-view-tracker'
import type { Route } from './+types/index'
import { IconLock } from '@tabler/icons-react'

interface ArtifactSummary {
  id: string
  storageKey: string
  name: string
  derivedTitle: string | null
  titleOverride: string | null
  description: string | null
  ownerId: string
  ownerEmail: string | null
  ownerName: string | null
  bridgeRequesterLabel: string | null
  ownerImage: string | null
  ownerInitial: string
  ownerIsExternal: boolean
  ownerKind: 'human' | 'bot'
  modifiedTime: string | null
  viewCount: number
  canReplaceFile: boolean
  canViewHistory: boolean
  canChangeVisibility: boolean
  canMove: boolean
  visibility: Visibility
  ogImageKey: string
  workspaceHd: string | null
  workspaceMsTenantId: string | null
  availableVisibilities: ReadonlyArray<EditableVisibility>
  currentVersionId: string | null
  displayedVersionId: string
  displayedVersionOrdinal: number
  isHistoricalVersion: boolean
  versions: ReadonlyArray<VersionRow>
  grants: ReadonlyArray<GrantEntry>
  comments: ReadonlyArray<CommentThreadView>
  revisitContext?: ViewerRevisitContext | null
  // Viewer list (who viewed): present on the ok / static_site payloads only.
  // { false, 0 } whenever the loader gate fails, the count query degrades,
  // or the requester is not an active human member of the file's workspace.
  showViewerListMetaEntry?: boolean
  viewerListCount?: number
  defaultReturnTo: string
  projectId: string | null
  projectName: string | null
  linkExpiresAt: string | null
  linkExpired: boolean
  linkSharingAvailable: boolean
  linkExpiryDefaultDays: number | null
  linkExpiryMaxDays: number | null
  canReopenExpiredLink: boolean
}

type LoaderData =
  | {
      kind: 'preauth'
      artifact: {
        id: string
        name: string | null
        derivedTitle: string | null
        titleOverride: string | null
        description: string | null
      }
      canonicalUrl: string
    }
  | {
      kind: 'ok'
      user: UserInfo | null
      artifact: ArtifactSummary
      renderType: 'html' | 'md'
      canTrackView: boolean
      sandboxUrl: string
      canonicalUrl: string
    }
  | {
      kind: 'static_site'
      user: UserInfo | null
      artifact: ArtifactSummary
      canTrackView: boolean
      sandboxUrl: string
      bundlePaths: ReadonlyArray<string>
      fallbackToIndex: boolean
      canonicalUrl: string
    }
  | {
      kind: 'denied-internal'
      user: UserInfo
      emailVerified: boolean
      requestStatus: 'pending' | 'approved' | 'rejected' | null
      artifact: {
        id: string
        storageKey: string
        name: string
        derivedTitle: string | null
        titleOverride: string | null
        // CTA 分岐に使う: workspace はアクセス依頼、private は creator
        // (= owner) に Artifact Share 側で grants 追加依頼
        visibility: Visibility
        ownerEmail: string | null
      }
    }
  | {
      kind: 'denied-external'
      user: UserInfo
      artifactId: string
      emailVerified: boolean
      requestStatus: 'pending' | 'approved' | 'rejected' | null
    }
  | { kind: 'source-missing'; user: UserInfo; artifact: { id: string } }
  | { kind: 'unavailable'; user: UserInfo | null }
  | {
      kind: 'unsupported'
      user: UserInfo | null
      artifact: {
        id: string
        storageKey: string
        name: string
        derivedTitle: string | null
        titleOverride: string | null
        description: string | null
        modifiedTime: string | null
        canReplaceFile: boolean
        canViewHistory: boolean
        canChangeVisibility: boolean
        canMove: boolean
        visibility: Visibility
        ogImageKey: string
        ownerId: string
        ownerEmail: string | null
        ownerName: string | null
        ownerImage: string | null
        ownerInitial: string
        workspaceHd: string | null
        availableVisibilities: ReadonlyArray<EditableVisibility>
        currentVersionId: string | null
        displayedVersionId: string
        displayedVersionOrdinal: number
        isHistoricalVersion: boolean
        versions: ReadonlyArray<VersionRow>
        grants: ReadonlyArray<GrantEntry>
        comments: ReadonlyArray<CommentThreadView>
        defaultReturnTo: string
        viewCount: number
      }
    }

type SharePreviewArtifact = {
  id: string
  name: string
  derivedTitle: string | null
  titleOverride: string | null
  description: string | null
  visibility: Visibility
  ogImageKey: string
}

function preauthMetaDescription(canonicalUrl: string) {
  return `This Artifact Share file requires sign-in with an allowed account. AI assistants cannot read the file contents from this unauthenticated page. Shell-capable agents can try ${buildPreauthCliOpenCommand(canonicalUrl)}.`
}

const PREAUTH_OG_DESCRIPTION = 'Shared via Artifact Share'

export async function loader({
  params,
  context,
  request,
}: Route.LoaderArgs): Promise<LoaderData> {
  const db = createDb()

  // versions は leftJoin。version 行欠落 (NULL current_version_id か
  // dangling FK) のとき owner には source-missing を返したい。owner
  // 以外には share の存在を露呈しないため 404 に倒す。
  const shareable = await db
    .selectFrom('shareables')
    .innerJoin('users', 'users.id', 'shareables.owner_user_id')
    .leftJoin('versions', 'versions.id', 'shareables.current_version_id')
    .leftJoin(
      'artifact_containers as return_project',
      'return_project.id',
      'shareables.container_id',
    )
    .leftJoin(
      'workspaces as artifact_ws',
      'artifact_ws.id',
      'shareables.workspace_id',
    )
    .leftJoin(
      'users as container_creator',
      'container_creator.id',
      'return_project.created_by_id',
    )
    .select([
      'shareables.id',
      'shareables.workspace_id',
      'shareables.owner_user_id',
      'shareables.name',
      'shareables.artifact_kind',
      'shareables.derived_title',
      'shareables.title_override',
      'shareables.description',
      'shareables.visibility',
      'shareables.link_expires_at',
      'shareables.view_count',
      'shareables.updated_at',
      'shareables.current_version_id',
      'shareables.container_id',
      'users.email as owner_email',
      'users.name as owner_name',
      'users.image as owner_image',
      'users.kind as owner_kind',
      'versions.r2_key',
      'versions.entrypoint_path',
      'versions.fallback_to_index',
      'versions.artifact_kind as version_artifact_kind',
      'versions.published_at as current_published_at',
      'return_project.id as return_project_id',
      'return_project.name as return_project_name',
      'return_project.workspace_id as return_project_workspace_id',
      'return_project.kind as return_project_kind',
      'return_project.base_visibility as return_project_base_visibility',
      'return_project.archived_at as return_project_archived_at',
      'artifact_ws.hd as artifact_workspace_hd',
      'artifact_ws.email_domain as artifact_workspace_email_domain',
      'container_creator.email as container_creator_email',
    ])
    .where('shareables.id', '=', params.id)
    .executeTakeFirst()
  if (!shareable) {
    throw new Response('Not found', { status: 404 })
  }

  const requestUrl = new URL(request.url)
  const requestedVersionId = requestUrl.searchParams.get('version')?.trim()
  const canonicalUrl = new URL(`/a/${shareable.id}`, request.url)
  if (requestedVersionId) {
    canonicalUrl.searchParams.set('version', requestedVersionId)
  }
  const canonicalUrlString = canonicalUrl.toString()
  const user = context.get(userContext)

  if (!shareable.r2_key) {
    if (user && shareable.owner_user_id === user.id) {
      return forbidden({
        kind: 'source-missing',
        user: toUserInfo(user),
        artifact: { id: shareable.id },
      })
    }
    throw new Response('Not found', { status: 404 })
  }

  if (!user) {
    if (
      shareable.visibility === 'link' &&
      (!requestedVersionId ||
        requestedVersionId === shareable.current_version_id)
    ) {
      return await buildLinkAnonymousResponse(
        db,
        { ...shareable, r2_key: shareable.r2_key! },
        request,
        context,
        canonicalUrlString,
      )
    }
    return {
      kind: 'preauth',
      artifact: {
        id: shareable.id,
        name: null,
        derivedTitle: null,
        titleOverride: null,
        description: null,
      },
      canonicalUrl: canonicalUrlString,
    }
  }

  const userInfo = toUserInfo(user)
  const linkPolicy = await loadWorkspaceLinkPolicy(db, shareable.workspace_id)
  const linkAccess =
    shareable.visibility === 'link'
      ? await checkAnonymousLinkAccess(db, shareable.id)
      : null
  const availableVisibilities = availableVisibilitiesFor(
    isOrgWorkspace(user),
    shareable.return_project_kind === 'project' ? 'project' : 'inbox',
  )
  const storageKey = shareable.r2_key
  const artifactMimeType =
    shareable.version_artifact_kind === 'markdown_page'
      ? 'text/markdown'
      : 'text/html'
  const dbSnapshot: ArtifactSnapshot = {
    id: storageKey,
    name: shareable.name,
    mimeType: artifactMimeType,
    modifiedTime: null,
    ownerEmail: shareable.owner_email,
  }

  const displayCheck: ViewerDisplayCheck = await viewerDisplayCheck(
    db,
    shareable.visibility,
    user.id,
    dbSnapshot,
    {
      shareableId: shareable.id,
      ownerUserId: shareable.owner_user_id,
      artifactWorkspaceId: shareable.workspace_id,
      viewerWorkspaceId: user.workspaceId,
      viewerEmail: user.email,
      viewerEmailVerified: user.emailVerified,
      containerId: shareable.container_id,
      containerKind: shareable.return_project_kind,
      containerBaseVisibility: shareable.return_project_base_visibility,
    },
  )

  if (displayCheck.kind === 'access-denied') {
    if (shareable.owner_user_id === user.id) {
      return forbidden({
        kind: 'source-missing',
        user: userInfo,
        artifact: { id: shareable.id },
      })
    }
    const requestStatus = await getRequesterAccessRequestStatus(
      db,
      shareable.id,
      user.id,
    )
    if (shareable.workspace_id === user.workspaceId) {
      return forbidden({
        kind: 'denied-internal',
        user: userInfo,
        emailVerified: user.emailVerified,
        requestStatus,
        artifact: {
          id: shareable.id,
          storageKey,
          name: shareable.name,
          derivedTitle: shareable.derived_title,
          titleOverride: shareable.title_override,
          // visibility 別に PermissionDenied の CTA が変わる:
          visibility: shareable.visibility,
          ownerEmail: shareable.owner_email,
        },
      })
    }
    return forbidden({
      kind: 'denied-external',
      user: userInfo,
      artifactId: shareable.id,
      emailVerified: user.emailVerified,
      requestStatus,
    })
  }

  if (displayCheck.kind === 'meta-unavailable') {
    if (shareable.owner_user_id === user.id) {
      return forbidden({
        kind: 'source-missing',
        user: userInfo,
        artifact: { id: shareable.id },
      })
    }
    return forbidden({ kind: 'unavailable', user: userInfo })
  }

  const displayedVersion = requestedVersionId
    ? await db
        .selectFrom('versions')
        .select([
          'id',
          'artifact_kind',
          'entrypoint_path',
          'r2_key',
          'fallback_to_index',
          'published_at',
        ])
        .where('shareable_id', '=', shareable.id)
        .where('id', '=', requestedVersionId)
        .where('status', '=', 'published')
        .where('published_at', 'is not', null)
        .executeTakeFirst()
    : {
        id: shareable.current_version_id!,
        artifact_kind:
          shareable.version_artifact_kind ?? shareable.artifact_kind,
        entrypoint_path: shareable.entrypoint_path!,
        r2_key: shareable.r2_key!,
        fallback_to_index: shareable.fallback_to_index ?? 0,
        published_at: shareable.current_published_at,
      }
  if (!displayedVersion) {
    throw new Response('Not found', { status: 404 })
  }
  const isHistoricalVersion =
    displayedVersion.id !== shareable.current_version_id

  const {
    modifiedTime,
    name: fileName,
    mimeType,
    ownerEmail,
  } = displayCheck.meta
  const nameStale = fileName !== shareable.name
  const isOwner = shareable.owner_user_id === user.id
  const isPrefetch = isPrefetchRequest(request)
  const shouldRecordView = !isPrefetch && !isHistoricalVersion
  const preserveRevisitFixture = isDevScreenStateRequest(
    request,
    'viewer/revisit-context',
  )
  const bridgeAttributionFixture = isDevScreenStateRequest(
    request,
    'viewer/bridge-attribution',
  )
  const bridgeRequesterEmailFixture =
    bridgeAttributionFixture &&
    new URL(request.url).searchParams.get('bridgeRequester') === 'email'
  const canTrackView = !isPrefetch && !isHistoricalVersion
  const canViewHistory = true
  const isStaticSite = displayedVersion.artifact_kind === 'static_site'
  const detectedRenderType = isStaticSite
    ? 'static_site'
    : displayedVersion.artifact_kind === 'markdown_page'
      ? 'md'
      : displayedVersion.artifact_kind === 'html_page'
        ? 'html'
        : detectArtifactType(mimeType, fileName)
  const canReplaceFile =
    isOwner ||
    (user.selfUploadEnabled === true &&
      (await canUpdateShareableVersion(db, user, shareable.id)))
  const canReturnToProject =
    shareable.return_project_id !== null &&
    shareable.return_project_id === shareable.container_id &&
    shareable.return_project_workspace_id === user.workspaceId &&
    shareable.return_project_kind === 'project' &&
    shareable.return_project_archived_at === null
  const versions = (
    await loadHistoryVersions(
      db,
      shareable.id,
      shareable.current_version_id,
      displayedVersion.id,
      shareable.workspace_id === user.workspaceId,
    )
  ).map((version) => ({
    ...version,
    isDisplayed: version.id === displayedVersion.id,
  }))
  const displayedHistoryVersion = versions.find(
    (version) => version.id === displayedVersion.id,
  )
  if (!displayedHistoryVersion) {
    throw new Response('Not found', { status: 404 })
  }
  const displayedVersionOrdinal = displayedHistoryVersion.ordinal
  // creator なら visibility に関わらず grants を pre-load する。
  // private / workspace の切り替え時に、既存の個別許可を最初から見せる。
  const grants = isOwner
    ? await loadOwnerGrants(db, user, shareable.id)
    : ([] as ReadonlyArray<GrantEntry>)
  const commentAccess = await commentAccessFromVerifiedShareable(db, user, {
    id: shareable.id,
    workspaceId: shareable.workspace_id,
    ownerUserId: shareable.owner_user_id,
    visibility: shareable.visibility,
    currentVersionId: shareable.current_version_id,
    artifactKind: shareable.version_artifact_kind ?? shareable.artifact_kind,
    entrypointPath: shareable.entrypoint_path,
    r2Key: shareable.r2_key,
  })
  // Viewer-list gate. The spec expression also requires
  // `displayCheck.kind === 'access-granted'`; by this point every non-granted
  // displayCheck kind has already returned, so the equivalence assumes this
  // post-access-granted evaluation position.
  const viewerListGate = Boolean(detectedRenderType) && !isHistoricalVersion
  const [
    comments,
    latestCommentCreatedAt,
    revisitContext,
    viewerListStats,
    bridgeAttribution,
  ] = await Promise.all([
    isHistoricalVersion
      ? Promise.resolve([] as ReadonlyArray<CommentThreadView>)
      : loadCommentThreads(db, commentAccess, user),
    isHistoricalVersion
      ? Promise.resolve(null)
      : latestOtherCommentCreatedAt(db, shareable.id, user.id),
    detectedRenderType && !isHistoricalVersion
      ? loadViewerRevisitContext(db, {
          shareableId: shareable.id,
          viewerUserId: user.id,
          currentVersionId: shareable.current_version_id!,
          versions,
        }).catch((error: unknown) => {
          console.error('viewer revisit context failed', error)
          return null
        })
      : Promise.resolve(null),
    viewerListGate
      ? countShareableViewers(db, {
          shareableId: shareable.id,
          requesterUserId: user.id,
        }).catch((error: unknown) => {
          // Degrade to no viewer-list entry rather than failing the page.
          console.error('viewer list count failed', error)
          return null
        })
      : Promise.resolve(null),
    bridgeAttributionFixture
      ? Promise.resolve({
          requester_display_name: bridgeRequesterEmailFixture
            ? null
            : 'Aki Tanaka from the International Research Team',
          requester_verified_email: 'aki@example.com',
        })
      : shareable.owner_kind === 'bot'
        ? loadBridgeAttributionOrNull(db, displayedVersion.id)
        : Promise.resolve(null),
  ])
  // When the gate fails, the query fails, or the requester is outside the
  // audience, the serialized fields collapse to { false, 0 } so the loader
  // data never leaks a count. canViewViewerList stays loader-internal; the UI
  // gates on showViewerListMetaEntry only.
  const canViewViewerList = viewerListStats?.requesterEligible ?? false
  const showViewerListMetaEntry = canViewViewerList
  const viewerListCount = canViewViewerList
    ? Number(viewerListStats?.viewerCount ?? 0)
    : 0
  // Owner or Team workspace admin may move it. Reuse the admin flag the comment
  // access check already resolved rather than querying workspace_members again.
  const canMove = isOwner || commentAccess.isTeamWorkspaceAdmin
  const ownerName = bridgeAttributionFixture
    ? 'Publishing bot'
    : shareable.owner_name
  const ownerKind = bridgeAttributionFixture ? 'bot' : shareable.owner_kind
  const ownerInitial = getOwnerInitial(ownerName, shareable.owner_email)
  const bridgeRequester = await bridgeRequesterPresentation(
    db,
    bridgeAttribution,
    shareable.workspace_id,
    shareable.artifact_workspace_hd,
    shareable.artifact_workspace_email_domain,
    shareable.container_creator_email,
    { allowEmailFallback: shareable.workspace_id === user.workspaceId },
  )
  const baseArtifact = {
    id: shareable.id,
    storageKey,
    name: fileName,
    derivedTitle: shareable.derived_title,
    titleOverride: shareable.title_override,
    description: shareable.description,
    entrypointPath: displayedVersion.entrypoint_path,
    ownerId: shareable.owner_user_id,
    ownerEmail: ownerEmail ?? shareable.owner_email,
    ownerName,
    bridgeRequesterLabel: bridgeRequester.label,
    ownerImage: shareable.owner_image,
    ownerInitial,
    ownerIsExternal: bridgeAttribution
      ? bridgeRequester.isExternal
      : isExternalAuthorEmail(
          ownerEmail ?? shareable.owner_email,
          shareable.artifact_workspace_hd,
          shareable.container_creator_email,
        ),
    ownerKind,
    modifiedTime,
    viewCount: Number(shareable.view_count ?? 0),
    visibility: shareable.visibility,
    ogImageKey: shareable.updated_at,
    projectBaseVisibility:
      shareable.return_project_kind === 'project'
        ? shareable.return_project_base_visibility
        : null,
    defaultReturnTo: canReturnToProject
      ? `/projects/${shareable.return_project_id}`
      : '/',
    projectId: canReturnToProject ? shareable.return_project_id : null,
    projectName: canReturnToProject ? shareable.return_project_name : null,
    linkExpiresAt: shareable.link_expires_at,
    linkExpired: linkAccess?.kind === 'expired',
    linkSharingAvailable: linkPolicy ? canUseLinkSharing(linkPolicy) : false,
    linkExpiryDefaultDays: linkPolicy?.linkExpiryDefaultDays ?? null,
    linkExpiryMaxDays: linkPolicy?.linkExpiryMaxDays ?? null,
    canReopenExpiredLink: isOwner || commentAccess.isTeamWorkspaceAdmin,
    canMove,
    workspaceHd: user.hd,
    workspaceMsTenantId: user.msTenantId,
  }

  if (isStaticSite) {
    const bundlePaths = await db
      .selectFrom('version_files')
      .select('path')
      .where('version_id', '=', displayedVersion.id)
      .execute()
    const token = await signSandboxToken(
      {
        uid: user.id,
        wid: shareable.workspace_id,
        aid: shareable.id,
        vid: displayedVersion.id,
        fid: displayedVersion.r2_key,
        mt: modifiedTime,
        t: 'static_site',
        jti: nanoid(),
      },
      env.BETTER_AUTH_SECRET,
    )
    if (shouldRecordView) {
      const { recencyWrite, followUps } = viewFollowUps({
        db,
        dedupKv: env.VIEW_DEDUP,
        user,
        shareableId: shareable.id,
        nameStale,
        fileName,
        hmacSecret: env.BETTER_AUTH_SECRET,
        live: env.ARTIFACT_LIVE,
        currentPublishedAt: preserveRevisitFixture
          ? null
          : shareable.current_published_at,
        currentCommentCreatedAt: preserveRevisitFixture
          ? null
          : latestCommentCreatedAt,
      })
      await recencyWrite
      context.get(ctxContext).waitUntil(Promise.all(followUps))
    }

    return {
      kind: 'static_site',
      canTrackView,
      user: userInfo,
      artifact: {
        ...baseArtifact,
        canReplaceFile,
        canViewHistory,
        canChangeVisibility: isOwner,
        availableVisibilities,
        currentVersionId: shareable.current_version_id,
        displayedVersionId: displayedVersion.id,
        displayedVersionOrdinal,
        isHistoricalVersion,
        versions,
        grants,
        comments,
        revisitContext,
        showViewerListMetaEntry,
        viewerListCount,
      },
      sandboxUrl: buildArtifactSandboxUrl(
        env,
        shareable.id,
        displayedVersion.id,
        token,
        displayedVersion.entrypoint_path ?? undefined,
      ),
      bundlePaths: bundlePaths.map((file) => file.path),
      fallbackToIndex: Number(displayedVersion.fallback_to_index) === 1,
      canonicalUrl: canonicalUrlString,
    }
  }

  const renderType =
    detectedRenderType === 'static_site' ? null : detectedRenderType
  if (!renderType) {
    return {
      kind: 'unsupported',
      user: userInfo,
      artifact: {
        ...baseArtifact,
        name: fileName,
        canReplaceFile,
        canViewHistory,
        canChangeVisibility: isOwner,
        currentVersionId: shareable.current_version_id,
        displayedVersionId: displayedVersion.id,
        displayedVersionOrdinal,
        isHistoricalVersion,
        versions,
        grants,
        comments,
        ownerEmail: ownerEmail ?? shareable.owner_email,
        availableVisibilities,
      },
    }
  }

  const token = await signSandboxToken(
    {
      uid: user.id,
      wid: shareable.workspace_id,
      aid: shareable.id,
      vid: displayedVersion.id,
      fid: displayedVersion.r2_key,
      mt: modifiedTime,
      t: renderType,
      jti: nanoid(),
    },
    env.BETTER_AUTH_SECRET,
  )

  if (shouldRecordView) {
    const { recencyWrite, followUps } = viewFollowUps({
      db,
      dedupKv: env.VIEW_DEDUP,
      user,
      shareableId: shareable.id,
      nameStale,
      fileName,
      hmacSecret: env.BETTER_AUTH_SECRET,
      live: env.ARTIFACT_LIVE,
      currentPublishedAt: preserveRevisitFixture
        ? null
        : shareable.current_published_at,
      currentCommentCreatedAt: preserveRevisitFixture
        ? null
        : latestCommentCreatedAt,
    })
    await recencyWrite
    context.get(ctxContext).waitUntil(Promise.all(followUps))
  }

  const sandboxUrl = buildArtifactSandboxUrl(
    env,
    shareable.id,
    displayedVersion.id,
    token,
    displayedVersion.entrypoint_path ?? undefined,
  )

  return {
    kind: 'ok',
    canTrackView,
    user: userInfo,
    artifact: {
      ...baseArtifact,
      canReplaceFile,
      canViewHistory,
      canChangeVisibility: isOwner,
      availableVisibilities,
      currentVersionId: shareable.current_version_id,
      displayedVersionId: displayedVersion.id,
      displayedVersionOrdinal,
      isHistoricalVersion,
      versions,
      grants,
      comments,
      revisitContext,
      showViewerListMetaEntry,
      viewerListCount,
    },
    renderType,
    sandboxUrl,
    canonicalUrl: canonicalUrlString,
  }
}

async function buildLinkAnonymousResponse(
  db: ReturnType<typeof createDb>,
  shareable: {
    id: string
    name: string
    derived_title: string | null
    title_override: string | null
    description: string | null
    owner_user_id: string
    owner_email: string | null
    owner_name: string | null
    owner_image: string | null
    workspace_id: string
    artifact_workspace_hd: string | null
    artifact_workspace_email_domain: string | null
    container_creator_email: string | null
    r2_key: string
    entrypoint_path: string | null
    fallback_to_index: number | null
    current_version_id: string | null
    version_artifact_kind: string | null
    artifact_kind: string
    visibility: string
    view_count: number | null
    updated_at: string
    container_id: string | null
    return_project_kind: string | null
    return_project_base_visibility: string | null
    return_project_id: string | null
    return_project_name: string | null
  },
  request: Request,
  context: Route.LoaderArgs['context'],
  canonicalUrl: string,
): Promise<LoaderData> {
  const storageKey = shareable.r2_key
  const artifactMimeType =
    shareable.version_artifact_kind === 'markdown_page'
      ? 'text/markdown'
      : 'text/html'

  const dbSnapshot: ArtifactSnapshot = {
    id: storageKey,
    name: shareable.name,
    mimeType: artifactMimeType,
    modifiedTime: null,
    ownerEmail: shareable.owner_email,
  }

  const displayCheck = await viewerDisplayCheck(
    db,
    shareable.visibility as Visibility,
    null,
    dbSnapshot,
    {
      shareableId: shareable.id,
      ownerUserId: shareable.owner_user_id,
      artifactWorkspaceId: shareable.workspace_id,
      viewerWorkspaceId: null,
      viewerEmail: null,
      viewerEmailVerified: false,
      containerId: shareable.container_id,
      containerKind: shareable.return_project_kind as
        | 'project'
        | 'inbox'
        | null,
      containerBaseVisibility: shareable.return_project_base_visibility as
        | 'workspace'
        | 'private'
        | null,
    },
  )

  if (displayCheck.kind !== 'access-granted') {
    return { kind: 'unavailable', user: null }
  }

  const { modifiedTime, name: fileName } = displayCheck.meta
  const isStaticSite = shareable.version_artifact_kind === 'static_site'
  const bridgeAttributionFixture = isDevScreenStateRequest(
    request,
    'viewer/bridge-attribution',
  )
  const bridgeRequesterEmailFixture =
    bridgeAttributionFixture &&
    new URL(request.url).searchParams.get('bridgeRequester') === 'email'
  const bridgeAttribution = bridgeAttributionFixture
    ? {
        requester_display_name: bridgeRequesterEmailFixture
          ? null
          : 'Aki Tanaka from the International Research Team',
        requester_verified_email: 'aki@example.com',
      }
    : isReservedBotEmail(shareable.owner_email ?? '')
      ? await loadBridgeAttributionOrNull(db, shareable.current_version_id!)
      : null
  const ownerName = bridgeAttributionFixture
    ? 'Publishing bot'
    : shareable.owner_name
  const ownerInitial = getOwnerInitial(ownerName, shareable.owner_email ?? '')
  const bridgeRequester = await bridgeRequesterPresentation(
    db,
    bridgeAttribution,
    shareable.workspace_id,
    shareable.artifact_workspace_hd,
    shareable.artifact_workspace_email_domain,
    shareable.container_creator_email,
    { allowEmailFallback: false },
  )
  const baseArtifact = {
    id: shareable.id,
    storageKey,
    name: fileName,
    derivedTitle: shareable.derived_title,
    titleOverride: shareable.title_override,
    description: shareable.description,
    ownerId: shareable.owner_user_id,
    ownerEmail: shareable.owner_email,
    ownerName,
    bridgeRequesterLabel: bridgeRequester.label,
    ownerImage: shareable.owner_image,
    ownerInitial,
    ownerIsExternal: bridgeRequester.isExternal,
    // This query path doesn't join users.kind; the reserved bot email domain
    // is equally authoritative (sign-up rejects it).
    ownerKind:
      bridgeAttributionFixture ||
      isReservedBotEmail(shareable.owner_email ?? '')
        ? ('bot' as const)
        : ('human' as const),
    modifiedTime,
    viewCount: Number(shareable.view_count ?? 0),
    visibility: shareable.visibility as Visibility,
    ogImageKey: shareable.updated_at,
    projectBaseVisibility: null,
    defaultReturnTo: '/',
    projectId: null,
    projectName: null,
    canMove: false,
    workspaceHd: null,
    workspaceMsTenantId: null,
    canReplaceFile: false,
    canViewHistory: false,
    canChangeVisibility: false,
    availableVisibilities: [] as ReadonlyArray<EditableVisibility>,
    currentVersionId: shareable.current_version_id,
    displayedVersionId: shareable.current_version_id!,
    displayedVersionOrdinal: 1,
    isHistoricalVersion: false,
    versions: [] as ReadonlyArray<VersionRow>,
    grants: [] as ReadonlyArray<GrantEntry>,
    comments: [] as ReadonlyArray<CommentThreadView>,
    linkExpiresAt: null,
    linkExpired: false,
    linkSharingAvailable: false,
    linkExpiryDefaultDays: null,
    linkExpiryMaxDays: null,
    canReopenExpiredLink: false,
  }

  let anonymousCookieHeader: string | null = null
  const isPrefetch = isPrefetchRequest(request)
  const canTrackView = !isPrefetch
  if (!isPrefetch) {
    const anonymousView = await anonymousViewIdentifier(
      request,
      env.BETTER_AUTH_SECRET,
    )
    anonymousCookieHeader = anonymousView.cookieHeader
    context.get(ctxContext).waitUntil(
      recordViewAndNotifyViewCount(
        db,
        env.VIEW_DEDUP,
        shareable.id,
        anonymousView.identifier,
        {
          hmacSecret: env.BETTER_AUTH_SECRET,
        },
        env.ARTIFACT_LIVE,
      ),
    )
  }

  const token = await signSandboxToken(
    {
      uid: null,
      wid: shareable.workspace_id,
      aid: shareable.id,
      vid: shareable.current_version_id!,
      fid: storageKey,
      mt: modifiedTime,
      t: isStaticSite
        ? 'static_site'
        : (detectArtifactType(artifactMimeType, fileName) ?? 'html'),
      jti: nanoid(),
    },
    env.BETTER_AUTH_SECRET,
  )

  if (isStaticSite) {
    const bundlePaths = await db
      .selectFrom('version_files')
      .select('path')
      .where('version_id', '=', shareable.current_version_id!)
      .execute()
    return withAnonymousCookie(
      {
        kind: 'static_site',
        canTrackView,
        user: null,
        artifact: baseArtifact,
        sandboxUrl: buildArtifactSandboxUrl(
          env,
          shareable.id,
          shareable.current_version_id!,
          token,
          shareable.entrypoint_path ?? undefined,
        ),
        bundlePaths: bundlePaths.map((file) => file.path),
        fallbackToIndex: Number(shareable.fallback_to_index) === 1,
        canonicalUrl,
      },
      anonymousCookieHeader,
    )
  }

  const renderType = detectArtifactType(artifactMimeType, fileName)
  if (!renderType) {
    return { kind: 'unavailable', user: null }
  }

  return withAnonymousCookie(
    {
      kind: 'ok',
      canTrackView,
      user: null,
      artifact: baseArtifact,
      renderType,
      sandboxUrl: buildArtifactSandboxUrl(
        env,
        shareable.id,
        shareable.current_version_id!,
        token,
        shareable.entrypoint_path ?? undefined,
      ),
      canonicalUrl,
    },
    anonymousCookieHeader,
  )
}

function loadBridgeAttribution(
  db: ReturnType<typeof createDb>,
  versionId: string,
) {
  return db
    .selectFrom('bridge_operations')
    .select(['requester_display_name', 'requester_verified_email'])
    .where('version_id', '=', versionId)
    .executeTakeFirst()
}

async function loadBridgeAttributionOrNull(
  db: ReturnType<typeof createDb>,
  versionId: string,
) {
  try {
    return await loadBridgeAttribution(db, versionId)
  } catch (error) {
    console.error('bridge attribution failed', error)
    return null
  }
}

const EMAIL_ADDRESS_IN_TEXT = /[^\s<>]+@[^\s<>]+/u

async function bridgeRequesterPresentation(
  db: ReturnType<typeof createDb>,
  attribution: Awaited<ReturnType<typeof loadBridgeAttribution>> | null,
  workspaceId: string,
  workspaceHd: string | null,
  workspaceEmailDomain: string | null,
  selfEmail: string | null,
  options: { allowEmailFallback: boolean },
) {
  if (!attribution) return { label: null, isExternal: false }

  const displayName = attribution.requester_display_name
  const displayNameIsEmail =
    displayName !== null && EMAIL_ADDRESS_IN_TEXT.test(displayName)
  const label =
    (displayNameIsEmail ? null : displayName) ??
    (options.allowEmailFallback ? attribution.requester_verified_email : null)

  const workspaceDomain = workspaceHd ?? workspaceEmailDomain
  let isExternal =
    label !== null &&
    isExternalAuthorEmail(
      attribution.requester_verified_email,
      workspaceDomain,
      selfEmail,
    )
  if (isExternal) {
    try {
      const activeMember = await db
        .selectFrom('users')
        .innerJoin('workspace_members', (join) =>
          join
            .onRef('workspace_members.user_id', '=', 'users.id')
            .on('workspace_members.workspace_id', '=', workspaceId),
        )
        .select('users.id')
        .where('users.kind', '=', 'human')
        .where('workspace_members.status', '!=', 'removed')
        .where(
          lowerEmail('users.email'),
          '=',
          attribution.requester_verified_email,
        )
        .executeTakeFirst()
      if (activeMember) isExternal = false
    } catch (error) {
      console.error('bridge requester membership lookup failed', error)
    }
  }
  if (isExternal) {
    const requesterDomain = normalizeEmailDomain(
      attribution.requester_verified_email,
    )
    let claimedWorkspaceId: string | null = null
    try {
      claimedWorkspaceId = requesterDomain
        ? await findWorkspaceIdByDomainClaim(db, requesterDomain)
        : null
    } catch (error) {
      console.error('bridge requester domain claim lookup failed', error)
    }
    if (claimedWorkspaceId === workspaceId) isExternal = false
  }

  return {
    label,
    isExternal,
  }
}

function withAnonymousCookie(
  payload: LoaderData,
  cookieHeader: string | null,
): LoaderData {
  if (!cookieHeader) return payload
  return data(payload, {
    headers: { 'Set-Cookie': cookieHeader },
  }) as unknown as LoaderData
}

function forbidden(payload: LoaderData) {
  return data(payload, { status: 403 }) as unknown as LoaderData
}

function viewFollowUps({
  db,
  dedupKv,
  user,
  shareableId,
  nameStale,
  fileName,
  hmacSecret,
  live,
  currentPublishedAt,
  currentCommentCreatedAt,
}: {
  db: ReturnType<typeof createDb>
  dedupKv: KVNamespace
  user: SessionUser
  shareableId: string
  nameStale: boolean
  fileName: string
  hmacSecret: string
  live: Cloudflare.Env['ARTIFACT_LIVE']
  currentPublishedAt: string | null
  currentCommentCreatedAt: string | null
}): { recencyWrite: Promise<void>; followUps: Promise<unknown>[] } {
  const followUps: Promise<unknown>[] = []
  if (nameStale) {
    followUps.push(
      db
        .updateTable('shareables')
        .set({
          name: fileName,
        })
        .where('id', '=', shareableId)
        .execute()
        .catch((err) => {
          console.error('shareable_name_snapshot_write_failed', {
            shareable_id: shareableId,
            err,
          })
        }),
    )
  }
  const recencyWrite = recordViewerRecency(db, shareableId, user.id, {
    versionSeenThroughAt: currentPublishedAt,
    commentSeenThroughAt: currentCommentCreatedAt,
  }).catch((err) => {
    console.error('view_recency_write_failed', {
      shareable_id: shareableId,
      err,
    })
  })
  const view = recencyWrite.then(() =>
    recordViewAndNotifyViewCount(
      db,
      dedupKv,
      shareableId,
      { kind: 'user', id: user.id },
      {
        hmacSecret,
        versionSeenThroughAt: currentPublishedAt,
        commentSeenThroughAt: currentCommentCreatedAt,
        deferAfterRecency: true,
      },
      live,
    ),
  )
  const settledView = view.catch((err) => {
    console.error('view_record_write_failed', {
      shareable_id: shareableId,
      err,
    })
    return undefined
  })
  followUps.push(
    settledView
      .then((result) => result?.deferred)
      .catch((err) => {
        console.error('view_event_write_failed', {
          shareable_id: shareableId,
          err,
        })
      }),
  )
  return {
    recencyWrite,
    followUps,
  }
}

async function loadOwnerGrants(
  db: ReturnType<typeof createDb>,
  user: SessionUser,
  shareableId: string,
): Promise<ReadonlyArray<GrantEntry>> {
  const result = await listGrants(db, user, shareableId)
  return result.kind === 'ok' ? result.grants : []
}

async function loadHistoryVersions(
  db: ReturnType<typeof createDb>,
  shareableId: string,
  currentVersionId: string | null,
  displayedVersionId: string,
  mayShowCreatorEmail: boolean,
): Promise<ReadonlyArray<VersionRow>> {
  const [countRow, rows] = await Promise.all([
    db
      .selectFrom('versions')
      .select((eb) => eb.fn.count<number>('id').as('count'))
      .where('shareable_id', '=', shareableId)
      .where('status', '=', 'published')
      .where('published_at', 'is not', null)
      .executeTakeFirst(),
    db
      .selectFrom('versions')
      .leftJoin('users', 'users.id', 'versions.created_by_id')
      .select([
        'versions.id',
        'versions.created_at as createdAt',
        'versions.size_bytes as sizeBytes',
        'users.email as createdByEmail',
        'users.name as createdByName',
        'versions.created_by_agent_profile_id as createdByAgentProfileId',
      ])
      .where('versions.shareable_id', '=', shareableId)
      .where('versions.status', '=', 'published')
      .where('versions.published_at', 'is not', null)
      .orderBy('versions.created_at', 'desc')
      .orderBy('versions.id', 'desc')
      .limit(50)
      .execute(),
  ])
  const total = Number(countRow?.count ?? 0)

  const versions = rows.map((row, index) => ({
    id: row.id,
    ordinal: total - index,
    createdAt: row.createdAt,
    sizeBytes: row.sizeBytes,
    isCurrent: row.id === currentVersionId,
    createdByLabel: row.createdByAgentProfileId
      ? 'Agent'
      : (row.createdByName ??
        (mayShowCreatorEmail ? row.createdByEmail : null) ??
        'User'),
  }))
  if (versions.some((version) => version.id === displayedVersionId)) {
    return versions
  }

  const displayedRow = await db
    .selectFrom('versions')
    .leftJoin('users', 'users.id', 'versions.created_by_id')
    .select((eb) => [
      'versions.id',
      'versions.created_at as createdAt',
      'versions.size_bytes as sizeBytes',
      'users.email as createdByEmail',
      'users.name as createdByName',
      'versions.created_by_agent_profile_id as createdByAgentProfileId',
      eb
        .selectFrom('versions as older')
        .select((sub) => sub.fn.count<number>('older.id').as('count'))
        .whereRef('older.shareable_id', '=', 'versions.shareable_id')
        .where('older.status', '=', 'published')
        .where('older.published_at', 'is not', null)
        .where(
          sql<boolean>`(
            older.created_at < versions.created_at
            OR (older.created_at = versions.created_at AND older.id <= versions.id)
          )`,
        )
        .as('ordinal'),
    ])
    .where('versions.shareable_id', '=', shareableId)
    .where('versions.id', '=', displayedVersionId)
    .where('versions.status', '=', 'published')
    .where('versions.published_at', 'is not', null)
    .executeTakeFirst()
  if (!displayedRow) {
    throw new Response('Not found', { status: 404 })
  }

  return [
    ...versions,
    {
      id: displayedRow.id,
      ordinal: Number(displayedRow.ordinal),
      createdAt: displayedRow.createdAt,
      sizeBytes: displayedRow.sizeBytes,
      isCurrent: displayedRow.id === currentVersionId,
      createdByLabel: displayedRow.createdByAgentProfileId
        ? 'Agent'
        : (displayedRow.createdByName ??
          (mayShowCreatorEmail ? displayedRow.createdByEmail : null) ??
          'User'),
    },
  ]
}

export function meta({ loaderData }: Route.MetaArgs) {
  const robots = { name: 'robots', content: 'noindex, nofollow' }
  if (loaderData?.kind === 'preauth') {
    const title = 'Artifact Share'
    const description = preauthMetaDescription(loaderData.canonicalUrl)
    const tags: Array<
      | { title: string }
      | { property: string; content: string }
      | { name: string; content: string }
    > = [
      { title: `${title} · Artifact Share` },
      robots,
      { name: 'description', content: description },
      { property: 'og:title', content: title },
      { property: 'og:description', content: PREAUTH_OG_DESCRIPTION },
      { property: 'og:type', content: 'website' },
      { property: 'og:site_name', content: 'Artifact Share' },
      { property: 'og:url', content: loaderData.canonicalUrl },
    ]
    return tags
  }
  if (loaderData?.kind === 'static_site' || loaderData?.kind === 'ok') {
    return sharedPreviewMeta(
      loaderData.artifact,
      robots,
      loaderData.canonicalUrl,
    )
  }
  return [{ title: 'Artifact Share' }, robots]
}

function sharedPreviewMeta(
  artifact: SharePreviewArtifact,
  robots: { name: string; content: string },
  canonicalUrl: string,
): Array<
  | { title: string }
  | { property: string; content: string }
  | { name: string; content: string }
> {
  const title = displayTitle(artifact)
  const tags: Array<
    | { title: string }
    | { property: string; content: string }
    | { name: string; content: string }
  > = [{ title: `${title} · Artifact Share` }, robots]
  if (artifact.visibility === 'link') {
    const description = sharedPreviewDescription(artifact)
    const imageUrl = new URL(
      `/a/${encodeURIComponent(artifact.id)}/og-image`,
      canonicalUrl,
    )
    imageUrl.searchParams.set('v', artifact.ogImageKey)
    tags.push(
      { name: 'description', content: description },
      ...socialMeta({
        title,
        description,
        url: canonicalUrl,
        image: imageUrl.toString(),
        imageAlt: `${title} on Artifact Share`,
      }),
    )
  }
  return tags
}

function sharedPreviewDescription(artifact: SharePreviewArtifact): string {
  return artifact.description?.trim() || PREAUTH_OG_DESCRIPTION
}

export default function ViewerRoute({ loaderData }: Route.ComponentProps) {
  switch (loaderData.kind) {
    case 'preauth':
      return <PreauthFallback canonicalUrl={loaderData.canonicalUrl} />
    case 'denied-internal':
      return (
        <PermissionDenied
          variant="internal"
          artifact={loaderData.artifact}
          user={loaderData.user}
          emailVerified={loaderData.emailVerified}
          requestStatus={loaderData.requestStatus}
        />
      )
    case 'denied-external':
      return (
        <PermissionDenied
          variant="external"
          artifactId={loaderData.artifactId}
          user={loaderData.user}
          emailVerified={loaderData.emailVerified}
          requestStatus={loaderData.requestStatus}
        />
      )
    case 'source-missing':
      return (
        <SourceMissing user={loaderData.user} artifact={loaderData.artifact} />
      )
    case 'unsupported':
      return (
        <ViewerShell
          artifact={loaderData.artifact}
          user={loaderData.user}
          renderType={null}
          sandboxUrl={null}
          bundlePaths={[]}
        >
          <UnsupportedContent />
        </ViewerShell>
      )
    case 'unavailable':
      return (
        <Unavailable
          reason="missing"
          user={loaderData.user}
          screenCaptureError="viewer-unavailable"
        />
      )
    case 'ok':
      return (
        <>
          <ViewerShell
            artifact={loaderData.artifact}
            user={loaderData.user}
            renderType={loaderData.renderType}
            sandboxUrl={loaderData.sandboxUrl}
            bundlePaths={[]}
          />
          <ArtifactViewTracker
            artifactId={loaderData.artifact.id}
            renderType={loaderData.renderType}
            canTrackView={loaderData.canTrackView}
            visibility={loaderData.artifact.visibility}
            viewerState={loaderData.user ? 'authenticated' : 'anonymous'}
          />
        </>
      )
    case 'static_site':
      return (
        <>
          <ViewerShell
            artifact={loaderData.artifact}
            user={loaderData.user}
            renderType="static_site"
            sandboxUrl={loaderData.sandboxUrl}
            bundlePaths={loaderData.bundlePaths}
            fallbackToIndex={loaderData.fallbackToIndex}
          />
          <ArtifactViewTracker
            artifactId={loaderData.artifact.id}
            renderType="static_site"
            canTrackView={loaderData.canTrackView}
            visibility={loaderData.artifact.visibility}
            viewerState={loaderData.user ? 'authenticated' : 'anonymous'}
          />
        </>
      )
    default: {
      const _exhaustive: never = loaderData
      return _exhaustive
    }
  }
}

export function buildPreauthCliOpenCommand(canonicalUrl: string) {
  return `npm exec --yes --package=@artifactshare/cli -- artifactshare open ${canonicalUrl}`
}

function PreauthFallback({ canonicalUrl }: { canonicalUrl: string }) {
  const { t } = useT()
  const cliCommand = buildPreauthCliOpenCommand(canonicalUrl)
  const [agentHelpOpen, setAgentHelpOpen] = useState(false)
  const returnUrl = new URL(canonicalUrl)
  const returnPath = `${returnUrl.pathname}${returnUrl.search}`
  const signInHref = `/sign-in?method=email&next=${encodeURIComponent(returnPath)}`
  return (
    <Stack gap="0" align="center" justify="center" asChild>
      <main className={preauthMainClassName}>
        <div className={preauthCardClassName}>
          <span className={preauthLockIconClassName} aria-hidden="true">
            <IconLock strokeWidth={1.6} aria-hidden="true" />
          </span>
          <h1 className={preauthTitleClassName}>{t('lp.invite.title')}</h1>
          <Stack gap="12">
            <p className={preauthSubClassName}>{t('lp.invite.sub')}</p>
            <AuthBlock>
              <SignInOptions callbackURL={returnPath} />
              <Link to={signInHref} className={authEmailLinkClassName}>
                {t('signin.email.toggle')}
                <LastUsedBadge method="email" />
              </Link>
            </AuthBlock>
          </Stack>
          <AgentDisclosure
            open={agentHelpOpen}
            onToggle={() => setAgentHelpOpen((open) => !open)}
            summaryLabel={t('lp.invite.agentSummary')}
            panelId="preauth-agent-help"
            panelAriaHidden={!agentHelpOpen}
          >
            <AgentHelpContent
              cliCommand={cliCommand}
              interactive={agentHelpOpen}
            />
          </AgentDisclosure>
        </div>
        <div className="mt-[var(--spacing-8)]">
          <Inline gap="2" align="center" wrap justify="center" asChild>
            <p className={preauthFooterLinksClassName}>
              <BrandMark size={16} aria-hidden="true" />
              <span>{t('lp.invite.about')}</span>
              <Link to="/">{t('lp.invite.aboutLink')}</Link>
            </p>
          </Inline>
        </div>
      </main>
    </Stack>
  )
}

export function AgentHelpContent({
  cliCommand,
  interactive,
}: {
  cliCommand: string
  interactive: boolean
}) {
  const { t } = useT()
  return (
    <>
      <div className={preauthAgentBodyClassName}>
        <p>{t('lp.invite.aiBody')}</p>
        <p>
          <strong>{t('lp.invite.cliTitle')}</strong>
          {t('lp.invite.cliBody')}
        </p>
      </div>
      <CopyableCodeBlock
        code={cliCommand}
        name={t('lp.invite.commandLabel')}
        labels={{
          copy: t('lp.invite.copyCommand'),
          copied: t('lp.invite.copyCopied'),
          failed: t('lp.invite.copyFailed'),
        }}
        compact
        copyTabIndex={interactive ? 0 : -1}
      />
      <div className={preauthAgentBodyClassName}>
        <p>
          <strong>{t('lp.invite.chatTitle')}</strong>
          {t('lp.invite.chatBody')}
        </p>
      </div>
    </>
  )
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const rootData = useRouteLoaderData<{ user: SessionUser | null }>('root')
  if (!rootData?.user) {
    return (
      <main data-screen-capture-error="viewer-route-error-boundary">
        <Empty>
          <EmptyContent>
            <Button asChild>
              <Link to="/">Back</Link>
            </Button>
          </EmptyContent>
        </Empty>
      </main>
    )
  }
  const is404 = isRouteErrorResponse(error) && error.status === 404
  return (
    <Unavailable
      user={toUserInfo(rootData.user)}
      reason={is404 ? 'missing' : 'open-error'}
      screenCaptureError="viewer-route-error-boundary"
    />
  )
}
