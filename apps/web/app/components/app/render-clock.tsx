import { createContext, useCallback, useContext, type ReactNode } from 'react'
import { useHydrated } from '~/hooks/use-hydrated'
import type { Locale } from '~/i18n/messages'
import { formatRelative } from '~/lib/datetime'

// The time the server rendered this document, from the root loader. Relative
// times ("30 minutes ago") are counted from it until hydration finishes, so the
// browser's first render produces the same text as the server's even when the
// clocks have moved on. After hydration they count from the browser's clock.
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

/** Returns the formatter every screen uses for relative times. */
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
