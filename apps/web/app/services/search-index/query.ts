import { normalizeSearchText } from './normalize'

export type SearchTier = 'title' | 'phrase' | 'all' | 'any'
export type IndexSearchInput = {
  query: string
  includeActiveDocumentCount?: boolean
  ownerUserIds?: string[]
  containerIds?: string[]
  updated?: { from?: string; to?: string }
  sort?: 'relevance' | 'newest'
  any?: boolean
  allowedIds?: string[]
  /** Internal typeahead ranking window; results searches leave this unset. */
  maxResults?: number
  /** Page-group completion only. */
  groupKeys?: string[]
  limit?: number
  cursor?: number
}
export type IndexHit = {
  id: string
  tier: SearchTier
  rank: number
  activityAt: string
}
export type IndexPage = {
  items: IndexHit[]
  nextCursor: number | null
  activeDocumentCount?: number
  incompleteGroupKeys?: string[]
}
export type IndexSearchResult =
  | IndexPage
  | { error: { code: 'search_capacity_exceeded' } }
export class SearchCapacityError extends Error {
  constructor() {
    super('search_capacity_exceeded')
  }
}
// Split bindings by bytes, never by the number of discoverable IDs.
export const ALLOWED_ID_BINDING_BYTES = 1024 * 1024
export function bindAllowedIds(ids: string[]): string[] {
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

/** Map both literal/prefix and segmented matches back onto original source text. */
export function searchMatchSpans(
  body: string,
  query: string,
): Array<[number, number]> {
  const prepared = prepareQuery(query)
  const starts: number[] = [],
    ends: number[] = [],
    pieces: string[] = []
  for (const part of graphemeSegmenter.segment(body)) {
    const normalized = part.segment.normalize('NFKC').toLowerCase()
    pieces.push(normalized)
    for (let i = 0; i < normalized.length; i++) {
      starts.push(part.index)
      ends.push(part.index + part.segment.length)
    }
  }
  const normalized = pieces.join('')
  const spans: Array<[number, number]> = []
  const collect = (
    text: string,
    terms: string[],
    from: number[],
    to: number[],
  ) => {
    for (const term of terms) {
      if (!term) continue
      let at = text.indexOf(term)
      while (at >= 0) {
        spans.push([from[at], to[at + term.length - 1]])
        at = text.indexOf(term, at + term.length)
      }
    }
  }
  collect(normalized, [...prepared.terms, ...prepared.prefixes], starts, ends)
  const tokens: string[] = [],
    tokenStarts: number[] = [],
    tokenEnds: number[] = []
  for (const part of wordSegmenter.segment(normalized)) {
    if (!part.isWordLike) continue
    let sourceOffset = 0
    for (const token of normalizeSearchText(part.segment)
      .split(' ')
      .filter(Boolean)) {
      const start = part.segment.indexOf(token, sourceOffset)
      if (tokens.length) {
        tokenStarts.push(starts[part.index + start])
        tokenEnds.push(ends[part.index + start])
      }
      tokens.push(token)
      for (let i = 0; i < token.length; i++) {
        tokenStarts.push(starts[part.index + start + i])
        tokenEnds.push(ends[part.index + start + i])
      }
      sourceOffset = start + token.length
    }
  }
  collect(tokens.join(' '), prepared.terms, tokenStarts, tokenEnds)
  return spans
}

export function excerpt(body: string, query: string): string {
  const positions = searchMatchSpans(body, query).map(([start]) => start)
  if (!positions.length) return ''
  const start = Math.max(0, Math.min(...positions) - 80)
  return `${start ? '…' : ''}${body.slice(start, start + 240)}${body.length > start + 240 ? '…' : ''}`
}
