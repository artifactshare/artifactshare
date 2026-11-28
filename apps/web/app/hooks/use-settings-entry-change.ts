import { useLayoutEffect, useRef } from 'react'
import { useLocation, useNavigationType } from 'react-router'

export function useSettingsEntryChange(clear: () => void) {
  const { key } = useLocation()
  const navigationType = useNavigationType()
  const entry = useRef(key)
  useLayoutEffect(() => {
    if (entry.current !== key) {
      entry.current = key
      if (navigationType !== 'REPLACE') clear()
    }
  }, [key, navigationType, clear])
}
