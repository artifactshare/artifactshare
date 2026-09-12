import { requireUserApiWithBearerMiddleware } from '~/middleware/auth'
import { getCliAuthority, requireUser } from '~/middleware/context'
import { checkUploadAccess } from '~/services/upload-access.server'
import type { Route } from './+types/api.cli.doctor'

export const middleware = [requireUserApiWithBearerMiddleware]

export async function loader({ context }: Route.LoaderArgs) {
  const user = requireUser(context)
  const authority = getCliAuthority(context)
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
      authority:
        authority?.kind === 'agent'
          ? {
              preset: 'agent',
              project_id: authority.projectId,
            }
          : { preset: 'unrestricted', project_id: null },
    },
  } as const

  if (permission.kind !== 'allowed') {
    return Response.json({
      ...payload,
      upload: {
        ok: false,
        ...uploadPermissionDiagnostic(),
      },
    })
  }

  return Response.json({
    ...payload,
    upload: {
      ok: true,
    },
  })
}

function uploadPermissionDiagnostic() {
  return {
    code: 'self-upload-disabled',
    message: 'Sign in with Google or Microsoft to upload files.',
  }
}
