import { afterEach, describe, expect, test, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import type { ReactNode } from 'react'
import { page } from 'vitest/browser'
import { createMemoryRouter, RouterProvider } from 'react-router'
import ProjectsIndex from './_protected/projects'
import '~/app.css'

const submitMock = vi.hoisted(() => vi.fn())

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    t: (key: string, vars?: Record<string, string | number>) => {
      const labels: Record<string, string> = {
        'tb.home': 'Home',
        'project.location': 'Project location',
        'project.projects': 'Projects',
        'project.create': 'Create project',
        'project.workspaceNote': `Projects are created in the ${vars?.workspaceName} workspace, not in a personal folder.`,
        'project.joinedSection': 'Joined',
        'project.joinableSection': 'Projects you can join',
        'project.sharedProjects': 'Shared projects',
        'project.sharedProjectsNote':
          'Shared from another workspace as a project member.',
        'project.showArchived': `Show archived (${vars?.count})`,
        'project.search': 'Search projects',
        'project.emptyTitle': 'No projects yet',
        'project.emptyBody': 'Create your first project.',
        'project.createTitle': 'Create project',
        'project.createDescription': `Create a project in ${vars?.workspaceName}.`,
        'project.fileCount': `${vars?.count} files`,
        'project.newBadge': `${vars?.count} new`,
        'project.join': 'Join',
        'project.joinedLabel': 'Joined',
      }
      return labels[key] ?? key
    },
    locale: 'en',
  }),
}))

vi.mock('react-router', async () => {
  const actual =
    await vi.importActual<typeof import('react-router')>('react-router')
  return {
    ...actual,
    useActionData: () => undefined,
    useFetcher: () => ({ submit: submitMock }),
    useNavigation: () => ({ state: 'idle', formData: undefined }),
    useOutletContext: () => ({ signedIn: true, workspaceName: 'Workspace' }),
    useViewTransitionState: () => false,
  }
})

vi.mock('~/components/app/page-breadcrumb', () => ({
  PageBreadcrumb: ({ children, ...props }: { children: ReactNode }) => (
    <nav {...props}>{children}</nav>
  ),
}))

vi.mock('~/services/db.server', () => ({ createDb: vi.fn() }))
vi.mock('~/services/projects.server', () => ({
  createProjectContainer: vi.fn(),
  listSharedProjects: vi.fn(),
  listWorkspaceProjects: vi.fn(),
  normalizeProjectDescription: vi.fn(),
  normalizeProjectName: vi.fn(),
  parseProjectBaseVisibility: vi.fn(),
}))
vi.mock('~/services/project-membership.server', () => ({
  joinProject: vi.fn(),
  leaveProject: vi.fn(),
  listProjectsForIndex: vi.fn(),
}))
vi.mock('~/services/upload-access.server', () => ({
  checkUploadAccess: vi.fn(),
}))
vi.mock('~/middleware/context', () => ({ requireUser: vi.fn() }))
vi.mock('~/lib/flagship-fallback.server', () => ({}))

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'project-1',
  name: 'Alpha project',
  description: 'A project description',
  baseVisibility: 'workspace',
  fileCount: 0,
  updatedAt: null,
  archivedAt: null,
  workspaceId: 'workspace-1',
  newCount: 0,
  hasExternal: false,
  joined: true,
  ...overrides,
})

const shared = {
  id: 'shared-1',
  name: 'Shared project',
  description: 'Shared description',
  baseVisibility: 'workspace' as const,
  fileCount: 0,
  fileUpdatedAt: null,
  sourceWorkspaceName: 'Other workspace',
}

let root: Root | undefined
let router: ReturnType<typeof createMemoryRouter> | undefined

type LoaderDataOnlyRouteProps = {
  loaderData: Record<string, unknown>
}

const ProjectsIndexForTest = ProjectsIndex as unknown as (
  props: LoaderDataOnlyRouteProps,
) => ReactNode

afterEach(() => {
  submitMock.mockClear()
  root?.unmount()
  root = undefined
  router?.dispose()
  router = undefined
  document.body.replaceChildren()
})

async function mount(loaderData: Record<string, unknown>, initialEntry = '/') {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  router = createMemoryRouter(
    [
      {
        path: '*',
        element: <ProjectsIndexForTest loaderData={loaderData} />,
      },
    ],
    { initialEntries: [initialEntry] },
  )
  root.render(<RouterProvider router={router} />)
  await vi.waitFor(() => expect(host.querySelector('nav')).not.toBeNull())
  return host
}

