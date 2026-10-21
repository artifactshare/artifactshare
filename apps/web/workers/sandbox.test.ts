import { beforeEach, describe, expect, test, vi } from 'vitest'

const sandboxHandlerMock = vi.hoisted(() => vi.fn())

vi.mock('./bundle-sandbox', () => ({
  handleArtifactSandboxRequest: sandboxHandlerMock,
  sandboxNotFoundResponse: () => new Response('Not found', { status: 404 }),
}))

import app from './sandbox'

describe('sandbox worker', () => {
  const env = { APP_ENV: 'development' } as unknown as Env

  beforeEach(() => {
    sandboxHandlerMock.mockReset()
  })

  test('routes artifact sandbox subdomains to the sandbox handler', async () => {
    sandboxHandlerMock.mockResolvedValue(new Response('sandbox'))

    const response = await app.fetch(
      new Request('https://a-abc123def4--v-7631.usercontent.localhost:5174/'),
      env,
      {} as ExecutionContext,
    )

    expect(await response.text()).toBe('sandbox')
    expect(sandboxHandlerMock).toHaveBeenCalled()
  })

  test('rejects the bare sandbox host', async () => {
    const response = await app.fetch(
      new Request('https://sandbox.localhost:5174/'),
      env,
      {} as ExecutionContext,
    )

    expect(response.status).toBe(404)
    expect(sandboxHandlerMock).not.toHaveBeenCalled()
  })
})

test.each([
  'abc123def4--v-7631.sandbox.artifactshare.com',
  'abc123def4--v-7631.artifactshare.link',
  'artifactshareusercontent.com',
  'abc123def4.artifactshareusercontent.com',
  'a-abc123def4--v-ff.artifactshareusercontent.com',
])('refuses every content surface on %s', async (host) => {
  sandboxHandlerMock.mockClear()
  for (const path of [
    '/',
    '/style.css',
    '/download',
    '/__artifactshare_probe',
  ]) {
    const response = await app.fetch(
      new Request(`https://${host}${path}?t=old`, {
        headers: { Cookie: 'as_bnd=old' },
      }),
      { APP_ENV: 'production' } as Env,
    )
    expect(response.status).toBe(404)
    expect(response.headers.has('X-ArtifactShare-Sandbox-Probe')).toBe(false)
  }
  expect(sandboxHandlerMock).not.toHaveBeenCalled()
})

test.each(['a', 'l'])('dispatches the new %s execution kind', async (kind) => {
  sandboxHandlerMock.mockResolvedValue(new Response('new content'))
  const response = await app.fetch(
    new Request(
      `https://${kind}-abc123def4--v-7631.artifactshareusercontent.com/`,
    ),
    { APP_ENV: 'production' } as Env,
  )
  expect(await response.text()).toBe('new content')
})
