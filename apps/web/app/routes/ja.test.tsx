import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, test, vi } from 'vitest'

vi.mock('cloudflare:workers', () => ({ env: {} }))
vi.mock('~/services/db.server', () => ({ createDb: vi.fn() }))

vi.mock('./_home/+components/landing', () => ({
  Landing: () => <div data-landing="true">Landing</div>,
}))

import JaLandingRoute, { meta } from './ja'

describe('/ja route', () => {
  test('does not export a loader', async () => {
    const route = await import('./ja')
    expect('loader' in route).toBe(false)
  })

  test('returns Japanese canonical and social URLs', () => {
    const metadata = meta()
    expect(metadata).toContainEqual({
      tagName: 'link',
      rel: 'canonical',
      href: 'https://artifactshare.com/ja',
    })
    expect(metadata).toContainEqual({
      property: 'og:url',
      content: 'https://artifactshare.com/ja',
    })
  })

  test('renders Landing for the Japanese root locale', () => {
    const html = renderToStaticMarkup(createElement(JaLandingRoute))
    expect(html).toContain('data-landing="true"')
  })
})
