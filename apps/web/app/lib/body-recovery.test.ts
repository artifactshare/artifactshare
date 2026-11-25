import { expect, test } from 'vitest'
import { bodyRecoveryHtml } from './body-recovery'

const VIEWER_URL = '/a/example?version=v1&from=body'

test.each([false, true] as const)(
  'both languages point back to the viewer (expired=%s)',
  (expired) => {
    const parts = bodyRecoveryHtml(VIEWER_URL, expired).split(
      '<section lang="ja">',
    )
    expect(parts).toHaveLength(2)
    for (const part of parts)
      expect(part).toContain('<a href="/a/example?version=v1&amp;from=body">')
    expect(parts[1]).toMatch(/[぀-ヿ一-鿿]/)
  },
)

test('an expired opening link is explained differently from a lost one', () => {
  expect(bodyRecoveryHtml(VIEWER_URL, true)).not.toBe(
    bodyRecoveryHtml(VIEWER_URL, false),
  )
})

test('escapes the destination so it cannot close the attribute or inject markup', () => {
  const html = bodyRecoveryHtml('/a/x?a=1&b=2"><script>alert(1)</script>')
  expect(html).toContain(
    'href="/a/x?a=1&amp;b=2&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"',
  )
  expect(html).not.toContain('<script>')
})
