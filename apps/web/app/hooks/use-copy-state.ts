import { useEffect, useRef, useState } from 'react'
import { writeClipboardText } from '~/lib/clipboard'

export type CopyState = 'idle' | 'copied' | 'failed'

export function useCopyState(
  text: string,
  { resetMs = 2200 }: { resetMs?: number } = {},
): {
  state: CopyState
  copy: () => void
} {
  const [state, setState] = useState<CopyState>('idle')
  const resetTimeout = useRef<number | null>(null)
  const requestSequence = useRef(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (resetTimeout.current !== null) {
        window.clearTimeout(resetTimeout.current)
        resetTimeout.current = null
      }
    }
  }, [])

  const setResult = (result: Exclude<CopyState, 'idle'>, sequence: number) => {
    if (!mounted.current || sequence !== requestSequence.current) return
    if (resetTimeout.current !== null) {
      window.clearTimeout(resetTimeout.current)
    }
    setState(result)
    resetTimeout.current = window.setTimeout(() => {
      resetTimeout.current = null
      if (!mounted.current) return
      setState('idle')
    }, resetMs)
  }

  const copy = () => {
    const sequence = ++requestSequence.current
    void writeClipboardText(text)
      .then((ok) => setResult(ok ? 'copied' : 'failed', sequence))
      .catch(() => setResult('failed', sequence))
  }

  return { state, copy }
}
