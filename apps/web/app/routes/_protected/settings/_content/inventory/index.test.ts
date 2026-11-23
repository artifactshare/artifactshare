import { RouterContextProvider } from 'react-router'
import { describe, expect, test, vi } from 'vitest'
import { settingsAdminGate } from '../../+lib/settings-admin.server'
vi.mock('cloudflare:workers', () => ({ env: {} }))
import { loader } from './index'
describe('inventory index loader', () => {
  test('redirects an admitted admin to projects', () => {
    const context = new RouterContextProvider()
    context.set(settingsAdminGate, 'allowed')
    const url = new URL('https://x/settings/inventory')
    let thrown: unknown
    try {
      loader({
        context,
        request: new Request(url),
        params: {},
        url,
        pattern: '/settings/inventory',
      })
    } catch (error) {
      thrown = error
    }
    if (!(thrown instanceof Response)) throw new Error('expected a redirect')
    expect(thrown.status).toBe(302)
    expect(thrown.headers.get('Location')).toBe('/settings/inventory/projects')
  })
})
