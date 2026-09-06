export const LINK_ABUSE_TEXT_LIMIT = 6_000
export const LINK_ABUSE_EXTERNAL_DOMAIN_LIMIT = 50
export const LINK_ABUSE_ENTRYPOINT_LIMIT = 256 * 1_024

export interface ExtractedLinkAbuseContent {
  text: string
  externalDomains: string[]
}

export function extractLinkAbuseContent(
  html: string,
): ExtractedLinkAbuseContent {
  // Large documents are sampled as a head window and a tail window. Each
  // window is stripped and mined on its own with its own share of the text
  // and domain budgets, so neither a runaway block in the head nor a script
  // the tail starts inside can crowd out the other window's evidence.
  const halfLimit = LINK_ABUSE_ENTRYPOINT_LIMIT / 2
  const windows: Array<{ html: string; startsInsideBlock: boolean }> =
    html.length <= LINK_ABUSE_ENTRYPOINT_LIMIT
      ? [{ html, startsInsideBlock: false }]
      : [
          { html: html.slice(0, halfLimit), startsInsideBlock: false },
          { html: html.slice(-halfLimit), startsInsideBlock: true },
        ]
  const textBudget = Math.ceil(LINK_ABUSE_TEXT_LIMIT / windows.length)
  const domainBudget = Math.ceil(
    LINK_ABUSE_EXTERNAL_DOMAIN_LIMIT / windows.length,
  )
  const seen = new Set<string>()
  const texts: string[] = []
  const domainLists: string[][] = []
  for (const window of windows) {
    const active = stripInactiveContent(window.html, window.startsInsideBlock)
    const domains: string[] = []
    extractExternalDomains(active, seen, domains, domainBudget)
    domainLists.push(domains)
    texts.push(
      decodeHtmlEntities(active.replace(/<[^>]*>/gu, ' '))
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, textBudget),
    )
  }

  const text = texts
    .filter((value) => value.length > 0)
    .join('\n')
    .slice(0, LINK_ABUSE_TEXT_LIMIT)
  const externalDomains = domainLists
    .flat()
    .slice(0, LINK_ABUSE_EXTERNAL_DOMAIN_LIMIT)
  return { text, externalDomains }
}

