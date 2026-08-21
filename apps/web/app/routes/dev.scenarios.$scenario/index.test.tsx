import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryRouter } from 'react-router'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { TooltipProvider } from '~/components/ui/tooltip'

const isViteDevMock = vi.hoisted(() => vi.fn(() => true))

vi.mock('~/lib/is-vite-dev', () => ({
  isViteDev: isViteDevMock,
}))

vi.mock('~/hooks/use-t', () => ({
  useT: () => ({
    locale: 'en',
    t: (key: string) => key,
    tPlural: (key: string, count: number) => `${key}:${count}`,
  }),
}))

vi.mock('~/components/app/public-footer', () => ({
  PublicFooter: ({
    variant = 'full',
    'data-regression-region': regressionRegion,
  }: {
    variant?: string
    'data-regression-region'?: string
  }) => (
    <footer
      data-slot="public-footer"
      data-variant={variant}
      data-regression-region={regressionRegion}
    />
  ),
}))

vi.mock('~/components/app/avatar-menu', () => ({
  AvatarMenu: () => <button type="button">Fixture account</button>,
}))

vi.mock('~/routes/a.$id/+hooks/use-remove-artifact', () => ({
  useRemoveArtifact: () => vi.fn(),
}))

vi.mock('~/routes/a.$id/+hooks/use-edit-title', () => ({
  useEditTitle: () => ({
    isEditing: false,
    value: '',
    start: vi.fn(),
    cancel: vi.fn(),
    change: vi.fn(),
    submit: vi.fn(),
  }),
}))

vi.mock('react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router')>()),
  useRouteLoaderData: () => ({ maintenance: false }),
  useViewTransitionState: () => false,
}))

import {
  loader,
  meta,
  ScenarioPage,
  scenarioRegistry,
  SCENARIO_IDS,
} from './index'

function renderScenario(id: (typeof SCENARIO_IDS)[number]) {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/dev/scenarios/${id}`]}>
      <TooltipProvider>
        <ScenarioPage scenario={id} />
      </TooltipProvider>
    </MemoryRouter>,
  )
}

function expect404(run: () => unknown) {
  try {
    run()
    expect.unreachable('expected a 404 Response')
  } catch (error) {
    expect(error).toBeInstanceOf(Response)
    expect((error as Response).status).toBe(404)
  }
}

beforeEach(() => {
  isViteDevMock.mockReset()
  isViteDevMock.mockReturnValue(true)
})

describe('/dev/scenarios/:scenario loader', () => {
  test('allows every registered scenario in Vite dev', () => {
    for (const scenario of SCENARIO_IDS) {
      expect(loader({ params: { scenario } })).toEqual({ scenario })
    }
  })

  test('returns 404 for unknown scenarios', () => {
    expect404(() => loader({ params: { scenario: 'not-a-scenario' } }))
    expect404(() => loader({ params: { scenario: 'toString' } }))
    expect404(() => loader({ params: { scenario: '__proto__' } }))
  })

  test('returns 404 outside Vite dev', () => {
    isViteDevMock.mockReturnValue(false)
    expect404(() => loader({ params: { scenario: 'landing-default' } }))
  })
})

describe('scenario registry and required contracts', () => {
  test('has 14 unique fixed ids', () => {
    expect(SCENARIO_IDS).toHaveLength(14)
    expect(new Set(SCENARIO_IDS).size).toBe(14)
    expect(Object.keys(scenarioRegistry).sort()).toEqual(
      [...SCENARIO_IDS].sort(),
    )
  })

  test.each(SCENARIO_IDS)('%s has its required shell contract', (scenario) => {
    const definition = scenarioRegistry[scenario]
    const html = renderScenario(scenario)

    expect(html).toContain(`data-regression-scenario="${scenario}"`)
    for (const region of definition.requiredRegions) {
      expect(html).toContain(`data-regression-region="${region}"`)
    }
    expect(html.match(/<main\b/g) ?? []).toHaveLength(1)
    if (definition.requiresHeading) {
      expect(html.match(/<h1\b/g) ?? []).toHaveLength(1)
    }
    if (definition.requiresPrimary) {
      expect(html).toContain('data-regression-primary=')
    }
    if (definition.requiresOverlay) {
      expect(html).toContain('data-regression-overlay="drop-catcher"')
    }
    for (const marker of definition.requiredMarkers ?? []) {
      expect(html).toContain(marker)
    }
    if (definition.viewerError) {
      expect(html).toContain('role="heading"')
      expect(html).toContain('aria-level="2"')
      expect(html.match(/<h1\b/g) ?? []).toHaveLength(0)
      expect(html).toContain('<div data-regression-region="header"><header')
      expect(html).toContain('data-regression-region="main"')
      expect(html.match(/data-regression-region="header"/g) ?? []).toHaveLength(
        1,
      )
      expect(html.match(/data-regression-region="main"/g) ?? []).toHaveLength(1)
    }
    if (scenario === 'viewer-default') {
      const markerIndex = html.indexOf('data-regression-overlay="drop-catcher"')
      const overlayTagStart = html.lastIndexOf('<div', markerIndex)
      const overlayTagEnd = html.indexOf('>', markerIndex)
      expect(markerIndex).toBeGreaterThan(-1)
      expect(html.slice(overlayTagStart, overlayTagEnd)).toContain(
        'outline-link',
      )
    }
  })
})

test('uses the dev scenario document title', () => {
  expect(meta()).toEqual([{ title: 'Product shell regression scenarios' }])
})
