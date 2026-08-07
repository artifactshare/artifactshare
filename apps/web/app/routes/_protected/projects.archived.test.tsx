import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({ env: {} }))
vi.mock('~/services/db.server', () => ({ createDb: () => null }))
vi.mock('~/middleware/context', () => ({ requireUser: vi.fn() }))
vi.mock('~/services/access.server', () => ({
  isTeamWorkspaceAdmin: vi.fn(),
}))
vi.mock('~/services/projects.server', () => ({
  listArchivedWorkspaceProjects: vi.fn(),
}))
vi.mock('~/lib/flagship-fallback.server', () => ({}))
vi.mock('~/services/project-membership.server', () => ({
  listJoinedProjectsForDropdown: vi.fn(),
}))
vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>()
  return {
    ...actual,
    Link: ({ children, to }: { children: ReactNode; to: string }) => (
      <a href={to}>{children}</a>
    ),
    useRevalidator: () => ({ revalidate: vi.fn() }),
  }
})
vi.mock('../_home/+components/topbar', () => ({
  Topbar: () => <div data-primary-topbar="current" />,
}))
vi.mock('../_home/+components/bottom-tab-bar', () => ({
  BottomTabBar: () => <div data-bottom-tab-bar />,
}))
vi.mock('~/hooks/use-t', () => ({
  useT: () => ({ locale: 'en', t: (key: string) => key }),
}))
vi.mock('~/components/app/page-breadcrumb', () => ({
  PageBreadcrumb: ({ children }: { children: ReactNode }) => (
    <nav>{children}</nav>
  ),
}))
vi.mock('~/components/ui/breadcrumb', () => ({
  BreadcrumbList: ({ children }: { children: ReactNode }) => <>{children}</>,
  BreadcrumbItem: ({ children }: { children: ReactNode }) => <>{children}</>,
  BreadcrumbLink: ({ children }: { children: ReactNode }) => <>{children}</>,
  BreadcrumbPage: ({ children }: { children: ReactNode }) => <>{children}</>,
  BreadcrumbSeparator: () => <span>/</span>,
}))
vi.mock('~/components/ui/empty', () => ({
  Empty: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  EmptyDescription: ({ children }: { children: ReactNode }) => (
    <p>{children}</p>
  ),
  EmptyHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  EmptyMedia: () => null,
  EmptyTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}))
vi.mock('~/components/app/project-manage-dialogs', () => ({
  DeleteProjectDialog: () => null,
  UnarchiveProjectButton: ({ children }: { children: ReactNode }) => (
    <button>{children}</button>
  ),
}))
vi.mock('~/components/ui/button', () => ({
  Button: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

import ArchivedProjects from './projects.archived'

const loaderData = {
  projects: [],
  user: { id: 'u1', name: 'User', email: 'u1@example.com' },
  userId: 'u1',
  isAdmin: true,
  workspaceId: 'w1',
  workspaceName: 'Workspace',
  joinedProjects: [],
}

describe('archived projects primary navigation', () => {
  test('keeps the desktop and mobile navigation', () => {
    const html = renderToStaticMarkup(
      createElement(ArchivedProjects, { loaderData } as never),
    )
    expect(html).toContain('data-primary-topbar="current"')
    expect(html).toContain('data-bottom-tab-bar')
  })
})
