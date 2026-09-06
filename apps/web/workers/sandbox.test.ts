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
      new Request('https://abc123def4.sandbox.localhost:5174/'),
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
