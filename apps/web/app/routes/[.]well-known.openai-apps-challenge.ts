import { env } from 'cloudflare:workers'

export function loader() {
  const token = env.OPENAI_APPS_CHALLENGE_TOKEN?.trim()

  if (!token) {
    return new Response(null, { status: 404 })
  }

  return new Response(token, {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
    },
  })
}
