export type ScreenAuth =
  | 'anonymous'
  | 'free-owner'
  | 'plus-owner'
  | 'team-owner'
  | 'team-member'

export type ScreenLoop =
  | 'create'
  | 'post'
  | 'share'
  | 'view'
  | 'react'
  | 'repost'
  | 'support'

export type ScreenReady = {
  selector: string
  /** Additional CSS selectors that must all be visible alongside the ready target. */
  visibleWith?: string[]
  description: string
  timeoutMs?: number
}

export type ScreenInteraction =
  | { action: 'fill'; selector: string; value: string; readySelector?: string }
  | {
      action: 'click' | 'hover'
      selector: string
      readySelector?: string
    }
  | {
      action: 'setInputFiles'
      selector: string
      name: string
      mimeType: string
      content: string
      captureImmediately?: boolean
      readySelector?: string
    }

export type ScreenSetup = {
  auth?: ScreenAuth
  seedAuth?: ScreenAuth
  scenario?: string
  /** Reset this scenario before each serial capture, after ordinary jobs finish. */
  reseedBeforeCapture?: boolean
  scenarioArtifactIndex?: number
  query?: string
  interactions?: ScreenInteraction[]
  /** Capture runner only: never installed in production routes. */
  actionResponse?: {
    route: string
    method: 'POST'
    intent: string
    status?: number
    pending?: boolean
    data?: Record<string, unknown>
  }
  ready?: ScreenReady
  postInteractionReady?: ScreenReady
}

export type ScreenState = {
  /** Require this exact navigation status instead of the default OK response. */
  expectedError?: string
  expectedStatus?: number
  id: string
  description: string
  setup: ScreenSetup
}

export type ScreenSection = {
  id: string
  selector: string
}

export type ScreenSpec = {
  id: string
  route: Record<string, string>
  auth: ScreenAuth
  loop: ScreenLoop
  metric: string
  role: string
  primaryAction: string
  states: ScreenState[]
  sections?: ScreenSection[]
  captureConcurrency?: number
  ready?: ScreenReady
}
