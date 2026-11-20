import { expect, test } from 'vitest'
import { withoutLongAttributeValues } from './extract'

const long = 'A'.repeat(65536)
const kib = 'B'.repeat(1025)

test('empties long values of attributes that are not indexed', () => {
  expect(
    withoutLongAttributeValues(
      `<img alt="photo" src="data:image/png;base64,${long}"><a href='${kib}'>x</a><img src=${kib}><img/src="${kib}">`,
    ),
  ).toBe(`<img alt="photo" src=""><a href=''>x</a><img src=""><img/src="">`)
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

test('keeps the attribute after an emptied unquoted value', () => {
  expect(withoutLongAttributeValues(`<img src=${kib} alt="kept">`)).toBe(
    `<img src="" alt="kept">`,
  )
})

test('ends raw text only at an appropriate end tag', () => {
  expect(
    withoutLongAttributeValues(
      `<textarea></textareax <img src="${kib}"></textarea><img src="${kib}">`,
    ),
  ).toBe(`<textarea></textareax <img src="${kib}"></textarea><img src="">`)
})

test('keeps indexes aligned after characters that lengthen when lowercased', () => {
  expect(
    withoutLongAttributeValues(
      `<p>İİİ</p><style>p{}</style><img src="${kib}">`,
    ),
  ).toBe(`<p>İİİ</p><style>p{}</style><img src="">`)
})

test('treats title and style inside svg as markup', () => {
  expect(
    withoutLongAttributeValues(`<svg><title/><style/></svg><img src="${kib}">`),
  ).toBe(`<svg><title/><style/></svg><img src="">`)
})

test('ends comments where the HTML tokenizer does', () => {
  expect(
    withoutLongAttributeValues(
      `<!--><img src="${kib}"><!-- x --!><img src="${kib}">`,
    ),
  ).toBe(`<!--><img src=""><!-- x --!><img src="">`)
})
