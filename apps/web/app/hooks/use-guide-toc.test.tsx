// @vitest-environment happy-dom

import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'

import { useGuideToc } from './use-guide-toc'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

type FakeEntry = {
  isIntersecting: boolean
  target: Element
  boundingClientRect: { top: number }
}

const observers: { notify: (entries: FakeEntry[]) => void }[] = []

class FakeIntersectionObserver {
  constructor(callback: (entries: FakeEntry[]) => void) {
    observers.push({ notify: callback })
  }
  observe() {}
  disconnect() {}
}

function TocProbe() {
  return <span>{useGuideToc() ?? 'none'}</span>
}

function section(id: string) {
  const element = document.createElement('div')
  element.id = id
  element.setAttribute('data-toc-section', '')
  document.body.appendChild(element)
  return element
}

function entering(id: string, top: number): FakeEntry {
  return {
    isIntersecting: true,
    target: document.getElementById(id)!,
    boundingClientRect: { top },
  }
}

describe('useGuideToc', () => {
  const hosts: HTMLDivElement[] = []
  const roots: ReturnType<typeof createRoot>[] = []
  let originalObserver: typeof IntersectionObserver | undefined

  beforeEach(() => {
    originalObserver = globalThis.IntersectionObserver
    Object.assign(globalThis, {
      IntersectionObserver: FakeIntersectionObserver,
    })
    observers.length = 0
    section('one')
    section('two')
  })

  afterEach(async () => {
    for (const root of roots) await React.act(async () => root.unmount())
    for (const host of hosts) host.remove()
    hosts.length = 0
    roots.length = 0
    document.body.innerHTML = ''
    Object.assign(globalThis, { IntersectionObserver: originalObserver })
  })

  async function mountProbe() {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    hosts.push(host)
    roots.push(root)
    await React.act(async () => root.render(<TocProbe />))
    return host
  }

  test('reports the topmost visible section', async () => {
    const host = await mountProbe()

    expect(host.textContent).toBe('none')

    await React.act(async () =>
      observers[0]!.notify([entering('two', 200), entering('one', 40)]),
    )

    expect(host.textContent).toBe('one')
  })

  test('keeps each mount on its own section', async () => {
    const first = await mountProbe()
    await React.act(async () => observers[0]!.notify([entering('one', 40)]))

    const second = await mountProbe()
    await React.act(async () => observers[1]!.notify([entering('two', 60)]))

    expect(second.textContent).toBe('two')
    expect(first.textContent).toBe('one')
  })
})
