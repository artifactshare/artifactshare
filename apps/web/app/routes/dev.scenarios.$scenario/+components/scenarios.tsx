import { SearchFixture } from './search-fixture'
import type { ElementType } from 'react'
import { FocusedConsentFixture } from './focused-consent-fixture'
import { FocusedDeviceFixture } from './focused-device-fixture'
import { FocusedSignInFixture } from './focused-sign-in-fixture'
import { HomeFixture } from './home-fixture'
import { LandingFixture } from './landing-fixture'
import { PublicGuideFixture } from './public-guide-fixture'
import { PublicAboutFixture } from './public-about-fixture'
import { PublicPricingFixture } from './public-pricing-fixture'
import { ViewerErrorFixture } from './viewer-error-fixture'
import {
  ViewerFixture,
  ViewerMoveFixture,
  ViewerTooltipFixture,
} from './viewer-fixture'

export const SCENARIO_IDS = [
  'search-mobile-search',
  'search-mobile-filters',
  'search-mobile-search-ja',
  'search-mobile-filters-ja',
  'search-loading',
  'search-error',
  'search-daily-limit',
  'search-palette-daily-limit',
  'search-continuation-error',
  'search-group-expanded',
  'search-results',
  'search-empty',
  'search-any',
  'search-capped',
  'landing-default',
  'landing-invite',
  'focused-sign-in',
  'focused-device',
  'focused-consent',
  'public-pricing',
  'public-guide',
  'public-about',
  'app-home-empty',
  'app-home-content',
  'viewer-default',
  'viewer-move-entry',
  'viewer-tooltip-open',
  'viewer-forbidden',
  'viewer-unexpected',
] as const

export type ScenarioId = (typeof SCENARIO_IDS)[number]

export interface ScenarioDefinition {
  title: string
  locale?: 'en' | 'ja'
  component: ElementType
  requiredRegions: readonly string[]
  requiresHeading: boolean
  requiresPrimary: boolean
  requiresOverlay?: boolean
  viewerError?: boolean
  requiredMarkers?: readonly string[]
}

