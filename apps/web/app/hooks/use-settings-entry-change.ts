import { useLayoutEffect, useRef } from 'react'
import { useLocation } from 'react-router'

// Discard submission feedback when leaving its history entry without remounting controls.
export function useSettingsEntryChange(clear: () => void) {
  const { key } = useLocation()
  const entry = useRef(key)
  useLayoutEffect(() => {
    if (entry.current !== key) {
      entry.current = key
      clear()
    }
  }, [key, clear])
}
