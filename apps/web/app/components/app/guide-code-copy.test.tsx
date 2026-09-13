// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { renderMarkdownBody } from '~/lib/markdown-renderer.server'
import { GuideProse } from './guide-shell'
import { bindI18n } from '~/lib/i18n'
import type { Locale } from '~/i18n/messages'

const writeClipboardText = vi.hoisted(() => vi.fn())
vi.mock('~/lib/clipboard', () => ({ writeClipboardText }))
const localeState = vi.hoisted(() => ({ locale: 'en' as Locale }))
vi.mock('~/hooks/use-t', () => ({
  useT: () => bindI18n(localeState.locale),
}))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let host: HTMLDivElement
let root: ReturnType<typeof createRoot>

beforeEach(() => {
  vi.useFakeTimers()
  writeClipboardText.mockReset()
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

async function renderGuide(locale: Locale = 'en') {
  localeState.locale = locale
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
}

afterEach(async () => {
  await act(async () => root.unmount())
  host.remove()
  vi.useRealTimers()
})

test.each([
  ['en', 'Copy', 'Copied', 'Copy code'],
  ['ja', 'コピー', 'コピーしました', 'コードをコピー'],
] as const)(
  'copies the selected block with %s accessible feedback',
  async (locale, copy, copied, ariaLabel) => {
    await renderGuide(locale)
    writeClipboardText.mockResolvedValue(true)
    const buttons = host.querySelectorAll<HTMLButtonElement>('[data-code-copy]')
    expect(buttons[1].textContent).toBe(copy)
    expect(buttons[1].getAttribute('aria-label')).toBe(ariaLabel)
    await act(async () => buttons[1].click())
    expect(writeClipboardText).toHaveBeenCalledWith('echo second')
    expect(buttons[0].textContent).toBe(copy)
    expect(buttons[1].textContent).toBe(copied)
    expect(buttons[1].getAttribute('aria-label')).toBe(copied)
    await act(async () => vi.advanceTimersByTime(1600))
    expect(buttons[1].textContent).toBe(copy)
    expect(buttons[1].getAttribute('aria-label')).toBe(ariaLabel)
  },
)

test.each(['en', 'ja'] as const)(
  'does not claim success when copying fails in %s',
  async (locale) => {
    await renderGuide(locale)
    writeClipboardText.mockResolvedValue(false)
    const button = host.querySelector<HTMLButtonElement>('[data-code-copy]')!
    await act(async () => button.click())
    expect(button.textContent).toBe(locale === 'ja' ? 'コピー' : 'Copy')
    expect(button.getAttribute('aria-label')).toBe(
      locale === 'ja' ? 'コードをコピー' : 'Copy code',
    )
  },
)

test('clears feedback timers for every copied block on unmount', async () => {
  await renderGuide()
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

test('updates labels and clears old feedback when the locale changes', async () => {
  await renderGuide('en')
  writeClipboardText.mockResolvedValue(true)
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[data-code-copy]')!.click(),
  )
  await renderGuide('ja')
  expect(vi.getTimerCount()).toBe(0)
  const button = host.querySelector<HTMLButtonElement>('[data-code-copy]')!
  expect(button.textContent).toBe('コピー')
  expect(button.getAttribute('aria-label')).toBe('コードをコピー')
})
