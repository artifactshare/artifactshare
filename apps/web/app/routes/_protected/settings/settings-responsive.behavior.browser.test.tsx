import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test } from 'vitest'
import { commands } from 'vitest/browser'
import { waitForBrowserLayout } from '~/test/browser-layout'
import '~/app.css'
import { type ReactNode } from 'react'
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router'
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
import { ProjectsTable } from './inventory/+components/projects-table'
import { ArtifactsTable } from './inventory/+components/artifacts-table'
import { BotSection } from './+components/bot-section'
import ExternalAccessPage from './external-access'
import SettingsLayout from './_layout'
const language = vi.hoisted(() => ({ locale: 'en' as 'en' | 'ja' }))
vi.mock('~/hooks/use-t', () => ({ useT: () => bindI18n(language.locale) }))
vi.mock('~/services/link-sharing.server', () => ({}))
vi.mock('~/services/team-management.server', () => ({}))
vi.mock('~/services/project-membership.server', () => ({}))
vi.mock('~/services/db.server', () => ({}))
vi.mock('~/middleware/context', () => ({}))
import MembersPage from './index'
import GeneralPage from './general'
import ActivityPage from './activity'
import AnalyticsPage from './analytics'
import IntegrationsPage from './integrations'
import AiToolsPage from './+components/ai-tools-page'
import BillingPage from './billing'
import ProjectsPage from './inventory/projects'
import ArtifactsPage from './inventory/artifacts'
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
async function withScreen(
  content: ReactNode,
  inspect: (container: HTMLDivElement) => Promise<void>,
  path = '/settings/bots',
  settingsShell = true,
) {
  const router = createMemoryRouter(
    [
      {
        element: (
          <TooltipProvider>
            {settingsShell ? <SettingsLayout loaderData={shell} /> : <Outlet />}
          </TooltipProvider>
        ),
        children: [{ path, element: content }],
      },
    ],
    { initialEntries: [path] },
  )
  const container = document.createElement('div')
  container.id = 'settings-layout-fixture'
  document.body.appendChild(container)
  const root = createRoot(container)
  try {
    await act(async () => root.render(<RouterProvider router={router} />))
    await waitForBrowserLayout()
    await inspect(container)
  } finally {
    await act(async () => root.unmount())
    router.dispose()
    container.remove()
  }
}
function fits(element: Element) {
  const rect = element.getBoundingClientRect()
  // One CSS pixel allows fractional font/layout rounding, not hidden overflow.
  return (
    rect.left >= -1 &&
    rect.right <= innerWidth + 1 &&
    element.scrollWidth <= element.clientWidth + 1
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

for (const theme of ['light', 'dark'])
  for (const locale of ['en', 'ja'] as const) {
    test(`phone inventory cards, empty states and bot wrapping (${theme}, ${locale})`, async () => {
      const previousTheme = document.documentElement.dataset.theme
      document.documentElement.dataset.theme = theme
      language.locale = locale
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
        for (const width of [390, 599, 600, 1440]) {
          await page.viewport(width, 844)
          await withScreen(
            <ProjectsTable rows={[project]} locale={locale} />,
            async (container) => {
              const card = container.querySelector('article')!
              const table = container.querySelector('table')!
              expect(card.checkVisibility()).toBe(width < 600)
              expect(table.checkVisibility()).toBe(width >= 600)
              if (width < 600) {
                expect(fits(card)).toBe(true)
                expect(card.textContent).toContain('7')
                expect(card.textContent).toContain('2 KB')
                expect(card.textContent).toContain(
                  bindI18n(locale).t('team.inventory.archived'),
                )
                expect(card.querySelector('a')?.getAttribute('href')).toBe(
                  '/projects/reports',
                )
              }
            },
            '/settings/inventory/projects',
          )
          await withScreen(
            <ArtifactsTable rows={[artifact]} locale={locale} />,
            async (container) => {
              if (width < 600) {
                const card = container.querySelector('article')!
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
                if (width < 600) {
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
  plan: 'free',
  stripeSubscriptionStatus: '',
  hasSubscription: false,
  billingConfigured: true,
  defaultCurrency: 'jpy' as const,
  initialPlan: 'team' as const,
  initialInterval: 'monthly' as const,
  storageUsedBytes: 0,
  storageQuotaBytes: 100000000000,
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
const ledgerPages = () => [
  {
    path: '/settings',
    content: (
      <MembersPage
        loaderData={{
          currentUserIsAdmin: true,
          currentUserRole: 'owner',
          membersPage: {
            members: [
              {
                id: 'long-member',
                name: 'Active member',
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
              name: 'Removed member',
              email: memberEmails[1],
              image: null,
              ownedArtifactCount: 2,
            },
          ],
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
            name: 'Owner',
            email: 'owner@example.test',
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
              if (path === '/settings') {
                for (const email of memberEmails) {
                  const address = page
                    .getByText(email, { exact: true })
                    .element()
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
                    text.selectNodeContents(address)
                    const cellBounds = cell.getBoundingClientRect()
                    return (
                      [row, cell, address, table, ...badges].every(fits) &&
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
                  for (const badge of badges) {
                    expect(
                      badge.getBoundingClientRect().top,
                    ).toBeGreaterThanOrEqual(
                      address.getBoundingClientRect().bottom - 1,
                    )
                  }
                  expect(
                    address.getBoundingClientRect().height,
                  ).toBeGreaterThan(
                    parseFloat(getComputedStyle(address).lineHeight),
                  )
                  const group = cell.firstElementChild!
                  if (!(group instanceof HTMLElement))
                    throw new Error('Missing member group')
                  const originals = [group, address].map(
                    (el) => el.style.cssText,
                  )
                  try {
                    // Restore the reviewed horizontal badges; for the badge-free
                    // removed row, inject an unbreakable address to check text bounds.
                    group.style.flexDirection = 'row'
                    group.style.alignItems = 'center'
                    address.style.wordBreak = 'normal'
                    if (!badges.length) {
                      address.style.overflowWrap = 'normal'
                      address.style.whiteSpace = 'nowrap'
                    }
                    expect(memberFits()).toBe(false)
                  } finally {
                    ;[group, address].forEach((el, index) => {
                      el.style.cssText = originals[index]
                    })
                  }
                  expect(memberFits()).toBe(true)
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
