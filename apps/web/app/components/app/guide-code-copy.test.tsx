// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { renderMarkdownBody } from '~/lib/markdown-renderer.server'
import { GuideProse } from './guide-shell'

const writeClipboardText = vi.hoisted(() => vi.fn())
vi.mock('~/lib/clipboard', () => ({ writeClipboardText }))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(async () => {
  vi.useFakeTimers()
  writeClipboardText.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const html = renderMarkdownBody(
    '```bash\necho first\n```\n\n```bash\necho second\n```',
  )
  await act(async () => {
    root.render(
      <GuideProse>
        <div dangerouslySetInnerHTML={{ __html: html }} />
      </GuideProse>,
    )
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.useRealTimers()
})

test('copies only the selected rendered code block and resets accessible feedback', async () => {
  writeClipboardText.mockResolvedValue(true)
  const buttons = host.querySelectorAll<HTMLButtonElement>('[data-code-copy]')
  await act(async () => buttons[1].click())
  expect(writeClipboardText).toHaveBeenCalledWith('echo second')
  expect(buttons[0].textContent).toBe('Copy')
  expect(buttons[1].textContent).toBe('Copied')
  expect(buttons[1].getAttribute('aria-label')).toBe('Copied')
  await act(async () => vi.advanceTimersByTime(1600))
  expect(buttons[1].textContent).toBe('Copy')
  expect(buttons[1].getAttribute('aria-label')).toBe('Copy code')
})

test('does not claim success when copying fails', async () => {
  writeClipboardText.mockResolvedValue(false)
  const button = host.querySelector<HTMLButtonElement>('[data-code-copy]')!
  await act(async () => button.click())
  expect(button.textContent).toBe('Copy')
  expect(button.getAttribute('aria-label')).toBe('Copy code')
})

test('clears feedback timers for every copied block on unmount', async () => {
  writeClipboardText.mockResolvedValue(true)
  const buttons = host.querySelectorAll<HTMLButtonElement>('[data-code-copy]')
  await act(async () => {
    buttons[0].click()
    buttons[1].click()
  })
  expect(vi.getTimerCount()).toBe(2)
  await act(async () => root.render(null))
  expect(vi.getTimerCount()).toBe(0)
})
