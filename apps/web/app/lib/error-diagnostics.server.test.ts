import { afterEach, expect, test, vi } from 'vitest'
import { logErrorDiagnostic } from './error-diagnostics.server'

afterEach(() => {
  vi.restoreAllMocks()
})

function logged(error: unknown, method?: string, routeId?: string) {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  logErrorDiagnostic('test.operation', error, method, routeId)
  expect(log).toHaveBeenCalledTimes(1)
  const [diagnostic] = log.mock.calls[0] ?? []
  log.mockRestore()
  return diagnostic as Record<string, unknown>
}

test('keeps the result code and source frames and drops message text', () => {
  const error = new Error(
    'D1_ERROR: UNIQUE constraint failed: bot_destinations.name: SQLITE_CONSTRAINT value=synthetic-secret-value',
  )
  error.stack = [
    `Error: ${error.message}`,
    '    at createDestination (app/services/bot-destinations.server.ts:251:11)',
    '    at https://app.example/s/synthetic-share-id?token=synthetic-token:1:2',
    '    at action (/build/assets/bots-abc.js?v=synthetic-query#frag:12:34)',
    '    at async callRouteHandler (index.js:9:8)',
  ].join('\n')

  const diagnostic = logged(error, 'POST', 'bots')

  expect(diagnostic).toEqual({
    operation: 'test.operation',
    cause: 'Error',
    code: 'D1_ERROR',
    frames: [
      'createDestination (app/services/bot-destinations.server.ts:251:11)',
      'action (/build/assets/bots-abc.js:12:34)',
      'async callRouteHandler (index.js:9:8)',
    ],
    method: 'POST',
    routeId: 'bots',
  })
  const text = JSON.stringify(diagnostic)
  expect(text).not.toContain('synthetic-secret-value')
  expect(text).not.toContain('synthetic-share-id')
  expect(text).not.toContain('synthetic-token')
  expect(text).not.toContain('synthetic-query')
})

test('never reads frames or codes out of the message text', () => {
  const error = new Error(
    'upstream said:\n    at synthetic-token-value (synthetic-path.ts:1:2)\nSQLITE_SYNTHETIC_TOKEN',
  )
  error.stack = `Error: ${error.message}\n    at handler (app/services/slack.server.ts:290:9)`
  expect(logged(error)).toEqual({
    operation: 'test.operation',
    cause: 'Error',
    frames: ['handler (app/services/slack.server.ts:290:9)'],
  })

  const rewritten = new Error('synthetic-message')
  rewritten.stack = '    at synthetic-token-value (synthetic-path.ts:1:2)'
  expect(logged(rewritten)).toEqual({
    operation: 'test.operation',
    cause: 'Error',
  })
})

test('names the wrapped cause and takes its result code', () => {
  const inner = new TypeError('SQLITE_BUSY: synthetic-inner-detail')
  const error = new Error('synthetic-outer-detail', { cause: inner })

  const diagnostic = logged(error)

  expect(diagnostic).toMatchObject({
    cause: 'Error',
    innerCause: 'TypeError',
    code: 'SQLITE_BUSY',
  })
  expect(JSON.stringify(diagnostic)).not.toMatch(/synthetic-(inner|outer)/)
})

test('reduces custom error names, unknown values and methods to fixed values', () => {
  class SyntheticPrivateError extends Error {
    override name = 'SyntheticPrivateError'
    secretField = 'synthetic-field-value'
  }
  const custom = logged(new SyntheticPrivateError('x'), 'PROPFIND')
  expect(custom).toMatchObject({ cause: 'Error', method: 'OTHER' })
  expect(JSON.stringify(custom)).not.toContain('synthetic-field-value')
  expect(custom.frames).toEqual(expect.any(Array))

  expect(logged({ message: 'synthetic-object' })).toEqual({
    operation: 'test.operation',
    cause: 'Unknown',
  })
})
