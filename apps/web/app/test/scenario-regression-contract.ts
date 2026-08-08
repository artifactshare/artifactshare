import {
  SCENARIO_IDS,
  scenarioRegistry,
  type ScenarioId,
} from '~/routes/dev.scenarios.$scenario/+components/scenarios'

declare const __VISUAL_FAULT__: string | null

export const VIEWPORTS = {
  mobile: { width: 390, height: 844 },
  'mobile-short': { width: 390, height: 667 },
  desktop: { width: 1440, height: 900 },
} as const

type Viewport = keyof typeof VIEWPORTS
type Theme = 'light' | 'dark'

const themes: readonly Theme[] = ['light', 'dark']
const standardViewports: readonly Viewport[] = ['mobile', 'desktop']
const shortViewportScenarios = new Set<ScenarioId>([
  'focused-sign-in',
  'focused-device',
  'focused-consent',
  'viewer-forbidden',
  'viewer-unexpected',
])

export const SCENARIO_CONDITIONS = SCENARIO_IDS.flatMap((scenario) => [
  ...standardViewports.flatMap((viewport) =>
    themes.map((theme) => ({ scenario, viewport, theme })),
  ),
  ...(shortViewportScenarios.has(scenario)
    ? themes.map((theme) => ({
        scenario,
        viewport: 'mobile-short' as const,
        theme,
      }))
    : []),
])

export interface ScenarioContract {
  requiredRegions: readonly string[]
  interactions?: readonly {
    selector: string
    type: 'hover'
    waitMs: number
  }[]
  headerSelector?: string
  requiresHeading?: boolean
  requiresPrimary?: boolean
  requiresOverlay?: boolean
}

export const SCENARIO_CONTRACTS = Object.fromEntries(
  SCENARIO_IDS.map((scenario) => {
    const definition = scenarioRegistry[scenario]
    return [
      scenario,
      {
        requiredRegions: definition.requiredRegions,
        requiresHeading: definition.requiresHeading,
        requiresPrimary: definition.requiresPrimary,
        requiresOverlay: definition.requiresOverlay,
        ...(scenario.startsWith('viewer-') && !definition.viewerError
          ? { headerSelector: '#viewer-topbar' }
          : {}),
        ...(scenario === 'viewer-tooltip-open'
          ? {
              interactions: [
                {
                  selector: '[aria-label="Collapse Artifact Share"]',
                  type: 'hover' as const,
                  waitMs: 350,
                },
              ],
            }
          : {}),
      },
    ]
  }),
) as Record<ScenarioId, ScenarioContract>

export const VISUAL_FAULT = __VISUAL_FAULT__ as
  | 'geometry'
  | 'axe'
  | 'runtime'
  | 'image'
  | 'header'
  | null

export function scenarioSnapshotExpression() {
  return () => ({
    mainCount: document.querySelectorAll('main').length,
    headingCount: document.querySelectorAll('h1').length,
    primaryCount: document.querySelectorAll('[data-regression-primary]').length,
    overlayCount: document.querySelectorAll('[data-regression-overlay]').length,
    regions: [...document.querySelectorAll('[data-regression-region]')].map(
      (element) => element.getAttribute('data-regression-region'),
    ),
  })
}

export function validateScenarioSnapshot(
  snapshot: ReturnType<ReturnType<typeof scenarioSnapshotExpression>>,
  contract: ScenarioContract,
  viewport: string,
) {
  const findings: string[] = []
  if (snapshot.mainCount !== 1) findings.push(`main:${snapshot.mainCount}`)
  if (contract.requiresHeading && snapshot.headingCount !== 1)
    findings.push(`heading:${snapshot.headingCount}`)
  if (contract.requiresPrimary && snapshot.primaryCount < 1)
    findings.push('primary:missing')
  if (contract.requiresOverlay && snapshot.overlayCount < 1)
    findings.push('overlay:missing')
  for (const region of contract.requiredRegions)
    if (!snapshot.regions.includes(region)) findings.push(`region:${region}`)
  if (!(viewport in VIEWPORTS)) findings.push(`viewport:${viewport}`)
  return findings
}

export function headingSnapshotExpression() {
  return () => ({
    galleryHeadingCount: document.querySelectorAll('#gallery-heading').length,
    mainCount: document.querySelectorAll('main').length,
    sectionHeadingCount: document.querySelectorAll('main section h2').length,
  })
}

export function validateHeadingSnapshot(
  snapshot: ReturnType<ReturnType<typeof headingSnapshotExpression>>,
) {
  const findings: string[] = []
  if (snapshot.galleryHeadingCount !== 1)
    findings.push(`gallery-heading:${snapshot.galleryHeadingCount}`)
  if (snapshot.mainCount !== 1) findings.push(`main:${snapshot.mainCount}`)
  if (snapshot.sectionHeadingCount < 1) findings.push('section-heading:missing')
  return findings
}