function extractExternalDomains(
  value: string,
  seen: Set<string>,
  externalDomains: string[],
  limit: number,
): void {
  // Attribute URLs are read only inside tags, so script-like assignments in
  // active text (`el.src = "https://…"`) are not harvested as attributes.
  for (const tag of value.matchAll(/<[a-z][^>]*>/giu)) {
    for (const match of tag[0].matchAll(
      /\b(?:href|src|action)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/giu,
    )) {
      addExternalDomain(
        match[1] ?? match[2] ?? match[3] ?? '',
        seen,
        externalDomains,
        limit,
      )
      if (externalDomains.length >= limit) return
    }
    if (/^<meta\b/iu.test(tag[0])) {
      const httpEquiv = attributeValue(tag[0], 'http-equiv')?.toLowerCase()
      if (httpEquiv === 'refresh') {
        const content = attributeValue(tag[0], 'content') ?? ''
        const target = /(?:^|;)\s*url\s*=\s*['"]?([^'";\s]+)/iu.exec(
          content,
        )?.[1]
        if (target) addExternalDomain(target, seen, externalDomains, limit)
        if (externalDomains.length >= limit) return
      }
    }
  }

  for (const match of value.matchAll(/\bhttps?:\/\/[^\s<>"')]+/giu)) {
    addExternalDomain(match[0], seen, externalDomains, limit)
    if (externalDomains.length >= limit) return
  }
}

const INACTIVE_TAG_NAMES = ['script', 'style'] as const

/**
 * Removes `<script>` and `<style>` blocks in one forward pass over a window.
 * Every `<` is visited at most once, so the work is linear however many
 * openers lack a closer. An unclosed opener drops the rest of the window
 * (the tail window is scanned separately, so evidence there survives), and a
 * window that starts inside a block drops everything up to its first closer.
 */
export function stripInactiveContent(
  html: string,
  startsInsideBlock = false,
): string {
  const parts: string[] = []
  let emitFrom = 0
  let inside: string | null = null
  let cursor = html.indexOf('<')

  if (startsInsideBlock) {
    const firstClose = findFirstCloser(html)
    const firstOpen = findFirstOpener(html)
    if (
      firstClose !== null &&
      (firstOpen === -1 || firstClose.index < firstOpen)
    ) {
      emitFrom = firstClose.end
      cursor = html.indexOf('<', emitFrom)
    }
  }

  while (cursor !== -1) {
    if (inside === null) {
      const name = openerName(html, cursor)
      if (name !== null) {
        parts.push(html.slice(emitFrom, cursor), ' ')
        inside = name
        const contentStart = tagEnd(html, cursor + 1 + name.length)
        emitFrom = contentStart
        cursor = html.indexOf('<', contentStart)
        continue
      }
    } else if (
      html.charCodeAt(cursor + 1) === 47 /* / */ &&
      tagNameMatches(html, cursor + 2, inside)
    ) {
      emitFrom = tagEnd(html, cursor + 2 + inside.length)
      inside = null
      cursor = html.indexOf('<', emitFrom)
      continue
    }
    cursor = html.indexOf('<', cursor + 1)
  }

  if (inside === null) parts.push(html.slice(emitFrom))
  return parts.join('')
}

function findFirstOpener(html: string): number {
  let cursor = html.indexOf('<')
  while (cursor !== -1) {
    if (openerName(html, cursor) !== null) return cursor
    cursor = html.indexOf('<', cursor + 1)
  }
  return -1
}

function findFirstCloser(html: string): { index: number; end: number } | null {
  let cursor = html.indexOf('</')
  while (cursor !== -1) {
    for (const name of INACTIVE_TAG_NAMES) {
      if (tagNameMatches(html, cursor + 2, name)) {
        return { index: cursor, end: tagEnd(html, cursor + 2 + name.length) }
      }
    }
    cursor = html.indexOf('</', cursor + 2)
  }
  return null
}

function openerName(html: string, lt: number): string | null {
  for (const name of INACTIVE_TAG_NAMES) {
    if (tagNameMatches(html, lt + 1, name)) return name
  }
  return null
}

function tagNameMatches(html: string, from: number, name: string): boolean {
  if (html.slice(from, from + name.length).toLowerCase() !== name) return false
  const boundary = html[from + name.length]
  return boundary === '>' || boundary === '/' || isHtmlWhitespace(boundary)
}

function tagEnd(html: string, from: number): number {
  const end = html.indexOf('>', from)
  return end === -1 ? html.length : end + 1
}

function isHtmlWhitespace(value: string | undefined): boolean {
  return (
    value === ' ' ||
    value === '\t' ||
    value === '\n' ||
    value === '\f' ||
    value === '\r'
  )
}

function attributeValue(tag: string, name: string): string | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const match = new RegExp(
    `\\b${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
    'iu',
  ).exec(tag)
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null
}

function addExternalDomain(
  raw: string,
  seen: Set<string>,
  domains: string[],
  limit: number,
): void {
  if (domains.length >= limit) return
  const value = decodeHtmlEntities(raw.trim())
  if (!value || value.startsWith('#')) return
  let url: URL
  try {
    url = new URL(value.startsWith('//') ? `https:${value}` : value)
  } catch (_error) {
    return
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return
  const hostname = url.hostname.toLowerCase().replace(/\.$/u, '')
  if (!hostname || isArtifactShareHost(hostname) || seen.has(hostname)) return
  seen.add(hostname)
  domains.push(hostname)
}

function isArtifactShareHost(hostname: string): boolean {
  return (
    hostname === 'artifactshare.com' ||
    hostname.endsWith('.artifactshare.com') ||
    hostname === 'artifactshare.link' ||
    hostname.endsWith('.artifactshare.link')
  )
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#(\d+);/gu, (match, decimal: string) =>
      decodeNumericEntity(match, decimal, 10),
    )
    .replace(/&#x([\da-f]+);/giu, (match, hex: string) =>
      decodeNumericEntity(match, hex, 16),
    )
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

function decodeNumericEntity(
  original: string,
  encoded: string,
  radix: number,
): string {
  const codePoint = Number.parseInt(encoded, radix)
  if (
    !Number.isInteger(codePoint) ||
    codePoint < 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  )
    return original
  return String.fromCodePoint(codePoint)
}
