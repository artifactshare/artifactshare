import { expect, test, vi } from 'vitest'
import { loadEstimate } from './billing-preview'

vi.mock('cloudflare:workers', () => ({ env: {} }))

test.each([
  ['a lost connection', new TypeError('Failed to fetch')],
  [
    'an unreadable response',
    new Error('Unable to decode turbo-stream response', { cause: 'x' }),
  ],
])('%s reads as an estimate that could not be loaded', async (_, fault) => {
  await expect(loadEstimate(() => Promise.reject(fault))).resolves.toEqual({
    kind: 'external-failed',
  })
})

test('the app’s own failure still reaches the error boundary', async () => {
  const appError = new Error('Unexpected Server Error')
  await expect(loadEstimate(() => Promise.reject(appError))).rejects.toBe(
    appError,
  )
})
