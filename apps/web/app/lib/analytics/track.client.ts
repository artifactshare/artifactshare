// client 限定の GA4 sender。同意 (shouldLoadAnalytics) を毎回確認し、false なら送らない
import type { AnalyticsEventName, AnalyticsEventParams } from './events'
type GtagFn = (...args: unknown[]) => void
interface AnalyticsWindow {
  dataLayer?: unknown[]
  gtag?: GtagFn
}
let runtimeConsentAllows = false
let runtimeMeasurementId: string | null = null
export function setAnalyticsRuntimeState(state: {
  shouldLoadAnalytics: boolean
  measurementId: string | null
}): void {
  runtimeConsentAllows = state.shouldLoadAnalytics
  runtimeMeasurementId = state.measurementId
}
// Returns whether the event was actually pushed (true) or suppressed (false)
// because consent is not granted, the Measurement ID is unset, or gtag is absent.
type ExactAnalyticsParams<Allowed, Candidate extends Allowed> = Candidate & {
  [Key in Exclude<keyof Candidate, keyof Allowed>]: never
}
type RequiredAnalyticsEventName = {
  [Name in AnalyticsEventName]: undefined extends AnalyticsEventParams[Name]
    ? never
    : {} extends AnalyticsEventParams[Name]
      ? never
      : Name
}[AnalyticsEventName]

export function trackEvent<
  EventName extends AnalyticsEventName,
  Params extends AnalyticsEventParams[EventName] =
    AnalyticsEventParams[EventName],
>(
  name: EventName,
  ...[params]: [Extract<EventName, RequiredAnalyticsEventName>] extends [never]
    ? [params?: ExactAnalyticsParams<AnalyticsEventParams[EventName], Params>]
    : [params: ExactAnalyticsParams<AnalyticsEventParams[EventName], Params>]
): boolean {
  if (!runtimeConsentAllows || !runtimeMeasurementId) return false
  if (typeof window === 'undefined') return false
  const w = window as unknown as AnalyticsWindow
  if (typeof w.gtag !== 'function') return false
  const cleaned = Object.fromEntries(
    Object.entries(params ?? {}).filter(([, value]) => value !== undefined),
  )
  w.gtag('event', name, cleaned)
  return true
}
