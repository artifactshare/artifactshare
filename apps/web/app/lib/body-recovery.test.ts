import { expect, test } from 'vitest'
import { bodyRecoveryHtml } from './body-recovery'

test.each([
  [
    false,
    'This body is unavailable or you no longer have access.',
    '本文を表示できないか、閲覧権限がなくなっています。',
  ],
  [
    true,
    'This opening link has expired or has already been used.',
    'このリンクは有効期限が切れているか、すでに使用されています。',
  ],
] as const)(
  'recovery expired=%s explains recovery in both languages',
  (expired, english, japanese) => {
    const html = bodyRecoveryHtml('/a/example?version=v1&from=body', expired)
    expect(html).toContain(english)
    expect(html).toContain('<section lang="ja">')
    expect(html).toContain(japanese)
    expect(html).toContain(
      'ビューアーに戻って再読み込みし、本文を開き直してください。',
    )
    expect(html).toContain(
      '<a href="/a/example?version=v1&amp;from=body">Return to the viewer</a>',
    )
    expect(html).toContain(
      '<a href="/a/example?version=v1&amp;from=body">ビューアーに戻る</a>',
    )
  },
)
