export const INDEX_FORMAT_VERSION = 13
export const BM25_WEIGHTS = [3, 1, 0.5] as const
export const KATAKANA_WEIGHT = 0.25

export function katakanaRuns(text: string): string {
  return [...text.normalize('NFKC').matchAll(/[\p{Script=Katakana}ー]{2,}/gu)]
    .flatMap(([run]) => [
      ...splitUtf8(
        run.length >= 3 && run.endsWith('ー') ? run.slice(0, -1) : run,
        TOKEN_BYTES,
      ),
    ])
    .join(' ')
}

export const TOKEN_BYTES = 16 * 1024
export const COLUMN_BYTES = 128 * 1024
const encoder = new TextEncoder()
const segmenter = new Intl.Segmenter('ja', { granularity: 'word' })

export function normalizeSearchText(text: string): string {
  const tokens: string[] = []
  for (const part of segmenter.segment(text.normalize('NFKC').toLowerCase())) {
    if (!part.isWordLike) continue
    let token = part.segment
    if (/^[\p{Script=Katakana}ー]{3,}$/u.test(token) && token.endsWith('ー'))
      token = token.slice(0, -1)
    tokens.push(...splitUtf8(token, TOKEN_BYTES))
  }
  return tokens.join(' ')
}

export function* splitUtf8(text: string, limit: number): Generator<string> {
  let parts: string[] = []
  let bytes = 0
  for (const point of text) {
    const size = encoder.encode(point).length
    if (bytes + size > limit) {
      yield parts.join('')
      parts = []
      bytes = 0
    }
    parts.push(point)
    bytes += size
  }
  if (parts.length) yield parts.join('')
}

export function packTokens(normalized: string): string[] {
  const chunks: string[] = []
  let tokens: string[] = []
  let bytes = 0
  for (const token of normalized.split(' ')) {
    if (!token) continue
    const size = encoder.encode(token).length
    if (size > TOKEN_BYTES) throw new Error('search_token_not_normalized')
    if (bytes + size + (tokens.length ? 1 : 0) > COLUMN_BYTES) {
      chunks.push(tokens.join(' '))
      tokens = []
      bytes = 0
    }
    bytes += size + (tokens.length ? 1 : 0)
    tokens.push(token)
  }
  if (tokens.length) chunks.push(tokens.join(' '))
  return chunks
}

export function snippet(text: string): string {
  const points: string[] = []
  for (const point of text) {
    if (points.length === 200_000) break
    points.push(point)
  }
  return points.join('')
}

export function phraseSeam(left: string, right: string): string {
  return left && right
    ? `${left.split(' ').slice(-32).join(' ')} ${right.split(' ').slice(0, 32).join(' ')}`
    : ''
}
