import { useLayoutEffect, useRef } from 'react'
import { useLocation, useNavigationType } from 'react-router'

// Discard submission feedback when the user opens another entry of the same
// page without remounting its controls. A replace rewrites the current entry,
// such as the Settings layout removing a consumed return parameter, and keeps
// what is in flight or shown there.
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
