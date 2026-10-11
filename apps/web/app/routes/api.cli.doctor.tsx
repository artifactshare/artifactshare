import { cliScopeDeniedResponse } from '~/lib/cli-agent-operations'
import { cliReadAuthority } from '~/lib/cli-authority-policy'
import { CLI_DOCTOR_RESPONSE_SCHEMA } from '@artifactshare/contract'
import { requireUserApiWithBearerMiddleware } from '~/middleware/auth'
import { getCliAuthority, requireUser } from '~/middleware/context'
import { checkUploadAccess } from '~/services/upload-access.server'
import type { Route } from './+types/api.cli.doctor'

export const middleware = [requireUserApiWithBearerMiddleware]

export async function loader({ context }: Route.LoaderArgs) {
  const user = requireUser(context)
  const resolved = getCliAuthority(context)
  const publisher =
    resolved?.kind === 'publisher' ||
    (resolved?.kind === 'bootstrap' && resolved.preset === 'publisher')
      ? resolved
      : null
  const authority = publisher ? null : cliReadAuthority(resolved)
  if (authority === 'denied') return cliScopeDeniedResponse()
  const permission = await checkUploadAccess(user)
  const payload = {
    user: {
      id: user.id,
      email: user.email,
    },
    workspace: {
      id: user.workspaceId,
      hosted_domain: user.hd,
    },
    auth: {
      kind: 'bearer_or_session',
      ok: true,
      authority: publisher
        ? {
            preset: 'publisher',
            project_id: null,
            publisher_client_id: publisher.publisherClientId,
            publisher_client_name: publisher.publisherClientName,
          }
        : authority !== null
          ? {
              preset: 'agent',
              project_id: authority.projectId,
            }
          : { preset: 'unrestricted', project_id: null },
    },
  } as const

  if (permission.kind !== 'allowed') {
    return Response.json(
      CLI_DOCTOR_RESPONSE_SCHEMA.parse({
        ...payload,
        upload: {
          ok: false,
          ...uploadPermissionDiagnostic(),
        },
      }),
    )
  }

  return Response.json(
    CLI_DOCTOR_RESPONSE_SCHEMA.parse({
      ...payload,
      upload: {
        ok: true,
      },
    }),
  )
}

function uploadPermissionDiagnostic() {
  return {
    code: 'self-upload-disabled',
    message: 'Sign in with Google or Microsoft to upload files.',
  }
}
