import {
  createContext,
  use,
  useCallback,
  useMemo,
  useRef,
  useState,
} from 'react'

interface AnalyticsConsentContextValue {
  manualOpen: boolean
  commentPanelOpen: boolean
  setCommentPanelOpen: (open: boolean) => void
  openBanner: (trigger?: HTMLElement | null) => void
  closeBanner: () => void
  returnFocus: () => void
}

const defaultValue: AnalyticsConsentContextValue = {
  manualOpen: false,
  commentPanelOpen: false,
  setCommentPanelOpen: () => {},
  openBanner: () => {},
  closeBanner: () => {},
  returnFocus: () => {},
}

const AnalyticsConsentContext = createContext(defaultValue)

export function AnalyticsConsentProvider({
  children,
}: {
  children: React.ReactNode
}) {
  const [manualOpen, setManualOpen] = useState(false)
  const [commentPanelOpen, setCommentPanelOpen] = useState(false)
  const triggerRef = useRef<HTMLElement | null>(null)
  const openBanner = useCallback((trigger?: HTMLElement | null) => {
    triggerRef.current = trigger ?? null
    setManualOpen(true)
  }, [])
  const closeBanner = useCallback(() => setManualOpen(false), [])
  const returnFocus = useCallback(() => {
    triggerRef.current?.focus()
    triggerRef.current = null
  }, [])

  const value = useMemo(
    () => ({
      manualOpen,
      commentPanelOpen,
      setCommentPanelOpen,
      openBanner,
      closeBanner,
      returnFocus,
    }),
    [manualOpen, commentPanelOpen, openBanner, closeBanner, returnFocus],
  )

  return (
    <AnalyticsConsentContext.Provider value={value}>
      {children}
    </AnalyticsConsentContext.Provider>
  )
}

export function useAnalyticsConsent() {
  return use(AnalyticsConsentContext)
}
