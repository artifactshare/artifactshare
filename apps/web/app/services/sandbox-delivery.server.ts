import { env } from 'cloudflare:workers'
import { artifactDeliveryEnabled } from '~/lib/hosts'
import { renderTypeFromKind, type ArtifactType } from '~/lib/artifact-type'
import type { ArtifactKind } from '~/lib/shareable-types'
import { linkDomainContext, userContext } from '~/middleware/context'
import {
  viewerAccessAllowed,
  type ArtifactSnapshot,
} from '~/services/access.server'
import * as access from '~/modules/access'
import { checkAnonymousLinkAccess } from '~/services/link-sharing.server'
import { createDb } from '~/services/db.server'
import type { RouterContextProvider } from 'react-router'
import { anonymousLinkLowTrust } from './link-trust.server'

export async function authorizeSandboxDelivery(
  {
    context,
    params,
    request,
  }: {
    context: Readonly<RouterContextProvider>
    params: { id: string }
    request: Request
  },
  policy: 'refresh' | 'body',
) {
  if (!artifactDeliveryEnabled(env))
    return { ok: false, error: 'delivery-unavailable', status: 503 } as const
  const linkDomain = context.get(linkDomainContext)
  if (linkDomain && params.id !== linkDomain.shareableId) {
    return { ok: false, error: 'not-found', status: 404 } as const
  }
  const user = linkDomain ? null : context.get(userContext)
  const db = createDb()
  const shareable = await db
    .selectFrom('shareables')
    .leftJoin('users', 'users.id', 'shareables.owner_user_id')
    .leftJoin('workspaces', 'workspaces.id', 'shareables.workspace_id')
    .leftJoin('versions', 'versions.id', 'shareables.current_version_id')
    .leftJoin(
      'artifact_containers as project_container',
      'project_container.id',
      'shareables.container_id',
    )
    .select([
      'shareables.id',
      'users.created_at as owner_created_at',
      'workspaces.plan as artifact_workspace_plan',
      'shareables.workspace_id',
      'shareables.owner_user_id',
      'shareables.name',
      'shareables.visibility',
      'shareables.container_id',
      'shareables.current_version_id',
      'shareables.artifact_kind',
      'project_container.kind as project_container_kind',
      'project_container.base_visibility as project_container_base_visibility',
      'versions.r2_key',
      'versions.status as version_status',
      'versions.published_at as version_published_at',
      'versions.entrypoint_path',
      'versions.artifact_kind as version_artifact_kind',
    ])
    .where('shareables.id', '=', params.id)
    .executeTakeFirst()
  const artifactKind = shareable?.version_artifact_kind
  const renderType = artifactKind ? deliveryRenderType(artifactKind) : null
  if (!shareable?.r2_key || !shareable.current_version_id || !renderType) {
    return { ok: false, error: 'not-found', status: 404 } as const
  }

  if ((!user || linkDomain) && shareable.visibility !== 'link') {
    return { ok: false, error: 'not-found', status: 401 } as const
  }

  const snapshot: ArtifactSnapshot = {
    id: shareable.r2_key,
    name: shareable.name,
    mimeType: 'text/html',
    modifiedTime: null,
    ownerEmail: null,
  }
  const check = user
    ? await (async () => {
        const accessFacts = await access.facts(db, {
          shareableId: shareable.id,
          viewerUserId: user.id,
          now: new Date().toISOString(),
        })
        return accessFacts &&
          accessFacts.viewerUserId === user.id &&
          accessFacts.artifactWorkspaceId === shareable.workspace_id &&
          viewerAccessAllowed(accessFacts)
          ? ({ kind: 'access-granted', meta: snapshot } as const)
          : ({ kind: 'access-denied' } as const)
      })()
    : (await checkAnonymousLinkAccess(db, shareable.id)).kind === 'allowed'
      ? ({ kind: 'access-granted', meta: snapshot } as const)
      : ({ kind: 'access-denied' } as const)
  if (check.kind !== 'access-granted') {
    return { ok: false, error: 'not-found', status: 404 } as const
  }

  const requestedVersionId =
    policy === 'refresh' && linkDomain
      ? undefined
      : new URL(request.url).searchParams.get('version')?.trim()
  if (
    !user &&
    requestedVersionId &&
    requestedVersionId !== shareable.current_version_id
  ) {
    return { ok: false, error: 'not-found', status: 404 } as const
  }
  if (policy === 'body' && !requestedVersionId) {
    return { ok: false, error: 'missing-version', status: 400 } as const
  }
  if (
    policy === 'body' &&
    !user &&
    (await anonymousLinkLowTrust(db, shareable))
  ) {
    return { ok: false, error: 'not-found', status: 404 } as const
  }
  const version = requestedVersionId
    ? await db
        .selectFrom('versions')
        .select(['id', 'r2_key', 'entrypoint_path', 'artifact_kind'])
        .where('shareable_id', '=', shareable.id)
        .where('id', '=', requestedVersionId || shareable.current_version_id)
        .where('status', '=', 'published')
        .where('published_at', 'is not', null)
        .executeTakeFirst()
    : shareable.version_status === 'published' &&
        shareable.version_published_at !== null
      ? {
          id: shareable.current_version_id,
          r2_key: shareable.r2_key,
          entrypoint_path: shareable.entrypoint_path,
          artifact_kind: shareable.version_artifact_kind,
        }
      : undefined
  const versionRenderType = version?.artifact_kind
    ? deliveryRenderType(version.artifact_kind)
    : null
  if (!version || !versionRenderType) {
    return { ok: false, error: 'not-found', status: 404 } as const
  }

  return {
    ok: true,
    shareable,
    version,
    renderType: versionRenderType,
    uid: user?.id ?? null,
    modifiedTime: check.meta.modifiedTime,
  } as const
}

// Kinds the sandbox delivers. spa / workspace_app have no delivery here.
function deliveryRenderType(kind: ArtifactKind): ArtifactType | null {
  return kind === 'static_site' ? 'static_site' : renderTypeFromKind(kind)
}
