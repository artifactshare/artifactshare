import { useState } from 'react'
import { getBrowserTimeZone } from '~/lib/viewer-timezone.client'
import { useHydrated } from './use-hydrated'

export function useViewerCalendar(): {
  hydrated: boolean
  timeZone: string
  now: Date
} {
  const hydrated = useHydrated()
  const timeZone = hydrated ? getBrowserTimeZone() : 'UTC'
  const [now] = useState(() => new Date())
  return { hydrated, timeZone, now }
}
