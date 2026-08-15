import { requireUserApiMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import {
  decodeProjectCandidateCursor,
  isOwnedPendingAgentCode,
  isWorkspaceAdmin,
  listProjectCandidates,
  normalizeProjectCandidateQuery,
  type ProjectCandidatePurpose,
} from '~/services/project-candidates.server'
import type { Route } from './+types/api.project-candidates'

export const middleware = [requireUserApiMiddleware]

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context)
  const params = new URL(request.url).searchParams
  const purpose = params.get('purpose')
  if (purpose !== 'bot-destination' && purpose !== 'agent-approval') {
    return Response.json(
      { error: { code: 'unknown-purpose' } },
      { status: 400 },
    )
  }
  if (purpose === 'bot-destination') {
    if (!(await isWorkspaceAdmin(user))) {
      return Response.json({ error: { code: 'forbidden' } }, { status: 403 })
    }
  } else {
    const userCode = (params.get('user_code') ?? '')
      .replace(/[^A-Za-z0-9]/g, '')
      .toUpperCase()
    if (userCode.length !== 8) {
      return Response.json(
        { error: { code: 'invalid-user-code' } },
        { status: 400 },
      )
    }
    if (!(await isOwnedPendingAgentCode(user, userCode))) {
      return Response.json({ error: { code: 'not-found' } }, { status: 404 })
    }
  }
  const query = normalizeProjectCandidateQuery(params.get('q'))
  const cursor = decodeProjectCandidateCursor(
    params.get('cursor'),
    purpose as ProjectCandidatePurpose,
    query,
  )
  if (cursor === 'invalid') {
    return Response.json({ error: { code: 'invalid-cursor' } }, { status: 400 })
  }
  return Response.json(
    await listProjectCandidates({ user, purpose, query, cursor }),
    { headers: { 'Cache-Control': 'private, no-store' } },
  )
}
