import type { FirstTouch } from './first-touch'
import type { AnalyticsAuthMethod } from './events'

export interface AnalyticsSignupPayload {
  method: AnalyticsAuthMethod
  workspaceCreated: boolean
  firstTouch: FirstTouch | null
}
