// @vitest-environment happy-dom
import React from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { RecipientSuggestionInput } from './recipient-suggestion-input'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const labels = {
  placeholder: 'Name or email',
  loading: 'Loading',
  empty: 'Empty',
  count: (count: number) => `${count} results`,
}

describe('RecipientSuggestionInput', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    vi.useFakeTimers()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    React.act(() => root.unmount())
    document.body.innerHTML = ''
  })

  test('waits for the query threshold, debounces, and selects with Enter', async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        candidates: [
          {
            email: 'amy@example.com',
            user: { id: 'amy', name: 'Amy', image: null },
            displayName: 'Amy',
          },
        ],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const onCommit = vi.fn()
    await render({ onCommit })
    const input = container.querySelector('input')!

    await changeInput(input, 'a')
    await React.act(async () => vi.advanceTimersByTimeAsync(250))
    expect(fetchMock).not.toHaveBeenCalled()

    await changeInput(input, 'am')
    expect(document.body.textContent).toContain('Loading')
    await React.act(async () => {
      await vi.advanceTimersByTimeAsync(200)
      await Promise.resolve()
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[role="option"]')?.textContent).toContain(
      'Amy',
    )

    await React.act(async () => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
      )
    })
    expect(onCommit).toHaveBeenCalledWith('amy@example.com')
  })

  test('allows spaces in names but commits a valid email on space', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => {})),
    )
    const onCommit = vi.fn()
    await render({ onCommit })
    const input = container.querySelector('input')!

    await changeInput(input, 'Amy')
    const nameSpace = new KeyboardEvent('keydown', {
      key: ' ',
      bubbles: true,
      cancelable: true,
    })
    await React.act(async () => input.dispatchEvent(nameSpace))
    expect(nameSpace.defaultPrevented).toBe(false)
    expect(onCommit).not.toHaveBeenCalled()

    await changeInput(input, 'amy@example.com')
    const emailSpace = new KeyboardEvent('keydown', {
      key: ' ',
      bubbles: true,
      cancelable: true,
    })
    await React.act(async () => input.dispatchEvent(emailSpace))
    expect(emailSpace.defaultPrevented).toBe(true)
    expect(onCommit).toHaveBeenCalledWith()
  })

  test('does not commit while IME composition is active', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const onCommit = vi.fn()
    await render({ onCommit })
    const input = container.querySelector('input')!
    await changeInput(input, 'amy@example.com')
    await React.act(async () => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          isComposing: true,
        }),
      )
    })
    expect(onCommit).not.toHaveBeenCalled()
  })

  test('Escape closes suggestions without escaping the parent and refocus can reopen them', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          candidates: [
            {
              email: 'amy@example.com',
              user: { id: 'amy', name: 'Amy', image: null },
              displayName: 'Amy',
            },
          ],
        }),
      ),
    )
    const onCommit = vi.fn()
    const parentKeyDown = vi.fn()
    await render({ onCommit, onParentKeyDown: parentKeyDown })
    const input = container.querySelector('input')!
    await changeInput(input, 'am')
    await React.act(async () => {
      await vi.advanceTimersByTimeAsync(200)
      await Promise.resolve()
    })
    expect(document.querySelector('[role="listbox"]')).not.toBeNull()

    await React.act(async () => {
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      )
    })
    expect(document.querySelector('[role="listbox"]')).toBeNull()
    expect(parentKeyDown).not.toHaveBeenCalled()

    await React.act(async () => {
      input.blur()
      input.focus()
    })
    expect(document.querySelector('[role="listbox"]')).not.toBeNull()
  })

  test('closes the popover on request errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))
    await render({ onCommit: vi.fn() })
    const input = container.querySelector('input')!
    await changeInput(input, 'am')
    await React.act(async () => {
      await vi.advanceTimersByTimeAsync(200)
      await Promise.resolve()
    })
    expect(document.querySelector('[role="listbox"]')).toBeNull()
  })

  test('announces loading and does not refetch for an equal exclusion list', async () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}))
    vi.stubGlobal('fetch', fetchMock)
    function Harness() {
      const [value, setValue] = React.useState('am')
      const [renderCount, setRenderCount] = React.useState(0)
      return (
        <div>
          <button type="button" onClick={() => setRenderCount((n) => n + 1)}>
            Render {renderCount}
          </button>
          <RecipientSuggestionInput
            value={value}
            disabled={false}
            context={{ kind: 'shareable', id: 'shareable-1' }}
            excludedEmails={['existing@example.com']}
            ownerEmail="owner@example.com"
            onChange={setValue}
            onCommit={vi.fn()}
            labels={labels}
          />
        </div>
      )
    }
    await React.act(async () => root.render(<Harness />))
    await React.act(async () => container.querySelector('input')?.focus())
    expect(document.body.textContent).toContain('Loading')
    await React.act(async () => vi.advanceTimersByTimeAsync(200))
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await React.act(async () =>
      container
        .querySelector('button')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    )
    await React.act(async () => vi.advanceTimersByTimeAsync(250))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  async function render({
    onCommit,
    onParentKeyDown,
  }: {
    onCommit: (value?: string) => void
    onParentKeyDown?: () => void
  }) {
    function Harness() {
      const [value, setValue] = React.useState('')
      return (
        <div onKeyDown={onParentKeyDown}>
          <RecipientSuggestionInput
            value={value}
            disabled={false}
            context={{ kind: 'shareable', id: 'shareable-1' }}
            excludedEmails={[]}
            ownerEmail="owner@example.com"
            onChange={setValue}
            onCommit={onCommit}
            labels={labels}
          />
        </div>
      )
    }
    await React.act(async () => root.render(<Harness />))
    await React.act(async () => container.querySelector('input')?.focus())
  }
})

async function changeInput(input: HTMLInputElement, value: string) {
  await React.act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    )?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
