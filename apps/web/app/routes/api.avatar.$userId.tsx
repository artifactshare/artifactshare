import { env } from 'cloudflare:workers'
import type { Route } from './+types/api.avatar.$userId'

export async function loader({ params }: Route.LoaderArgs) {
  const userId = params.userId
  if (!userId) return new Response(null, { status: 404 })

  const key = `avatars/${userId}.jpg`
  const object = await env.BUCKET.get(key)
  if (!object) return new Response(null, { status: 404 })

  return new Response(object.body, {
    headers: {
      'Content-Type': object.httpMetadata?.contentType ?? 'image/jpeg',
      'Cache-Control': 'public, max-age=86400',
    },
  })
}
