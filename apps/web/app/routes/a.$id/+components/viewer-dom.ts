export function getActiveElement(): HTMLElement | null {
  const activeElement = document.activeElement
  return activeElement instanceof HTMLElement ? activeElement : null
}
