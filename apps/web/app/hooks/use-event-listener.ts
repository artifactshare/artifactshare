import { useEffect, useEffectEvent } from 'react'

type ListenerTargets = {
  window: WindowEventMap
  document: DocumentEventMap
}

type ListenerOptions = Pick<AddEventListenerOptions, 'capture' | 'passive'>

export function useEventListener<
  Target extends keyof ListenerTargets,
  Type extends keyof ListenerTargets[Target] & string,
>(
  target: Target | null,
  type: Type,
  listener: (event: ListenerTargets[Target][Type]) => void,
  options?: ListenerOptions,
): void
export function useEventListener(
  target: keyof ListenerTargets | null,
  type: string,
  listener: (event: Event) => void,
  options?: ListenerOptions,
): void
export function useEventListener(
  target: keyof ListenerTargets | null,
  type: string,
  listener: (event: Event) => void,
  { capture = false, passive }: ListenerOptions = {},
) {
  const onEvent = useEffectEvent(listener)
  useEffect(() => {
    if (!target) return
    const node = target === 'window' ? window : document
    const handle = (event: Event) => onEvent(event)
    node.addEventListener(type, handle, { capture, passive })
    return () => node.removeEventListener(type, handle, { capture })
  }, [target, type, capture, passive])
}
