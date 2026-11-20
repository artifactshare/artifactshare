import { expect, test } from 'vitest'
import { withoutLongAttributeValues } from './extract'

const long = 'A'.repeat(65536)

test('empties long quoted and unquoted attribute values', () => {
  expect(
    withoutLongAttributeValues(
      `<img alt="photo" src="data:image/png;base64,${long}"><a href='${long}'>x</a><img src=${long}>`,
    ),
  ).toBe(`<img alt="photo" src=""><a href="">x</a><img src="">`)
})

test('keeps indexed and short attribute values and text', () => {
  const html = `<p title="${'t'.repeat(65535)}">body ${long}</p>`
  expect(withoutLongAttributeValues(html)).toBe(html)
})
