import { expect, test } from 'vitest'
import { withoutLongAttributeValues } from './extract'

const long = 'A'.repeat(65536)
const kib = 'B'.repeat(1025)

test('empties long values of attributes that are not indexed', () => {
  expect(
    withoutLongAttributeValues(
      `<img alt="photo" src="data:image/png;base64,${long}"><a href='${kib}'>x</a><img src=${kib}><img/src="${kib}">`,
    ),
  ).toBe(`<img alt="photo" src=""><a href=''>x</a><img src=><img/src="">`)
})

test('cuts indexed attribute values at 64 KiB instead of emptying them', () => {
  expect(withoutLongAttributeValues(`<img alt="${long}C">`)).toBe(
    `<img alt="${long}">`,
  )
  const kept = `<p title="${'t'.repeat(65536)}">x</p>`
  expect(withoutLongAttributeValues(kept)).toBe(kept)
})

test('leaves text, comments and raw-text element content unchanged', () => {
  const html = [
    `<p>body name="${long}"</p>`,
    `<pre>a = '${long}'</pre>`,
    `<!-- <img src="${kib}"> -->`,
    `<script>var x = "${long}"; document.write('<img src="${kib}">')</script>`,
    `<textarea><img src="${kib}"></textarea>`,
  ].join('')
  expect(withoutLongAttributeValues(html)).toBe(html)
})

test('rewrites tags that follow a raw-text element', () => {
  expect(
    withoutLongAttributeValues(`<style>p{}</style><img src="${kib}">`),
  ).toBe(`<style>p{}</style><img src="">`)
})
