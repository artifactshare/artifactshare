import axe from 'axe-core'
import { createRoot, type Root } from 'react-dom/client'
import { createMemoryRouter, RouterProvider } from 'react-router'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { page } from 'vitest/browser'
import '~/app.css'
import { auditGaps } from '~/lib/gap-audit'
import { TooltipProvider } from '~/components/ui/tooltip'
import { ScenarioPage } from './index'
import {
  scenarioSnapshotExpression,
  SCENARIO_CONDITIONS,
  SCENARIO_CONTRACTS,
  validateScenarioSnapshot,
  VISUAL_FAULT,
  VIEWPORTS,
} from 'virtual:scenario-regression-contract'

let root: Root | undefined
let consoleError: ReturnType<typeof vi.spyOn> | undefined
const runtimeErrors: string[] = []
const recordRuntimeError = (message: string) => runtimeErrors.push(message)
const onRuntimeError = (event: ErrorEvent) => recordRuntimeError(event.message)

function mount(
  scenario: keyof typeof SCENARIO_CONTRACTS,
  theme: 'light' | 'dark',
) {
  document.documentElement.lang = 'en'
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
        loader: () => ({ locale: 'en', appTheme: theme }),
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
      await page.elementLocator(target).hover()
    }
    await new Promise((resolve) => setTimeout(resolve, interaction.waitMs))
  }
}

afterEach(() => {
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
      await runInteractions(scenario)
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
