import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'
import { Toaster } from './sonner'

let commentPanelOpen = false
let receivedProps: Record<string, unknown> = {}

vi.mock('~/components/app/analytics-consent-provider', () => ({
  useAnalyticsConsent: () => ({ commentPanelOpen }),
}))

vi.mock('sonner', () => ({
  Toaster: (props: Record<string, unknown>) => {
    receivedProps = props
    return <output />
  },
}))

describe('Toaster comment panel offsets', () => {
  test('does not pass offsets while the panel is closed', () => {
    commentPanelOpen = false
    renderToStaticMarkup(<Toaster />)
    expect(receivedProps).not.toHaveProperty('offset')
    expect(receivedProps).not.toHaveProperty('mobileOffset')
  })

  test('passes safe desktop and mobile offsets while the panel is open', () => {
    commentPanelOpen = true
    renderToStaticMarkup(<Toaster />)
    expect(receivedProps.offset).toEqual({
      bottom: 'var(--comment-panel-toast-bottom)',
    })
    expect(receivedProps.mobileOffset).toEqual({
      bottom: 'var(--comment-panel-toast-bottom)',
    })
    expect(receivedProps.className).toContain(
      '[--comment-panel-toast-bottom:var(--spacing-6)]',
    )
    expect(receivedProps.className).toContain(
      'max-sheet:[--comment-panel-toast-bottom:calc(var(--height-comment-panel-sheet)+var(--spacing-3))]',
    )
  })
})
