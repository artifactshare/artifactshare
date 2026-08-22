import { useEffect, useLayoutEffect, useRef } from 'react'

const useIsomorphicLayoutEffect =
  typeof document === 'undefined' ? useEffect : useLayoutEffect

/** Keep the latest committed value available to asynchronous callbacks. */
export function useLatestRef<T>(value: T) {
  const ref = useRef(value)
  useIsomorphicLayoutEffect(() => {
    ref.current = value
  }, [value])
  return ref
}
