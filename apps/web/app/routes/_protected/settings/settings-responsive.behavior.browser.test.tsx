import { INVENTORY_PAGE_SIZE } from '~/lib/team-management'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, onTestFinished, test } from 'vitest'
import { commands } from 'vitest/browser'
import {
  fits as fitsDimension,
  waitForBrowserLayout,
} from '~/test/browser-layout'
import '~/app.css'
import { type ReactNode } from 'react'
import {
  createMemoryRouter,
  Outlet,
  parsePath,
  RouterProvider,
  RouterContextProvider,
  useLoaderData,
  UNSAFE_withComponentProps,
} from 'react-router'
import { vi } from 'vitest'
import { page } from 'vitest/browser'
import axe from 'axe-core'
import { bindI18n } from '~/lib/i18n'
import { avatarSlotFor } from '~/lib/user'
import { AuthorAvatar } from '~/components/app/author-avatar'
import { PlanCard } from '~/components/app/plan-card'
import { BillingSelection } from '~/components/app/billing-toggle'
import { BILLING_PRICES, formatPrice } from '~/lib/billing-prices'
import { PRICING_COPY } from '~/lib/pricing-content'
import { TooltipProvider } from '~/components/ui/tooltip'
import { Checkbox } from '~/components/ui/checkbox'
import { ProjectsTable } from './_content/inventory/+components/projects-table'
import { ArtifactsTable } from './_content/inventory/+components/artifacts-table'
import { BotSection } from './+components/bot-section'
import ExternalAccessPage from './_content/external-access'
import SettingsLayout from './_layout'
const language = vi.hoisted(() => ({ locale: 'en' as 'en' | 'ja' }))
vi.mock('~/hooks/use-t', () => ({ useT: () => bindI18n(language.locale) }))
vi.mock('~/services/link-sharing.server', () => ({}))
const services = vi.hoisted(() => ({
  updateWorkspaceName: vi.fn(),
  removeWorkspaceMember: vi.fn(),
  transferRemovedMemberAssets: vi.fn(),
  revokeWorkspaceMemberCliSessions: vi.fn(),
  loadWorkspaceMembersPage: vi.fn(),
  loadRemovedWorkspaceMembers: vi.fn(),
  parseMembersPageFilters: () => ({
    query: '',
    role: 'all',
    activity: 'all',
    page: 1,
  }),
}))
vi.mock('~/services/team-management.server', () => services)
vi.mock('./+lib/settings-request.server', () => ({
  settingsActiveAdmin: async () => true,
}))
vi.mock('~/services/project-membership.server', () => ({}))
vi.mock('~/services/db.server', () => ({ createDb: () => ({}) }))
vi.mock('~/middleware/context', () => ({
  requireUser: () => ({ id: 'owner' }),
}))
import MembersPage, {
  screen as membersScreen,
  action as membersAction,
  loader as membersLoader,
} from './_content/index'
import GeneralPage, {
  screen as generalScreen,
  action as updateGeneral,
} from './_content/general'
import ActivityPage from './_content/activity'
import AnalyticsPage from './_content/analytics'
import IntegrationsPage from './_content/integrations'
import AiToolsPage from './+components/ai-tools-page'
import BillingPage from './_content/billing'
import ProjectsPage from './_content/inventory/projects'
import ArtifactsPage from './_content/inventory/artifacts'
import { PricingPage } from '~/components/app/pricing-page'
vi.mock('~/services/slack.server', () => ({}))
vi.mock('~/services/billing.server', () => ({}))
vi.mock('~/services/billing-usage.server', () => ({}))
vi.mock('~/services/access.server', () => ({}))

// Retained before repair: external-access.tsx PolicyToggle; theme.css :root
// and html[data-theme='dark']; tokens.css avatar palette; AuthorAvatar's
// text-card foreground (AvatarMenu overrides it with white).
const legacyThemes = {
  light: {
    background: '#ffffff',
    card: '#ffffff',
    foreground: '#37352f',
    input: 'rgba(55,53,47,0.1)',
  },
  dark: {
    background: '#111315',
    card: '#14171a',
    foreground: '#e7e2d8',
    input: 'rgba(231,226,216,0.13)',
  },
}
const legacyAvatars = [
  'linear-gradient(135deg, #ff8a65, #ff6f61)',
  'linear-gradient(135deg, #34d399, #059669)',
  'linear-gradient(135deg, #fbbf24, #d97706)',
  'linear-gradient(135deg, #fb7185, #e11d48)',
  'linear-gradient(135deg, #818cf8, #4f46e5)',
  'linear-gradient(135deg, #38bdf8, #0284c7)',
]
function ratio(a: number[], b: number[]) {
  const luminance = (rgb: number[]) =>
    rgb
      .slice(0, 3)
      .map((value) => {
        const c = value / 255
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
      })
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0)
  const x = luminance(a),
    y = luminance(b)
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}

