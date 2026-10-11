import { act } from 'react'
import { createRoot, hydrateRoot, type Root } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, expect, test, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { waitForBrowserLayout } from '~/test/browser-layout'
import { VersionWidget } from './version-widget'
import '~/app.css'

vi.mock('~/hooks/use-t', async () => {
  const { bindI18n } = await import('~/lib/i18n')
  return { useT: () => bindI18n('en') }
})
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  document.body.replaceChildren()
  vi.useRealTimers()
})
const publishedAt = '2026-06-02T10:30:00.000Z'
const widget = (canViewHistory: boolean) => (
  <VersionWidget
    displayedPublishedAt={publishedAt}
    canViewHistory={canViewHistory}
    versions={[]}
    onOpenHistory={() => undefined}
  />
)

test.each([false, true])(
  'freshness clicks reach the artifact (history: %s)',
  async (canViewHistory) => {
    await page.viewport(375, 812)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const click = vi.fn()
    root = createRoot(host)
    await act(async () =>
      root!.render(
        <>
          <button style={{ position: 'fixed', inset: 0 }} onClick={click}>
            Artifact action
          </button>
          {widget(canViewHistory)}
        </>,
      ),
    )
    await waitForBrowserLayout()
    const time = host.querySelector('time')!
    const bounds = time.getBoundingClientRect()
    expect(bounds.width).toBeGreaterThan(0)
    const target = document.elementFromPoint(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
    )!
    expect(target.textContent).toBe('Artifact action')
    const targetBounds = target.getBoundingClientRect()
    await userEvent.click(target, {
      position: {
        x: bounds.x + bounds.width / 2 - targetBounds.x,
        y: bounds.y + bounds.height / 2 - targetBounds.y,
      },
    })
    expect(click).toHaveBeenCalledOnce()
  },
)

test('freshness hydrates across different server and browser clocks', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime('2026-06-02T10:31:00.000Z')
  const host = document.createElement('div')
  document.body.appendChild(host)
  host.innerHTML = renderToString(widget(false))
  const recoverable = vi.fn()
  vi.setSystemTime('2026-06-02T12:30:00.000Z')
  await act(async () => {
    root = hydrateRoot(host, widget(false), { onRecoverableError: recoverable })
  })
  expect(recoverable).not.toHaveBeenCalled()
  expect(host.querySelector('time')?.textContent).toBe('2 hours ago')
  expect(host.querySelector('time')?.dateTime).toBe(publishedAt)
})
