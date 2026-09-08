// @vitest-environment happy-dom

import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const writeClipboardText = vi.hoisted(() => vi.fn())

vi.mock('~/lib/clipboard', () => ({ writeClipboardText }))

import { useCopyState } from './use-copy-state'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

function CopyProbe() {
  const { state, copy } = useCopyState('https://example.test/')
  return (
    <button type="button" onClick={copy}>
      {state}
    </button>
  )
}

describe('useCopyState', () => {
  let host: HTMLDivElement
  let root: ReturnType<typeof createRoot>

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    writeClipboardText.mockReset()
  })

  afterEach(async () => {
    await React.act(async () => root.unmount())
    host.remove()
    vi.useRealTimers()
  })

  test('reports failure when clipboard writing rejects', async () => {
    writeClipboardText.mockRejectedValue(new Error('clipboard unavailable'))
    await React.act(async () => root.render(<CopyProbe />))

    await React.act(async () => host.querySelector('button')?.click())

    expect(host.textContent).toBe('failed')
    expect(writeClipboardText).toHaveBeenCalledWith('https://example.test/')
  })

  test('restarts the feedback timeout when the same result repeats', async () => {
    vi.useFakeTimers()
    writeClipboardText.mockRejectedValue(new Error('clipboard unavailable'))
    await React.act(async () => root.render(<CopyProbe />))
    const button = host.querySelector('button')!

    await React.act(async () => button.click())
    await React.act(async () => vi.advanceTimersByTime(2_000))
    await React.act(async () => button.click())
    await React.act(async () => vi.advanceTimersByTime(300))
    expect(host.textContent).toBe('failed')

    await React.act(async () => vi.advanceTimersByTime(1_900))
    expect(host.textContent).toBe('idle')
  })

  test('ignores an older copy result that settles after a newer attempt', async () => {
    let resolveFirst!: (result: boolean) => void
    let resolveSecond!: (result: boolean) => void
    writeClipboardText
      .mockImplementationOnce(
        () => new Promise<boolean>((resolve) => (resolveFirst = resolve)),
      )
      .mockImplementationOnce(
        () => new Promise<boolean>((resolve) => (resolveSecond = resolve)),
      )
    await React.act(async () => root.render(<CopyProbe />))
    const button = host.querySelector('button')!

    await React.act(async () => {
      button.click()
      button.click()
      resolveSecond(true)
    })
    expect(host.textContent).toBe('copied')

    await React.act(async () => resolveFirst(false))
    expect(host.textContent).toBe('copied')
  })

  test('ignores a copy result that settles after unmount', async () => {
    vi.useFakeTimers()
    let resolveCopy!: (result: boolean) => void
    writeClipboardText.mockImplementation(
      () => new Promise<boolean>((resolve) => (resolveCopy = resolve)),
    )
    await React.act(async () => root.render(<CopyProbe />))

    await React.act(async () => host.querySelector('button')?.click())
    await React.act(async () => root.render(null))
    await React.act(async () => resolveCopy(true))

    expect(host.textContent).toBe('')
    expect(vi.getTimerCount()).toBe(0)
  })
})
