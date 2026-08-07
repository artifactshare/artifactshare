declare module 'virtual:scenario-regression-contract' {
  type ScenarioId =
    | 'app-home-content'
    | 'app-home-empty'
    | 'focused-consent'
    | 'focused-device'
    | 'focused-sign-in'
    | 'landing-ai-open'
    | 'landing-default'
    | 'landing-invite'
    | 'public-about'
    | 'public-guide'
    | 'public-pricing'
    | 'viewer-default'
    | 'viewer-tooltip-open'
    | 'viewer-forbidden'
    | 'viewer-unexpected'

  export const SCENARIO_CONDITIONS: ReadonlyArray<{
    scenario: ScenarioId
    theme: 'light' | 'dark'
    viewport: 'mobile' | 'mobile-short' | 'desktop'
  }>
  interface ScenarioInteraction {
    selector: string
    type: 'hover'
    waitMs: number
  }
  interface ScenarioContract {
    requiredRegions: readonly string[]
    interactions?: readonly ScenarioInteraction[]
    headerSelector?: string
    requiresMobileTitleTruncation?: boolean
    requiresTooltip?: boolean
  }
  export const SCENARIO_CONTRACTS: Record<ScenarioId, ScenarioContract>
  export const VIEWPORTS: Record<string, { width: number; height: number }>
  export const VISUAL_FAULT:
    | 'geometry'
    | 'axe'
    | 'runtime'
    | 'image'
    | 'header'
    | null
  export function scenarioSnapshotExpression(): () => any
  export function validateScenarioSnapshot(
    snapshot: any,
    contract: ScenarioContract,
    viewport: string,
  ): string[]
  export function headingSnapshotExpression(): () => any
  export function validateHeadingSnapshot(snapshot: any): string[]
}
