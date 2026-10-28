import { isOrgWorkspace } from '~/lib/user'
import { CLI_WHOAMI_RESPONSE_SCHEMA } from '@artifactshare/contract'
import { requireUserApiWithBearerMiddleware } from '~/middleware/auth'
import { getCliAuthority, requireUser } from '~/middleware/context'
import type { Route } from './+types/api.cli.whoami'

export const middleware = [requireUserApiWithBearerMiddleware]

export function loader({ context }: Route.LoaderArgs) {
  const user = requireUser(context)
  const authority = getCliAuthority(context)
  const publisher =
    authority?.kind === 'publisher' ||
    (authority?.kind === 'bootstrap' && authority.preset === 'publisher')
      ? authority
      : null
  return Response.json(
    CLI_WHOAMI_RESPONSE_SCHEMA.parse({
      user: {
        id: user.id,
        email: user.email,
      },
      workspace: {
        id: user.workspaceId,
        hosted_domain: user.hd,
        visibility_available: isOrgWorkspace(user),
      },
      auth: {
        kind: 'bearer_or_session',
        ...(publisher
          ? {
              authority: {
                preset: 'publisher',
                project_id: null,
                publisher_client_id: publisher.publisherClientId,
                publisher_client_name: publisher.publisherClientName,
              },
            }
          : {}),
      },
    }),
  )
}
