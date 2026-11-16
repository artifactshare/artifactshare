import axe from 'axe-core'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { page } from 'vitest/browser'
import '~/app.css'
import { auditGaps } from '~/lib/gap-audit'
import { TooltipProvider } from '~/components/ui/tooltip'
import { ScenarioPage } from './index'
import { scenarioRegistry } from './+components/scenarios'
import {
  scenarioSnapshotExpression,
  SCENARIO_CONDITIONS,
  SCENARIO_CONTRACTS,
  validateScenarioSnapshot,
  VISUAL_FAULT,
  VIEWPORTS,
} from '~/test/scenario-regression-contract'

let root: Root | undefined
let consoleError: ReturnType<typeof vi.spyOn> | undefined
const runtimeErrors: string[] = []
const recordRuntimeError = (message: string) => runtimeErrors.push(message)
const onRuntimeError = (event: ErrorEvent) => recordRuntimeError(event.message)

function mount(
  scenario: keyof typeof SCENARIO_CONTRACTS,
  theme: 'light' | 'dark',
) {
  const locale = scenarioRegistry[scenario].locale ?? 'en'
  document.documentElement.lang = locale
  if (scenario.startsWith('search-')) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: RequestInfo | URL) => {
        if (String(url).includes('search-logs'))
          return Response.json({
            searches: [
              {
                id: 'fixture-history',
                query: 'planning',
                filters_json: JSON.stringify({
                  query: 'planning',
                  sort: 'newest',
                  filters: { ownerUserIds: ['fixture-owner'] },
                }),
                selectedScope: {
                  owners: [{ id: 'fixture-owner', name: 'Alex Morgan' }],
                  projects: [],
                },
              },
            ],
          })
        if (scenario === 'search-loading')
          return new Promise<Response>(() => {})
        if (scenario === 'search-continuation-error')
          return new Response(null, { status: 503 })
        if (String(url).includes('search-groups'))
          return Response.json({
            items: [
              {
                id: 'fixture-member',
                title: 'Quarterly planning report 2',
                ownerId: 'fixture-owner',
                ownerName: 'Alex Morgan',
                updatedAt: '2026-09-15T12:00:00Z',
                lastViewedAt: null,
                receipt: 'fixture-member',
              },
            ],
            total: { value: 2, relation: 'eq' },
            nextCursor: null,
            searchLogId: 'fixture-search',
          })
        return Response.json({
          files: [
            {
              id: 'fixture-report',
              title: 'Quarterly planning report',
              ownerName: 'Alex Morgan',
              project: { id: 'fixture-project', name: 'Launch review' },
              path: 'index.html',
              artifactKind: 'html_page',
              visibility: 'workspace',
              lastViewedAt: '2026-09-16T12:00:00Z',
              excerpt:
                'The planning report collects decisions and follow-up work for the next release.',
            },
          ],
          owners: [{ id: 'fixture-owner', name: 'Alex Morgan', fileCount: 37 }],
          projects: [{ id: 'fixture-project', name: 'Launch review' }],
          recent: [
            {
              id: 'fixture-report',
              title: 'Quarterly planning report',
              ownerName: 'Alex Morgan',
              artifactKind: 'html_page',
            },
          ],
        })
      }),
    )
  }
  document.documentElement.dataset.theme = theme
  document.documentElement.style.colorScheme = theme
  const style = document.createElement('style')
  style.textContent =
    '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}'
  const host = document.createElement('div')
  document.head.appendChild(style)
  document.body.replaceChildren(host)
  const router = createMemoryRouter(
    [
      {
        id: 'root',
        path: '*',
        loader: () => ({ locale, appTheme: theme }),
        element: (
          <TooltipProvider delayDuration={300} disableHoverableContent>
            <ScenarioPage scenario={scenario} theme={theme} />
          </TooltipProvider>
        ),
      },
    ],
    { initialEntries: [`/dev/scenarios/${scenario}?theme=${theme}`] },
  )
  root = createRoot(host)
  root.render(<RouterProvider router={router} />)
}

async function settle() {
  await vi.waitFor(() => expect(document.querySelector('main')).not.toBeNull())
  await document.fonts.ready
  await Promise.all(
    [...document.images].map(async (image) => {
      if (!image.complete)
        await new Promise<void>((resolve, reject) => {
          image.addEventListener('load', () => resolve(), { once: true })
          image.addEventListener(
            'error',
            () => reject(new Error(`Image failed: ${image.currentSrc}`)),
            { once: true },
          )
        })
      if (image.naturalWidth === 0)
        throw new Error(`Image has no pixels: ${image.currentSrc}`)
      await image.decode()
    }),
  )
  await new Promise(requestAnimationFrame)
  window.scrollTo(0, 0)
}

