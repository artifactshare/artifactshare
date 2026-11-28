// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useMediaQuery } from './use-media-query'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let container: HTMLDivElement
let root: Root
let matches = false
const listeners = new Set<() => void>()

beforeEach(() => {
  matches = false
  listeners.clear()
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (media) =>
      ({
        media,
        get matches() {
          return matches
        },
        addEventListener: (_: string, listener: () => void) =>
          listeners.add(listener),
        removeEventListener: (_: string, listener: () => void) =>
          listeners.delete(listener),
      }) as unknown as MediaQueryList,
  )
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

function Probe() {
  return useMediaQuery('(max-width: 599px)') ? 'phone' : 'wide'
}

function resize(next: boolean) {
  matches = next
  for (const listener of listeners) listener()
}

test('the value follows the media query and stops listening on unmount', async () => {
  await act(async () => root.render(<Probe />))
  expect(container.textContent).toBe('wide')

  await act(async () => resize(true))
  expect(container.textContent).toBe('phone')

  await act(async () => resize(false))
  expect(container.textContent).toBe('wide')

  await act(async () => root.render(<></>))
  expect(listeners.size).toBe(0)
})
