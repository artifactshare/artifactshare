import { env } from 'cloudflare:workers'
import { nanoid } from 'nanoid'
import { bodyRecoveryHtml } from '~/lib/body-recovery'
import { signSandboxUrl } from '~/lib/sandbox-token'
import { authorizeSandboxDelivery } from '~/services/sandbox-delivery.server'
import type { Route } from './+types/a.$id.body'

const headers = {
  'Cache-Control': 'private, no-store',
  'Content-Type': 'text/html; charset=utf-8',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy':
    "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
}

export async function loader(args: Route.LoaderArgs) {
  const viewerUrl = `/a/${encodeURIComponent(args.params.id)}`
  const deny = (status: number) =>
    new Response(bodyRecoveryHtml(viewerUrl), { status, headers })
  if (args.request.method !== 'GET') return deny(405)
  if (!new URL(args.request.url).searchParams.get('version')?.trim())
    return deny(400)
  const authorized = await authorizeSandboxDelivery(args, 'body')
  if (!authorized.ok)
    return deny(authorized.status === 401 ? 404 : authorized.status)
  const { shareable, version, renderType, uid, modifiedTime } = authorized
  const location = await signSandboxUrl(
    {
      uid,
      wid: shareable.workspace_id,
      aid: shareable.id,
      vid: version.id,
      fid: version.r2_key,
      mt: modifiedTime,
      t: renderType,
      jti: nanoid(),
      standalone: true,
    },
    env.BETTER_AUTH_SECRET,
    env,
    version.entrypoint_path ?? undefined,
  )
  return new Response(null, {
    status: 302,
    headers: { ...headers, Location: location },
  })
}

export const action = loader
