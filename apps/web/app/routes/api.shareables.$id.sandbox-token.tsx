import { env } from 'cloudflare:workers'
import { nanoid } from 'nanoid'
import { artifactSandboxUrl } from '~/lib/hosts'
import { renderTypeFromKind } from '~/lib/artifact-type'
import { signSandboxToken } from '~/lib/sandbox-token'
import { userContext } from '~/middleware/context'
import {
  viewerDisplayCheck,
  type ArtifactSnapshot,
} from '~/services/access.server'
import { createDb } from '~/services/db.server'
import type { Route } from './+types/api.shareables.$id.sandbox-token'

export async function loader({ context, params, request }: Route.LoaderArgs) {
  const user = context.get(userContext)
  const db = createDb()
  const shareable = await db
    .selectFrom('shareables')
    .leftJoin('versions', 'versions.id', 'shareables.current_version_id')
    .leftJoin(
      'artifact_containers as project_container',
      'project_container.id',
      'shareables.container_id',
    )
    .select([
      'shareables.id',
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
      'versions.entrypoint_path',
      'versions.artifact_kind as version_artifact_kind',
    ])
    .where('shareables.id', '=', params.id)
    .executeTakeFirst()
  if (!shareable?.r2_key || !shareable.current_version_id) {
    return Response.json({ error: 'not-found' }, { status: 404 })
  }

  if (!user && shareable.visibility !== 'link') {
    return Response.json({ error: 'not-found' }, { status: 401 })
  }

  const snapshot: ArtifactSnapshot = {
    id: shareable.r2_key,
    name: shareable.name,
    mimeType: 'text/html',
    modifiedTime: null,
    ownerEmail: null,
  }
  const check = await viewerDisplayCheck(
    db,
    shareable.visibility,
    user?.id ?? null,
    snapshot,
    {
      shareableId: shareable.id,
      ownerUserId: shareable.owner_user_id,
      artifactWorkspaceId: shareable.workspace_id,
      viewerWorkspaceId: user?.workspaceId ?? null,
      viewerEmail: user?.email ?? null,
      viewerEmailVerified: user?.emailVerified ?? false,
      containerId: shareable.container_id,
      containerKind: shareable.project_container_kind,
      containerBaseVisibility: shareable.project_container_base_visibility,
    },
  )
  if (check.kind !== 'access-granted') {
    return Response.json({ error: 'not-found' }, { status: 404 })
  }

  const requestedVersionId = new URL(request.url).searchParams.get('version')
  if (requestedVersionId && !user) {
    return Response.json({ error: 'not-found' }, { status: 404 })
  }
  const requestedVersion = requestedVersionId
    ? await db
        .selectFrom('versions')
        .select(['id', 'r2_key', 'entrypoint_path', 'artifact_kind'])
        .where('id', '=', requestedVersionId)
        .where('shareable_id', '=', shareable.id)
        .where('status', '=', 'published')
        .where('published_at', 'is not', null)
        .where('artifact_kind', 'in', ['html_page', 'markdown_page'])
        .executeTakeFirst()
    : null
  if (requestedVersionId && !requestedVersion) {
    return Response.json({ error: 'not-found' }, { status: 404 })
  }
  const version = requestedVersion ?? {
    id: shareable.current_version_id,
    r2_key: shareable.r2_key,
    entrypoint_path: shareable.entrypoint_path,
    artifact_kind: shareable.version_artifact_kind,
  }
  const artifactKind = version.artifact_kind
  const renderType =
    artifactKind === 'static_site'
      ? 'static_site'
      : artifactKind === 'html_page' || artifactKind === 'markdown_page'
        ? renderTypeFromKind(artifactKind)
        : null
  if (!renderType) {
    return Response.json({ error: 'not-found' }, { status: 404 })
  }

  const token = await signSandboxToken(
    {
      uid: user?.id ?? null,
      wid: shareable.workspace_id,
      aid: shareable.id,
      vid: version.id,
      fid: version.r2_key,
      mt: check.meta.modifiedTime,
      t: renderType,
      jti: nanoid(),
    },
    env.BETTER_AUTH_SECRET,
  )

  const sandboxUrl = artifactSandboxUrl(
    env,
    shareable.id,
    token,
    version.entrypoint_path ?? undefined,
  )
  return Response.json({ sandboxUrl, renderType })
}