describe('projects structure', () => {
  test('exposes the current page structure', async () => {
    const host = await mount({
      sharedProjects: [shared],
      rows: [
        row(),
        row({ id: 'joinable-1', name: 'Joinable project', joined: false }),
        row({
          id: 'archived-1',
          name: 'Archived project',
          archivedAt: '2026-01-01T00:00:00.000Z',
        }),
      ],
    })

    expect(host.querySelector('a[href="/"]')?.textContent).toBe('Home')
    expect(host.querySelector('nav')?.textContent).toContain('Projects')
    expect(host.querySelector('h1')?.textContent).toBe('Projects')
    expect(host.textContent).toContain(
      'Projects are created in the Workspace workspace',
    )
    expect(host.querySelector('input[type="search"]')).toBeNull()
    expect(host.textContent).toContain('Joined')
    expect(host.textContent).toContain('Projects you can join')
    expect(host.textContent).toContain('Shared projects')
    expect(host.textContent).toContain('Show archived (1)')
    const primaryCreateButtons = host
      .querySelector('h1')
      ?.closest('section')
      ?.querySelectorAll('button')
    expect(primaryCreateButtons).toHaveLength(1)
    expect(primaryCreateButtons?.[0]).toHaveTextContent('Create project')
  })

  test('empty state has one primary Create action', async () => {
    const host = await mount({
      sharedProjects: [],
      rows: [],
    })
    expect(host.querySelector('h1')?.textContent).toBe('Projects')
    expect(host.textContent).toContain('No projects yet')
    expect(
      Array.from(host.querySelectorAll('button')).filter(
        (button) => button.textContent?.trim() === 'Create project',
      ),
    ).toHaveLength(1)
  })

  test('empty state opens the existing create dialog', async () => {
    const host = await mount({
      sharedProjects: [],
      rows: [],
    })
    const create = page.getByRole('button', { name: 'Create project' })
    expect(await create.all()).toHaveLength(1)
    await create.click()
    const dialog = page.getByRole('dialog')
    expect(await dialog.all()).toHaveLength(1)
    await expect.element(dialog).toBeVisible()
    expect(host.textContent).toContain('Create project')
  })

  test('create query opens the existing create dialog', async () => {
    await mount({ sharedProjects: [], rows: [] }, '/projects?create=1')
    const dialog = page.getByRole('dialog')
    expect(await dialog.all()).toHaveLength(1)
    await expect.element(dialog).toBeVisible()
  })

  test('populated state joins the only joinable project', async () => {
    const joinableName =
      'Joinable project with a deliberately long name for mobile wrapping'
    const joinableDescription =
      'A deliberately long joinable project description keeps the Join button beside a realistic multi-line row on narrow screens.'
    const host = await mount({
      sharedProjects: [],
      rows: [
        row(),
        row({
          id: 'joinable-1',
          name: joinableName,
          description: joinableDescription,
          joined: false,
        }),
      ],
    })
    const join = page.getByRole('button', { name: 'Join' })
    expect(await join.all()).toHaveLength(1)
    await join.click()
    const projectLinks = host.querySelectorAll(
      `a[aria-label="${joinableName}"]`,
    )
    expect(projectLinks).toHaveLength(1)
    const projectRow = projectLinks[0].parentElement
    expect(projectRow).not.toBeNull()
    expect(projectRow).toHaveTextContent('Joined')
    expect(projectRow?.querySelector('button')).toBeNull()
    expect(submitMock).toHaveBeenCalledWith(
      { intent: 'join-project', projectId: 'joinable-1' },
      { method: 'post' },
    )
  })

  test('long project rows keep metadata, marks, and trailing controls in bounds', async () => {
    const joinedName =
      'Long project name that wraps to three lines on mobile screens'
    const joinableName =
      'Joinable project with a deliberately long name for mobile wrapping'
    const host = await mount({
      sharedProjects: [],
      rows: [
        row({ id: 'long-joined', name: joinedName, newCount: 1 }),
        row({
          id: 'long-joinable',
          name: joinableName,
          description:
            'A deliberately long joinable project description keeps the Join button beside a realistic multi-line row on narrow screens.',
          joined: false,
        }),
      ],
    })

    for (const name of [joinedName, joinableName]) {
      const link = host.querySelector<HTMLElement>(`a[aria-label="${name}"]`)
      expect(link).not.toBeNull()
      const projectRow = link!.parentElement!
      expect(projectRow.scrollWidth).toBeLessThanOrEqual(projectRow.clientWidth)
      expect(projectRow.querySelector('[aria-hidden="true"]')).not.toBeNull()
    }
    const joinedRow = host.querySelector<HTMLElement>(
      `a[aria-label="${joinedName}"]`,
    )!.parentElement!
    expect(joinedRow).toHaveTextContent('1 new')
    const joinableRow = host.querySelector<HTMLElement>(
      `a[aria-label="${joinableName}"]`,
    )!.parentElement!
    expect(joinableRow.querySelector('button')).toHaveTextContent('Join')
  })

  test('populated state reveals archived projects when checked', async () => {
    await mount({
      sharedProjects: [],
      rows: [
        row(),
        row({
          id: 'archived-1',
          name: 'Archived project',
          archivedAt: '2026-01-01T00:00:00.000Z',
        }),
      ],
    })
    const archivedToggle = page.getByRole('checkbox', {
      name: 'Show archived (1)',
    })
    expect(await archivedToggle.all()).toHaveLength(1)
    await archivedToggle.click()
    const archived = page.getByText('Archived project')
    expect(await archived.all()).toHaveLength(1)
    await expect.element(archived).toBeVisible()
  })

  test('project marks expose deterministic inline avatar backgrounds', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const { ProjectMark } = await import('~/components/app/project-mark')
    createRoot(host).render(
      <ProjectMark id="project-a" name="  Alpha project" />,
    )
    await expect.element(page.getByText('A')).toBeVisible()
    const mark = host.querySelector<HTMLElement>('[aria-hidden="true"]')!
    expect(mark.style.background).not.toBe('')
    expect(mark.className).not.toContain('bg-avatar')
  })
})
