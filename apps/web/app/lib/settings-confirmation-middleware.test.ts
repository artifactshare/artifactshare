import { RouterContextProvider } from 'react-router'
import { expect, test } from 'vitest'
import { settingsSubmissionMiddleware } from './settings-confirmation'

// A server TypeError thrown before a Settings action must not reach the
// browser as a TypeError, which the confirmation reads as a lost connection.
test.each([
  ['/settings', true],
  ['/settings.data', true],
  ['/settings/billing', true],
  ['/settings/billing/', true],
  ['/settings/billing.data', true],
  ['/settings/billing/_.data', true],
  ['/settingsx', false],
  ['/settings-other', false],
  ['/projects', false],
])('%s converts a server TypeError: %s', async (pathname, converted) => {
  const wrapped = settingsSubmissionMiddleware(() => {
    throw new TypeError('session lookup failed')
  })
  const url = new URL('https://app.test' + pathname)
  const request = new Request(url, { method: 'POST' })
  const error = await Promise.resolve()
    .then(() =>
      wrapped(
        {
          request,
          url,
          params: {},
          pattern: pathname,
          context: new RouterContextProvider(),
        },
        () => Promise.resolve(new Response()),
      ),
    )
    .catch((thrown: unknown) => thrown)
  expect(error instanceof TypeError).toBe(!converted)
  expect(error).toBeInstanceOf(Error)
})
