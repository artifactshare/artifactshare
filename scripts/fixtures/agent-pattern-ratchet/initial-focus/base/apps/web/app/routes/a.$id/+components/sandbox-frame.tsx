import { useCallback, useEffect, useEffectEvent, useRef } from 'react'

export function useSandboxFrameController({
  locale,
  renderType,
  targetThreadId,
  trustedMessageOrigin,
}: {
  locale: string
  renderType: string
  targetThreadId: string | null
  trustedMessageOrigin: string
}) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const showsViewerPreferences = renderType === 'pdf' || renderType === 'video'
  const sendViewerPreferences = useCallback(() => {
    if (!showsViewerPreferences) return
    const theme = document.documentElement.dataset.theme
    frameRef.current?.contentWindow?.postMessage(
      viewerPreferencesMessage({
        locale,
        theme: isAppTheme(theme) ? theme : DEFAULT_APP_THEME,
      }),
      trustedMessageOrigin,
    )
  }, [locale, showsViewerPreferences, trustedMessageOrigin])

  const focusFrame = useCallback(() => {
    requestAnimationFrame(() => {
      const active = document.activeElement
      if (active !== document.body && active !== frameRef.current) return
      frameRef.current?.focus({ preventScroll: true })
    })
  }, [])
  return { focusFrame, frameRef, sendViewerPreferences }
}
