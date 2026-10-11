import { displayTitle } from '~/lib/display-title'
import { publisherArtifactSql } from '~/services/publisher-scope.server'
import {
  allowsHumanCliMutation,
  cliReadAuthority,
} from '~/lib/cli-authority-policy'
import { cliScopeDeniedResponse } from '~/lib/cli-agent-operations'
import {
  ArtifactIdParamsSchema,
  CliEditRequestSchema,
  PublisherRetentionRequestSchema,
  CliEditResponseSchema,
} from '@artifactshare/contract'
import { errorResponse } from '~/lib/api-errors'
import {
  cliEditErrorResponse,
  cliEditSuccessBody,
} from '~/lib/shareable-settings-adapter.server'
import { requireUserApiWithBearerMiddleware } from '~/middleware/auth'
import { getCliAuthority, requireUser } from '~/middleware/context'
import { saveRetention } from '~/services/retention-settings.server'
import { withDb } from '~/services/db.server'
import { editShareableSettings } from '~/services/shareables.server'
import type { Route } from './+types/api.cli.shareables.$id.edit'

export const middleware = [requireUserApiWithBearerMiddleware]

export async function action({
  request,
  params,
  context,
  url,
}: Route.ActionArgs) {
  const authority = getCliAuthority(context)
  const publisher = authority?.kind === 'publisher' ? authority : null
  if (request.method !== 'POST' && !(publisher && request.method === 'PATCH')) {
    return new Response('Method Not Allowed', { status: 405 })
  }
  const user = requireUser(context)
  if (!publisher && cliReadAuthority(authority) === 'denied')
    return cliScopeDeniedResponse()
  const parsedParams = ArtifactIdParamsSchema.safeParse(params)
  if (!parsedParams.success) {
    return errorResponse('not-found', 'Shareable not found.', 404)
  }

  const body = await request.json().catch(() => null)
  if (publisher) {
    const parsed = PublisherRetentionRequestSchema.safeParse(body)
    if (!parsed.success)
      return errorResponse(
        'validation-failed',
        'Only retain_versions is allowed.',
        400,
      )
    return withDb(async (db) => {
      const row = await db
        .selectFrom('shareables')
        .leftJoin('artifact_containers as c', 'c.id', 'shareables.container_id')
        .selectAll('shareables')
        .select('c.kind as container_kind')
        .where('shareables.id', '=', parsedParams.data.id)
        .where(publisherArtifactSql(user.id, publisher))
        .executeTakeFirst()
      if (!row) return errorResponse('not-found', 'Shareable not found.', 404)
      const metadata = await saveRetention(
        db,
        row.id,
        user.id,
        parsed.data.retain_versions,
        undefined,
        publisher,
      )
      if (!metadata)
        return errorResponse('not-found', 'Shareable not found.', 404)
      return Response.json(
        CliEditResponseSchema.parse({
          ...cliEditSuccessBody(url.href, {
            id: row.id,
            title: displayTitle({
              name: row.name,
              derivedTitle: row.derived_title,
              titleOverride: row.title_override,
            }),
            visibility: row.visibility,
            linkExpiresAt: row.link_expires_at,
            updatedAt: row.updated_at,
            activityAt: row.activity_at,
            projectId:
              row.container_kind === 'project' ? row.container_id : null,
            artifactKind: row.artifact_kind as
              | 'html_page'
              | 'markdown_page'
              | 'static_site',
          }),
          ...metadata,
        }),
      )
    })
  }
  const parsedBody = CliEditRequestSchema.safeParse(body)
  if (!parsedBody.success) {
    return errorResponse('validation-failed', 'Invalid edit payload.', 400)
  }
  const parsed = cliEditInput(parsedBody.data)

  if (parsedBody.data.retain_versions !== undefined) {
    if (!allowsHumanCliMutation(authority)) {
      return errorResponse(
        'forbidden',
        'Version retention requires unrestricted owner credentials.',
        403,
      )
    }
    const owned = await withDb((db) =>
      db
        .selectFrom('shareables')
        .select('id')
        .where('id', '=', parsedParams.data.id)
        .where('owner_user_id', '=', user.id)
        .executeTakeFirst(),
    )
    if (!owned)
      return errorResponse(
        'forbidden',
        'Only the artifact owner can change version retention.',
        403,
      )
  }
  const result = await withDb(
    async (db) =>
      await editShareableSettings(
        db,
        user,
        parsedParams.data.id,
        parsed,
        authority,
      ),
  )
  switch (result.kind) {
    case 'ok': {
      const retention = parsedBody.data.retain_versions
      const metadata =
        retention === undefined
          ? {}
          : await withDb((db) =>
              saveRetention(db, parsedParams.data.id, user.id, retention),
            )
      if (metadata === null)
        return errorResponse(
          'forbidden',
          'Only the artifact owner can change version retention.',
          403,
        )
      return Response.json(
        CliEditResponseSchema.parse({
          ...cliEditSuccessBody(url.href, result.shareable),
          ...metadata,
        }),
      )
    }
    default:
      return cliEditErrorResponse(result)
  }
}

function cliEditInput(payload: ReturnType<typeof CliEditRequestSchema.parse>) {
  return {
    ...(payload.title !== undefined ? { title: payload.title } : {}),
    ...(payload.visibility !== undefined
      ? { visibility: payload.visibility }
      : {}),
    ...(payload.link_expires_at !== undefined
      ? { linkExpiresAt: payload.link_expires_at }
      : {}),
    ...(payload.add_emails !== undefined
      ? { addEmails: payload.add_emails }
      : {}),
    ...(payload.remove_emails !== undefined
      ? { removeEmails: payload.remove_emails }
      : {}),
    ...(payload.destination !== undefined
      ? {
          destination:
            payload.destination === 'home'
              ? { type: 'inbox' as const }
              : {
                  type: 'project' as const,
                  projectId: payload.destination.project_id,
                },
        }
      : {}),
  }
}
