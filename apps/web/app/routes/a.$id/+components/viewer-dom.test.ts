// @vitest-environment happy-dom
import { afterEach, describe, expect, test } from 'vitest'
import { restoreViewerPanelFocus } from './viewer-dom'

describe('restoreViewerPanelFocus', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  test('restores the original trigger while the chrome is expanded', () => {
    const trigger = document.body.appendChild(document.createElement('button'))
    const fallback = document.body.appendChild(document.createElement('button'))

    restoreViewerPanelFocus({
      returnFocusRef: { current: trigger },
      collapsedFallbackRef: { current: fallback },
      topbarCollapsed: false,
    })

    expect(document.activeElement).toBe(trigger)
  })

  test('uses the visible collapse toggle after a user closes a panel', () => {
    const fallback = document.body.appendChild(document.createElement('button'))

    restoreViewerPanelFocus({
      returnFocusRef: { current: document.createElement('button') },
      collapsedFallbackRef: { current: fallback },
      topbarCollapsed: true,
    })

    expect(document.activeElement).toBe(fallback)
  })

  test.each([false, true])(
    'does not steal focus from a forced transition when collapsed is %s',
    (topbarCollapsed) => {
      const nextPanelControl = document.body.appendChild(
        document.createElement('button'),
      )
      const fallback = document.body.appendChild(
        document.createElement('button'),
      )
      nextPanelControl.focus()

      restoreViewerPanelFocus({
        returnFocusRef: { current: document.createElement('button') },
        collapsedFallbackRef: { current: fallback },
        topbarCollapsed,
      })

      expect(document.activeElement).toBe(nextPanelControl)
    },
  )
})
