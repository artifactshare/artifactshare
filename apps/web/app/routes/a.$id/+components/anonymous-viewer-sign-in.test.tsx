import { renderToStaticMarkup } from 'react-dom/server'
import type { ReactElement } from 'react'
import { describe, expect, test, vi } from 'vitest'
import { AnonymousViewerSignInControl } from './anonymous-viewer-sign-in'

describe('AnonymousViewerSignInControl', () => {
  const href = 'https://artifactshare.com/sign-in?next=%2Fa%2Fs1'

  test('uses a link so Google can decorate an analytics-enabled transition', () => {
    const html = renderToStaticMarkup(
      <AnonymousViewerSignInControl
        href={href}
        label="Sign in"
        shouldLoadAnalytics
      />,
    )

    expect(html).toContain(`href="${href}"`)
  })

  test('uses scripted navigation when analytics is disabled', () => {
    const control = AnonymousViewerSignInControl({
      href,
      label: 'Sign in',
      shouldLoadAnalytics: false,
    }) as ReactElement<{ onClick: () => void }>
    const html = renderToStaticMarkup(control)

    expect(html).toMatch(/<button[^>]*>Sign in<\/button>/)
    expect(html).not.toContain('href=')

    const assign = vi.fn()
    vi.stubGlobal('window', { location: { assign } })
    control.props.onClick()
    expect(assign).toHaveBeenCalledWith(href)
    vi.unstubAllGlobals()
  })
})
