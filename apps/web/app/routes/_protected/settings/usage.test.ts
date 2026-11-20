import { expect, test, vi } from 'vitest'
vi.mock('~/middleware/context', () => ({ requireUser: vi.fn() }))
import { loader } from './usage'
import { RouterContextProvider } from 'react-router'
test('redirects authenticated usage visits to billing', () => {
  const response = loader({
    context: new RouterContextProvider(),
    params: {},
    pattern: '/settings/usage',
    url: new URL('https://example.test/settings/usage'),
    request: new Request('https://example.test/settings/usage'),
  })
  expect(response.status).toBe(302)
  expect(response.headers.get('Location')).toBe('/settings/billing')
})