const nativeStates = (['light', 'dark'] as const).flatMap((theme) =>
  [false, true].flatMap((checked) =>
    [false, true].map((disabled) => ({ theme, checked, disabled })),
  ),
)
test.each(nativeStates)(
  'retained native checkbox baseline ($theme, checked=$checked, disabled=$disabled, Chromium)',
  async ({ theme, checked, disabled }) => {
    const name = `native-${theme}-${checked}-${disabled}`
    const colors = legacyThemes[theme]
    const container = document.createElement('div')
    container.id = 'legacy-settings-controls'
    Object.assign(container.style, {
      background: colors.background,
      color: colors.foreground,
      colorScheme: theme,
      padding: '16px',
      width: '300px',
    })
    document.body.appendChild(container)
    const root = createRoot(container)
    try {
      await act(async () =>
        root.render(
          <>
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                name="legacy"
                defaultChecked={checked}
                disabled={disabled}
                value="true"
                className="size-4 self-start"
              />
              Link sharing
            </label>
            <div style={{ display: 'flex' }}>
              {legacyAvatars.map((background) => (
                <span
                  key={background}
                  style={{
                    background,
                    color: colors.card,
                    width: 26,
                    height: 26,
                  }}
                >
                  A
                </span>
              ))}
            </div>
          </>,
        ),
      )
      await waitForBrowserLayout()
      const capture = await commands.settingsContrastCapture(
        '#legacy-settings-controls',
        name,
      )
      const image = new Image()
      image.src = `data:image/png;base64,${capture}`
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const context = canvas.getContext('2d')!
      context.drawImage(image, 0, 0)
      const input = container.querySelector('input')!
      const bounds = input.getBoundingClientRect(),
        outer = container.getBoundingClientRect()
      const scale = image.width / outer.width
      const x = Math.round((bounds.left - outer.left) * scale)
      const y = Math.round((bounds.top - outer.top + bounds.height / 2) * scale)
      const sample = (sx: number) =>
        Array.from(context.getImageData(sx, y, 1, 1).data)
      const border = sample(x),
        background = sample(x - 2)
      await commands.settingsContrastReport({
        name: name,
        x,
        y,
        border,
        background,
        ratio: ratio(border, background),
      })
      expect(border[3]).toBe(255)
      expect(background[3]).toBe(255)
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  },
)

// Layout and painted contrast require native CSS; data contracts stay in unit tests.

const project = {
  id: 'reports',
  name: 'QuarterlyReports'.repeat(8),
  archivedAt: '2026-01-01',
  baseVisibility: 'workspace' as const,
  artifactCount: 7,
  sizeBytes: 2048,
  updatedAt: '2026-01-01T00:00:00Z',
}
const artifact = {
  id: 'report',
  name: 'Report'.repeat(40),
  owner: { name: 'Owner'.repeat(20), email: 'owner@example.test' },
  location: { kind: 'project' as const, name: project.name },
  visibility: 'project' as const,
  sizeBytes: 2048,
  updatedAt: project.updatedAt,
}
const longEmail =
  'nightly-report-automation-with-a-long-destination-address@bots.artifactshare.invalid'
const memberEmails = ['active', 'removed', 'owner'].map(
  (status) =>
    `${status}-member-with-a-long-synthetic-address-dev-screen-team-settings-long-member-addresses@example.test`,
)
const bot = {
  id: 'bot',
  name: 'W'.repeat(30),
  email: longEmail,
  botStoppedAt: null,
  credentialLive: true,
  projectId: 'reports',
  projectName: 'Reports',
  projectNameSnapshot: 'Reports',
  lastAuthAt: null,
  cancelable: false,
}
const shell = {
  kind: 'team' as const,
  workspace: {
    id: 'workspace',
    name: 'Reports',
    hd: null,
    plan: 'team',
    storageUsedBytes: 0,
    storageQuotaBytes: 100000000000,
  },
  currentUserIsAdmin: true,
  currentUserRole: 'owner' as const,
  joinedProjects: [],
  user: {
    id: 'owner',
    name: 'Owner',
    email: 'owner@example.test',
    image: null,
    initial: 'O',
  },
}
// Billing shows the plan and storage of the Settings shell.
const freePlanShell = {
  ...shell,
  workspace: { ...shell.workspace, plan: 'free' },
}
function createTestRouter(...args: Parameters<typeof createMemoryRouter>) {
  const router = createMemoryRouter(...args)
  onTestFinished(() => router.dispose())
  return router
}

test('disposes both routers when fixture setup throws', () => {
  const disposals: Array<ReturnType<typeof vi.fn>> = []
  // Completion hooks run in reverse registration order.
  onTestFinished(() => {
    expect(disposals).toHaveLength(2)
    for (const dispose of disposals) expect(dispose).toHaveBeenCalledTimes(1)
  })
  expect(() => {
    for (let index = 0; index < 2; index++) {
      const router = createTestRouter([{ path: '/', element: <div /> }])
      disposals.push(vi.spyOn(router, 'dispose'))
    }
    throw new Error('fixture setup failed')
  }).toThrow('fixture setup failed')
})

async function withScreen(
  content: ReactNode,
  inspect: (
    container: HTMLDivElement,
    router: ReturnType<typeof createMemoryRouter>,
  ) => Promise<void>,
  path = '/settings/bots',
  settingsShell: boolean | typeof shell = true,
  action?: NonNullable<
    Parameters<typeof createMemoryRouter>[0][number]['action']
  >,
) {
  const layoutShell = settingsShell === true ? shell : settingsShell
  const router = createTestRouter(
    [
      {
        element: (
          <TooltipProvider>
            {layoutShell ? (
              <SettingsLayout loaderData={layoutShell} />
            ) : (
              <Outlet />
            )}
          </TooltipProvider>
        ),
        children: [
          { path: parsePath(path).pathname, element: content, action },
        ],
      },
    ],
    { initialEntries: [path] },
  )
  const container = document.createElement('div')
  container.id = 'settings-layout-fixture'
  document.body.appendChild(container)
  const root = createRoot(container)
  const unmount = vi.spyOn(root, 'unmount')
  try {
    await act(async () => root.render(<RouterProvider router={router} />))
    await waitForBrowserLayout()
    await inspect(container, router)
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
  expect(unmount).toHaveBeenCalledOnce()
  expect(container.isConnected).toBe(false)
}
function fits(element: Element) {
  const rect = element.getBoundingClientRect()
  // One CSS pixel allows fractional font/layout rounding, not hidden overflow.
  return (
    rect.left >= -1 &&
    rect.right <= innerWidth + 1 &&
    fitsDimension(element.scrollWidth, element.clientWidth)
  )
}
function visibleEmpty(container: Element) {
  const message = bindI18n(language.locale).t('team.inventory.empty')
  return (
    [...container.querySelectorAll('p, td')].filter(
      (el) =>
        el.textContent === message &&
        el.checkVisibility({ visibilityProperty: true }),
    ).length === 1
  )
}

for (const width of [600, 979, 980])
  for (const kind of ['artifacts', 'projects'] as const)
    test(`Inventory ${kind} at ${width}px exposes names and navigation`, async () => {
      language.locale = 'en'
      await page.viewport(width, 844)
      const path = '/settings/inventory/' + kind
      const rows = Array.from(
        { length: INVENTORY_PAGE_SIZE + 1 },
        (_, index) => ({ ...artifact, id: artifact.id + index }),
      )
      const projects = Array.from(
        { length: INVENTORY_PAGE_SIZE + 1 },
        (_, index) => ({ ...project, id: project.id + index }),
      )
      const destination =
        kind === 'artifacts' ? '/a/report0' : '/projects/reports0'
      const router = createTestRouter(
        [
          { path: destination, element: <div /> },
          {
            element: (
              <TooltipProvider>
                <SettingsLayout loaderData={shell} />
              </TooltipProvider>
            ),
            children: [
              {
                path,
                loader: ({ request }) => new URL(request.url).search,
                Component: () => {
                  const params = new URLSearchParams(useLoaderData<string>())
                  const current = Number(params.get('page') ?? 1)
                  const start = (current - 1) * INVENTORY_PAGE_SIZE
                  return kind === 'artifacts' ? (
                    <ArtifactsPage
                      loaderData={{
                        artifacts: {
                          page: current,
                          total: rows.length,
                          artifacts: rows.slice(
                            start,
                            start + INVENTORY_PAGE_SIZE,
                          ),
                        },
                        filters: {
                          sort:
                            params.get('sort') === 'size' ? 'size' : 'updated',
                          visibility:
                            params.get('visibility') === 'project'
                              ? 'project'
                              : 'all',
                          page: current,
                        },
                      }}
                    />
                  ) : (
                    <ProjectsPage
                      loaderData={{
                        projects: {
                          page: current,
                          total: projects.length,
                          projects: projects.slice(
                            start,
                            start + INVENTORY_PAGE_SIZE,
                          ),
                        },
                      }}
                    />
                  )
                },
              },
              {
                path: '/settings',
                element: (
                  <MembersPage
                    loaderData={{
                      ...memberRows,
                      removedMembers:
                        width === 979 ? memberRows.removedMembers : [],
                      filters: {
                        query: '',
                        role: 'all',
                        activity: 'all',
                        page: 1,
                      },
                    }}
                  />
                ),
              },
            ],
          },
        ],
        { initialEntries: [path] },
      )
      const container = document.createElement('div')
      document.body.appendChild(container)
      const root = createRoot(container)
      const unmount = vi.spyOn(root, 'unmount')
      try {
        await act(async () => root.render(<RouterProvider router={router} />))
        await waitForBrowserLayout()
        const table = container.querySelector('table')!,
          card = container.querySelector('article')!
        expect(table.checkVisibility()).toBe(width >= 980)
        expect(card.checkVisibility()).toBe(width < 980)
        const link = (width >= 980 ? table : card).querySelector('a')!
        expect(link.getAttribute('href')).toBe(destination)
        expect(getComputedStyle(link).textDecorationLine).toContain('underline')
        await expect.element(page.elementLocator(link)).toBeVisible()
        await page.elementLocator(link).click()
        await vi.waitFor(() =>
          expect(router.state.location.pathname).toBe(destination),
        )
        await act(async () => router.navigate(-1))
        await waitForBrowserLayout()
        const { t } = bindI18n('en')
        if (kind === 'artifacts') {
          for (const [field, option] of [
            ['team.inventory.filter', 'table.visibilityProject'],
            ['team.inventory.sort', 'team.inventory.sort.size'],
          ] as const) {
            const select = page.getByRole('combobox', { name: t(field) })
            expect(fits(select.element())).toBe(true)
            await select.click()
            await page
              .getByRole('option', { name: t(option), exact: true })
              .click()
          }
          const apply = page.getByRole('button', { name: 'Apply filters' })
          expect(fits(apply.element())).toBe(true)
          await apply.click()
          await vi.waitFor(() =>
            expect(router.state.location.search).toBe(
              '?visibility=project&sort=size',
            ),
          )
        }
        for (const label of ['Next', 'Previous']) {
          const pager = page.getByRole('link', { name: label, exact: true })
          await expect.element(pager).toBeVisible()
          expect(fits(pager.element())).toBe(true)
          await pager.click()
          await vi.waitFor(() => {
            const params = new URLSearchParams(router.state.location.search)
            expect(params.get('page')).toBe(label === 'Next' ? '2' : null)
            if (kind === 'artifacts') {
              expect(params.get('visibility')).toBe('project')
              expect(params.get('sort')).toBe('size')
            }
          })
        }
        if (kind === 'artifacts') {
          const removed = page.getByRole('link', {
            name: 'Removed members',
            exact: true,
          })
          const next = page.getByRole('link', { name: 'Next', exact: true })
          await expect.element(next).toBeVisible()
          const pager = next.element()
          expect(
            container.querySelector('table')!.compareDocumentPosition(pager) &
              Node.DOCUMENT_POSITION_FOLLOWING,
          ).toBeTruthy()
          expect(
            pager.compareDocumentPosition(removed.element()) &
              Node.DOCUMENT_POSITION_FOLLOWING,
          ).toBeTruthy()
          await removed.click()
          await vi.waitFor(() =>
            expect(router.state.location).toMatchObject({
              pathname: '/settings',
              hash: '#removed-members',
            }),
          )
          await expect
            .element(page.getByRole('heading', { name: 'Removed members' }))
            .toBeVisible()
          const section = page.elementLocator(
            container.querySelector('#removed-members')!,
          )
          await expect
            .element(section.getByRole('heading', { name: 'Removed members' }))
            .toBeVisible()
          await expect
            .element(
              section.getByText(
                width === 979
                  ? memberRows.removedMembers[0].name
                  : 'No removed members.',
                { exact: true },
              ),
            )
            .toBeVisible()
        }
      } finally {
        await act(async () => root.unmount())
        container.remove()
        await page.viewport(1280, 800)
      }
      expect(unmount).toHaveBeenCalledOnce()
      expect(container.isConnected).toBe(false)
      expect([innerWidth, innerHeight]).toEqual([1280, 800])
    })

for (const theme of ['light', 'dark'])
  for (const locale of ['en', 'ja'] as const) {
    test(`phone inventory cards, empty states and bot wrapping (${theme}, ${locale})`, async () => {
      const previousTheme = document.documentElement.dataset.theme
      document.documentElement.dataset.theme = theme
      language.locale = locale
      const originalWrite = navigator.clipboard.writeText
      const clipboard = vi
        .spyOn(navigator.clipboard, 'writeText')
        .mockResolvedValue()
      try {
        await page.viewport(390, 844)
        await withScreen(
          <BotSection bots={[bot]} canCreate />,
          async (container) => {
            const name = page.getByText(bot.name, { exact: true }).element()
            expect(fits(name)).toBe(true)
            const nameStyle = name.style.cssText
            try {
              name.style.overflowWrap = 'normal'
              expect(fits(name)).toBe(false)
            } finally {
              name.style.cssText = nameStyle
            }
            expect(fits(name)).toBe(true)
            const email = page.getByRole('button', { name: longEmail })
            const element = email.element()
            expect(fits(element)).toBe(true)
            expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(
              391,
            )
            expect(element.getBoundingClientRect().height).toBeGreaterThan(
              parseFloat(getComputedStyle(element).lineHeight),
            )
            // Reapply the original nowrap fault, then restore and recheck.
            const before = element.style.cssText
            try {
              element.style.whiteSpace = 'nowrap'
              expect(fits(element)).toBe(false)
            } finally {
              element.style.cssText = before
            }
            expect(fits(element)).toBe(true)
            await email.click()
            expect(clipboard).toHaveBeenCalledWith(longEmail)
            expect(container.querySelector('main')).not.toBeNull()
          },
        )
        for (const width of [390, 599, 600, 979, 980, 1440]) {
          await page.viewport(width, 844)
          await withScreen(
            <ProjectsTable rows={[project]} locale={locale} />,
            async (container) => {
              const card = container.querySelector('article')!
              const table = container.querySelector('table')!
              expect(card.checkVisibility()).toBe(width < 980)
              expect(table.checkVisibility()).toBe(width >= 980)
              const link = (width < 980 ? card : table).querySelector('a')!
              expect(link.getAttribute('href')).toBe('/projects/' + project.id)
              const style = getComputedStyle(link)
              expect(style.textDecorationLine).toContain('underline')
              expect(pixels(style.color)).toEqual(
                pixels(style.getPropertyValue('--link')),
              )
              if (width < 980) {
                expect(link.textContent).toBe(project.name)
                expect(fits(link)).toBe(true)
                expect(style.textOverflow).not.toBe('ellipsis')
                expect(fits(card)).toBe(true)
                expect(card.textContent).toContain('7')
                expect(card.textContent).toContain('2 KB')
                expect(card.textContent).toContain(
                  bindI18n(locale).t('team.inventory.archived'),
                )
              }
            },
            '/settings/inventory/projects',
          )
          await withScreen(
            <ArtifactsTable rows={[artifact]} locale={locale} />,
            async (container) => {
              const card = container.querySelector('article')!
              const table = container.querySelector('table')!
              expect(card.checkVisibility()).toBe(width < 980)
              expect(table.checkVisibility()).toBe(width >= 980)
              const link = (width < 980 ? card : table).querySelector('a')!
              expect(link.getAttribute('href')).toBe('/a/' + artifact.id)
              const style = getComputedStyle(link)
              expect(style.textDecorationLine).toContain('underline')
              expect(pixels(style.color)).toEqual(
                pixels(style.getPropertyValue('--link')),
              )
              if (width < 980) {
                expect(link.textContent).toBe(artifact.name)
                expect(fits(link)).toBe(true)
                expect(style.textOverflow).not.toBe('ellipsis')
                expect(fits(card)).toBe(true)
                for (const field of card.querySelectorAll('dd'))
                  expect(fits(field)).toBe(true)
              }
            },
            '/settings/inventory/artifacts',
          )
          for (const kind of ['projects', 'artifacts'])
            await withScreen(
              kind === 'projects' ? (
                <ProjectsTable rows={[]} locale={locale} />
              ) : (
                <ArtifactsTable rows={[]} locale={locale} />
              ),
              async (container) => {
                expect(visibleEmpty(container)).toBe(true)
                if (width < 980) {
                  const empty = [...container.querySelectorAll('p')].find(
                    (el) =>
                      el.textContent ===
                      bindI18n(locale).t('team.inventory.empty'),
                  )!
                  try {
                    empty.hidden = true
                    expect(visibleEmpty(container)).toBe(false)
                  } finally {
                    empty.hidden = false
                  }
                  expect(visibleEmpty(container)).toBe(true)
                }
              },
              `/settings/inventory/${kind}`,
            )
        }
      } finally {
        clipboard.mockRestore()
        if (previousTheme === undefined)
          delete document.documentElement.dataset.theme
        else document.documentElement.dataset.theme = previousTheme
        await page.viewport(1280, 800)
      }
      expect(navigator.clipboard.writeText).toBe(originalWrite)
      expect(document.documentElement.dataset.theme).toBe(previousTheme)
      expect([innerWidth, innerHeight]).toEqual([1280, 800])
    })

    test(`expiry number/unit and badges fit (${theme}, ${locale})`, async () => {
      const previousTheme = document.documentElement.dataset.theme
      document.documentElement.dataset.theme = theme
      language.locale = locale
      try {
        await page.viewport(390, 844)
        for (const plan of ['free', 'plus', 'team'] as const)
          for (const unlimited of [false, true]) {
            await withScreen(
              <ExternalAccessPage
                loaderData={{
                  policy: {
                    plan,
                    linkSharingEnabled: true,
                    externalPostingEnabled: true,
                    linkExpiryDefaultDays: unlimited ? null : 30,
                    linkExpiryMaxDays: unlimited ? null : 90,
                  },
                }}
              />,
              async (container) => {
                expect(
                  document.documentElement.scrollWidth,
                ).toBeLessThanOrEqual(391)
                for (const input of container.querySelectorAll(
                  'input[type="number"]',
                )) {
                  const unit = document.getElementById(
                    input.getAttribute('aria-describedby')!,
                  )!
                  const inputRect = input.getBoundingClientRect(),
                    unitRect = unit.getBoundingClientRect()
                  expect(unitRect.left).toBeGreaterThanOrEqual(inputRect.right)
                  // Measure the text line, not the span's padding box.
                  const text = document.createRange()
                  text.selectNodeContents(unit)
                  const unitIsCentered = () => {
                    const textRect = text.getBoundingClientRect()
                    return (
                      Math.abs(
                        (textRect.top + textRect.bottom) / 2 -
                          (inputRect.top + inputRect.bottom) / 2,
                      ) <= 1
                    )
                  }
                  expect(unitIsCentered()).toBe(true)
                  const previousStyle = unit.style.cssText
                  try {
                    unit.style.paddingTop = '6px'
                    expect(unitIsCentered()).toBe(false)
                  } finally {
                    unit.style.cssText = previousStyle
                  }
                  expect(unitIsCentered()).toBe(true)
                  const group = input.parentElement!.parentElement!
                  const checkbox = group.querySelector('[data-slot="checkbox"]')
                  if (checkbox)
                    expect(
                      checkbox.getBoundingClientRect().top,
                    ).toBeGreaterThanOrEqual(inputRect.bottom)
                }
                const badge = [...container.querySelectorAll('span')].find(
                  (el) =>
                    el.textContent ===
                    bindI18n(locale).t(`externalAccess.planLabel.${plan}`),
                )!
                expect(fits(badge)).toBe(true)
                expect(getComputedStyle(badge).whiteSpace).toBe('nowrap')
              },
              '/settings/external-access',
            )
          }
      } finally {
        if (previousTheme === undefined)
          delete document.documentElement.dataset.theme
        else document.documentElement.dataset.theme = previousTheme
        await page.viewport(1280, 800)
      }
    })
  }

// Paint alpha over actual ancestors rather than treating rgba as opaque.
function pixels(color: string, backgrounds: string[] = []) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 1
  const context = canvas.getContext('2d')!
  for (const value of [...backgrounds, color]) {
    context.fillStyle = value
    context.fillRect(0, 0, 1, 1)
  }
  return Array.from(context.getImageData(0, 0, 1, 1).data)
}
function surfaces(element: Element) {
  const colors: string[] = []
  for (
    let parent = element.parentElement;
    parent;
    parent = parent.parentElement
  )
    colors.unshift(getComputedStyle(parent).backgroundColor)
  return ['white', ...colors]
}
function boundaryContrast(element: Element) {
  const style = getComputedStyle(element)
  const backgrounds = surfaces(element)
  const outside = pixels('transparent', backgrounds)
  const border = pixels(style.borderLeftColor, [
    ...backgrounds,
    style.backgroundColor,
  ])
  return ratio(border, outside)
}
function textContrast(element: Element) {
  const style = getComputedStyle(element),
    backgrounds = surfaces(element)
  return ratio(
    pixels(style.color, [...backgrounds, style.backgroundColor]),
    pixels(style.backgroundColor, backgrounds),
  )
}

test.each(['light', 'dark'] as const)(
  'avatar, checkbox and billing boundaries meet contrast with fault controls (%s)',
  async (theme) => {
    const previousTheme = document.documentElement.dataset.theme
    document.documentElement.dataset.theme = theme
    language.locale = 'en'
    const ids = Array.from({ length: 6 }, (_, slot) => {
      let id = 0
      while (avatarSlotFor(`contrast-${id}`) !== slot + 1) id++
      return `contrast-${id}`
    })
    try {
      await withScreen(
        <section
          className="bg-card text-foreground p-4"
          aria-label="Contrast controls"
        >
          <div className="flex gap-2">
            {ids.map((id) => (
              <AuthorAvatar key={id} id={id} initial="A" image={null} />
            ))}
          </div>
          <form className="my-4 flex gap-4">
            {[false, true].flatMap((checked) =>
              [false, true].map((disabled) => (
                <label key={`${checked}-${disabled}`} className="flex gap-2">
                  <Checkbox checked={checked} disabled={disabled} />
                  {checked ? 'Checked' : 'Unchecked'}{' '}
                  {disabled ? 'disabled' : 'enabled'}
                </label>
              )),
            )}
          </form>
          <BillingSelection
            copy={PRICING_COPY.en}
            currency="jpy"
            interval="month"
            onCurrencyChange={() => {}}
            onIntervalChange={() => {}}
          />
        </section>,
        async (container) => {
          const controls = container.querySelector(
            '[aria-label="Contrast controls"]',
          )!
          const avatars = controls.querySelectorAll<HTMLElement>(
            '[data-slot="avatar-fallback"]',
          )
          expect(avatars).toHaveLength(6)
          for (const avatar of avatars)
            expect(textContrast(avatar)).toBeGreaterThanOrEqual(4.5)
          const avatar = avatars[0],
            originalAvatarStyle = avatar.style.cssText
          try {
            // Sample the original gradient away from the white glyph and rounded edge.
            avatar.id = 'legacy-avatar-fault'
            avatar.style.background = legacyAvatars[0]
            avatar.style.color = '#ffffff' // retained menu override in both themes
            const capture = await commands.settingsContrastCapture(
              '#legacy-avatar-fault',
              `avatar-fault-${theme}`,
            )
            const image = new Image()
            image.src = `data:image/png;base64,${capture}`
            await image.decode()
            const canvas = document.createElement('canvas')
            canvas.width = image.width
            canvas.height = image.height
            const context = canvas.getContext('2d')!
            context.drawImage(image, 0, 0)
            const x = Math.floor(image.width / 2),
              y = 2
            const background = Array.from(context.getImageData(x, y, 1, 1).data)
            const foreground = pixels(getComputedStyle(avatar).color)
            const measured = ratio(foreground, background)
            await commands.settingsContrastReport({
              name: `avatar-fault-${theme}`,
              x,
              y,
              border: foreground,
              background,
              ratio: measured,
            })
            expect(measured).toBeLessThan(4.5)
          } finally {
            avatar.style.cssText = originalAvatarStyle
            avatar.removeAttribute('id')
          }
          expect(textContrast(avatar)).toBeGreaterThanOrEqual(4.5)
          for (const checkbox of controls.querySelectorAll<HTMLElement>(
            '[data-slot="checkbox"]',
          )) {
            // The boundary must contrast with the external surface; checked fill is
            // itself a boundary and need not contrast with its own border.
            const externalContrast = () =>
              ratio(
                pixels(getComputedStyle(checkbox).borderLeftColor, [
                  ...surfaces(checkbox),
                  getComputedStyle(checkbox).backgroundColor,
                ]),
                pixels('transparent', surfaces(checkbox)),
              )
            expect(externalContrast()).toBeGreaterThanOrEqual(3)
            const original = checkbox.style.cssText
            if (checkbox.hasAttribute('disabled')) {
              const disabledStyle = getComputedStyle(checkbox)
              expect(disabledStyle.borderStyle).toBe('dashed')
              if (checkbox.getAttribute('data-state') === 'checked') {
                const enabled = controls.querySelector(
                  '[data-slot="checkbox"][data-state="checked"]:not(:disabled)',
                )!
                expect(disabledStyle.backgroundColor).not.toBe(
                  getComputedStyle(enabled).backgroundColor,
                )
              }
              try {
                checkbox.style.borderStyle = 'solid'
                expect(getComputedStyle(checkbox).borderStyle).not.toBe(
                  'dashed',
                )
              } finally {
                checkbox.style.cssText = original
              }
              expect(getComputedStyle(checkbox).borderStyle).toBe('dashed')
            }
            try {
              checkbox.style.borderColor = legacyThemes[theme].input
              checkbox.style.background = 'transparent'
              const measured = externalContrast()
              console.info(
                'Retained product border-input (not native)',
                theme,
                measured,
              )
              expect(externalContrast()).toBeLessThan(3)
            } finally {
              checkbox.style.cssText = original
            }
            expect(externalContrast()).toBeGreaterThanOrEqual(3)
          }
          for (const button of controls.querySelectorAll<HTMLButtonElement>(
            '[aria-pressed="true"]',
          )) {
            expect(boundaryContrast(button)).toBeGreaterThanOrEqual(3)
            expect(textContrast(button)).toBeGreaterThanOrEqual(4.5)
            const original = button.style.cssText
            try {
              button.style.borderColor = 'transparent'
              await waitForBrowserLayout()
              await Promise.all(
                button.getAnimations().map((animation) => animation.finished),
              )
              expect(boundaryContrast(button)).toBeLessThan(3)
            } finally {
              button.style.cssText = original
              await waitForBrowserLayout()
              await Promise.all(
                button.getAnimations().map((animation) => animation.finished),
              )
            }
            expect(boundaryContrast(button)).toBeGreaterThanOrEqual(3)
          }
          const results = await axe.run(controls, {
            runOnly: ['color-contrast'],
          })
          expect(results.violations).toEqual([])
        },
      )
    } finally {
      if (previousTheme === undefined)
        delete document.documentElement.dataset.theme
      else document.documentElement.dataset.theme = previousTheme
    }
  },
)

test.each(['en', 'ja'] as const)(
  'plan alignment applies only to multi-column layouts (%s)',
  async (locale) => {
    language.locale = locale
    try {
      for (const width of [390, 767, 768, 1440]) {
        await page.viewport(width, 844)
        await withScreen(
          <div className="grid gap-4 md:grid-cols-2">
            {(['plus', 'team'] as const).map((plan) => (
              <PlanCard
                key={plan}
                plan={plan}
                currency="jpy"
                interval="year"
                copy={PRICING_COPY[locale]}
              >
                <button>Choose {plan}</button>
              </PlanCard>
            ))}
          </div>,
          async (container) => {
            for (const card of container.querySelectorAll('article')) {
              const description = card.querySelector('p')!
              const price = description.nextElementSibling!
              expect(getComputedStyle(description).minHeight).toBe(
                width < 768 ? 'auto' : '44px',
              )
              expect(getComputedStyle(price).minHeight).toBe(
                width < 768 ? 'auto' : '96px',
              )
              expect(fits(card)).toBe(true)
            }
          },
          '/settings/billing',
        )
      }
    } finally {
      await page.viewport(1280, 800)
    }
  },
)

const billingData = {
  canManage: true,
  stripeSubscriptionStatus: '',
  hasSubscription: false,
  billingConfigured: true,
  defaultCurrency: 'jpy' as const,
  initialPlan: 'team' as const,
  initialInterval: 'monthly' as const,
  activeProjectCount: 1,
  projectLimit: null,
  entryContext: 'default' as const,
  externalPostingEnabled: true,
  contract: null,
  monthlyEstimate: null,
  showOverageProjection: false,
  includedBytes: 100000000000,
  overageProjection: null,
  contributorCount: 1,
}
const memberRows = {
  membersPage: {
    members: [
      {
        id: 'long-member',
        name: 'Active member with a long name and AnUnbrokenFamilyNameThatMustRemainFullyReadableOnPhones',
        email: memberEmails[0],
        image: null,
        role: 'admin',
        isAdmin: true,
        firstContributedAt: null,
        lastContributedAt: null,
        pendingUploads: 0,
      },
      {
        id: 'owner',
        name: 'Team Owner',
        email: memberEmails[2],
        image: null,
        role: 'owner',
        isAdmin: true,
        firstContributedAt: null,
        lastContributedAt: null,
        pendingUploads: 0,
      },
    ],
    total: 2,
    page: 1,
  },
  removedMembers: [
    {
      id: 'long-removed-member',
      name: 'Removed member with a long name and AnUnbrokenFamilyNameThatMustRemainFullyReadableOnPhones',
      email: memberEmails[1],
      image: null,
      ownedArtifactCount: 2,
    },
  ],
} satisfies Omit<Parameters<typeof MembersPage>[0]['loaderData'], 'filters'>

test('consumes the Slack callback notice on the integrations route', async () => {
  language.locale = 'en'
  await withScreen(
    <IntegrationsPage loaderData={{ connections: [] }} />,
    async (container, router) => {
      const status = page
        .elementLocator(container)
        .getByText(bindI18n('en').t('team.integrations.slack.connected'), {
          exact: true,
        })
      await expect.element(status).toBeVisible()
      expect(router.state.location.search).toBe('?view=teams')
      expect(router.state.historyAction).toBe('REPLACE')
      await act(async () => router.navigate('/settings/integrations'))
      await expect.element(status).not.toBeInTheDocument()
      await act(async () => router.navigate(-1))
      expect(router.state.location.search).toBe('?view=teams')
      await expect.element(status).not.toBeInTheDocument()
    },
    '/settings/integrations?connected=slack&view=teams',
  )
})

test.each(['ok', 'invalid'] as const)(
  'Japanese General submission reports %s at its form',
  async (code) => {
    language.locale = 'ja'
    services.updateWorkspaceName.mockImplementation(
      (_db, _actor, name: string) => ({
        kind: name.trim() ? 'ok' : 'invalid',
      }),
    )
    const success = generalScreen.states.find(
      (state) => state.id === 'result-success',
    )?.setup
    const failure = generalScreen.states.find(
      (state) => state.id === 'result-error',
    )?.setup
    const interactions = (code === 'ok' ? success : failure)?.interactions
    const ready = success?.postInteractionReady
    const errorReady = failure?.postInteractionReady
    if (!interactions || !ready || !errorReady)
      throw new Error('Missing General result setup')
    await withScreen(
      <GeneralPage loaderData={{ owner: null }} />,
      async () => {
        // Start with an empty required field so the capture must enter its own draft.
        await page.getByRole('textbox').fill('')
        for (const interaction of interactions) {
          const target = page.elementLocator(
            document.querySelector(interaction.selector)!,
          )
          if (interaction.action === 'fill')
            await target.fill(interaction.value)
          else await target.click()
        }
        if (code === 'ok') await commands.waitForScreenReady(ready)
        else {
          await commands.waitForScreenReady(errorReady)
          await expect(
            commands.waitForScreenReady({ ...ready, timeoutMs: 100 }),
          ).rejects.toThrow('ready condition was not met: ' + ready.description)
        }
      },
      generalScreen.route.en,
      true,
      (args) =>
        updateGeneral({
          ...args,
          context: new RouterContextProvider(),
          pattern: '/settings/general',
          url: new URL(args.request.url),
        }),
    )
  },
)

test.each([
  'result-success',
  'result-error',
  'result-warning',
  'missing-transfer',
] as const)('Japanese Members submission reaches %s', async (id) => {
  const warning = id === 'result-warning' || id === 'missing-transfer'
  const setup = membersScreen.states.find(
    (state) => state.id === (warning ? 'result-warning' : id),
  )?.setup
  const ready = setup?.postInteractionReady
  if (!ready) throw new Error('Missing Members result readiness')
  language.locale = 'ja'
  let removed = false
  const target = {
    ...memberRows.membersPage.members[0],
    id: 'casey-removed-member',
    name: 'Casey Morgan',
    role: 'member' as const,
    isAdmin: false,
  }
  services.removeWorkspaceMember.mockImplementation(() => {
    removed = true
    return { kind: 'ok' }
  })
  services.transferRemovedMemberAssets.mockResolvedValue({ kind: 'invalid' })
  services.revokeWorkspaceMemberCliSessions.mockResolvedValue({
    kind: id === 'result-error' ? 'invalid' : 'ok',
  })
  services.loadWorkspaceMembersPage.mockImplementation(() => ({
    ...memberRows.membersPage,
    members: removed ? [] : [target],
  }))
  services.loadRemovedWorkspaceMembers.mockImplementation(() =>
    removed
      ? [{ ...target, ownedArtifactCount: id === 'missing-transfer' ? 0 : 1 }]
      : [],
  )
  const router = createTestRouter(
    [
      {
        element: (
          <TooltipProvider>
            <SettingsLayout loaderData={shell} />
          </TooltipProvider>
        ),
        children: [
          {
            path: 'settings',
            Component: UNSAFE_withComponentProps(MembersPage),
            loader: (args) =>
              membersLoader({
                ...args,
                context: new RouterContextProvider(),
                params: {},
                pattern: '/settings',
                url: new URL(args.request.url),
              }),
            action: (args) =>
              membersAction({
                ...args,
                context: new RouterContextProvider(),
                params: {},
                pattern: '/settings',
                url: new URL(args.request.url),
              }),
          },
          {
            path: 'settings/recipients',
            loader: () => ({ recipients: [], total: 0, query: '' }),
          },
        ],
      },
    ],
    {
      initialEntries:
        id === 'result-success'
          ? ['/settings?q=first', '/settings?q=second']
          : ['/settings'],
    },
  )
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<RouterProvider router={router} />))
    await page
      .getByRole('button', { name: bindI18n('ja').t('team.members.menu') })
      .click()
    await page
      .getByRole('menuitem', {
        name: bindI18n('ja').t(
          warning ? 'team.members.remove' : 'team.members.revokeCliSessions',
        ),
        exact: true,
      })
      .click()
    await page
      .getByRole('alertdialog')
      .getByRole('button', {
        name: bindI18n('ja').t(
          warning
            ? 'team.members.removeConfirm.action'
            : 'team.members.revokeCliSessions',
        ),
        exact: true,
      })
      .click()
    if (id === 'missing-transfer') {
      await expect
        .element(
          page
            .elementLocator(document.body)
            .getByRole('alertdialog')
            .getByRole('status'),
        )
        .toHaveAttribute('data-settings-status', 'removed-transfer-failed')
      await vi.waitFor(() =>
        expect(
          container.querySelector('[data-transfer-removed-files]:disabled'),
        ).not.toBeNull(),
      )
      await expect(
        commands.waitForScreenReady({ ...ready, timeoutMs: 100 }),
      ).rejects.toThrow('ready condition was not met: ' + ready.description)
    } else await commands.waitForScreenReady(ready)
    if (id === 'result-success') {
      const input = page.getByRole('searchbox')
      await input.fill('Pending search')
      for (const [delta, search] of [
        [-1, '?q=first'],
        [1, '?q=second'],
      ] as const) {
        await act(async () => router.navigate(delta))
        expect(router.state.location.search).toBe(search)
        expect(container.querySelector('[data-settings-status]')).toBeNull()
        // Moving through history drops the unsubmitted draft; the fixture's
        // loader data stands in for that entry's search.
        await expect.element(page.getByRole('searchbox')).toHaveValue('')
      }
    }
    if (id === 'result-warning') {
      const removeCalls = services.removeWorkspaceMember.mock.calls.length
      services.transferRemovedMemberAssets.mockResolvedValue({ kind: 'ok' })
      // The removal went through, so the dialog offers Close, not Cancel.
      await page
        .getByRole('alertdialog')
        .getByRole('button', { name: bindI18n('ja').t('common.close') })
        .click()
      await page
        .getByRole('button', {
          name: bindI18n('ja').t('team.removedMembers.transfer'),
          exact: true,
        })
        .click()
      await page
        .getByRole('alertdialog')
        .getByRole('button', {
          name: bindI18n('ja').t('team.removedMembers.transferConfirm.action'),
          exact: true,
        })
        .click()
      await expect
        .element(page.getByRole('alertdialog'))
        .not.toBeInTheDocument()
      expect(services.removeWorkspaceMember.mock.calls.length).toBe(removeCalls)
      expect(services.transferRemovedMemberAssets.mock.lastCall).toContain(
        target.id,
      )
    }
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})