export const scenarioRegistry: Record<ScenarioId, ScenarioDefinition> = {
  'search-mobile-search': {
    title: 'search-mobile-search',
    component: () => <SearchFixture state="results" />,
    requiredRegions: ['header', 'main'],
    requiresHeading: true,
    requiresPrimary: false,
  },
  'search-mobile-filters': {
    title: 'search-mobile-filters',
    component: () => <SearchFixture state="results" />,
    requiredRegions: ['header', 'main'],
    requiresHeading: true,
    requiresPrimary: false,
  },
  'search-mobile-search-ja': {
    title: 'search-mobile-search-ja',
    component: () => <SearchFixture state="results" />,
    requiredRegions: ['header', 'main'],
    requiresHeading: true,
    requiresPrimary: false,
    locale: 'ja',
  },
  'search-mobile-filters-ja': {
    title: 'search-mobile-filters-ja',
    component: () => <SearchFixture state="results" />,
    requiredRegions: ['header', 'main'],
    requiresHeading: true,
    requiresPrimary: false,
    locale: 'ja',
  },
  'search-loading': {
    title: 'search-loading',
    component: () => <SearchFixture state="results" />,
    requiredRegions: ['header', 'main'],
    requiresHeading: true,
    requiresPrimary: false,
  },
  'search-daily-limit': {
    title: 'search-daily-limit',
    component: () => <SearchFixture state="daily-limit" />,
    requiredRegions: ['header', 'main'],
    requiresHeading: true,
    requiresPrimary: false,
  },
  'search-palette-daily-limit': {
    title: 'search-palette-daily-limit',
    component: () => <SearchFixture state="results" />,
    requiredRegions: ['header', 'main'],
    requiresHeading: true,
    requiresPrimary: false,
  },
  'search-error': {
    title: 'search-error',
    component: () => <SearchFixture state="error" />,
    requiredRegions: ['header', 'main'],
    requiresHeading: false,
    requiresPrimary: false,
  },
  'search-continuation-error': {
    title: 'search-continuation-error',
    component: () => <SearchFixture state="continuation-error" />,
    requiredRegions: ['header', 'main'],
    requiresHeading: true,
    requiresPrimary: false,
  },
  'search-group-expanded': {
    title: 'search-group-expanded',
    component: () => <SearchFixture state="group-expanded" />,
    requiredRegions: ['header', 'main'],
    requiresHeading: true,
    requiresPrimary: false,
  },
  'search-results': {
    title: 'Search results',
    component: () => <SearchFixture state="results" />,
    requiredRegions: ['header', 'main'],
    requiresHeading: true,
    requiresPrimary: false,
  },
  'search-empty': {
    title: 'Search empty',
    component: () => <SearchFixture state="empty" />,
    requiredRegions: ['header', 'main'],
    requiresHeading: true,
    requiresPrimary: false,
  },
  'search-any': {
    title: 'Search any',
    component: () => <SearchFixture state="any" />,
    requiredRegions: ['header', 'main'],
    requiresHeading: true,
    requiresPrimary: false,
  },
  'search-capped': {
    title: 'Search capped',
    component: () => <SearchFixture state="capped" />,
    requiredRegions: ['header', 'main'],
    requiresHeading: true,
    requiresPrimary: false,
  },

  'landing-default': {
    title: 'Landing default',
    component: LandingFixture,
    requiredRegions: ['main', 'hero', 'footer'],
    requiresHeading: true,
    requiresPrimary: true,
  },
  'landing-invite': {
    title: 'Landing invite',
    component: () => <LandingFixture invite />,
    requiredRegions: ['main', 'hero', 'footer'],
    requiresHeading: true,
    requiresPrimary: true,
  },
  'focused-sign-in': {
    title: 'Focused sign in',
    component: FocusedSignInFixture,
    requiredRegions: ['main', 'footer'],
    requiresHeading: true,
    requiresPrimary: true,
  },
  'focused-device': {
    title: 'Focused device',
    component: FocusedDeviceFixture,
    requiredRegions: ['main', 'footer'],
    requiresHeading: true,
    requiresPrimary: true,
  },
  'focused-consent': {
    title: 'Focused consent',
    component: FocusedConsentFixture,
    requiredRegions: ['main'],
    requiresHeading: true,
    requiresPrimary: true,
  },
  'public-pricing': {
    title: 'Public pricing',
    component: PublicPricingFixture,
    requiredRegions: ['header', 'main', 'footer'],
    requiresHeading: true,
    requiresPrimary: true,
  },
  'public-guide': {
    title: 'Public guide',
    component: PublicGuideFixture,
    requiredRegions: ['header', 'main', 'footer'],
    requiresHeading: true,
    requiresPrimary: false,
  },
  'public-about': {
    title: 'Public about',
    component: PublicAboutFixture,
    requiredRegions: ['header', 'main', 'footer'],
    requiresHeading: true,
    requiresPrimary: true,
  },
  'app-home-empty': {
    title: 'App home empty',
    component: () => <HomeFixture content={false} />,
    requiredRegions: ['header', 'main'],
    requiresHeading: true,
    requiresPrimary: false,
    requiredMarkers: ['data-slot="empty"'],
  },
  'app-home-content': {
    title: 'App home content',
    component: () => <HomeFixture content />,
    requiredRegions: ['header', 'main'],
    requiresHeading: true,
    requiresPrimary: false,
    requiredMarkers: [
      'quarterly-planning-review-with-a-name-that-keeps-going.md',
    ],
  },
  'viewer-default': {
    title: 'Viewer default',
    component: ViewerFixture,
    requiredRegions: ['main'],
    requiresHeading: true,
    requiresPrimary: false,
    requiresOverlay: true,
    requiredMarkers: ['id="viewer-topbar"'],
  },
  'viewer-move-entry': {
    title: 'Viewer move entry',
    component: ViewerMoveFixture,
    requiredRegions: ['main'],
    requiresHeading: true,
    requiresPrimary: false,
    requiresOverlay: true,
    requiredMarkers: ['data-viewer-move-entry'],
  },
  'viewer-tooltip-open': {
    title: 'Viewer tooltip open',
    component: ViewerTooltipFixture,
    requiredRegions: ['main'],
    requiresHeading: true,
    requiresPrimary: false,
    requiresOverlay: true,
    requiredMarkers: ['id="viewer-topbar"'],
  },
  'viewer-forbidden': {
    title: 'Viewer forbidden',
    component: ViewerErrorFixture,
    requiredRegions: ['header', 'main'],
    requiresHeading: false,
    requiresPrimary: true,
    viewerError: true,
  },
  'viewer-unexpected': {
    title: 'Viewer unexpected error',
    component: () => <ViewerErrorFixture unexpected />,
    requiredRegions: ['header', 'main'],
    requiresHeading: false,
    requiresPrimary: true,
    viewerError: true,
  },
}

export function isScenarioId(value: string | undefined): value is ScenarioId {
  return value !== undefined && SCENARIO_IDS.includes(value as ScenarioId)
}
