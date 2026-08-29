import { afterEach, describe, expect, test, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { MemoryRouter, useLocation } from 'react-router'
import { page, userEvent } from 'vitest/browser'
import { ProjectsDropdown } from './+components/projects-dropdown'
import { waitForBrowserLayout } from '~/test/browser-layout'
import '~/app.css'

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    t: (key: string, vars?: Record<string, string | number>) => {
      if (key === 'project.newBadge') return `${vars?.count} new`
      return (
        {
          'tb.home': 'Home',
          'tb.homeView': 'Home view',
          'tb.projects': 'Projects',
          'home.myFiles': 'My files',
          'home.allProjects': 'All projects',
          'tb.recent': 'Recent',
          'team.settings': 'Settings',
        }[key] ?? key
      )
    },
  }),
}))

const projects = [
  {
    id: 'jp-tokyo',
    name: '仕様確認用プロジェクトの長い名前東京',
    newCount: 0,
  },
  {
    id: 'jp-osaka',
    name: '仕様確認用プロジェクトの長い名前東京',
    newCount: 1,
    workspaceName: 'partner.example',
  },
  {
    id: 'ascii-long',
    name: `ASCIIprojectname_${'x'.repeat(72)}`,
    newCount: 100,
  },
]

function LocationProbe() {
  const location = useLocation()
  return <output data-route>{location.pathname}</output>
}

function Harness({
  joinedProjects = projects,
}: {
  joinedProjects?: typeof projects
}) {
  return (
    <MemoryRouter initialEntries={['/']}>
      <ProjectsDropdown joinedProjects={joinedProjects} />
      <LocationProbe />
    </MemoryRouter>
  )
}

let root: Root | undefined

afterEach(() => {
  root?.unmount()
  root = undefined
  document.body.replaceChildren()
})

async function mount(options: { joinedProjects?: typeof projects } = {}) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  root.render(<Harness {...options} />)
  await vi.waitFor(() =>
    expect(host.querySelector('button[aria-label="Projects"]')).not.toBeNull(),
  )
  return host
}

async function openWithClick() {
  const trigger = page.getByRole('button', { name: 'Projects' })
  await trigger.click()
  await vi.waitFor(() =>
    expect(document.querySelector('[role="menu"]')).not.toBeNull(),
  )
  return document.querySelector<HTMLButtonElement>(
    'button[aria-label="Projects"]',
  )!
}

