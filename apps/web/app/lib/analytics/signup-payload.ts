import type { FirstTouch } from './first-touch'
import type { SignupMethod } from '~/services/signup-analytics.server'

export interface AnalyticsSignupPayload {
  method: SignupMethod
  workspaceCreated: boolean
  firstTouch: FirstTouch | null
}
