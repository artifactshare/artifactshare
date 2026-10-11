// @vitest-environment happy-dom
import { act } from 'react'
import { hydrateRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, expect, test, vi } from 'vitest'
import { PublicationTime } from './publication-time'

const language = vi.hoisted(() => ({ locale: 'en' as 'en' | 'ja' }))
vi.mock('~/hooks/use-t', () => ({ useT: () => language }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

test.each([
  ['en', '2 hours ago'],
  ['ja', '2 時間前'],
] as const)(
  'publication time hydrates with different clocks and ICU in %s',
  async (locale, relative) => {
    language.locale = locale
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime('2026-06-02T10:31:00Z')
    const localized = vi.spyOn(Date.prototype, 'toLocaleString')
    localized.mockReturnValue('server ICU date')
    const publishedAt = '2026-06-02T10:30:00.000Z'
    const view = <PublicationTime publishedAt={publishedAt} />
    const host = document.createElement('div')
    document.body.appendChild(host)
    host.innerHTML = renderToString(view)
    expect(host.textContent).toBe('2026-06-02 10:30:00 UTC')
    vi.setSystemTime('2026-06-02T12:30:00Z')
    localized.mockReturnValue('browser ICU date')
    const recoverable = vi.fn()
    await act(async () => {
      root = hydrateRoot(host, view, { onRecoverableError: recoverable })
    })
    expect(recoverable).not.toHaveBeenCalled()
    expect(host.textContent).toBe(relative)
    const time = host.querySelector('time')!
    expect(time.dateTime).toBe(publishedAt)
    expect(time.getAttribute('aria-label')).toBe('2026-06-02 10:30:00 UTC')
    expect(time.hasAttribute('title')).toBe(false)
  },
)