const ledgerPages = () => [
  {
    path: '/settings',
    content: (
      <MembersPage
        loaderData={{
          ...memberRows,
          filters: { query: '', role: 'all', activity: 'all', page: 1 },
        }}
      />
    ),
  },
  { path: '/settings/bots', content: <BotSection bots={[bot]} canCreate /> },
  {
    path: '/settings/general',
    content: (
      <GeneralPage
        loaderData={{
          owner: {
            id: 'owner',
            name: 'Synthetic owner with AnUnbrokenFamilyNameThatMustRemainFullyReadableOnPhones',
            email: memberEmails[2],
            image: null,
          },
        }}
      />
    ),
  },
  {
    path: '/settings/tokens',
    content: (
      <AiToolsPage
        loaderData={{ tokens: [], cliFamilies: [], createdToken: null }}
      />
    ),
  },
  {
    path: '/settings/external-access',
    content: (
      <ExternalAccessPage
        loaderData={{
          policy: {
            plan: 'team',
            linkSharingEnabled: true,
            externalPostingEnabled: true,
            linkExpiryDefaultDays: 30,
            linkExpiryMaxDays: null,
          },
        }}
      />
    ),
  },
  {
    path: '/settings/billing',
    content: <BillingPage loaderData={billingData} />,
  },
  {
    path: '/settings/activity',
    content: <ActivityPage loaderData={{ events: [], total: 0, page: 1 }} />,
  },
  { path: '/settings/analytics', content: <AnalyticsPage /> },
  {
    path: '/settings/integrations',
    content: <IntegrationsPage loaderData={{ connections: [] }} />,
  },
  {
    path: '/settings/inventory/projects',
    content: (
      <ProjectsPage
        loaderData={{ projects: { projects: [project], total: 1, page: 1 } }}
      />
    ),
  },
  {
    path: '/settings/inventory/artifacts',
    content: (
      <ArtifactsPage
        loaderData={{
          artifacts: { artifacts: [artifact], total: 1, page: 1 },
          filters: { visibility: 'all', sort: 'updated', page: 1 },
        }}
      />
    ),
  },
]
for (const theme of ['light', 'dark'])
  for (const locale of ['en', 'ja'] as const) {
    test(`all Settings ledger pages fit at 390px (${theme}, ${locale})`, async () => {
      const previousTheme = document.documentElement.dataset.theme
      document.documentElement.dataset.theme = theme
      language.locale = locale
      try {
        await page.viewport(390, 844)
        for (const { path, content } of ledgerPages())
          await withScreen(
            content,
            async (container) => {
              expect(container.querySelector('main'), path).not.toBeNull()
              // Settings draws its own top and bottom bars around the page.
              for (const bar of ['#app-topbar', '[data-bottom-tab-bar]'])
                await expect
                  .element(page.elementLocator(container.querySelector(bar)!), {
                    message: `${path} ${bar}`,
                  })
                  .toBeVisible()
              expect(
                document.documentElement.scrollWidth,
                path,
              ).toBeLessThanOrEqual(391)
              for (const element of container.querySelectorAll('main *')) {
                if (
                  !element.checkVisibility({ visibilityProperty: true }) ||
                  element.classList.contains('sr-only')
                )
                  continue
                const bounds = element.getBoundingClientRect()
                if (!bounds.width || !bounds.height) continue
                // Ignore SVG internal geometry; inspect the icon's outer viewport.
                if (element instanceof SVGElement && element.tagName !== 'svg')
                  continue
                expect(
                  bounds.left,
                  `${path}: ${element.tagName} ${element.className}`,
                ).toBeGreaterThanOrEqual(-1)
                expect(
                  bounds.right,
                  `${path}: ${element.tagName} ${element.className}`,
                ).toBeLessThanOrEqual(391)
              }
              if (path === '/settings/general') {
                const address = page
                  .getByText(memberEmails[2], { exact: true })
                  .element()
                if (!(address instanceof HTMLElement))
                  throw new Error('Missing owner address')
                const name = address.previousElementSibling!
                const ownerFits = () => [name, address].every(fits)
                expect(ownerFits()).toBe(true)
                const originals = [name, address].map((el) => el.className)
                try {
                  name.className = 'text-foreground truncate font-medium'
                  address.className = 'truncate'
                  expect(ownerFits()).toBe(false)
                } finally {
                  ;[name, address].forEach((el, index) => {
                    el.className = originals[index]
                  })
                }
                expect(ownerFits()).toBe(true)
              }
              if (path === '/settings') {
                for (const email of memberEmails) {
                  const address = page
                    .getByText(email, { exact: true })
                    .element()
                  if (!(address instanceof HTMLElement))
                    throw new Error('Missing member address')
                  const name = address.previousElementSibling!
                  const row = address.closest('tr')!
                  const cell = address.closest('td')!
                  const table = address.closest(
                    '[data-slot="table-container"]',
                  )!
                  const badges = [
                    ...cell.querySelectorAll('[data-slot="badge"]'),
                  ]
                  const memberFits = () => {
                    const text = document.createRange()
                    text.selectNodeContents(address.parentElement!)
                    const cellBounds = cell.getBoundingClientRect()
                    return (
                      [row, cell, name, address, table, ...badges].every(
                        fits,
                      ) &&
                      badges.every(
                        (badge) =>
                          badge.getBoundingClientRect().top >=
                          address.getBoundingClientRect().bottom - 1,
                      ) &&
                      [...text.getClientRects()].every(
                        (rect) =>
                          rect.left >= cellBounds.left - 1 &&
                          rect.right <= cellBounds.right + 1,
                      )
                    )
                  }
                  expect(memberFits(), email).toBe(true)
                  expect(
                    address.getBoundingClientRect().height,
                  ).toBeGreaterThan(
                    parseFloat(getComputedStyle(address).lineHeight),
                  )
                  const group = cell.firstElementChild!
                  if (!(group instanceof HTMLElement))
                    throw new Error('Missing member group')
                  const originals = [group, address].map((el) => el.className)
                  try {
                    // Restore the horizontal flex group and remove break-all:
                    // only badge-bearing rows had a horizontal group.
                    // Removed members already wrapped anywhere
                    // and fit without the added break-all class.
                    if (badges.length)
                      group.className =
                        'flex min-w-0 items-center gap-[var(--spacing-2)]'
                    address.classList.remove('max-md:break-all')
                    expect(memberFits()).toBe(!badges.length)
                  } finally {
                    ;[group, address].forEach((el, index) => {
                      el.className = originals[index]
                    })
                  }
                  expect(memberFits()).toBe(true)
                  if (email !== memberEmails[2]) {
                    const nameClasses = name.className
                    try {
                      name.className = 'text-foreground truncate font-medium'
                      expect(memberFits()).toBe(false)
                    } finally {
                      name.className = nameClasses
                    }
                    expect(memberFits()).toBe(true)
                  }
                }
              }

              if (
                locale === 'en' &&
                [
                  '/settings/bots',
                  '/settings/inventory/projects',
                  '/settings/external-access',
                  '/settings/billing',
                ].includes(path)
              ) {
                await commands.settingsContrastCapture(
                  '#settings-layout-fixture',
                  `${path.replaceAll('/', '-')}-${theme}`,
                )
              }
            },
            path,
            path === '/settings/billing' ? freePlanShell : true,
          )
      } finally {
        if (previousTheme === undefined)
          delete document.documentElement.dataset.theme
        else document.documentElement.dataset.theme = previousTheme
        await page.viewport(1280, 800)
      }
    })
  }

