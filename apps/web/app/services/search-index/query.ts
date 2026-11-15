import { normalizeSearchText } from './normalize'

export type SearchTier = 'title' | 'phrase' | 'all' | 'any'
export type IndexSearchInput = {
  query: string
  ownerUserIds?: string[]
  containerIds?: string[]
  updated?: { from?: string; to?: string }
  sort?: 'relevance' | 'newest'
  any?: boolean
  allowedIds?: string[]
  /** Internal typeahead ranking window; exhaustive searches leave this unset. */
  maxResults?: number
  limit?: number
  cursor?: number
}
export type IndexHit = {
  id: string
  tier: SearchTier
  rank: number
  activityAt: string
}
export type IndexPage = { items: IndexHit[]; nextCursor: number | null }
export type IndexSearchResult =
  | IndexPage
  | { error: { code: 'search_capacity_exceeded' } }
export class SearchCapacityError extends Error {
  constructor() {
    super('search_capacity_exceeded')
  }
}
// Reserve room for ranking/filter bindings under the SQLite parameter limit.
export const MAX_ALLOWED_IDS = 125_000
export const ALLOWED_ID_BINDING_BYTES = 1024 * 1024
const MAX_ALLOWED_ID_BINDINGS = 10
export function bindAllowedIds(ids: string[]): string[] {
  if (ids.length > MAX_ALLOWED_IDS) throw new SearchCapacityError()
  const arrays: string[] = []
  let parts: string[] = [],
    bytes = 2
  const encoder = new TextEncoder()
  for (const id of ids) {
    const part = JSON.stringify(id)
    const size = encoder.encode(part).byteLength
    if (size + 2 > ALLOWED_ID_BINDING_BYTES) throw new SearchCapacityError()
    if (bytes + size + (parts.length ? 1 : 0) > ALLOWED_ID_BINDING_BYTES) {
      arrays.push(`[${parts.join(',')}]`)
      if (arrays.length >= MAX_ALLOWED_ID_BINDINGS)
        throw new SearchCapacityError()
      parts = []
      bytes = 2
    }
    bytes += size + (parts.length ? 1 : 0)
    parts.push(part)
  }
  arrays.push(`[${parts.join(',')}]`)
  return arrays
}
export const tierOrder: Record<SearchTier, number> = {
  title: 0,
  phrase: 1,
  all: 2,
  any: 3,
}
export const literalKey = (value: string) =>
  value.normalize('NFKC').toLowerCase()
export const groupKey = (value: string) =>
  literalKey(value).replace(/\p{Nd}/gu, '')
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`

/** Only generated syntax reaches MATCH. Katakana runs retain segmented alternatives. */
export function prepareQuery(value: string) {
  const literal = literalKey(value.trim())
  const terms: string[] = []
  const expressions: string[] = []
  const runExpressions: string[] = []
  const prefixes: string[] = []
  for (const part of literal.split(/([\p{Script=Katakana}ー]+)/u)) {
    const tokens = normalizeSearchText(part).split(' ').filter(Boolean)
    if (!tokens.length) continue
    if (/^[\p{Script=Katakana}ー]+$/u.test(part)) {
      terms.push(tokens.join(' '))
      const prefix =
        part.length >= 3 && part.endsWith('ー') ? part.slice(0, -1) : part
      prefixes.push(prefix)
      runExpressions.push(quote(prefix) + '*')
      expressions.push(
        `({title body script}: ${quote(tokens.join(' '))} OR {title body script}: ${quote(prefix)}*)`,
      )
    } else
      for (const token of tokens) {
        runExpressions.push('""')
        terms.push(token)
        expressions.push(`{title body script}: ${quote(token)}`)
      }
  }
  return {
    literal,
    terms,
    expressions,
    runExpressions,
    prefixes,
    phrase: normalizeSearchText(value),
    blank: !value.trim(),
  }
}

const graphemeSegmenter = new Intl.Segmenter('ja', { granularity: 'grapheme' })
const wordSegmenter = new Intl.Segmenter('ja', { granularity: 'word' })

export function excerpt(body: string, query: string): string {
  const prepared = prepareQuery(query)
  const offsets: number[] = []
  const pieces: string[] = []
  // Normalize grapheme clusters together so combining marks and half-width kana
  // compose as ingestion does. Every normalized code unit retains its source span.
  for (const part of graphemeSegmenter.segment(body)) {
    const normalized = part.segment.normalize('NFKC')
    pieces.push(normalized)
    for (let i = 0; i < normalized.toLowerCase().length; i++)
      offsets.push(part.index)
  }
  const normalized = pieces.join('').toLowerCase()
  const positions: number[] = []
  for (const term of [...prepared.terms, ...prepared.prefixes]) {
    const position = normalized.indexOf(term)
    if (position >= 0) positions.push(offsets[position])
  }
  // The segmented Katakana alternative can match even when the original spelling
  // contains long-vowel marks or separators absent from the packed token sequence.
  const tokens: string[] = [],
    tokenOffsets: number[] = []
  for (const part of wordSegmenter.segment(normalized)) {
    if (!part.isWordLike) continue
    let sourceOffset = 0
    for (const token of normalizeSearchText(part.segment)
      .split(' ')
      .filter(Boolean)) {
      const tokenStart = part.segment.indexOf(token, sourceOffset)
      if (tokens.length) tokenOffsets.push(offsets[part.index + tokenStart])
      tokens.push(token)
      for (let i = 0; i < token.length; i++)
        tokenOffsets.push(offsets[part.index + tokenStart + i])
      sourceOffset = tokenStart + token.length
    }
  }
  const packed = tokens.join(' ')
  for (const term of prepared.terms) {
    const position = packed.indexOf(term)
    if (position >= 0) positions.push(tokenOffsets[position])
  }
  if (!positions.length) return ''
  const start = Math.max(0, Math.min(...positions) - 80)
  return `${start ? '…' : ''}${body.slice(start, start + 240)}${body.length > start + 240 ? '…' : ''}`
}
