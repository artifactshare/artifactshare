import { env } from 'cloudflare:workers'
import type { Kysely } from 'kysely'
import { errorResponse } from '~/lib/api-errors'
import { getLocale } from '~/lib/i18n.server'
import { requireUserApiMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import { buildUpgradeRequest } from '~/services/upgrade-request.server'
import type { DB } from '~/types/db'
import {
  archiveProjectContainer,
  deleteProjectContainer,
  unarchiveProjectContainer,
  type ProjectArchiveResult,
  type ProjectUnarchiveResult,
} from '~/services/projects.server'
import type { Route } from './+types/api.projects.$id'

export const middleware = [requireUserApiMiddleware]

export async function action({ request, params, context }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }
  const user = requireUser(context)
  const body = (await request.json().catch(() => null)) as {
    action?: unknown
  } | null
  const op = body?.action
  const db = createDb()

  if (op === 'archive') {
    return mapArchiveResult(
      await archiveProjectContainer(db, user.workspaceId, params.id, user.id),
    )
  }
  if (op === 'unarchive') {
    return await mapUnarchiveResult(
      db,
      user,
      getLocale(request, user.locale),
      await unarchiveProjectContainer(db, user.workspaceId, params.id, user.id),
    )
  }
  if (op === 'delete') {
    const result = await deleteProjectContainer(
      db,
      user.workspaceId,
      params.id,
      user.id,
    )
    if (result === 'not-found') {
      return errorResponse('not-found', 'Project not found.', 404)
    }
    if (result === 'forbidden') {
      return errorResponse('forbidden', 'Not allowed.', 403)
    }
    if (result === 'not-empty') {
      return errorResponse('not-empty', 'Project still has files.', 409)
    }
    if (typeof result === 'object') {
      // The holder name is only revealed to callers who may delete the
      // project (creator or workspace admin), which deleteProjectContainer
      // has already verified.
      const holder = result.holderName ?? 'another member'
      return Response.json(
        {
          error: {
            code: 'project-has-agent-credentials',
            message: `Agent CLI credentials held by ${holder} still target this project.`,
            hint: '資格情報の停止・失効を行ってから、もう一度削除してください。',
            recovery: { kind: 'ask_human' },
            details: { holder_name: result.holderName },
          },
        },
        { status: 409 },
      )
    }
    return Response.json({ ok: true })
  }

  return errorResponse('invalid-action', 'Invalid action.', 400)
}

function mapArchiveResult(result: ProjectArchiveResult): Response {
  if (result === 'not-found') {
    return errorResponse('not-found', 'Project not found.', 404)
  }
  if (result === 'forbidden') {
    return errorResponse('forbidden', 'Not allowed.', 403)
  }
  return Response.json({ ok: true })
}

async function mapUnarchiveResult(
  db: Kysely<DB>,
  user: {
    id: string
    workspaceId: string
    kind: 'human' | 'bot'
  },
  locale: 'en' | 'ja',
  result: ProjectUnarchiveResult,
): Promise<Response> {
  if (typeof result === 'object' && result.kind === 'project-name-conflict') {
    return errorResponse(
      'project-name-conflict',
      'An active project with this name already exists.',
      409,
    )
  }
  if (typeof result === 'object') {
    const upgradeRequest =
      result.billingWorkspaceId && result.observedPlan
        ? await buildUpgradeRequest({
            db,
            actor: user,
            billingWorkspaceId: result.billingWorkspaceId,
            limitType: 'projects',
            observedPlan: result.observedPlan,
            locale,
            appBaseUrl: env.BETTER_AUTH_URL,
          })
        : null
    return errorResponse(
      'project-limit-reached',
      `You've reached your plan's project limit (${result.limit} projects). Upgrade your plan or archive existing projects. See /settings/billing for upgrade options.`,
      403,
      upgradeRequest
        ? {
            details: { upgrade_request: upgradeRequest },
            headers: { 'Cache-Control': 'private, no-store' },
          }
        : undefined,
    )
  }
  return mapArchiveResult(result)
}