test.each(
  (['light', 'dark'] as const).flatMap((theme) =>
    (['en', 'ja'] as const).map((locale) => ({ theme, locale })),
  ),
)(
  'Billing selection values and Pricing alignment ($theme, $locale)',
  async ({ theme, locale }) => {
    language.locale = locale
    const previousTheme = document.documentElement.dataset.theme
    document.documentElement.dataset.theme = theme
    const copy = PRICING_COPY[locale]
    try {
      await page.viewport(1440, 900)
      await withScreen(
        <BillingPage loaderData={billingData} />,
        async (container) => {
          for (const interval of ['Monthly', 'Yearly'])
            for (const currency of ['JPY', 'USD']) {
              await page
                .getByRole('button', {
                  name: new RegExp(
                    `^${interval === 'Monthly' ? copy.monthly : copy.yearly}`,
                  ),
                })
                .click()
              await page
                .getByRole('button', { name: currency, exact: true })
                .click()
              const forms = container.querySelectorAll<HTMLFormElement>(
                'form:has(input[name="plan"])',
              )
              expect(forms).toHaveLength(2)
              for (const form of forms) {
                const values = new FormData(form)
                expect(values.get('currency')).toBe(currency.toLowerCase())
                expect(values.get('interval')).toBe(interval.toLowerCase())
              }
              expect(container.querySelectorAll('[data-plan]')).toHaveLength(2)
              for (const card of container.querySelectorAll<HTMLElement>(
                '[data-plan]',
              )) {
                const plan = card.dataset.plan
                if (plan !== 'plus' && plan !== 'team')
                  throw new Error('Unexpected checkout plan')
                const selectedCurrency = currency === 'JPY' ? 'jpy' : 'usd'
                const selectedInterval =
                  interval === 'Monthly' ? 'month' : 'year'
                expect(card.textContent).toContain(
                  formatPrice(
                    selectedCurrency,
                    BILLING_PRICES[plan][selectedCurrency][selectedInterval],
                  ),
                )
              }
            }
        },
        '/settings/billing',
        freePlanShell,
      )
      await withScreen(
        <PricingPage locale={locale} initialCurrency="usd" signedIn={false} />,
        async (container) => {
          const cards = [...container.querySelectorAll('[data-plan]')]
          expect(cards).toHaveLength(3)
          expect(
            new Set(cards.map((card) => card.getBoundingClientRect().top)).size,
          ).toBe(1)
          expect(
            new Set(
              cards.map(
                (card) =>
                  card
                    .querySelector('p')!
                    .nextElementSibling!.getBoundingClientRect().top,
              ),
            ).size,
          ).toBe(1)
        },
        '/pricing',
        false,
      )
    } finally {
      if (previousTheme === undefined)
        delete document.documentElement.dataset.theme
      else document.documentElement.dataset.theme = previousTheme
      await page.viewport(1280, 800)
    }
  },
)

