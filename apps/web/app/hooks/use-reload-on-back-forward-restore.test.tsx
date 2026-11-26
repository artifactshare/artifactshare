// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, test, vi } from 'vitest'
import { useReloadOnBackForwardRestore } from './use-reload-on-back-forward-restore'

function pageShow(persisted: boolean) {
  const event = new Event('pageshow') as Event & { persisted: boolean }
  Object.defineProperty(event, 'persisted', { value: persisted })
  window.dispatchEvent(event)
}

test('a page restored from the back/forward cache loads again; a normal show does not', async () => {
  const reload = vi.fn()
  function Page() {
    useReloadOnBackForwardRestore(reload)
    return null
  }
  const container = document.body.appendChild(document.createElement('div'))
  const root = createRoot(container)
  try {
    await act(async () => root.render(<Page />))
    pageShow(false)
    expect(reload).not.toHaveBeenCalled()
    pageShow(true)
    expect(reload).toHaveBeenCalledTimes(1)
    await act(async () => root.unmount())
    pageShow(true)
    expect(reload).toHaveBeenCalledTimes(1)
  } finally {
    container.remove()
  }
})
