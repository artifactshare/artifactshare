import { renderMarkdownBody as renderMarkdown } from '~/lib/markdown-renderer.server'
import { getPublicPagePath } from '~/lib/public-pages'
import type {
  UpdateEntry,
  UpdateKind,
  UpdateLocale,
  UpdateProduct,
} from '~/lib/updates-types'

const MORE_MARKER = '<!-- more -->'
const FILENAME_PATTERN = /^([a-z0-9-]+)\.(en|ja)\.md$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const PRODUCTS_PATTERN = /^\[([^\]]*)\]$/

const ALLOWED_KEYS = new Set([
  'title',
  'date',
  'products',
  'kind',
  'flag',
  'notice',
  'details',
])
const VALID_PRODUCTS = new Set(['web', 'cli', 'agent', 'mcp', 'admin'])
const VALID_KINDS = new Set(['new', 'improve', 'fix'])
export interface UpdateFrontmatter {
  title: string
  date: string
  products: UpdateProduct[]
  kind: UpdateKind
  flag?: string
  notice?: true
  details?: string
}

interface ParsedUpdateFile {
  slug: string
  locale: UpdateLocale
  frontmatter: UpdateFrontmatter
  body: string
}

interface LocalizedContent {
  title: string
  bodyHtml: string
  summaryHtml: string
  hasMore: boolean
}

interface UpdateRecord {
  slug: string
  date: string
  products: UpdateProduct[]
  kind: UpdateKind
  flag?: string
  notice?: true
  details?: string
  en: LocalizedContent
  ja?: LocalizedContent
}

const entryModules = import.meta.glob('../updates/entries/*.md', {
  query: '?raw',
  eager: true,
  import: 'default',
}) as Record<string, string>

let cachedRecords: UpdateRecord[] | null = null

export function validateUpdateFilename(filename: string): {
  slug: string
  locale: UpdateLocale
} {
  const match = FILENAME_PATTERN.exec(filename)
  if (!match) {
    throw new Error(`Invalid updates entry filename: ${filename}`)
  }

  return {
    slug: match[1]!,
    locale: match[2] as UpdateLocale,
  }
}

function isValidDate(date: string): boolean {
  if (!DATE_PATTERN.test(date)) {
    return false
  }

  const [year, month, day] = date.split('-').map(Number)
  const parsed = new Date(Date.UTC(year!, month! - 1, day!))
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month! - 1 &&
    parsed.getUTCDate() === day!
  )
}

function parseProducts(value: string): UpdateProduct[] {
  const match = PRODUCTS_PATTERN.exec(value.trim())
  if (!match) {
    throw new Error(`Invalid products value: ${value}`)
  }

  const inner = match[1]!.trim()
  if (inner.length === 0) {
    throw new Error('products must not be empty')
  }

  const products = inner.split(',').map((item) => item.trim())
  if (products.some((product) => product.length === 0)) {
    throw new Error(`Invalid products value: ${value}`)
  }

  const seen = new Set<string>()
  for (const product of products) {
    if (!VALID_PRODUCTS.has(product)) {
      throw new Error(`Invalid product: ${product}`)
    }
    if (seen.has(product)) {
      throw new Error(`Duplicate product: ${product}`)
    }
    seen.add(product)
  }

  return products as UpdateProduct[]
}

function parseKind(value: string): UpdateKind {
  const kind = value.trim()
  if (!VALID_KINDS.has(kind)) {
    throw new Error(`Invalid kind: ${value}`)
  }
  return kind as UpdateKind
}

function parseFrontmatterLine(line: string): { key: string; value: string } {
  const separatorIndex = line.indexOf(': ')
  if (separatorIndex === -1) {
    throw new Error(`Invalid frontmatter line: ${line}`)
  }

  return {
    key: line.slice(0, separatorIndex).trim(),
    value: line.slice(separatorIndex + 2),
  }
}