// Native table sizing and clipping cannot be established by static HTML tests.
test.each(['en', 'ja'] as const)(
  'desktop Files keeps all six columns visible (%s)',
  async (locale) => {
    language.locale = locale
    await page.viewport(1440, 900)
    try {
      const entry = ledgerPages().find(
        ({ path }) => path === '/settings/inventory/artifacts',
      )!
      await withScreen(
        entry.content,
        async (container) => {
          const table = container.querySelector('table')!
          const wrapper = table.parentElement!
          const cells = [...table.querySelectorAll('th, td')]
          const columnsFit = () => fits(wrapper) && cells.every(fits)
          expect(table.querySelectorAll('th')).toHaveLength(6)
          expect(columnsFit()).toBe(true)
          const row = table.querySelector('tbody tr')!
          const owner = row.children[1].querySelector('span')!
          const location = row.children[2].querySelector('span')!
          expect(owner.title).toBe(artifact.owner.name)
          expect(location.title).toBe(artifact.location.name)
          const originals = [owner, location].map((el) => el.style.cssText)
          try {
            owner.style.maxWidth = '24rem'
            location.style.maxWidth = 'none'
            expect(columnsFit()).toBe(false)
          } finally {
            ;[owner, location].forEach((el, index) => {
              el.style.cssText = originals[index]
            })
          }
          expect(columnsFit()).toBe(true)
        },
        entry.path,
      )
    } finally {
      await page.viewport(1280, 800)
    }
  },
)

