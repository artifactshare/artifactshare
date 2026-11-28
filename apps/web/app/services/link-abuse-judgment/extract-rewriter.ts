import {
  LINK_ABUSE_ENTRYPOINT_LIMIT,
  LINK_ABUSE_EXTERNAL_DOMAIN_LIMIT,
  LINK_ABUSE_TEXT_LIMIT,
  extractLinkAbuseContent,
  type ExtractedLinkAbuseContent,
} from './extract'

const INACTIVE_ELEMENTS = 'script, style, noscript, template, iframe'
const URL_ATTRIBUTES: ReadonlyArray<readonly [selector: string, attr: string]> =
  [
    ['a[href]', 'href'],
    ['area[href]', 'href'],
    ['link[href]', 'href'],
    ['img[src]', 'src'],
    ['form[action]', 'action'],
  ]

export async function extractLinkAbuseContentFromHtml(
  html: string,
): Promise<ExtractedLinkAbuseContent> {
  if (typeof HTMLRewriter === 'undefined') return extractLinkAbuseContent(html)
  if (html.length > LINK_ABUSE_ENTRYPOINT_LIMIT) {
    html = html.slice(0, LINK_ABUSE_ENTRYPOINT_LIMIT)
  }

  const textParts: string[] = []
  let textLength = 0
  const domains: string[] = []
  const seen = new Set<string>()

  const addDomain = (raw: string | null) => {
    if (raw === null || domains.length >= LINK_ABUSE_EXTERNAL_DOMAIN_LIMIT)
      return
    const value = raw.trim()
    if (!value || value.startsWith('#')) return
    let url: URL
    try {
      url = new URL(value.startsWith('//') ? `https:${value}` : value)
    } catch {
      return
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return
    const hostname = url.hostname.toLowerCase().replace(/\.$/u, '')
    if (!hostname || isArtifactShareHost(hostname) || seen.has(hostname)) return
    seen.add(hostname)
    domains.push(hostname)
  }

  // Document-level text handlers also receive the contents of removed
  // elements, so inactive subtrees are tracked by depth instead of removed.
  let inactiveDepth = 0
  let rewriter = new HTMLRewriter().on(INACTIVE_ELEMENTS, {
    element(element) {
      let hasEndTag = true
      try {
        element.onEndTag(() => {
          inactiveDepth -= 1
        })
      } catch {
        // Self-closing (foreign content) elements have no end tag and no
        // content, so there is nothing to skip.
        hasEndTag = false
      }
      if (hasEndTag) inactiveDepth += 1
    },
  })
  for (const [selector, attr] of URL_ATTRIBUTES) {
    rewriter = rewriter.on(selector, {
      element(element) {
        if (inactiveDepth > 0) return
        addDomain(element.getAttribute(attr))
      },
    })
  }
  rewriter = rewriter
    .on('meta[http-equiv]', {
      element(element) {
        if (inactiveDepth > 0) return
        if (element.getAttribute('http-equiv')?.toLowerCase() !== 'refresh')
          return
        const content = element.getAttribute('content') ?? ''
        const target = /(?:^|;)\s*url\s*=\s*['"]?([^'";\s]+)/iu.exec(
          content,
        )?.[1]
        if (target) addDomain(target)
      },
    })
    .onDocument({
      text(chunk) {
        if (inactiveDepth > 0) return
        const value = decodeEntities(chunk.text)
        if (value) {
          for (const match of value.matchAll(/\bhttps?:\/\/[^\s<>"')]+/giu)) {
            addDomain(match[0])
          }
          if (textLength < LINK_ABUSE_TEXT_LIMIT) {
            textParts.push(value)
            textLength += value.length
          }
        }
        // A text node may arrive in several chunks; only a node boundary
        // separates words.
        if (chunk.lastInTextNode && textLength < LINK_ABUSE_TEXT_LIMIT) {
          textParts.push(' ')
        }
      },
    })

  // Consume the transformed stream so every handler runs to the end.
  await rewriter
    .transform(new Response(html, { headers: { 'content-type': 'text/html' } }))
    .arrayBuffer()

  const text = textParts
    .join('')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, LINK_ABUSE_TEXT_LIMIT)
  return { text, externalDomains: domains }
}

function isArtifactShareHost(hostname: string): boolean {
  return (
    hostname === 'artifactshare.com' ||
    hostname.endsWith('.artifactshare.com') ||
    hostname === 'artifactshare.link' ||
    hostname.endsWith('.artifactshare.link')
  )
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
}

function decodeEntities(value: string): string {
  if (!value.includes('&')) return value
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/giu,
    (whole: string, body: string) => {
      if (body[0] === '#') {
        const code =
          body[1] === 'x' || body[1] === 'X'
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10)
        return Number.isFinite(code) &&
          code > 0 &&
          code <= 0x10ffff &&
          (code < 0xd800 || code > 0xdfff)
          ? String.fromCodePoint(code)
          : whole
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? whole
    },
  )
}
