import { env } from 'cloudflare:workers'

export function loader() {
  // Trim so a stray newline pasted into the secret can't break the exact-match
  // domain verification.
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
