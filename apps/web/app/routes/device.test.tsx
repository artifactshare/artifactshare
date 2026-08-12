// @vitest-environment happy-dom

import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import Device, { verifyStateFrom } from './device'

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({ locale: 'en', t: (key: string) => key }),
}))
vi.mock('~/services/cli-device-authority.server', () => ({
  loadAgentApprovalContext: vi.fn(),
}))
vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useSearchParams: () => [deviceParams],
}))

let deviceParams = new URLSearchParams()
vi.mock('~/components/app/public-footer', () => ({
  PublicFooter: ({ variant }: { variant?: string }) => (
    <footer data-slot="public-footer" data-variant={variant} />
  ),
}))
vi.mock('~/lib/auth-client', () => ({
  deviceApprove: vi.fn(),
  deviceDeny: vi.fn(),
  deviceVerify: vi.fn(),
  signInToCurrentPage: vi.fn(),
}))
vi.mock('~/components/app/consent-panel', () => ({
  ConsentActions: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ConsentErrorAlert: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  ConsentStatusText: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
}))
vi.mock('~/components/app/focused-flow-brand', () => ({
  FocusedFlowBrand: () => <a href="/">Artifact Share</a>,
}))
vi.mock('~/components/app/landing-shell', () => ({
  LandingHero: ({ children }: { children: ReactNode }) => (
    <main>{children}</main>
  ),
  LandingShell: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}))
vi.mock('~/components/layout/inline', () => ({
  Inline: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('~/components/layout/stack', () => ({
  Stack: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock('~/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
  }: {
    children: ReactNode
    onClick?: () => void
  }) => <button onClick={onClick}>{children}</button>,
}))
vi.mock('~/components/ui/field', () => ({
  Field: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  FieldLabel: ({ children }: { children: ReactNode }) => (
    <label>{children}</label>
  ),
}))
vi.mock('~/components/ui/input', () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />,
}))

