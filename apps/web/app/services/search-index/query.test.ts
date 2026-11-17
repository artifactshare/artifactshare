import { expect, test } from 'vitest'
import { excerpt, searchMatchSpans } from './query'

/** The excerpt a scan of the whole body produces. */
function wholeBodyExcerpt(body: string, query: string) {
  const positions = searchMatchSpans(body, query).map(([start]) => start)
  if (!positions.length) return ''
  const start = Math.max(0, Math.min(...positions) - 80)
  return `${start ? '…' : ''}${body.slice(start, start + 240)}${body.length > start + 240 ? '…' : ''}`
}

const filler = (length: number) =>
  'alpha 検索 プロジェクト beta 共有 report '
    .repeat(length / 30 + 1)
    .slice(0, length)

test.each([
  ['at the start', 0],
  ['early in the body', 1200],
  ['deep in a long body', 150_000],
])(
  'a long body excerpts its first match %s like a whole-body scan',
  (_, at) => {
    const body = `${filler(at)}needleterm ${filler(160_000 - at)}`
    for (const query of ['needleterm', 'NEEDLETERM', 'needle term', 'term'])
      expect(excerpt(body, query)).toBe(wholeBodyExcerpt(body, query))
    expect(excerpt(body, 'needleterm')).toContain('needleterm')
  },
)

test.each([
  ['spaces', ' '.repeat(700)],
  ['hyphens', '-'.repeat(2000)],
  ['ideographic spaces', '　'.repeat(20_000)],
  ['combining marks after spaces', ' ́'.repeat(1000)],
  ['symbols', '❶❷❸─'.repeat(500)],
])('a segmented match bridging %s matches a whole-body scan', (_, gap) => {
  const body = `${filler(16_000)} フロント${gap}エンド エンジニア ${filler(40_000)}`
  for (const query of [
    'フロントエンドエンジニア',
    'フロント エンド エンジニア',
    'エンジニア',
  ])
    expect(excerpt(body, query)).toBe(wholeBodyExcerpt(body, query))
})

test('a later shorter match does not hide an earlier longer one', () => {
  const body = `${filler(3000)} alpha beta gamma ${filler(3000)} gamma ${filler(9000)}`
  for (const query of ['alpha beta gamma', 'gamma alpha', 'beta gamma'])
    expect(excerpt(body, query)).toBe(wholeBodyExcerpt(body, query))
})

test('Japanese, katakana and soft-hyphen text match a whole-body scan', () => {
  const body = `${'共有の設定を確認します。'.repeat(1365)}フロ­ントエンドエンジニアの募集フロントエンドエンジニア${'あ'.repeat(9000)}`
  for (const query of [
    'フロントエンドエンジニア',
    'エンジニア',
    '募集',
    '設定',
  ])
    expect(excerpt(body, query)).toBe(wholeBodyExcerpt(body, query))
})

test('a body without a match has no excerpt', () => {
  expect(excerpt(filler(50_000), 'absent')).toBe('')
  expect(excerpt(filler(50_000), '')).toBe(wholeBodyExcerpt(filler(50_000), ''))
})
