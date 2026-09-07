// @vitest-environment happy-dom

import * as React from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const toastMock = vi.hoisted(() =>
  Object.assign(vi.fn(), { warning: vi.fn(), getToasts: vi.fn(() => []) }),
)

vi.mock('sonner', () => ({ toast: toastMock }))
vi.mock('~/hooks/use-t', async () => {
  const { bindI18n } = await import('~/lib/i18n')
  return { useT: () => bindI18n('en') }
})

import { CopyUrlButton } from './copy-url-button'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe('CopyUrlButton sharing recovery', () => {
  let host: HTMLDivElement
  let root: ReturnType<typeof createRoot>
  let clipboardDescriptor: PropertyDescriptor | undefined
  let execCommandDescriptor: PropertyDescriptor | undefined

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    vi.clearAllMocks()
    clipboardDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      'clipboard',
    )
    execCommandDescriptor = Object.getOwnPropertyDescriptor(
      document,
      'execCommand',
    )
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    })
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => false),
    })
  })

  afterEach(async () => {
    await React.act(async () => root.unmount())
    host.remove()
    if (clipboardDescriptor) {
      Object.defineProperty(navigator, 'clipboard', clipboardDescriptor)
    } else {
      Reflect.deleteProperty(navigator, 'clipboard')
    }
    if (execCommandDescriptor) {
      Object.defineProperty(document, 'execCommand', execCommandDescriptor)
    } else {
      Reflect.deleteProperty(document, 'execCommand')
    }
  })

  test('opens the row sharing dialog after the actual copy fallback fails', async () => {
    const onOpenSharing = vi.fn()
    const controller = new AbortController()
    await React.act(async () => {
      root.render(
        <CopyUrlButton
          shareableId="abc123def4"
          visibility="link"
          onOpenSharing={onOpenSharing}
          sharingActionSignal={controller.signal}
        />,
      )
    })

    await React.act(async () => {
      host.querySelector('button')?.click()
    })

    const recoveryOptions = toastMock.mock.calls.at(-1)?.[1]
    expect(recoveryOptions.action.label).toBe('Open sharing settings')
    const preventDefault = vi.fn()
    recoveryOptions.action.onClick({ preventDefault })
    expect(preventDefault).toHaveBeenCalledOnce()
    expect(onOpenSharing).toHaveBeenCalledOnce()
  })
})
