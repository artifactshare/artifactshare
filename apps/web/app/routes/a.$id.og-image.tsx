import { displayTitle } from '~/lib/display-title'
import {
  viewerDisplayCheck,
  type ArtifactSnapshot,
} from '~/services/access.server'
import { createDb } from '~/services/db.server'
import { fetchShareOgImage } from '~/services/og-image-worker.server'

export async function loader({
  params,
  request,
}: {
  params: { id?: string }
  request: Request
}) {
  if (!params.id) {
    throw new Response('Not found', { status: 404 })
  }

  const db = createDb()
  const shareable = await db
    .selectFrom('shareables')
    .innerJoin('users', 'users.id', 'shareables.owner_user_id')
    .leftJoin('versions', 'versions.id', 'shareables.current_version_id')
    .select([
      'shareables.id',
      'shareables.workspace_id',
      'shareables.owner_user_id',
      'shareables.name',
      'shareables.derived_title',
      'shareables.title_override',
      'shareables.visibility',
      'users.email as owner_email',
      'users.name as owner_name',
      'users.image as owner_image',
      'versions.r2_key',
    ])
    .where('shareables.id', '=', params.id)
    .executeTakeFirst()

  if (!shareable || shareable.visibility !== 'link' || !shareable.r2_key) {
    throw new Response('Not found', { status: 404 })
  }

  const check = await viewerDisplayCheck(
    db,
    'link',
    null,
    {
      id: shareable.r2_key,
      modifiedTime: null,
      name: shareable.name,
      mimeType: 'text/html',
      ownerEmail: shareable.owner_email,
    } satisfies ArtifactSnapshot,
    {
      shareableId: shareable.id,
      ownerUserId: shareable.owner_user_id,
      artifactWorkspaceId: shareable.workspace_id,
      viewerWorkspaceId: null,
      viewerEmail: null,
      viewerEmailVerified: false,
      containerId: null,
      containerKind: null,
      containerBaseVisibility: null,
    },
  )
  if (check.kind !== 'access-granted') {
    throw new Response('Not found', { status: 404 })
  }

  const canonicalUrl = new URL(`/a/${shareable.id}`, request.url)
  const ownerAvatarUrl = safeOwnerAvatarUrl(shareable.owner_image, canonicalUrl)
  return fetchShareOgImage({
    title: displayTitle({
      name: shareable.name,
      derivedTitle: shareable.derived_title,
      titleOverride: shareable.title_override,
    }),
    ownerLabel: shareable.owner_name?.trim() || shareable.owner_email,
    ownerAvatarUrl,
    urlLabel: canonicalUrl.host + canonicalUrl.pathname,
  })
}

export function safeOwnerAvatarUrl(
  value: string | null,
  canonicalUrl: URL,
): string | null {
  if (!value) return null
  try {
    const avatarUrl = new URL(value)
    if (
      avatarUrl.origin === canonicalUrl.origin &&
      /^\/api\/avatar\/[^/]+$/u.test(avatarUrl.pathname)
    ) {
      return avatarUrl.toString()
    }
    if (
      avatarUrl.protocol === 'https:' &&
      avatarUrl.hostname === 'lh3.googleusercontent.com' &&
      avatarUrl.port === '' &&
      avatarUrl.username === '' &&
      avatarUrl.password === '' &&
      avatarUrl.hash === '' &&
      /^\/(?:a|a-)\/[^/]+$/u.test(avatarUrl.pathname)
    ) {
      return avatarUrl.toString()
    }
  } catch {
    // Older or malformed provider values fall back to an initial avatar.
  }
  return null
}
