import {
  ArtifactIdParamsSchema,
  CliEditRequestSchema,
} from '@artifactshare/contract'
import { errorResponse } from '~/lib/api-errors'
import { allowsHumanCliMutation } from '~/lib/cli-authority-policy'
import { requireUserApiMiddleware } from '~/middleware/auth'
import { getCliAuthority, requireUser } from '~/middleware/context'
import { withDb } from '~/services/db.server'
import {
  previewRetention,
  saveRetention,
} from '~/services/retention-settings.server'
import type { Route } from './+types/api.shareables.$id.retention'

export const middleware = [requireUserApiMiddleware]

export async function action({ request, params, context }: Route.ActionArgs) {
  if (request.method !== 'POST')
    return new Response('Method Not Allowed', { status: 405 })
  const user = requireUser(context)
  if (!allowsHumanCliMutation(getCliAuthority(context)))
    return errorResponse('forbidden', 'Owner access required.', 403)
  const id = ArtifactIdParamsSchema.safeParse(params)
  if (!id.success) return errorResponse('not-found', 'File not found.', 404)
  const raw = await request.json().catch(() => null)
  const body =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {}
  const parsed = CliEditRequestSchema.safeParse({
    retain_versions: body?.retain_versions,
  })
  if (
    !parsed.success ||
    parsed.data.retain_versions === undefined ||
    (body.operation !== 'preview' && body.operation !== 'save') ||
    Object.keys(body).some(
      (key) => !['operation', 'retain_versions', 'snapshot'].includes(key),
    ) ||
    (body.snapshot !== undefined && typeof body.snapshot !== 'string')
  ) {
    return errorResponse(
      'validation-failed',
      'Invalid retention settings.',
      400,
    )
  }
  const proposed = parsed.data.retain_versions
  return withDb(async (db) => {
    const preview = await previewRetention(db, id.data.id, user.id, proposed)
    if (!preview)
      return errorResponse('forbidden', 'Owner access required.', 403)
    const response = (value: unknown, status = 200) =>
      Response.json(value, {
        status,
        headers: { 'Cache-Control': 'private, no-store' },
      })
    if (body.operation === 'preview')
      return response({ kind: 'preview', ...preview })
    if (
      (preview.count > 0 && body.snapshot !== preview.snapshot) ||
      (body.snapshot !== undefined && body.snapshot !== preview.snapshot)
    ) {
      return response({ kind: 'preview', ...preview }, 409)
    }
    const result = await saveRetention(
      db,
      id.data.id,
      user.id,
      proposed,
      preview.snapshot,
    )
    if (result) return response({ kind: 'saved', ...result })
    const fresh = await previewRetention(db, id.data.id, user.id, proposed)
    return fresh
      ? response({ kind: 'preview', ...fresh }, 409)
      : errorResponse('forbidden', 'Owner access required.', 403)
  })
}