test.each(['members', 'artifacts'] as const)(
  '%s filter drafts submit and reset on Back',
  async (kind) => {
    const members = kind === 'members'
    language.locale = members ? 'en' : 'ja'
    const { t } = bindI18n(language.locale)
    const path = members ? '/settings' : '/settings/inventory/artifacts'
    const fields = members
      ? [
          {
            key: 'role',
            label: t('team.members.filter.role'),
            initialValue: 'admin',
            initialLabel: t('team.members.role.admin'),
            nextValue: 'member',
            nextLabel: t('team.members.role.member'),
          },
          {
            key: 'activity',
            label: t('team.members.filter.activity'),
            initialValue: 'active',
            initialLabel: t('team.members.filter.activity.active'),
            nextValue: 'inactive',
            nextLabel: t('team.members.filter.activity.inactive'),
          },
        ]
      : [
          {
            key: 'visibility',
            label: t('team.inventory.filter'),
            initialValue: 'private',
            initialLabel: t('table.visibilityPrivate'),
            nextValue: 'workspace',
            nextLabel: t('table.visibilityWorkspace'),
          },
          {
            key: 'sort',
            label: t('team.inventory.sort'),
            initialValue: 'size',
            initialLabel: t('team.inventory.sort.size'),
            nextValue: 'updated',
            nextLabel: t('team.inventory.sort.updated'),
          },
        ]
    const initialSearch = new URLSearchParams(
      fields.map(({ key, initialValue }) => [key, initialValue]),
    ).toString()
    const router = createTestRouter(
      [
        {
          element: (
            <TooltipProvider>
              <SettingsLayout loaderData={shell} />
            </TooltipProvider>
          ),
          children: [
            {
              path,
              loader: ({ request }) => new URL(request.url).search,
              Component: () => {
                const params = new URLSearchParams(useLoaderData<string>())
                const role = params.get('role'),
                  activity = params.get('activity'),
                  visibility = params.get('visibility')
                const matchingMembers = memberRows.membersPage.members.filter(
                  (member) => member.role === role,
                )
                return members ? (
                  <MembersPage
                    loaderData={{
                      ...memberRows,
                      membersPage: {
                        members: matchingMembers,
                        total: matchingMembers.length,
                        page: 1,
                      },
                      filters: {
                        query: params.get('q') ?? '',
                        page: 1,
                        role:
                          role === 'admin' ||
                          role === 'member' ||
                          role === 'owner'
                            ? role
                            : 'all',
                        activity:
                          activity === 'active' || activity === 'inactive'
                            ? activity
                            : 'all',
                      },
                    }}
                  />
                ) : (
                  <ArtifactsPage
                    loaderData={{
                      artifacts: { artifacts: [artifact], total: 1, page: 1 },
                      filters: {
                        page: 1,
                        visibility:
                          visibility === 'private' ||
                          visibility === 'workspace' ||
                          visibility === 'link' ||
                          visibility === 'project'
                            ? visibility
                            : 'all',
                        sort:
                          params.get('sort') === 'size' ? 'size' : 'updated',
                      },
                    }}
                  />
                )
              },
            },
          ],
        },
      ],
      { initialEntries: [path + '?' + initialSearch] },
    )
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    const unmount = vi.spyOn(root, 'unmount')
    try {
      await act(async () => root.render(<RouterProvider router={router} />))
      await waitForBrowserLayout()
      for (const { label, initialLabel } of fields) {
        const trigger = page.getByRole('combobox', { name: label, exact: true })
        await expect.element(trigger).toHaveTextContent(initialLabel)
        const fieldLabel = container.querySelector(
          `label[for="${trigger.element().id}"]`,
        )!
        expect(fieldLabel.textContent).toBe(label)
        await expect.element(page.elementLocator(fieldLabel)).toBeVisible()
        // A screen-reader-only label still has a layout box, just one pixel high.
        expect(
          fieldLabel.getBoundingClientRect().height,
        ).toBeGreaterThanOrEqual(
          Number.parseFloat(getComputedStyle(fieldLabel).fontSize),
        )
      }
      for (const { label, nextLabel } of fields) {
        const trigger = page.getByRole('combobox', { name: label, exact: true })
        await trigger.click()
        await page.getByRole('option', { name: nextLabel, exact: true }).click()
        await expect.element(trigger).toHaveTextContent(nextLabel)
      }
      const search = () => {
        const form = page
          .getByRole('combobox', { name: fields[0].label, exact: true })
          .element()
          .closest('form')!
        return page
          .elementLocator(form)
          .getByRole('button', {
            name: t(
              members
                ? 'team.members.filter.apply'
                : 'team.inventory.filter.apply',
            ),
            exact: true,
          })
          .click()
      }
      await search()
      if (members)
        await expect
          .element(page.getByText(t('team.members.noMatches'), { exact: true }))
          .toBeVisible()
      await vi.waitFor(() => {
        expect(router.state.location.pathname).toBe(path)
        for (const { key, nextValue } of fields)
          expect(
            new URLSearchParams(router.state.location.search).get(key),
          ).toBe(nextValue)
      })
      for (const { label, nextLabel } of fields)
        await expect
          .element(page.getByRole('combobox', { name: label, exact: true }))
          .toHaveTextContent(nextLabel)
      await act(async () => router.navigate(-1))
      expect(
        router.state.location.pathname + router.state.location.search,
      ).toBe(path + '?' + initialSearch)
      for (const { label, initialLabel } of fields)
        await expect
          .element(page.getByRole('combobox', { name: label, exact: true }))
          .toHaveTextContent(initialLabel)
      if (!members) {
        const apply = page
          .getByRole('button', {
            name: t('team.inventory.filter.apply'),
            exact: true,
          })
          .element()
        const restoredKey = router.state.location.key
        await search()
        await vi.waitFor(() => {
          expect(router.state.location.key).not.toBe(restoredKey)
          expect(router.state.location.search).toBe('?' + initialSearch)
        })
        await waitForBrowserLayout()
        expect(document.activeElement).toBe(apply)
      }
    } finally {
      await act(async () => root.unmount())
      container.remove()
      language.locale = 'en'
    }
    expect(unmount).toHaveBeenCalledOnce()
    expect(container.isConnected).toBe(false)
    expect(language.locale).toBe('en')
  },
)