describe('Topbar project dropdown behavior', () => {
  test('opens by click and keeps preview portals absent when hovered', async () => {
    await page.viewport(1024, 800)
    const host = await mount()
    const trigger = page.getByRole('button', { name: 'Projects' })

    await trigger.hover()
    expect(document.querySelector('[role="menu"]')).toBeNull()

    await openWithClick()
    const menu = document.querySelector<HTMLElement>('[role="menu"]')
    expect(menu).not.toBeNull()
    expect(
      document.querySelector(
        '[data-slot="hover-card-content"], [data-slot="hover-card-portal"]',
      ),
    ).toBeNull()
    const firstItem = document.querySelector<HTMLElement>(
      `a[href="/projects/${projects[0].id}"]`,
    )!
    await page.elementLocator(firstItem).hover()
    expect(
      document.querySelector(
        '[data-slot="hover-card-content"], [data-slot="hover-card-portal"]',
      ),
    ).toBeNull()
    expect(menu?.textContent).toContain('All projects')
  })

  test.each(['Enter', 'Space', 'ArrowDown'] as const)(
    'opens with %s from the trigger',
    async (key) => {
      await page.viewport(1024, 800)
      await mount()
      const trigger = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Projects"]',
      )!
      trigger.focus()
      await userEvent.keyboard(`{${key}}`)
      await vi.waitFor(() =>
        expect(document.querySelector('[role="menu"]')).not.toBeNull(),
      )
      const first = document.querySelector<HTMLAnchorElement>(
        `a[href="/projects/${projects[0].id}"]`,
      )!
      await vi.waitFor(() => expect(document.activeElement).toBe(first))
    },
  )

  test('moves through items, enters a project, and returns focus on Escape', async () => {
    await page.viewport(1024, 800)
    await mount()
    const trigger = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Projects"]',
    )!
    trigger.focus()
    await userEvent.keyboard('{Enter}')
    await vi.waitFor(() =>
      expect(document.querySelector('[role="menu"]')).not.toBeNull(),
    )
    const first = document.querySelector<HTMLAnchorElement>(
      `a[href="/projects/${projects[0].id}"]`,
    )!
    const second = document.querySelector<HTMLAnchorElement>(
      `a[href="/projects/${projects[1].id}"]`,
    )!

    await vi.waitFor(() => expect(document.activeElement).toBe(first))
    await userEvent.keyboard('{ArrowDown}')
    await vi.waitFor(() => expect(document.activeElement).toBe(second))
    await userEvent.keyboard('{ArrowUp}')
    await vi.waitFor(() => expect(document.activeElement).toBe(first))
    await userEvent.keyboard('{Escape}')
    await vi.waitFor(() =>
      expect(document.querySelector('[role="menu"]')).toBeNull(),
    )
    await vi.waitFor(() => expect(document.activeElement).toBe(trigger))

    trigger.focus()
    await userEvent.keyboard('{Enter}')
    await vi.waitFor(() =>
      expect(document.querySelector('[role="menu"]')).not.toBeNull(),
    )
    const reopenedFirst = document.querySelector<HTMLAnchorElement>(
      `a[href="/projects/${projects[0].id}"]`,
    )!
    const projectItem = document.querySelector<HTMLAnchorElement>(
      `a[href="/projects/${projects[1].id}"]`,
    )!
    await vi.waitFor(() => expect(document.activeElement).toBe(reopenedFirst))
    await userEvent.keyboard('{ArrowDown}')
    await vi.waitFor(() => expect(document.activeElement).toBe(projectItem))
    await userEvent.keyboard('{Enter}')
    await vi.waitFor(() =>
      expect(document.querySelector('[data-route]')?.textContent).toBe(
        `/projects/${projects[1].id}`,
      ),
    )
  })

  test('keeps full names, 26px marks, badges, separator hierarchy, and geometry', async () => {
    await page.viewport(640, 800)
    const host = await mount()
    await openWithClick()
    await waitForBrowserLayout()

    for (const project of projects) {
      const link = document.querySelector<HTMLAnchorElement>(
        `a[href="/projects/${project.id}"]`,
      )!
      const expectedName =
        project.newCount > 0
          ? `${project.name} ${'workspaceName' in project ? `${project.workspaceName} ` : ''}${project.newCount > 99 ? '99+' : String(project.newCount)} new`
          : `${project.name}${'workspaceName' in project ? ` ${project.workspaceName}` : ''}`
      await expect
        .element(page.elementLocator(link))
        .toHaveAccessibleName(expectedName)
      const mark = link.querySelector<HTMLElement>('[aria-hidden="true"]')!
      expect(getComputedStyle(mark).width).toBe('26px')
      expect(getComputedStyle(mark).height).toBe('26px')
      expect(getComputedStyle(mark).flexShrink).toBe('0')
      const name = link.querySelector<HTMLElement>('.truncate')!
      expect(name.textContent).toBe(project.name)
      const workspace = link.querySelectorAll<HTMLElement>('.truncate')[1]
      if ('workspaceName' in project) {
        expect(workspace?.textContent).toBe(project.workspaceName)
      } else {
        expect(workspace).toBeUndefined()
      }
      if (project.id === 'ascii-long') {
        expect(getComputedStyle(name).textOverflow).toBe('ellipsis')
        expect(name.scrollWidth).toBeGreaterThan(name.clientWidth)
      }
      if (project.newCount === 0) {
        expect(link.textContent).not.toContain('0 new')
        expect(link.querySelector('.bg-link-soft')).toBeNull()
      } else {
        const badge = link.querySelector<HTMLElement>('.bg-link-soft')!
        expect(badge.textContent).toBe(
          project.newCount > 99 ? '99+ new' : '1 new',
        )
        expect(getComputedStyle(badge).flexShrink).toBe('0')
      }
    }

    const content = document.querySelector<HTMLElement>(
      '[data-slot="dropdown-menu-content"]',
    )!
    const separator = content.querySelector<HTMLElement>(
      '[data-slot="dropdown-menu-separator"]',
    )!
    const allProjects = content.querySelector<HTMLAnchorElement>(
      'a[href="/projects"]',
    )!
    expect(separator.compareDocumentPosition(allProjects)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
    expect(allProjects.className).toContain('text-link')
    expect(allProjects.querySelector('[aria-hidden="true"]')).toBeNull()
    expect(content.scrollWidth).toBeLessThanOrEqual(content.clientWidth)
    for (const link of content.querySelectorAll<HTMLAnchorElement>(
      'a[href^="/projects/"]',
    )) {
      expect(link.scrollWidth).toBeLessThanOrEqual(link.clientWidth)
      const linkBox = link.getBoundingClientRect()
      const markBox = link
        .querySelector<HTMLElement>('[aria-hidden="true"]')!
        .getBoundingClientRect()
      expect(markBox.right).toBeLessThanOrEqual(linkBox.right + 0.5)
    }
  })
})

describe('Topbar project dropdown existing breakpoint', () => {
  test('hides the project item at the existing max-nav breakpoint', async () => {
    await page.viewport(599, 800)
    await mount()
    const trigger = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Projects"]',
    )!
    expect(getComputedStyle(trigger).display).toBe('none')
    expect(document.querySelector('[role="menu"]')).toBeNull()
  })
})
