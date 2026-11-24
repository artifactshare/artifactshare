import { beforeEach, describe, expect, test, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({ env: {} }))

const isViteDevMock = vi.hoisted(() => vi.fn(() => true))
const authHandlerMock = vi.hoisted(() => vi.fn())

vi.mock('~/lib/is-vite-dev', () => ({
  isViteDev: isViteDevMock,
}))

vi.mock('~/services/auth.server', () => ({
  authHandlerWithHangDetection: authHandlerMock,
}))

import { renderToStaticMarkup } from 'react-dom/server'
import {
  createMemoryRouter,
  RouterProvider,
  UNSAFE_withComponentProps,
} from 'react-router'
import DevSignIn, { action, loader } from './dev.sign-in'

beforeEach(() => {
  isViteDevMock.mockReset()
  isViteDevMock.mockReturnValue(true)
  authHandlerMock.mockReset()
})

describe('/dev/sign-in loader', () => {
  test('returns 404 outside Vite dev', () => {
    isViteDevMock.mockReturnValueOnce(false)

    expectThrownResponse(
      () =>
        loader({
          request: new Request('https://artifactshare.test/dev/sign-in'),
        } as never),
      404,
    )
  })

  test('defaults next to AI tools and CLI', async () => {
    isViteDevMock.mockReturnValueOnce(true)

    const result = await loader({
      request: new Request('https://artifactshare.test/dev/sign-in'),
    } as never)

    expect(result).toEqual({
      next: '/settings/tokens',
    })
  })

  test('keeps a safe internal next path', async () => {
    isViteDevMock.mockReturnValueOnce(true)

    const result = await loader({
      request: new Request(
        'https://artifactshare.test/dev/sign-in?next=/projects/p1',
      ),
    } as never)

    expect(result).toEqual({
      next: '/projects/p1',
    })
  })

  test('keeps an explicit Home next path', async () => {
    const result = await loader({
      request: new Request('https://artifactshare.test/dev/sign-in?next=%2F'),
    } as never)

    expect(result.next).toBe('/')
  })

  test('renders one sign-in form per dev persona', async () => {
    const loaderData = await loader({
      request: new Request('https://artifactshare.test/dev/sign-in?next=%2F'),
    } as never)
    const router = createMemoryRouter(
      [
        {
          id: 'dev-sign-in',
          path: '/',
          Component: UNSAFE_withComponentProps(DevSignIn),
        },
      ],
      { hydrationData: { loaderData: { 'dev-sign-in': loaderData } } },
    )
    try {
      const html = renderToStaticMarkup(<RouterProvider router={router} />)
      for (const persona of [
        'free-owner',
        'plus-owner',
        'team-owner',
        'team-member',
      ])
        expect(html).toContain(`name="persona" value="${persona}"`)
      expect(html).not.toContain('name="scenario"')
    } finally {
      router.dispose()
    }
  })

  test('sanitizes an unsafe next path to AI tools and CLI', async () => {
    isViteDevMock.mockReturnValueOnce(true)

    const result = await loader({
      request: new Request(
        'https://artifactshare.test/dev/sign-in?next=//evil.com',
      ),
    } as never)

    expect(result).toEqual({
      next: '/settings/tokens',
    })
  })
})

function expectThrownResponse(fn: () => unknown, status: number) {
  try {
    fn()
  } catch (error) {
    expect(error).toBeInstanceOf(Response)
    expect((error as Response).status).toBe(status)
    return
  }
  throw new Error(`Expected Response ${status}`)
}

