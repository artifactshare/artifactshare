import { useEffect, useState } from 'react'
import { writeClipboardText } from '~/lib/clipboard'

export type CopyState = 'idle' | 'copied' | 'failed'

/** Copy-to-clipboard with a transient state that resets to idle after 2.2s.
 *  Shared by the connector URL field and the config code block. */
export function useCopyState(text: string): {
  state: CopyState
  copy: () => void
} {
  const [state, setState] = useState<CopyState>('idle')

  useEffect(() => {
    if (state === 'idle') return
    const timeoutId = window.setTimeout(() => setState('idle'), 2200)
    return () => window.clearTimeout(timeoutId)
  }, [state])

  const copy = () => {
    void writeClipboardText(text).then((ok) =>
      setState(ok ? 'copied' : 'failed'),
    )
  }

  return { state, copy }
}
