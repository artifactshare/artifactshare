import { requireUserApiMiddleware } from '~/middleware/auth'
import { requireUser } from '~/middleware/context'
import { createDb } from '~/services/db.server'
import {
  availableVisibilitiesFor,
  defaultVisibilityFor,
} from '~/lib/shareable-types'
import {
  loadWorkspaceLinkPolicy,
  canUseLinkSharing,
  checkAnonymousLinkAccess,
} from '~/services/link-sharing.server'
import { listGrants } from '~/services/shareables.server'
import { isOrgWorkspace } from '~/lib/user'
import type { Route } from './+types/api.artifacts.$id.sharing-context'
export const middleware = [requireUserApiMiddleware]
export async function loader({ params, context }: Route.LoaderArgs) {
  const user = requireUser(context)
  const db = createDb()
  const s = await db
    .selectFrom('shareables')
    .select([
      'id',
      'owner_user_id',
      'visibility',
      'workspace_id',
      'link_expires_at',
      'container_id',
    ])
    .where('id', '=', params.id)
    .where('owner_user_id', '=', user.id)
    .executeTakeFirst()
  if (!s) throw new Response('Not found', { status: 404 })
  const [c, policy, grants, linkAccess] = await Promise.all([
    db
      .selectFrom('artifact_containers')
      .select(['kind', 'base_visibility'])
      .where('id', '=', s.container_id)
      .executeTakeFirst(),
    loadWorkspaceLinkPolicy(db, s.workspace_id),
    listGrants(db, user, s.id),
    s.visibility === 'link' ? checkAnonymousLinkAccess(db, s.id) : null,
  ])
  return Response.json({
    defaultVisibility: defaultVisibilityFor(
      isOrgWorkspace(user),
      c?.kind === 'project' ? 'project' : 'inbox',
    ),
    visibility: s.visibility,
    availableVisibilities: availableVisibilitiesFor(
      isOrgWorkspace(user),
      c?.kind === 'project' ? 'project' : 'inbox',
    ),
    grants: grants.kind === 'ok' ? grants.grants : [],
    projectBaseVisibility: c?.kind === 'project' ? c.base_visibility : null,
    linkExpired: linkAccess?.kind === 'expired',
    workspaceHd: user.hd,
    linkSharingAvailable: policy ? canUseLinkSharing(policy) : false,
    linkExpiresAt: s.link_expires_at,
    linkExpiryDefaultDays: policy?.linkExpiryDefaultDays ?? null,
    linkExpiryMaxDays: policy?.linkExpiryMaxDays ?? null,
  })
}