describe('/dev/sign-in action', () => {
  test.each(['free-owner', 'plus-owner', 'team-owner', 'team-member'] as const)(
    'passes %s unchanged to the auth endpoint',
    async (persona) => {
      authHandlerMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true })),
      )
      await action({
        request: new Request('https://artifactshare.test/dev/sign-in', {
          method: 'POST',
          body: new URLSearchParams({ persona }),
        }),
      } as never)
      await expect(
        (authHandlerMock.mock.calls[0][0] as Request).json(),
      ).resolves.toEqual({ persona })
    },
  )

  test('returns 404 outside Vite dev', async () => {
    isViteDevMock.mockReturnValueOnce(false)

    await expect(
      action({
        request: new Request('https://artifactshare.test/dev/sign-in', {
          method: 'POST',
          body: new URLSearchParams({ persona: 'team-owner' }),
        }),
      } as never),
    ).rejects.toMatchObject({ status: 404 })
  })

  test('rejects invalid roles', async () => {
    isViteDevMock.mockReturnValueOnce(true)

    await expect(
      action({
        request: new Request('https://artifactshare.test/dev/sign-in', {
          method: 'POST',
          body: new URLSearchParams({ role: 'owner' }),
        }),
      } as never),
    ).rejects.toMatchObject({ status: 400 })
  })

  test('redirects with Set-Cookie from the auth endpoint', async () => {
    isViteDevMock.mockReturnValueOnce(true)
    authHandlerMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'Set-Cookie': 'better-auth.session_token=abc; Path=/; HttpOnly',
        },
      }),
    )

    const response = await action({
      request: new Request('https://artifactshare.test/dev/sign-in', {
        method: 'POST',
        body: new URLSearchParams({ persona: 'team-owner', next: '/settings' }),
      }),
    } as never)

    expect(response.status).toBe(302)
    expect(response.headers.get('Location')).toBe('/settings')
    expect(response.headers.get('Set-Cookie')).toContain(
      'better-auth.session_token=abc',
    )
    expect(authHandlerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://artifactshare.test/api/auth/dev/sign-in',
        method: 'POST',
      }),
    )
    expect(
      (authHandlerMock.mock.calls[0][0] as Request).headers.get('origin'),
    ).toBe('https://artifactshare.test')
    await expect(
      (authHandlerMock.mock.calls[0][0] as Request).json(),
    ).resolves.toEqual({ persona: 'team-owner' })
  })

  test('does not pass stale incoming cookies to the auth endpoint', async () => {
    isViteDevMock.mockReturnValueOnce(true)
    authHandlerMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'Set-Cookie': 'better-auth.session_token=abc; Path=/; HttpOnly',
        },
      }),
    )

    await action({
      request: new Request('https://artifactshare.test/dev/sign-in', {
        method: 'POST',
        headers: { cookie: 'better-auth.session_token=old' },
        body: new URLSearchParams({ persona: 'team-owner', next: '/settings' }),
      }),
    } as never)

    expect(authHandlerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        headers: expect.any(Headers),
      }),
    )
    expect(
      (authHandlerMock.mock.calls[0][0] as Request).headers.get('cookie'),
    ).toBeNull()
  })

  test('passes browser fetch metadata headers to the auth endpoint', async () => {
    isViteDevMock.mockReturnValueOnce(true)
    authHandlerMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'Set-Cookie': 'better-auth.session_token=abc; Path=/; HttpOnly',
        },
      }),
    )

    await action({
      request: new Request('https://artifactshare.test/dev/sign-in', {
        method: 'POST',
        headers: {
          'sec-fetch-site': 'same-origin',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
          'sec-fetch-user': '?1',
        },
        body: new URLSearchParams({ persona: 'team-owner', next: '/settings' }),
      }),
    } as never)

    const authRequest = authHandlerMock.mock.calls[0][0] as Request
    expect(authRequest.headers.get('sec-fetch-site')).toBe('same-origin')
    expect(authRequest.headers.get('sec-fetch-mode')).toBe('navigate')
    expect(authRequest.headers.get('sec-fetch-dest')).toBe('document')
    expect(authRequest.headers.get('sec-fetch-user')).toBe('?1')
  })

  test('redirects to a safe custom next path', async () => {
    isViteDevMock.mockReturnValueOnce(true)
    authHandlerMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'Set-Cookie': 'better-auth.session_token=abc; Path=/; HttpOnly',
        },
      }),
    )

    const response = await action({
      request: new Request('https://artifactshare.test/dev/sign-in', {
        method: 'POST',
        body: new URLSearchParams({
          persona: 'team-member',
          next: '/projects/p1',
        }),
      }),
    } as never)

    expect(response.headers.get('Location')).toBe('/projects/p1')
  })

  test('sanitizes an unsafe posted next path before redirecting', async () => {
    isViteDevMock.mockReturnValueOnce(true)
    authHandlerMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: {
          'Set-Cookie': 'better-auth.session_token=abc; Path=/; HttpOnly',
        },
      }),
    )

    const response = await action({
      request: new Request('https://artifactshare.test/dev/sign-in', {
        method: 'POST',
        body: new URLSearchParams({
          persona: 'team-member',
          next: '//evil.example',
        }),
      }),
    } as never)

    expect(response.headers.get('Location')).toBe('/settings/tokens')
  })
})