describe('/device', () => {
  let deviceVerifyMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    deviceParams = new URLSearchParams()
    const authClient = await import('~/lib/auth-client')
    deviceVerifyMock = vi.mocked(authClient.deviceVerify)
    deviceVerifyMock.mockReset()
    vi.mocked(authClient.deviceApprove).mockReset()
    vi.mocked(authClient.deviceDeny).mockReset()
    vi.mocked(authClient.signInToCurrentPage).mockReset()
    document.body.innerHTML = ''
  })

  test.each([
    [
      { data: { status: 'pending' } },
      { kind: 'ready', code: 'AB12CD34', notice: false },
    ],
    [
      { data: { status: 'approved' } },
      { kind: 'done', code: 'AB12CD34', decision: 'approved' },
    ],
    [
      { data: { status: 'denied' } },
      { kind: 'done', code: 'AB12CD34', decision: 'denied' },
    ],
    [{ error: { status: 410 } }, { kind: 'expired', code: 'AB12CD34' }],
    [{ error: { status: 404 } }, { kind: 'not_found', code: 'AB12CD34' }],
    [{ data: { status: 'used' } }, { kind: 'already', code: 'AB12CD34' }],
    [{ error: { status: 400 } }, { kind: 'invalid', code: 'AB12CD34' }],
  ])('maps verify response %s to a fail-closed state', (response, expected) => {
    expect(verifyStateFrom(response, 'AB12CD34')).toEqual(expected)
  })

  test('unauthenticated branch renders the minimal public footer', () => {
    const html = renderToStaticMarkup(
      <Device
        {...({ loaderData: { signedIn: false } } as Parameters<
          typeof Device
        >[0])}
      />,
    )
    expect(html).toContain('data-slot="public-footer" data-variant="minimal"')
    expect(html).toContain('<h1')
    expect(html).toContain('device.preauth.title</h1>')
  })

  test('signed-in approval branch renders the minimal public footer', () => {
    const html = renderToStaticMarkup(
      <Device
        {...({ loaderData: { signedIn: true } } as Parameters<
          typeof Device
        >[0])}
      />,
    )
    expect(html).toContain('data-slot="public-footer" data-variant="minimal"')
    expect(html).toContain('<h1')
    expect(html).toContain('device.title</h1>')
  })

  test('verifies a manually entered complete code when signed in', async () => {
    deviceVerifyMock.mockResolvedValue({ data: { status: 'pending' } })
    const container = document.createElement('div')
    const root = createRoot(container)

    await React.act(async () =>
      root.render(
        <Device
          {...({ loaderData: { signedIn: true } } as Parameters<
            typeof Device
          >[0])}
        />,
      ),
    )
    const input = container.querySelector('input')!
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )!.set!.call(input, 'ab12-cd34')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await React.act(async () => {})

    expect(deviceVerifyMock).toHaveBeenCalledWith('AB12CD34')
    await React.act(async () => root.unmount())
  })

  test.each(['', 'AB12CD3'])(
    'does not verify incomplete code: %s',
    async (code) => {
      const container = document.createElement('div')
      const root = createRoot(container)
      await React.act(async () =>
        root.render(
          <Device
            {...({ loaderData: { signedIn: true } } as Parameters<
              typeof Device
            >[0])}
          />,
        ),
      )
      const input = container.querySelector('input')!
      await React.act(async () => {
        const setter = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          'value',
        )!.set!
        setter.call(input, code)
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await React.act(async () => {})
      expect(deviceVerifyMock).not.toHaveBeenCalled()
      await React.act(async () => root.unmount())
    },
  )

  test('verifies a complete code from the query as before', async () => {
    deviceParams = new URLSearchParams('user_code=ab12-cd34')
    deviceVerifyMock.mockResolvedValue({ data: { status: 'pending' } })
    const container = document.createElement('div')
    const root = createRoot(container)
    await React.act(async () =>
      root.render(
        <Device
          {...({ loaderData: { signedIn: true } } as Parameters<
            typeof Device
          >[0])}
        />,
      ),
    )
    await React.act(async () => {})
    expect(deviceVerifyMock).toHaveBeenCalledWith('AB12CD34')
    await React.act(async () => root.unmount())
  })

  test('syncs the displayed and verified code when the query code changes', async () => {
    deviceParams = new URLSearchParams('user_code=ab12-cd34')
    deviceVerifyMock.mockResolvedValue({ data: { status: 'pending' } })
    const container = document.createElement('div')
    const root = createRoot(container)
    await React.act(async () =>
      root.render(
        <Device
          {...({ loaderData: { signedIn: true } } as Parameters<
            typeof Device
          >[0])}
        />,
      ),
    )
    deviceParams = new URLSearchParams('user_code=ef56-gh78')
    await React.act(async () =>
      root.render(
        <Device
          {...({ loaderData: { signedIn: true } } as Parameters<
            typeof Device
          >[0])}
        />,
      ),
    )
    await React.act(async () => {})

    expect(container.querySelector('input')?.value).toBe('EF56-GH78')
    expect(deviceVerifyMock).toHaveBeenLastCalledWith('EF56GH78')
    await React.act(async () => root.unmount())
  })

  test('does not decide the new query code before its verification completes', async () => {
    deviceParams = new URLSearchParams('user_code=ab12-cd34')
    let resolveNextVerification!: (response: {
      data: { status: string }
    }) => void
    const nextVerification = new Promise<{ data: { status: string } }>(
      (resolve) => {
        resolveNextVerification = resolve
      },
    )
    deviceVerifyMock
      .mockResolvedValueOnce({ data: { status: 'pending' } })
      .mockReturnValueOnce(nextVerification)
    const authClient = await import('~/lib/auth-client')
    const deviceApproveMock = vi.mocked(authClient.deviceApprove)
    const deviceDenyMock = vi.mocked(authClient.deviceDeny)
    const container = document.createElement('div')
    const root = createRoot(container)
    let changeCode!: () => void

    function QueryChangeHarness() {
      const [changed, setChanged] = React.useState(false)
      changeCode = () => {
        deviceParams = new URLSearchParams('user_code=ef56-gh78')
        setChanged(true)
      }
      React.useLayoutEffect(() => {
        if (!changed) return
        for (const button of container.querySelectorAll('button')) {
          button.click()
        }
      }, [changed])
      return (
        <Device
          {...({ loaderData: { signedIn: true } } as Parameters<
            typeof Device
          >[0])}
        />
      )
    }

    await React.act(async () => root.render(<QueryChangeHarness />))
    await React.act(async () => {})
    expect(container.textContent).toContain('device.approve')
    deviceApproveMock.mockClear()
    deviceDenyMock.mockClear()

    await React.act(async () => changeCode())

    expect(deviceApproveMock).not.toHaveBeenCalled()
    expect(deviceDenyMock).not.toHaveBeenCalled()
    expect(container.querySelector('input')?.value).toBe('EF56-GH78')
    expect(deviceVerifyMock).toHaveBeenLastCalledWith('EF56GH78')

    resolveNextVerification({ data: { status: 'pending' } })
    await React.act(async () => {})
    await React.act(async () => root.unmount())
  })

  test('does not restore a ready state from an old verification result', async () => {
    deviceParams = new URLSearchParams('user_code=ab12-cd34')
    let resolveOldVerification!: (response: {
      data: { status: string }
    }) => void
    let resolveCurrentVerification!: (response: {
      data: { status: string }
    }) => void
    const oldVerification = new Promise<{ data: { status: string } }>(
      (resolve) => {
        resolveOldVerification = resolve
      },
    )
    const currentVerification = new Promise<{ data: { status: string } }>(
      (resolve) => {
        resolveCurrentVerification = resolve
      },
    )
    deviceVerifyMock
      .mockReturnValueOnce(oldVerification)
      .mockReturnValueOnce(currentVerification)
    const container = document.createElement('div')
    const root = createRoot(container)

    await React.act(async () =>
      root.render(
        <Device
          {...({ loaderData: { signedIn: true } } as Parameters<
            typeof Device
          >[0])}
        />,
      ),
    )
    expect(container.textContent).not.toContain('device.approve')

    deviceParams = new URLSearchParams('user_code=ef56-gh78')
    await React.act(async () =>
      root.render(
        <Device
          {...({ loaderData: { signedIn: true } } as Parameters<
            typeof Device
          >[0])}
        />,
      ),
    )
    resolveOldVerification({ data: { status: 'pending' } })
    await React.act(async () => {})
    expect(container.textContent).not.toContain('device.approve')

    resolveCurrentVerification({ data: { status: 'pending' } })
    await React.act(async () => {})
    expect(container.textContent).toContain('device.approve')
    await React.act(async () => root.unmount())
  })

  test('query removal returns to idle while editing and shows missing only when empty', async () => {
    deviceParams = new URLSearchParams('user_code=ab12-cd34')
    deviceVerifyMock.mockResolvedValue({ data: { status: 'pending' } })
    const container = document.createElement('div')
    const root = createRoot(container)
    await React.act(async () =>
      root.render(
        <Device
          {...({ loaderData: { signedIn: true } } as Parameters<
            typeof Device
          >[0])}
        />,
      ),
    )
    deviceParams = new URLSearchParams()
    await React.act(async () =>
      root.render(
        <Device
          {...({ loaderData: { signedIn: true } } as Parameters<
            typeof Device
          >[0])}
        />,
      ),
    )
    const input = container.querySelector('input')!
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!
    await React.act(async () => {
      setter.call(input, 'AB12')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.textContent).not.toContain('device.missing.title')
    await React.act(async () => {
      setter.call(input, '')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(container.textContent).toContain('device.missing.title')
    await React.act(async () => root.unmount())
  })

  test('does not apply a stale approval result after the query code changes', async () => {
    deviceParams = new URLSearchParams('user_code=ab12-cd34')
    deviceVerifyMock.mockResolvedValue({ data: { status: 'pending' } })
    const authClient = await import('~/lib/auth-client')
    const deviceApproveMock = vi.mocked(authClient.deviceApprove)
    let resolveApproval!: (response: { data: { status: string } }) => void
    const approval = new Promise<{ data: { status: string } }>((resolve) => {
      resolveApproval = resolve
    })
    deviceApproveMock.mockReturnValue(approval)
    const container = document.createElement('div')
    const root = createRoot(container)

    await React.act(async () =>
      root.render(
        <Device
          {...({ loaderData: { signedIn: true } } as Parameters<
            typeof Device
          >[0])}
        />,
      ),
    )
    await React.act(async () => {})
    expect(container.textContent).toContain('device.approve')

    await React.act(async () => {
      container.querySelector('button')?.click()
    })
    deviceParams = new URLSearchParams('user_code=ef56-gh78')
    await React.act(async () =>
      root.render(
        <Device
          {...({ loaderData: { signedIn: true } } as Parameters<
            typeof Device
          >[0])}
        />,
      ),
    )
    await React.act(async () => {})

    resolveApproval({ data: { status: 'approved' } })
    await React.act(async () => {})

    expect(container.querySelector('input')?.value).toBe('EF56-GH78')
    expect(container.querySelectorAll('button')).toHaveLength(2)
    expect(
      Array.from(container.querySelectorAll('p')).map(
        (node) => node.textContent,
      ),
    ).not.toContain('device.approved')
    await React.act(async () => root.unmount())
  })

  test('does not apply stale denial status or sign-in after the query code changes', async () => {
    deviceParams = new URLSearchParams('user_code=ab12-cd34')
    deviceVerifyMock.mockResolvedValue({ data: { status: 'pending' } })
    const authClient = await import('~/lib/auth-client')
    const deviceDenyMock = vi.mocked(authClient.deviceDeny)
    const signInMock = vi.mocked(authClient.signInToCurrentPage)
    let resolveDenial!: (response: { error: { status: number } }) => void
    const denial = new Promise<{ error: { status: number } }>((resolve) => {
      resolveDenial = resolve
    })
    deviceDenyMock.mockReturnValue(denial)
    const container = document.createElement('div')
    const root = createRoot(container)

    await React.act(async () =>
      root.render(
        <Device
          {...({ loaderData: { signedIn: true } } as Parameters<
            typeof Device
          >[0])}
        />,
      ),
    )
    await React.act(async () => {})

    await React.act(async () => {
      container.querySelectorAll('button')[1]?.click()
    })
    deviceParams = new URLSearchParams('user_code=ef56-gh78')
    await React.act(async () =>
      root.render(
        <Device
          {...({ loaderData: { signedIn: true } } as Parameters<
            typeof Device
          >[0])}
        />,
      ),
    )
    await React.act(async () => {})

    resolveDenial({ error: { status: 401 } })
    await React.act(async () => {})

    expect(container.querySelector('input')?.value).toBe('EF56-GH78')
    expect(container.textContent).toContain('device.approve')
    expect(container.textContent).not.toContain('device.already_handled')
    expect(signInMock).not.toHaveBeenCalled()
    await React.act(async () => root.unmount())
  })

  test('does not apply a stale denial failure after the query code changes', async () => {
    deviceParams = new URLSearchParams('user_code=ab12-cd34')
    deviceVerifyMock.mockResolvedValue({ data: { status: 'pending' } })
    const authClient = await import('~/lib/auth-client')
    const deviceDenyMock = vi.mocked(authClient.deviceDeny)
    let rejectDenial!: (error: Error) => void
    const denial = new Promise<never>((_, reject) => {
      rejectDenial = reject
    })
    deviceDenyMock.mockReturnValue(denial)
    const container = document.createElement('div')
    const root = createRoot(container)

    await React.act(async () =>
      root.render(
        <Device
          {...({ loaderData: { signedIn: true } } as Parameters<
            typeof Device
          >[0])}
        />,
      ),
    )
    await React.act(async () => {})

    await React.act(async () => {
      container.querySelectorAll('button')[1]?.click()
    })
    deviceParams = new URLSearchParams('user_code=ef56-gh78')
    await React.act(async () =>
      root.render(
        <Device
          {...({ loaderData: { signedIn: true } } as Parameters<
            typeof Device
          >[0])}
        />,
      ),
    )
    await React.act(async () => {})

    rejectDenial(new Error('network failure'))
    await React.act(async () => {})

    expect(container.querySelector('input')?.value).toBe('EF56-GH78')
    expect(container.querySelectorAll('button')).toHaveLength(2)
    expect(container.textContent).not.toContain('device.retry')
    await React.act(async () => root.unmount())
  })
})
