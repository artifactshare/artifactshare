import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { describe, expect, test, vi } from 'vitest'
import SignIn from './sign-in'

const mocks = vi.hoisted(() => ({
  params: new URLSearchParams(),
  signInOptionsProps: [] as Array<Record<string, unknown>>,
}))

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({ locale: 'en', t: (key: string) => key }),
}))
vi.mock('react-router', () => ({
  useSearchParams: () => [mocks.params],
  useRouteLoaderData: () => ({}),
}))
vi.mock('~/lib/auth-client', () => ({
  sendSignInOtp: vi.fn(),
  signInWithOtp: vi.fn(),
}))
vi.mock('~/components/app/public-footer', () => ({
  PublicFooter: ({ variant }: { variant?: string }) => (
    <footer data-slot="public-footer" data-variant={variant} />
  ),
}))
vi.mock('~/components/app/auth-card', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('~/components/app/auth-card')>()

  return {
    AuthCard: ({
      children,
      footer,
      title,
      sub,
    }: {
      children: ReactNode
      footer: ReactNode
      title: ReactNode
      sub: ReactNode
    }) => (
      <section>
        <h1>{title}</h1>
        <p>{sub}</p>
        {children}
        {footer}
      </section>
    ),
    AuthAlert: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    AuthDivider: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    AuthFootnote: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    AuthFormStack: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
    AuthHint: ({ children }: { children: ReactNode }) => <p>{children}</p>,
    AuthMaintenanceNotice: () => null,
    AuthProviders: actual.AuthProviders,
    AuthLinksRow: ({ children }: { children: ReactNode }) => (
      <div>{children}</div>
    ),
  }
})
vi.mock('~/components/app/sign-in-options', () => ({
  SignInOptions: (props: Record<string, unknown>) => {
    mocks.signInOptionsProps.push(props)
    return <div data-slot="sign-in-options" />
  },
}))
vi.mock('~/components/app/last-used-badge', () => ({
  LastUsedBadge: () => null,
}))
vi.mock('~/components/ui/button', () => ({
  Button: ({ children }: { children: ReactNode }) => (
    <button>{children}</button>
  ),
}))
vi.mock('~/components/ui/field', () => ({
  Field: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  FieldError: () => null,
  FieldLabel: ({ children }: { children: ReactNode }) => (
    <label>{children}</label>
  ),
}))
vi.mock('~/components/ui/input', () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />,
}))

describe('/sign-in', () => {
  test.beforeEach(() => {
    mocks.params = new URLSearchParams()
    mocks.signInOptionsProps = []
  })

  test('renders the minimal public footer', () => {
    const html = renderToStaticMarkup(<SignIn />)
    expect(html).toContain('data-slot="public-footer" data-variant="minimal"')
  })

  test('shows providers first by default', () => {
    const html = renderToStaticMarkup(<SignIn />)
    expect(html).toContain('signin.title')
    expect(html).toContain('signin.email.expand')
    expect(html).not.toContain('placeholder="signin.email.placeholder"')
    expect(html).toMatch(
      /<div class="mt-5"><div data-slot="sign-in-options"><\/div><\/div>/,
    )
  })

  test('shows upload context and preserves it for provider errors', () => {
    mocks.params = new URLSearchParams('intent=upload&next=%2F%3Fupload%3D1')
    const html = renderToStaticMarkup(<SignIn />)
    expect(html).toContain('signin.upload.title')
    expect(mocks.signInOptionsProps).toContainEqual(
      expect.objectContaining({
        callbackURL: '/?upload=1',
        errorCallbackURL: '/sign-in?intent=upload&next=%2F%3Fupload%3D1',
      }),
    )
  })

  test('opens email when it was explicitly selected', () => {
    mocks.params = new URLSearchParams('method=email')
    const html = renderToStaticMarkup(<SignIn />)
    expect(html).toContain('placeholder="signin.email.placeholder"')
    expect(html).toContain('signin.email.collapse')
    expect(mocks.signInOptionsProps).toHaveLength(0)
  })

  test('keeps the existing OAuth error callback behavior', () => {
    mocks.params = new URLSearchParams('client_id=client&sig=signature')
    renderToStaticMarkup(<SignIn />)
    expect(mocks.signInOptionsProps).toContainEqual(
      expect.objectContaining({ errorCallbackURL: undefined }),
    )
  })
})