export function parseUpdateFrontmatter(raw: string): {
  frontmatter: UpdateFrontmatter
  body: string
} {
  // CRLF の entry 1 件で全ページが落ちないよう、行末は LF に正規化して扱う。
  raw = raw.replace(/\r\n/g, '\n')
  if (!raw.startsWith('---\n') && raw !== '---') {
    throw new Error('Frontmatter must start with --- on line 1')
  }

  const closingIndex = raw.indexOf('\n---', 3)
  if (closingIndex === -1) {
    throw new Error('Frontmatter closing --- is missing')
  }

  const frontmatterBlock = raw.slice(4, closingIndex)
  const body = raw.slice(closingIndex + 4)
  const lines = frontmatterBlock.split('\n').filter((line) => line.length > 0)
  const seenKeys = new Set<string>()
  const values: Record<string, string> = {}

  for (const line of lines) {
    const { key, value } = parseFrontmatterLine(line)
    if (!ALLOWED_KEYS.has(key)) {
      throw new Error(`Unknown frontmatter key: ${key}`)
    }
    if (seenKeys.has(key)) {
      throw new Error(`Duplicate frontmatter key: ${key}`)
    }
    seenKeys.add(key)
    values[key] = value.trim()
  }

  for (const requiredKey of ['title', 'date', 'products', 'kind'] as const) {
    if (!(requiredKey in values)) {
      throw new Error(`Missing required frontmatter key: ${requiredKey}`)
    }
  }

  const title = values.title!
  if (title.length === 0) {
    throw new Error('title must not be empty')
  }

  const date = values.date!
  if (!isValidDate(date)) {
    throw new Error(`Invalid date: ${date}`)
  }

  const products = parseProducts(values.products!)
  const kind = parseKind(values.kind!)

  let details: string | undefined
  if ('details' in values) {
    details = values.details!
    if (!getPublicPagePath(details, 'en')) {
      throw new Error(`Unknown public page details ID: ${details}`)
    }
  }

  let flag: string | undefined
  if ('flag' in values) {
    flag = values.flag!
    if (flag.length === 0) {
      throw new Error('flag must not be empty')
    }
  }

  let notice: true | undefined
  if ('notice' in values) {
    if (values.notice !== 'true') {
      throw new Error(`Invalid notice value: ${values.notice}`)
    }
    notice = true
  }

  return {
    frontmatter: {
      title,
      date,
      products,
      kind,
      ...(flag ? { flag } : {}),
      ...(details ? { details } : {}),
      ...(notice ? { notice } : {}),
    },
    body,
  }
}

export function splitUpdateBody(body: string): {
  bodySource: string
  summarySource: string
  hasMore: boolean
} {
  const markerIndex = body.indexOf(MORE_MARKER)
  if (markerIndex === -1) {
    return {
      bodySource: body,
      summarySource: body,
      hasMore: false,
    }
  }

  const before = body.slice(0, markerIndex)
  const after = body.slice(markerIndex + MORE_MARKER.length)
  return {
    bodySource: before + after,
    summarySource: before,
    hasMore: true,
  }
}

function toLocalizedContent(title: string, body: string): LocalizedContent {
  const { bodySource, summarySource, hasMore } = splitUpdateBody(body)
  const bodyHtml = renderMarkdown(bodySource)
  return {
    title,
    bodyHtml,
    summaryHtml: hasMore ? renderMarkdown(summarySource) : bodyHtml,
    hasMore,
  }
}

export function parseUpdateFile(
  filename: string,
  raw: string,
): ParsedUpdateFile {
  const { slug, locale } = validateUpdateFilename(filename)
  const { frontmatter, body } = parseUpdateFrontmatter(raw)
  return { slug, locale, frontmatter, body }
}

function metaKey(record: {
  date: string
  products: UpdateProduct[]
  kind: UpdateKind
  flag?: string
  details?: string
  notice?: true
}): string {
  return JSON.stringify({
    date: record.date,
    // 言語対の一致判定は集合として比較する (並び順の違いを不一致にしない)。
    products: record.products.toSorted(),
    kind: record.kind,
    flag: record.flag ?? null,
    details: record.details ?? null,
    notice: record.notice ?? null,
  })
}

