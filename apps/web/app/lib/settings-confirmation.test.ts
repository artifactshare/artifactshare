import { expect, test } from 'vitest'
import { isInterruptedRequest } from './settings-confirmation'

// What the router hands a confirmation when a response arrived with an error
// status: the shape `isRouteErrorResponse` recognizes.
const routeError = (status: number) => ({
  status,
  statusText: '',
  internal: false,
  data: null,
})

// A request the app never answered can be retried. The app's own answer, at
// any status, is a result the confirmation must show instead.
test.each([
  [502, true],
  [503, true],
  [504, true],
  [500, false],
  [401, false],
  [403, false],
  [404, false],
  [409, false],
])('a %i response counts as an interrupted request: %s', (status, expected) => {
  expect(isInterruptedRequest(routeError(status))).toBe(expected)
})

test('a lost connection and an unreadable response are interrupted', () => {
  expect(isInterruptedRequest(new TypeError('Failed to fetch'))).toBe(true)
  expect(
    isInterruptedRequest(
      new Error('Unable to decode turbo-stream response', {
        cause: new TypeError('network error'),
      }),
    ),
  ).toBe(true)
})

test('a server failure and a decode message without a cause are not', () => {
  expect(
    isInterruptedRequest(new Error('Unable to decode turbo-stream response')),
  ).toBe(false)
  expect(isInterruptedRequest(new Error('service fault'))).toBe(false)
  expect(isInterruptedRequest(null)).toBe(false)
})