test.each(['light', 'dark', 'system-dark'] as const)(
  'Slack reauthorization explanation meets 7:1 in %s',
  async (theme) => {
    if (theme === 'system-dark') {
      const original = document.documentElement.dataset.theme
      onTestFinished(() => {
        if (original === undefined)
          delete document.documentElement.dataset.theme
        else document.documentElement.dataset.theme = original
      })
      document.documentElement.dataset.theme = 'light'
    }
    const before = document.documentElement.dataset.theme
    const darkScheme = matchMedia('(prefers-color-scheme: dark)')
    const previousDark = darkScheme.matches
    try {
      if (theme === 'system-dark') {
        delete document.documentElement.dataset.theme
        await commands.setMermaidColorScheme('dark')
        expect(matchMedia('(prefers-color-scheme: dark)').matches).toBe(true)
      } else document.documentElement.dataset.theme = theme
      for (const admin of [true, false]) {
        const router = createTestRouter([
          {
            element: (
              <TooltipProvider>
                <Outlet context={{ currentUserIsAdmin: admin }} />
              </TooltipProvider>
            ),
            children: [
              {
                path: '/',
                element: (
                  <IntegrationsPage
                    loaderData={{
                      connections: [
                        {
                          id: 'slack',
                          teamName: 'Reports',
                          installedAt: '2026-01-01',
                          installedByName: 'Owner',
                          needsReauthorization: true,
                        },
                      ],
                    }}
                  />
                ),
              },
            ],
          },
        ])
        const container = document.createElement('div')
        document.body.appendChild(container)
        const root = createRoot(container)
        const unmount = vi.spyOn(root, 'unmount')
        try {
          await act(async () => root.render(<RouterProvider router={router} />))
          await waitForBrowserLayout()
          const body = container.querySelector<HTMLElement>(
            '.bg-warning-soft p:last-child',
          )!
          expect(textContrast(body)).toBeGreaterThanOrEqual(7)
          if (theme === 'dark') {
            body.style.color = 'var(--muted-foreground)'
            expect(textContrast(body)).toBeLessThan(7)
          }
        } finally {
          await act(async () => root.unmount())
          container.remove()
        }
        expect(unmount).toHaveBeenCalledOnce()
        expect(container.isConnected).toBe(false)
      }
    } finally {
      if (before === undefined) delete document.documentElement.dataset.theme
      else document.documentElement.dataset.theme = before
      if (theme === 'system-dark') {
        await commands.setMermaidColorScheme(null)
        expect(darkScheme.matches).toBe(previousDark)
      }
      expect(document.documentElement.dataset.theme).toBe(before)
    }
  },
)