export function buildUpdateRecords(
  files: ReadonlyArray<{ filename: string; content: string }>,
): UpdateRecord[] {
  const bySlug = new Map<
    string,
    {
      en?: ParsedUpdateFile
      ja?: ParsedUpdateFile
    }
  >()
  for (const file of files) {
    const parsed = parseUpdateFile(file.filename, file.content)
    const group = bySlug.get(parsed.slug) ?? {}
    if (parsed.locale === 'en') {
      group.en = parsed
    } else {
      group.ja = parsed
    }
    bySlug.set(parsed.slug, group)
  }

  const records: UpdateRecord[] = []

  for (const [slug, group] of bySlug) {
    if (!group.en) {
      throw new Error(`Missing English entry for slug: ${slug}`)
    }

    const enContent = toLocalizedContent(
      group.en.frontmatter.title,
      group.en.body,
    )

    let jaContent: LocalizedContent | undefined
    if (group.ja) {
      const enMeta = metaKey(group.en.frontmatter)
      const jaMeta = metaKey(group.ja.frontmatter)
      if (enMeta !== jaMeta) {
        throw new Error(`Language pair metadata mismatch for slug: ${slug}`)
      }
      jaContent = toLocalizedContent(group.ja.frontmatter.title, group.ja.body)
    }

    records.push({
      slug,
      date: group.en.frontmatter.date,
      products: group.en.frontmatter.products,
      kind: group.en.frontmatter.kind,
      flag: group.en.frontmatter.flag,
      details: group.en.frontmatter.details,
      notice: group.en.frontmatter.notice,
      en: enContent,
      ja: jaContent,
    })
  }

  return records.sort(compareRecords)
}

function compareRecords(a: UpdateRecord, b: UpdateRecord): number {
  const dateCompare = b.date.localeCompare(a.date)
  if (dateCompare !== 0) {
    return dateCompare
  }
  return b.slug.localeCompare(a.slug)
}

function loadUpdateRecords(): UpdateRecord[] {
  if (cachedRecords) {
    return cachedRecords
  }

  const files = Object.entries(entryModules).map(([path, content]) => ({
    filename: path.split('/').pop()!,
    content,
  }))

  cachedRecords = buildUpdateRecords(files)
  return cachedRecords
}

function toPublicEntry(
  record: UpdateRecord,
  locale: UpdateLocale,
): UpdateEntry {
  const localized = locale === 'ja' && record.ja ? record.ja : record.en
  const detailsHref = record.details
    ? getPublicPagePath(record.details, locale)
    : undefined

  return {
    slug: record.slug,
    title: localized.title,
    date: record.date,
    products: record.products,
    kind: record.kind,
    flag: record.flag,
    notice: record.notice,
    bodyHtml: localized.bodyHtml,
    summaryHtml: localized.summaryHtml,
    hasMore: localized.hasMore,
    ...(detailsHref ? { detailsHref } : {}),
  }
}

function matchesProductFilter(
  products: UpdateProduct[],
  product?: UpdateProduct,
): boolean {
  if (!product) {
    return true
  }
  return products.includes(product)
}

export function getAllUpdates(
  locale: UpdateLocale,
  product?: UpdateProduct,
): UpdateEntry[] {
  const entries: UpdateEntry[] = []
  for (const record of loadUpdateRecords()) {
    if (matchesProductFilter(record.products, product)) {
      entries.push(toPublicEntry(record, locale))
    }
  }
  return entries
}

export function getUpdateBySlug(
  slug: string,
  locale: UpdateLocale,
): UpdateEntry | undefined {
  const record = loadUpdateRecords().find((entry) => entry.slug === slug)
  if (!record) {
    return undefined
  }
  return toPublicEntry(record, locale)
}
