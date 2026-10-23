import { expect, test } from 'vitest'
import { mutationOriginAllowed } from './request-origin.js'

test.each([
  [undefined, true],
  ['http://127.0.0.1:12345', true],
  ['null', false],
  ['http://127.0.0.1:12346', false],
  ['https://127.0.0.1:12345', false],
  ['http://localhost:12345', false],
  ['https://example.test', false],
  ['', false],
])('checks mutation Origin %s', (origin, allowed) => {
  expect(mutationOriginAllowed(origin, '127.0.0.1:12345')).toBe(allowed)
})

test.each(['null', undefined])(
  'accepts the no-referrer shell mutation with Origin %s',
  (origin) => {
    expect(
      mutationOriginAllowed(origin, '127.0.0.1:12345', 'same-origin'),
    ).toBe(true)
  },
)

test.each(['cross-site', 'same-site'])(
  'rejects %s mutations even with a missing or matching Origin',
  (fetchSite) => {
    for (const origin of [undefined, 'http://127.0.0.1:12345']) {
      expect(mutationOriginAllowed(origin, '127.0.0.1:12345', fetchSite)).toBe(
        false,
      )
    }
  },
)

test.each([
  [undefined, false],
  ['same-origin', true],
  ['same-site', false],
  ['cross-site', false],
  ['none', false],
  ['', false],
])('checks null Origin with Fetch Metadata %s', (fetchSite, allowed) => {
  expect(mutationOriginAllowed('null', '127.0.0.1:12345', fetchSite)).toBe(
    allowed,
  )
})

test('Fetch Metadata does not override an explicit foreign Origin', () => {
  expect(
    mutationOriginAllowed(
      'http://127.0.0.1:12346',
      '127.0.0.1:12345',
      'same-origin',
    ),
  ).toBe(false)
})

test('rejects duplicated Fetch Metadata with missing or matching Origin', () => {
  for (const origin of [undefined, 'http://127.0.0.1:12345', 'null']) {
    expect(
      mutationOriginAllowed(origin, '127.0.0.1:12345', ['same-origin']),
    ).toBe(false)
  }
})
