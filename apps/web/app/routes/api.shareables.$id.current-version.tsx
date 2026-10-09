import {
  ArtifactIdParamsSchema,
  ArtifactVersionLookupResponseSchema,
} from '@artifactshare/contract'
import { errorResponse } from '~/lib/api-errors'
import { linkDomainContext } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { checkAnonymousLinkAccess } from '~/services/link-sharing.server'
import type { Route } from './+types/api.shareables.$id.current-version'

const headers = { 'Cache-Control': 'private, no-store' }
const responseSchema = ArtifactVersionLookupResponseSchema.pick({
  currentVersionId: true,
})

function notFound() {
  return errorResponse('not-found', 'Shareable not found.', 404, { headers })
}

export async function loader({ context, params }: Route.LoaderArgs) {
  const parsed = ArtifactIdParamsSchema.safeParse(params)
  const linkDomain = context.get(linkDomainContext)
  if (
    !parsed.success ||
    (linkDomain && parsed.data.id !== linkDomain.shareableId)
  ) {
    return notFound()
  }
  const { id } = parsed.data
  const db = createDb()
  const shareable = await db
    .selectFrom('shareables')
    .innerJoin('versions', 'versions.id', 'shareables.current_version_id')
    .select([
      'shareables.visibility',
      'shareables.current_version_id',
      'versions.r2_key',
    ])
    .where('shareables.id', '=', id)
    .executeTakeFirst()
  if (
    shareable?.visibility !== 'link' ||
    !shareable.current_version_id ||
    !shareable.r2_key ||
    (await checkAnonymousLinkAccess(db, id, new Date().toISOString())).kind !==
      'allowed'
  ) {
    return notFound()
  }
  return Response.json(
    responseSchema.parse({ currentVersionId: shareable.current_version_id }),
    { headers },
  )
}

export function action() {
  return errorResponse('method-not-allowed', 'Method not allowed.', 405, {
    headers: { ...headers, Allow: 'GET, HEAD' },
  })
}
