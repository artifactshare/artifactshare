import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactNode } from 'react'
import { MemoryRouter } from 'react-router'
import { describe, expect, test, vi } from 'vitest'
import { Topbar } from './topbar'

vi.mock('~/hooks/use-t', () => ({ useT: () => ({ t: (key: string) => key }) }))
vi.mock('~/components/app/app-topbar', () => ({
  AppTopbar: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TopbarBrand: () => <div />,
}))
vi.mock('~/components/app/avatar-menu', () => ({ AvatarMenu: () => <div /> }))
vi.mock('~/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock('~/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuItem: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => (
    <>{children}</>
  ),
}))

const user = {
  id: 'u1',
  email: 'u1@example.com',
  name: 'User',
  image: null,
  initial: 'U',
}

describe('Topbar navigation', () => {
  const joinedProjects = [{ id: 'p1', name: 'P1', newCount: 0 }]

  test('uses the agreed primary order', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/']}>
        <Topbar workspaceName="Workspace" user={user} />
      </MemoryRouter>,
    )
    const home = html.indexOf('href="/"')
    const recent = html.indexOf('href="/recent"')
    const files = html.indexOf('href="/files"')
    const projects = html.indexOf('href="/projects"')
    expect(home).toBeGreaterThanOrEqual(0)
    expect(home).toBeLessThan(recent)
    expect(recent).toBeLessThan(files)
    expect(files).toBeLessThan(projects)
  })

  test.each([
    ['/', 'tb.home'],
    ['/recent', 'tb.recent'],
    ['/files', 'home.myFiles'],
  ])('%s marks only %s current', (pathname, label) => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[pathname]}>
        <Topbar workspaceName="Workspace" user={user} />
      </MemoryRouter>,
    )
    expect(html).toMatch(
      new RegExp(
        `aria-label="${label.replace('.', '\\.')}"[^>]*aria-current="page"`,
      ),
    )
    expect(html.match(/aria-current="page"/g)).toHaveLength(1)
  })

  test('settings keeps all items without a false current section', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/settings/general']}>
        <Topbar workspaceName="Workspace" user={user} />
      </MemoryRouter>,
    )
    expect(html).toContain('href="/recent"')
    expect(html).toContain('href="/files"')
    expect(html).toContain('href="/projects"')
    const primaryNav = html.match(/<nav[^>]*>[\s\S]*?<\/nav>/)?.[0]
    expect(primaryNav).not.toContain('aria-current="page"')
  })

  test.each(['/projects'])('project root current: %s', (pathname) => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[pathname]}>
        <Topbar
          workspaceName="Workspace"
          user={user}
          joinedProjects={joinedProjects}
        />
      </MemoryRouter>,
    )
    expect(html).toMatch(/aria-label="tb\.projects"[^>]*aria-current="page"/)
  })

  test('joined projects trigger keeps responsive hiding and button focus styles', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/projects']}>
        <Topbar
          workspaceName="Workspace"
          user={user}
          joinedProjects={joinedProjects}
        />
      </MemoryRouter>,
    )
    const trigger = html.match(
      /<button[^>]*aria-label="tb\.projects"[^>]*>/,
    )?.[0]
    expect(trigger).toContain('max-nav:hidden')
    expect(trigger).toContain('cursor-pointer')
    expect(trigger).toContain('focus-visible:ring-3')
    expect(trigger).toContain('aria-expanded:bg-transparent')
    expect(trigger).toContain('hover:aria-expanded:bg-accent')
    expect(trigger).toContain('aria-current="page"')
  })

  test.each(['/projects/p1'])('project detail current: %s', (pathname) => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[pathname]}>
        <Topbar
          workspaceName="Workspace"
          user={user}
          joinedProjects={joinedProjects}
        />
      </MemoryRouter>,
    )
    expect(html).toMatch(/aria-label="tb\.projects"[^>]*aria-current="page"/)
  })

  test.each(['/projects/p1/files', '/projects/p1/activity'])(
    'files/activity subpage current: %s',
    (pathname) => {
      const html = renderToStaticMarkup(
        <MemoryRouter initialEntries={[pathname]}>
          <Topbar
            workspaceName="Workspace"
            user={user}
            joinedProjects={joinedProjects}
          />
        </MemoryRouter>,
      )
      expect(html).toMatch(/aria-label="tb\.projects"[^>]*aria-current="page"/)
    },
  )

  test('zero joined projects keeps the direct projects link', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <Topbar workspaceName="Workspace" user={user} joinedProjects={[]} />
      </MemoryRouter>,
    )
    expect(html).toContain('href="/projects"')
    expect(html).not.toContain('aria-haspopup="menu"')
  })

  test('dropdown items are preserved', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/projects']}>
        <Topbar
          workspaceName="Workspace"
          user={user}
          joinedProjects={joinedProjects}
        />
      </MemoryRouter>,
    )
    expect(html).toContain('href="/projects/p1"')
    expect(html).toContain('home.allProjects')
  })
})

describe('Topbar nav is text-only on PC', () => {
  test('primary nav links carry no icons', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/']}>
        <Topbar workspaceName="Workspace" user={user} />
      </MemoryRouter>,
    )
    expect(html).not.toContain('tabler-icon-home')
    expect(html).not.toContain('tabler-icon-files')
    expect(html).not.toContain('tabler-icon-history')
    expect(html).not.toContain('tabler-icon-stack-2')
  })

  test('dropdown trigger keeps only the chevron', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/']}>
        <Topbar
          workspaceName="Workspace"
          user={user}
          joinedProjects={[{ id: 'p1', name: 'P1', newCount: 0 }]}
        />
      </MemoryRouter>,
    )
    const trigger = html.match(
      /<button[^>]*aria-label="tb\.projects"[^>]*>([\s\S]*?)<\/button>/,
    )?.[0]
    expect(trigger).toContain('tabler-icon-chevron-down')
    expect(trigger).not.toContain('tabler-icon-stack-2')
  })
})
