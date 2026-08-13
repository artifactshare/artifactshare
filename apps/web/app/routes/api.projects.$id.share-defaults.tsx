import { errorResponse } from '~/lib/api-errors'
import { MAX_GRANT_EMAILS } from '~/lib/grant-emails'
import { isExternalPostingEnabledForWorkspace } from '~/lib/project-external-posting.server'
import {
  PROJECT_SHARE_ROLES,
  type ProjectShareRole,
} from '~/lib/shareable-types'
import { requireUserApiMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import {
  canEditProjectContainer,
  getProjectContainerWorkspaceId,
  lookupProjectShareDefaultUsers,
  saveProjectShareDefaults,
} from '~/services/projects.server'
import type { Route } from './+types/api.projects.$id.share-defaults'

export const middleware = [requireUserApiMiddleware]

// 1 リクエストで受け取るメール数の上限。SQLite の bind 変数上限を超える
// `in (...)` を避けるためのガード (個別共有の lookup と同じ 100)。
const MAX_EMAILS_PER_REQUEST = 100

export function loader() {
  return new Response('Method Not Allowed', { status: 405 })
}

export async function action({ request, params, context }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 })
  }

  const user = requireUser(context)

  const body = (await request.json().catch(() => null)) as {
    action?: unknown
    emails?: unknown
    addEmails?: unknown
    addEntries?: unknown
    removeEmails?: unknown
    roleChanges?: unknown
  } | null
  if (!body || typeof body !== 'object') {
    return errorResponse('invalid-save-body', 'Invalid save body.', 400)
  }
  const db = createDb()
  const projectWorkspaceId = await getProjectContainerWorkspaceId(db, params.id)
  if (!projectWorkspaceId) {
    return errorResponse('forbidden', 'Forbidden.', 403)
  }
  const managerRoleEnabled = await isExternalPostingEnabledForWorkspace(
    db,
    projectWorkspaceId,
  )

  if (body.action === 'lookup') {
    const emails = optionalStringArray(body.emails)
    if (!emails || emails.length > MAX_EMAILS_PER_REQUEST) {
      return errorResponse('invalid-lookup-body', 'Invalid lookup body.', 400)
    }
    const result = await lookupProjectShareDefaultUsers(
      db,
      projectWorkspaceId,
      params.id,
      user,
      emails,
      { managerRoleEnabled },
    )
    if (result.kind === 'not-found') {
      return errorResponse('forbidden', 'Forbidden.', 403)
    }
    return Response.json({ entries: result.entries })
  }

  const addEmails = optionalStringArray(body.addEmails)
  const addEntries = optionalRoleEntryArray(body.addEntries)
  const removeEmails = optionalStringArray(body.removeEmails)
  const roleChanges = optionalRoleEntryArray(body.roleChanges)
  if (
    addEmails === null ||
    addEntries === null ||
    removeEmails === null ||
    roleChanges === null
  ) {
    return errorResponse('invalid-save-body', 'Invalid save body.', 400)
  }
  if (
    (addEmails?.length ?? 0) > MAX_EMAILS_PER_REQUEST ||
    (addEntries?.length ?? 0) > MAX_EMAILS_PER_REQUEST ||
    (removeEmails?.length ?? 0) > MAX_EMAILS_PER_REQUEST ||
    (roleChanges?.length ?? 0) > MAX_EMAILS_PER_REQUEST
  ) {
    return errorResponse('invalid-save-body', 'Too many emails.', 400)
  }
  if (
    (addEmails?.length ?? 0) === 0 &&
    (addEntries?.length ?? 0) === 0 &&
    (removeEmails?.length ?? 0) === 0 &&
    (roleChanges?.length ?? 0) === 0
  ) {
    return errorResponse('invalid-save-body', 'No changes to save.', 400)
  }

  // 認可はここで一度だけ確認し、保存サービスはワークスペース内の存在のみ検証する。
  const canEdit = await canEditProjectContainer(
    db,
    projectWorkspaceId,
    params.id,
    user,
    { managerRoleEnabled },
  )
  if (!canEdit) return errorResponse('forbidden', 'Forbidden.', 403)

  const result = await saveProjectShareDefaults(
    db,
    projectWorkspaceId,
    params.id,
    user.id,
    {
      addEmails: addEmails ?? [],
      addEntries: addEntries ?? [],
      removeEmails: removeEmails ?? [],
      roleChanges: roleChanges ?? [],
    },
    user.email,
    { allowNonViewerRoles: managerRoleEnabled },
  )
  switch (result) {
    case 'ok':
      return Response.json({ ok: true })
    case 'not-found':
      return errorResponse('forbidden', 'Forbidden.', 403)
    case 'too-many':
      return errorResponse(
        'too-many-grants',
        `Add up to ${MAX_GRANT_EMAILS} email addresses.`,
        400,
      )
    case 'role-not-allowed':
      return errorResponse(
        'role-not-allowed',
        'Role grants are not enabled.',
        400,
      )
    case 'grant-target-invalid':
      return errorResponse(
        'grant-target-invalid',
        'A grant change did not apply; reload the audience and retry.',
        400,
      )
    case 'bot-stopped-grant-rejected':
      return errorResponse(
        'bot-stopped-grant-rejected',
        'This bot has been stopped and cannot receive grants.',
        400,
      )
    case 'bot-grant-role-invalid':
      return errorResponse(
        'bot-grant-role-invalid',
        'Bots can only be viewers or contributors.',
        400,
      )
    case 'bot-grant-workspace-invalid':
      return errorResponse(
        'bot-grant-workspace-invalid',
        "Bots can only join audiences in their own workspace's projects.",
        400,
      )
  }
}

function optionalStringArray(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return null
  if (value.some((item) => typeof item !== 'string')) return null
  return value
}

function optionalRoleEntryArray(
  value: unknown,
): Array<{ email: string; role: ProjectShareRole }> | undefined | null {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return null
  if (value.length > MAX_EMAILS_PER_REQUEST) return null
  const validRoles = new Set<string>(PROJECT_SHARE_ROLES)
  const entries: Array<{ email: string; role: ProjectShareRole }> = []
  for (const item of value) {
    if (!item || typeof item !== 'object') return null
    const { email, role } = item as { email?: unknown; role?: unknown }
    if (typeof email !== 'string' || typeof role !== 'string') return null
    if (!validRoles.has(role)) return null
    entries.push({ email, role: role as ProjectShareRole })
  }
  return entries
}
