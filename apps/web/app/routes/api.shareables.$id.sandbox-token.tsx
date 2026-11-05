import { env } from 'cloudflare:workers'
import { nanoid } from 'nanoid'
import { signSandboxUrl } from '~/lib/sandbox-token'
import { authorizeSandboxDelivery } from '~/services/sandbox-delivery.server'
import type { Route } from './+types/api.shareables.$id.sandbox-token'

const NO_STORE_HEADERS = { 'Cache-Control': 'private, no-store' } as const

export async function loader(args: Route.LoaderArgs) {
  const authorized = await authorizeSandboxDelivery(args, 'refresh')
  if (!authorized.ok)
    return Response.json(
      { error: authorized.error },
      { status: authorized.status, headers: NO_STORE_HEADERS },
    )
  const { shareable, version, renderType: versionRenderType } = authorized
  const sandboxUrl = await signSandboxUrl(
    {
      uid: authorized.uid,
      wid: shareable.workspace_id,
      aid: shareable.id,
      vid: version.id,
      fid: version.r2_key,
      mt: authorized.modifiedTime,
      t: versionRenderType,
      jti: nanoid(),
    },
    env.BETTER_AUTH_SECRET,
    env,
    version.entrypoint_path ?? undefined,
  )

  return Response.json(
    { sandboxUrl, renderType: versionRenderType },
    { headers: NO_STORE_HEADERS },
  )
}
