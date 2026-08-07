import { renderToStaticMarkup } from 'react-dom/server'
import type { AnchorHTMLAttributes, ReactNode } from 'react'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { ViewerErrorShell } from './viewer-error-shell'

vi.mock('~/hooks/use-hydrated', () => ({
  useHydrated: () => false,
}))

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    locale: 'en',
    t: (key: string) =>
      ({
        'vw.back': 'Back',
        'vw.homeLink': 'Artifact Share home',
      })[key] ?? key,
    tPlural: (key: string, n: number) => `${n}`,
  }),
}))

let mockLocationState: unknown = null

vi.mock('react-router', () => ({
  Link: ({
    children,
    to,
    replace: _replace,
    viewTransition: _viewTransition,
    state: _state,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    children: ReactNode
    to: string
    replace?: boolean
    viewTransition?: boolean
    state?: unknown
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useLocation: () => ({ state: mockLocationState }),
}))

vi.mock('./avatar-menu', () => ({
  AvatarMenu: () => <button type="button">Account</button>,
}))

vi.mock('./denied-panel', () => ({
  DeniedPanel: () => <div>Denied</div>,
}))

describe('ViewerErrorShell', () => {
  beforeEach(() => {
    mockLocationState = null
  })

  test('without return context shows a named home link and no back link', () => {
    const html = renderToStaticMarkup(
      <ViewerErrorShell
        user={null}
        icon={null}
        title="Access denied"
        body="You do not have access."
        actions={null}
      />,
    )

    expect(html).toContain('href="/"')
    expect(html).toContain('aria-label="Artifact Share home"')
    expect(html).toContain('>Artifact Share<')
    expect(html).not.toContain('aria-label="Back"')
    expect(html).not.toContain('data-regression-region=')
    expect(html.match(/<main\b/g) ?? []).toHaveLength(1)
    expect(html).toContain('class="flex min-h-0 flex-1"')
  })

  test('optionally marks the topbar and main content boundaries', () => {
    const html = renderToStaticMarkup(
      <ViewerErrorShell
        user={null}
        icon={null}
        title="Access denied"
        body="You do not have access."
        actions={null}
        regressionRegions={{ header: 'header', main: 'main' }}
      />,
    )

    expect(html).toContain('<div data-regression-region="header"><header')
    expect(html).toContain(
      '<main class="flex min-h-0 flex-1" data-regression-region="main"><div>Denied</div></main>',
    )
    expect(html.match(/<main\b/g) ?? []).toHaveLength(1)
  })
})
