import { useLayoutEffect, useState } from 'react'

export function useSharingRecoverySignal(
  scope: string | null,
): AbortSignal | undefined {
  const [active, setActive] = useState<{
    scope: string
    signal: AbortSignal
  } | null>(null)

  useLayoutEffect(() => {
    if (scope === null) {
      setActive(null)
      return
    }
    const controller = new AbortController()
    setActive({ scope, signal: controller.signal })
    return () => controller.abort()
  }, [scope])

  return active?.scope === scope ? active.signal : undefined
}
