import { createContext, useCallback, useContext, type ReactNode } from 'react'
import { useHydrated } from '~/hooks/use-hydrated'
import type { Locale } from '~/i18n/messages'
import { formatRelative } from '~/lib/datetime'

const RenderClock = createContext<string | null>(null)

export function RenderClockProvider({
  renderedAt,
  children,
}: {
  renderedAt: string | null
  children: ReactNode
}) {
  return <RenderClock value={renderedAt}>{children}</RenderClock>
}

export function useRelativeTime(): (iso: string, locale: Locale) => string {
  const renderedAt = useContext(RenderClock)
  const hydrated = useHydrated()
  const base = hydrated ? null : renderedAt
  return useCallback(
    (iso: string, locale: Locale) =>
      formatRelative(iso, locale, base ? new Date(base) : new Date()),
    [base],
  )
}
