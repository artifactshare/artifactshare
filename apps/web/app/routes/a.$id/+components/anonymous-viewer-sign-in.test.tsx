import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test } from 'vitest'
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
    const html = renderToStaticMarkup(
      <AnonymousViewerSignInControl
        href={href}
        label="Sign in"
        shouldLoadAnalytics={false}
      />,
    )

    expect(html).toMatch(/<button[^>]*>Sign in<\/button>/)
    expect(html).not.toContain('href=')
  })
})
