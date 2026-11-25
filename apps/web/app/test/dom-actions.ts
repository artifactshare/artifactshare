// Role and accessible-name queries and user actions for happy-dom tests.
import { act } from 'react'
import { vi } from 'vitest'

const implicit: Record<string, string> = {
  button: 'button, [role="button"]',
  menuitem: '[role="menuitem"]',
  spinbutton: 'input[type="number"], [role="spinbutton"]',
  checkbox: 'input[type="checkbox"], [role="checkbox"]',
  radio: 'input[type="radio"], [role="radio"]',
  link: 'a[href], [role="link"]',
  textbox:
    'input[type="text"], input[type="email"], input:not([type]), textarea, [role="textbox"]',
}

function accessibleName(element: Element): string {
  const label = element.getAttribute('aria-label')
  if (label) return label.trim()
  const ids = element.getAttribute('aria-labelledby')
  if (ids)
    return ids
      .split(/\s+/)
      .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? '')
      .join(' ')
      .trim()
  if (element.id) {
    const forLabel = element.ownerDocument.querySelector(
      `label[for="${element.id}"]`,
    )
    if (forLabel) return (forLabel.textContent ?? '').trim()
  }
  const wrapping = element.closest('label')
  if (wrapping && wrapping !== element)
    return (wrapping.textContent ?? '').trim()
  return (element.textContent ?? '').trim()
}

export function shown(element: Element) {
  return !element.closest('[hidden], [aria-hidden="true"], [inert]')
}

/** An accessible name, exactly, or a test of one for a name the element
 * assembles from more than one piece of copy. */
export function byRole(
  root: Element | Document,
  role: string,
  name?: string | ((name: string) => boolean),
) {
  const matches = (element: Element) =>
    name === undefined ||
    (typeof name === 'string'
      ? accessibleName(element) === name
      : name(accessibleName(element)))
  const selector = implicit[role] ?? `[role="${role}"]`
  return (
    Array.from(root.querySelectorAll<HTMLElement>(selector)).find(
      (element) => shown(element) && matches(element),
    ) ?? null
  )
}

export function find<T>(read: () => T | null) {
  return vi.waitFor(() => {
    const value = read()
    if (!value) throw new Error('not found')
    return value
  })
}

export async function press(element: HTMLElement) {
  await act(() => {
    const init = { bubbles: true, cancelable: true, button: 0 }
    element.dispatchEvent(new PointerEvent('pointerdown', init))
    element.dispatchEvent(new MouseEvent('mousedown', init))
    element.focus()
    element.dispatchEvent(new PointerEvent('pointerup', init))
    element.dispatchEvent(new MouseEvent('mouseup', init))
    element.click()
  })
}

export async function fill(element: HTMLElement, value: string) {
  await act(() => {
    const input = element as HTMLInputElement
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )!.set!
    input.focus()
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

export async function escape() {
  await act(() => {
    const target = document.activeElement ?? document.body
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )
  })
}
