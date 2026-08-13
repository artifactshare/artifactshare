import { afterEach, describe, expect, test } from 'vitest'

import { enableMarkdownFragmentNavigation } from './markdown-fragment-navigation.client'

let frame: HTMLIFrameElement | undefined

afterEach(() => {
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
})
