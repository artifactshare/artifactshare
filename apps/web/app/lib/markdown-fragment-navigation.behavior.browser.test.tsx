import { afterEach, describe, expect, test, vi } from 'vitest'

import { enableMarkdownFragmentNavigation } from './markdown-fragment-navigation.client'

let frame: HTMLIFrameElement | undefined

afterEach(() => {
  if (frame) frame.srcdoc = ''
  frame?.remove()
  frame = undefined
})

describe('Markdown fragment navigation', () => {
  test('scrolls inside srcdoc without navigating to the parent application', async () => {
    frame = document.createElement('iframe')
    frame.setAttribute('sandbox', 'allow-same-origin')
    frame.style.height = '200px'
    frame.srcdoc = `<!doctype html><body style="margin:0">
      <a id="link" href="#target">Target</a>
      <div style="height:1200px"></div>
      <h2 id="target">Target heading</h2>
    </body>`
    document.body.appendChild(frame)
    await new Promise<void>((resolve) =>
      frame?.addEventListener('load', () => resolve(), { once: true }),
    )

    const originalLocation = frame.contentWindow!.location.href
    enableMarkdownFragmentNavigation(frame)
    frame.contentDocument!.getElementById('link')!.click()
    await new Promise(requestAnimationFrame)

    expect(frame.contentWindow!.location.href).toBe(originalLocation)
    expect(frame.contentWindow!.scrollY).toBeGreaterThan(0)
    expect(window.location.hash).toBe('')
  })

  test('leaves modified and non-primary clicks to the browser', async () => {
    frame = document.createElement('iframe')
    frame.srcdoc =
      '<a id="link" href="#target">Target</a><h2 id="target">Heading</h2>'
    document.body.appendChild(frame)
    await new Promise<void>((resolve) =>
      frame?.addEventListener('load', () => resolve(), { once: true }),
    )
    enableMarkdownFragmentNavigation(frame)

    const frameDocument = frame.contentDocument!
    const target = frameDocument.getElementById('target')!
    const scrollIntoView = vi.fn()
    target.scrollIntoView = scrollIntoView
    const link = frameDocument.getElementById('link')!

    for (const init of [
      { ctrlKey: true },
      { metaKey: true },
      { shiftKey: true },
      { button: 1 },
    ]) {
      const event = new frameDocument.defaultView!.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        ...init,
      })
      link.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
    }
    expect(scrollIntoView).not.toHaveBeenCalled()
  })
})
