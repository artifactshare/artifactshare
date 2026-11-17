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
  ['inside the first window', 1200],
  ['just before a window boundary', 16_378],
  ['across a window boundary', 16_380],
  ['just after a window boundary', 16_386],
  ['deep in a long body', 150_000],
])(
  'a long body excerpts its first match %s like a whole-body scan',
  (_, at) => {
    const body = `${filler(at)}needleterm ${filler(160_000 - at)}`
    for (const query of ['needleterm', 'NEEDLETERM', 'needle term'])
      expect(excerpt(body, query)).toBe(wholeBodyExcerpt(body, query))
    expect(excerpt(body, 'needleterm')).toContain('needleterm')
  },
)

test('Japanese and katakana matches across a boundary match a whole-body scan', () => {
  const body = `${'共有の設定を確認します。'.repeat(1365)}フロントエンドエンジニアの募集${'あ'.repeat(9000)}`
  for (const query of ['フロントエンドエンジニア', 'エンジニア', '募集'])
    expect(excerpt(body, query)).toBe(wholeBodyExcerpt(body, query))
})

test('a segmented match with a long gap before a window boundary matches a whole-body scan', () => {
  for (const gap of [' '.repeat(700), '-'.repeat(2000), '　'.repeat(20_000)]) {
    const body = `${filler(16_000)} フロント${gap}エンド エンジニア ${filler(40_000)}`
    for (const query of [
      'フロントエンドエンジニア',
      'フロント エンド エンジニア',
    ])
      expect(excerpt(body, query)).toBe(wholeBodyExcerpt(body, query))
  }
})

test('a body without a match has no excerpt', () => {
  expect(excerpt(filler(50_000), 'absent')).toBe('')
})
