import type { RefObject } from 'react'

export function getActiveElement(): HTMLElement | null {
  const activeElement = document.activeElement
  return activeElement instanceof HTMLElement ? activeElement : null
}

export function restoreViewerPanelFocus({
  returnFocusRef,
  collapsedFallbackRef,
  topbarCollapsed,
}: {
  returnFocusRef?: RefObject<HTMLElement | null>
  collapsedFallbackRef?: RefObject<HTMLElement | null>
  topbarCollapsed: boolean
}) {
  const activeElement = getActiveElement()
  if (activeElement !== null && activeElement !== document.body) return

  const target = topbarCollapsed
    ? collapsedFallbackRef?.current
    : returnFocusRef?.current
  target?.focus()
}