async function runInteractions(scenario: keyof typeof SCENARIO_CONTRACTS) {
  for (const interaction of SCENARIO_CONTRACTS[scenario].interactions ?? []) {
    const target = document.querySelector(interaction.selector)
    if (!target)
      throw new Error(`interaction target missing: ${interaction.selector}`)
    if (interaction.type === 'hover') {
      const overlays = [
        ...document.querySelectorAll<HTMLElement>(
          '[data-regression-overlay="drop-catcher"]',
        ),
      ]
      for (const overlay of overlays) overlay.style.pointerEvents = 'none'
      try {
        await page.elementLocator(target).hover()
      } finally {
        for (const overlay of overlays) overlay.style.pointerEvents = ''
      }
    }
    if (interaction.type === 'click') await page.elementLocator(target).click()
    if (interaction.readySelector)
      await vi.waitFor(() =>
        expect(
          document.querySelector(interaction.readySelector!),
        ).not.toBeNull(),
      )
    if (interaction.waitMs)
      await new Promise((resolve) => setTimeout(resolve, interaction.waitMs))
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  root?.unmount()
  root = undefined
  consoleError?.mockRestore()
  consoleError = undefined
  runtimeErrors.length = 0
  window.removeEventListener('error', onRuntimeError)
  document.head.querySelectorAll('style').forEach((style) => {
    if (style.textContent?.includes('caret-color:transparent')) style.remove()
  })
})

describe('scenario visual regression', () => {
  test.each(SCENARIO_CONDITIONS)(
    '$scenario-$viewport-$theme',
    async ({ scenario, viewport, theme }) => {
      const size = VIEWPORTS[viewport]
      await page.viewport(size.width, size.height)
      consoleError = vi.spyOn(console, 'error')
      window.addEventListener('error', onRuntimeError)
      mount(scenario, theme)
      await settle()
      // Previous scenario interactions must not leave a link hovered in this one.
      await page.elementLocator(document.documentElement).hover({
        position: { x: 0, y: 0 },
      })
      await runInteractions(scenario)
      if (scenario === 'search-continuation-error')
        await expect.element(page.getByRole('alert')).toBeVisible()
      if (scenario.startsWith('search-mobile-search'))
        await vi.waitFor(() =>
          expect(
            page.getByRole('status').last().element().textContent,
          ).not.toMatch(/Searching|検索中/),
        )

      if (VISUAL_FAULT === 'header') {
        const header = document.querySelector('#viewer-topbar')
        if (header) {
          const injected = document.createElement('div')
          injected.setAttribute('aria-hidden', 'true')
          injected.style.cssText =
            'height:30px;width:5px;background:#f0f;position:absolute;right:0;top:0'
          header.appendChild(injected)
        }
      }
      const snapshot = scenarioSnapshotExpression()()
      if (VISUAL_FAULT === 'geometry') snapshot.mainCount = 0
      expect(
        validateScenarioSnapshot(
          snapshot,
          SCENARIO_CONTRACTS[scenario],
          viewport,
        ),
      ).toEqual([])
      if (VISUAL_FAULT === 'axe') {
        const image = document.createElement('img')
        image.src = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='
        document.body.appendChild(image)
      }
      const axeResult = await axe.run(document, {
        runOnly: {
          type: 'tag',
          values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
        },
      })
      expect(axeResult.violations).toEqual([])
      if (VISUAL_FAULT === 'runtime')
        recordRuntimeError('injected runtime failure')
      expect(runtimeErrors).toEqual([])
      expect(consoleError).not.toHaveBeenCalled()
      if (VISUAL_FAULT === 'image') {
        const overlay = document.createElement('div')
        overlay.setAttribute('aria-hidden', 'true')
        overlay.style.cssText =
          'position:fixed;inset:0;background:rgb(255 0 255);z-index:2147483647'
        document.body.appendChild(overlay)
      }
      const gapFindings = auditGaps()
      expect(
        gapFindings,
        `Gap audit findings: ${JSON.stringify(gapFindings)}`,
      ).toEqual([])
      await expect(
        page.elementLocator(document.documentElement),
      ).toMatchScreenshot(`scenario-${scenario}-${viewport}-${theme}.png`)
      if (SCENARIO_CONTRACTS[scenario].headerSelector) {
        const header = document.querySelector(
          SCENARIO_CONTRACTS[scenario].headerSelector,
        )
        if (!header) throw new Error('viewer header missing')
        await expect(page.elementLocator(header)).toMatchScreenshot(
          `scenario-${scenario}-${viewport}-${theme}-header.png`,
          { comparatorOptions: { allowedMismatchedPixelRatio: 0 } },
        )
      }
    },
  )
})
