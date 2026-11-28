// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useEventListener } from './use-event-listener'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

function Listener({
  target,
  onKey,
  capture,
}: {
  target: 'window' | 'document' | null
  onKey: (key: string) => void
  capture?: boolean
}) {
  useEventListener(target, 'keydown', (event) => onKey(event.key), {
    capture,
  })
  return <button type="button">inside</button>
}

function press(node: EventTarget, key: string) {
  node.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
}

test('the listener hears events on its target until the component unmounts', async () => {
  const onKey = vi.fn()
  await act(async () => root.render(<Listener target="window" onKey={onKey} />))

  press(window, 'a')
  expect(onKey).toHaveBeenCalledWith('a')

  await act(async () => root.render(<></>))
  press(window, 'b')
  expect(onKey).toHaveBeenCalledTimes(1)
})

test('a new listener replaces the old one without missing an event', async () => {
  const first = vi.fn()
  const second = vi.fn()
  await act(async () =>
    root.render(<Listener target="document" onKey={first} />),
  )
  await act(async () =>
    root.render(<Listener target="document" onKey={second} />),
  )

  press(document, 'Enter')
  expect(first).not.toHaveBeenCalled()
  expect(second).toHaveBeenCalledExactlyOnceWith('Enter')
})

test('a null target listens to nothing until a target is named', async () => {
  const onKey = vi.fn()
  await act(async () => root.render(<Listener target={null} onKey={onKey} />))
  press(document, 'x')
  expect(onKey).not.toHaveBeenCalled()

  await act(async () =>
    root.render(<Listener target="document" onKey={onKey} />),
  )
  press(document, 'y')
  expect(onKey).toHaveBeenCalledExactlyOnceWith('y')

  await act(async () => root.render(<Listener target={null} onKey={onKey} />))
  press(document, 'z')
  expect(onKey).toHaveBeenCalledTimes(1)
})

test('a capture listener hears an event that a descendant stops from bubbling', async () => {
  const bubbling = vi.fn()
  const capturing = vi.fn()
  await act(async () =>
    root.render(
      <>
        <Listener target="document" onKey={bubbling} />
        <Listener target="document" onKey={capturing} capture />
      </>,
    ),
  )
  const button = container.querySelector('button')!
  button.addEventListener('keydown', (event) => event.stopPropagation())

  press(button, 'Escape')
  expect(capturing).toHaveBeenCalledExactlyOnceWith('Escape')
  expect(bubbling).not.toHaveBeenCalled()

  await act(async () => root.render(<></>))
  press(document, 'Escape')
  expect(capturing).toHaveBeenCalledTimes(1)
})
