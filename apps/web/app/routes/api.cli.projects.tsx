import { env } from 'cloudflare:workers'
import { requireUserApiWithBearerMiddleware } from '~/middleware/auth'
import { getCliAuthority, requireUser } from '~/middleware/context'
import { errorResponse } from '~/lib/api-errors'
import { uploadPermissionFailureResponse } from '~/lib/upload-permission-response.server'
import { withDb } from '~/services/db.server'
import {
  createProjectContainer,
  listWorkspaceProjects,
  normalizeProjectDescription,
  normalizeProjectName,
  parseProjectBaseVisibility,
} from '~/services/projects.server'
import { checkUploadAccess } from '~/services/upload-access.server'
import { buildUpgradeRequest } from '~/services/upgrade-request.server'
import type { Route } from './+types/api.cli.projects'

export const middleware = [requireUserApiWithBearerMiddleware]

export async function loader({ context }: Route.LoaderArgs) {
  const user = requireUser(context)
  const authority = getCliAuthority(context)
  if (authority?.kind === 'agent') {
    return Response.json({
      projects: [
        {
          id: authority.projectId,
          name: authority.projectNameSnapshot,
          description: null,
          base_visibility: 'restricted',
          file_count: null,
          updated_at: null,
        },
      ],
    })
  }
  // In-workspace projects only, unpaginated — same scope and reasoning as the
  // MCP list_projects tool: projects are a small curated set, and the token
  // must not reach outside its own workspace.
  const projects = await withDb(
    async (db) => await listWorkspaceProjects(db, user.workspaceId, user),
  )
  return Response.json({
    projects: projects.map((project) => ({
      id: project.id,
      name: project.name,
      description: project.description,
      base_visibility: project.baseVisibility,
      file_count: project.fileCount,
      updated_at: project.updatedAt,
    })),
  })
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }
  const user = requireUser(context)
  const body = (await request.json().catch(() => null)) as {
    name?: unknown
    description?: unknown
    base_visibility?: unknown
  } | null

  const name = normalizeProjectName(body?.name)
  if (!name) {
    return errorResponse('validation-failed', 'Project name is required.', 400)
  }
  const description = normalizeProjectDescription(body?.description)
  if (
    body?.base_visibility !== undefined &&
    body.base_visibility !== null &&
    body.base_visibility !== 'workspace' &&
    body.base_visibility !== 'private'
  ) {
    return errorResponse(
      'validation-failed',
      'Project visibility must be workspace or private.',
      400,
    )
  }
  const baseVisibility = parseProjectBaseVisibility(body?.base_visibility)

  const permission = await checkUploadAccess(user)
  if (permission.kind !== 'allowed') {
    return uploadPermissionFailureResponse(permission)
  }

  const result = await withDb(async (db) => {
    const created = await createProjectContainer(
      db,
      user.workspaceId,
      user.id,
      {
        name,
        description,
        baseVisibility,
      },
    )
    if (created.kind === 'project-limit-reached') {
      return {
        kind: 'project-limit-reached' as const,
        limit: created.limit,
        upgradeRequest:
          created.billingWorkspaceId && created.observedPlan
            ? await buildUpgradeRequest({
                db,
                actor: {
                  id: user.id,
                  workspaceId: user.workspaceId,
                  kind: user.kind,
                },
                billingWorkspaceId: created.billingWorkspaceId,
                limitType: 'projects',
                observedPlan: created.observedPlan,
                locale:
                  user.kind === 'bot' || user.locale !== 'ja' ? 'en' : 'ja',
                appBaseUrl: env.BETTER_AUTH_URL,
              })
            : null,
      }
    }
    if (created.kind === 'project-name-conflict') {
      return { kind: 'project-name-conflict' as const }
    }
    return { kind: 'created' as const, id: created.id }
  })
  if (result.kind === 'project-name-conflict') {
    return errorResponse(
      'project-name-conflict',
      'An active project with this name already exists.',
      409,
    )
  }
  if (result.kind === 'project-limit-reached') {
    return errorResponse(
      'project-limit-reached',
      `You've reached your plan's project limit (${result.limit} projects). Upgrade your plan or archive existing projects. See /settings/billing for upgrade options.`,
      403,
      result.upgradeRequest
        ? {
            details: { upgrade_request: result.upgradeRequest },
            headers: { 'Cache-Control': 'private, no-store' },
          }
        : undefined,
    )
  }

  return Response.json({
    project: {
      id: result.id,
      name,
      description,
      base_visibility: baseVisibility,
    },
  })
}
