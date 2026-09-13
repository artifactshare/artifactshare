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
  description: string
  timeoutMs?: number
}

export type ScreenInteraction =
  | {
      action: 'click' | 'hover'
      selector: string
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
  scenarioArtifactIndex?: number
  query?: string
  interactions?: ScreenInteraction[]
  ready?: ScreenReady
}

export type ScreenState = {
  id: string
  description: string
  setup: ScreenSetup
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
  captureConcurrency?: number
  ready?: ScreenReady
}
