import { useEffect, useEffectEvent, useRef, type RefObject } from 'react'

export function useInitialFrameFocus(
  frameRef: RefObject<HTMLIFrameElement | null>,
  targetThreadId: string | null,
) {
  // Opening a document should let the keyboard reach it without a click, once,
  // and only while the reader has not started doing something in the viewer.
  // Later answers (revalidation, reconnects, in-frame navigation) never offer
  // it again, and a comment link keeps its own destination.
  const initialFocusRef = useRef<'pending' | 'settled'>(
    targetThreadId ? 'settled' : 'pending',
  )
  const readerActedRef = useRef(false)
  const frameAnsweredRef = useRef(false)
  const offerInitialFocus = useEffectEvent(() => {
    if (initialFocusRef.current === 'settled' || !frameAnsweredRef.current)
      return
    // A background tab is offered focus when it is first shown.
    if (document.visibilityState !== 'visible') return
    initialFocusRef.current = 'settled'
    if (readerActedRef.current) return
    const selection = window.getSelection()
    if (selection && !selection.isCollapsed) return
    // A task, not an animation frame: a page that is not painting yet still
    // receives the focus, and the same guard keeps a control chosen meanwhile.
    window.setTimeout(() => {
      if (readerActedRef.current) return
      const active = document.activeElement
      if (active !== document.body && active !== frameRef.current) return
      frameRef.current?.focus({ preventScroll: true })
    }, 0)
  })
  useEffect(() => {
    const acted = (event: Event) => {
      // The frame gaining focus is not the reader working in the viewer.
      if (event.target === frameRef.current) return
      readerActedRef.current = true
    }
    const shown = () => offerInitialFocus()
    window.addEventListener('pointerdown', acted, true)
    window.addEventListener('keydown', acted, true)
    document.addEventListener('focusin', acted, true)
    document.addEventListener('visibilitychange', shown)
    return () => {
      window.removeEventListener('pointerdown', acted, true)
      window.removeEventListener('keydown', acted, true)
      document.removeEventListener('focusin', acted, true)
      document.removeEventListener('visibilitychange', shown)
    }
  }, [frameRef])
  return { frameAnsweredRef, offerInitialFocus }
}
