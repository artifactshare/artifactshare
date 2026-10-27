import { appFetch, cookieFromHeaders } from '../dev-sign-in.mjs'
import { localOrigin } from './plan.mjs'
export async function localRequest(
  baseUrl,
  path,
  options = {},
  fetcher = appFetch,
) {
  localOrigin(baseUrl)
  const target = new URL(path, baseUrl)
  if (target.origin !== baseUrl)
    throw new Error('Request must stay on the approved local origin')
  const response = await fetcher(baseUrl, target.href, {
    ...options,
    redirect: 'manual',
    signal: AbortSignal.timeout(10000),
  })
  if (response.status >= 300 && response.status < 400)
    throw new Error('Dev app redirects are not allowed')
  if (!response.ok)
    throw new Error(`Dev app request failed: HTTP ${response.status}`)
  const body = await response.json()
  return { response, body }
}
export async function signIn(baseUrl, persona, fetcher) {
  // No screen scenario: sign-in must not reset/seed a walkthrough's existing data.
  const { response, body } = await localRequest(
    baseUrl,
    '/api/auth/dev/sign-in',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ persona }),
    },
    fetcher,
  )
  const token = decodeURIComponent(
    cookieFromHeaders(response.headers)?.value ?? '',
  ).split('.')[0]
  if (!body.userId || !token)
    throw new Error('Dev sign-in returned no CLI-compatible session token')
  return token
}
export function serverClient(baseUrl, token) {
  const request = async (path, method = 'GET') =>
    (
      await localRequest(baseUrl, path, {
        method,
        headers: { authorization: `Bearer ${token}` },
      })
    ).body
  return {
    async list() {
      const artifacts = [],
        cursors = new Set()
      let cursor
      do {
        const page = await request(
          `/api/cli/artifacts${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
        )
        if (!Array.isArray(page.artifacts))
          throw new Error('Invalid artifact list evidence')
        artifacts.push(...page.artifacts)
        cursor = page.has_more ? page.next_cursor : null
        if (page.has_more && (!cursor || cursors.has(cursor)))
          throw new Error('Incomplete artifact pagination')
        cursors.add(cursor)
      } while (cursor)
      return artifacts
    },
    get: (id) =>
      request(`/api/cli/artifacts/${encodeURIComponent(id)}?include=versions`),
    delete: (id) =>
      request(`/api/cli/artifacts/${encodeURIComponent(id)}`, 'DELETE'),
  }
}
