import { MD_FILE_EXTENSIONS } from '../../lib/artifact-type'
import htmlEntities from './html-entities.json'
import { renderMarkdownBody } from '../../lib/markdown-renderer.server'
import { jsonStrings, scriptStrings, scriptElementStrings } from './literals'
import { INDEX_FORMAT_VERSION } from './normalize'

export interface ExtractedText {
  format: number
  body: string
  script: string
}
// WHATWG named references, generated from Python's standard-library html.entities.html5.
const namedEntities: Readonly<Record<string, string>> = htmlEntities
const maximumEntityLength = Math.max(
  ...Object.keys(namedEntities).map((name) => name.length),
)
// HTML numeric references use the Windows-1252 replacements for these controls.
const numericReplacements: Readonly<Record<number, number>> = {
  128: 8364,
  130: 8218,
  131: 402,
  132: 8222,
  133: 8230,
  134: 8224,
  135: 8225,
  136: 710,
  137: 8240,
  138: 352,
  139: 8249,
  140: 338,
  142: 381,
  145: 8216,
  146: 8217,
  147: 8220,
  148: 8221,
  149: 8226,
  150: 8211,
  151: 8212,
  152: 732,
  153: 8482,
  154: 353,
  155: 8250,
  156: 339,
  158: 382,
  159: 376,
}
function entities(value: string, attribute = false): string {
  return value.replace(
    /&(#x[0-9a-f]+;?|#\d+;?|[a-z][a-z0-9]*;?)/giu,
    (whole: string, name: string, offset: number) => {
      if (!name.startsWith('#')) {
        // Named references consume the longest recognized prefix. Only legacy
        // names may omit ';', and attributes reject an ambiguous following byte.
        for (
          let length = Math.min(name.length, maximumEntityLength);
          length > 0;
          length--
        ) {
          const prefix = name.slice(0, length)
          const decoded = Object.hasOwn(namedEntities, prefix)
            ? namedEntities[prefix]
            : undefined
          if (decoded === undefined) continue
          const next = value[offset + 1 + length] ?? ''
          if (!prefix.endsWith(';') && attribute && /[=a-z0-9]/iu.test(next))
            return whole
          return decoded + name.slice(length)
        }
        return whole
      }
      const code =
        name[1].toLowerCase() === 'x'
          ? parseInt(name.slice(2), 16)
          : parseInt(name.slice(1), 10)
      if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))
        return '\ufffd'
      return String.fromCodePoint(numericReplacements[code] ?? code)
    },
  )
}

const INDEXED_ATTRIBUTES = ['alt', 'title', 'aria-label', 'placeholder']
// Elements whose content the HTML tokenizer reads as text, not markup.
const RAW_TEXT_ELEMENTS = new Set([
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'noscript',
  'plaintext',
])
const OTHER_ATTRIBUTE_LIMIT = 1024
const INDEXED_ATTRIBUTE_LIMIT = 65536
const SPACE = /[\t\n\f\r ]/u

/**
 * HTMLRewriter rejects a start tag larger than its fixed per-tag memory limit
 * (about 2-3 MB) with "Parser error: The memory limit has been exceeded", so
 * one embedded data URI made a whole page unindexable. This pass reads only
 * start tags, the way the HTML tokenizer does, and shortens attribute values
 * there: values of attributes that are not indexed are emptied above 1 KiB,
 * and indexed attribute values are cut at 64 KiB. Text, comments and the
 * content of raw-text elements such as script are left unchanged.
 */
export function withoutLongAttributeValues(html: string): string {
  const parts: string[] = []
  let lower: string | undefined
  let copied = 0
  let at = 0
  const skipTo = (marker: string, from: number) => {
    const found = html.indexOf(marker, from)
    return found < 0 ? html.length : found + marker.length
  }
  while (at < html.length) {
    const open = html.indexOf('<', at)
    if (open < 0) break
    if (html.startsWith('<!--', open)) {
      at = skipTo('-->', open + 4)
      continue
    }
    const next = html[open + 1] ?? ''
    if (next === '!' || next === '?' || next === '/') {
      at = skipTo('>', open + 1)
      continue
    }
    if (!/[A-Za-z]/u.test(next)) {
      at = open + 1
      continue
    }
    let i = open + 1
    while (
      i < html.length &&
      !SPACE.test(html[i]) &&
      html[i] !== '/' &&
      html[i] !== '>'
    )
      i++
    const tag = html.slice(open + 1, i).toLowerCase()
    while (i < html.length && html[i] !== '>') {
      if (SPACE.test(html[i]) || html[i] === '/') {
        i++
        continue
      }
      const nameStart = i
      while (
        i < html.length &&
        !SPACE.test(html[i]) &&
        html[i] !== '/' &&
        html[i] !== '>' &&
        (html[i] !== '=' || i === nameStart)
      )
        i++
      const name = html.slice(nameStart, i).toLowerCase()
      let j = i
      while (j < html.length && SPACE.test(html[j])) j++
      if (html[j] !== '=') continue
      j++
      while (j < html.length && SPACE.test(html[j])) j++
      let valueStart = j
      let valueEnd: number
      const quote = html[j]
      if (quote === '"' || quote === "'") {
        valueStart = j + 1
        const close = html.indexOf(quote, valueStart)
        valueEnd = close < 0 ? html.length : close
        i = close < 0 ? html.length : close + 1
      } else {
        while (j < html.length && !SPACE.test(html[j]) && html[j] !== '>') j++
        valueEnd = j
        i = j
      }
      const limit = INDEXED_ATTRIBUTES.includes(name)
        ? INDEXED_ATTRIBUTE_LIMIT
        : OTHER_ATTRIBUTE_LIMIT
      if (valueEnd - valueStart > limit) {
        parts.push(html.slice(copied, valueStart))
        parts.push(
          limit === OTHER_ATTRIBUTE_LIMIT
            ? ''
            : html.slice(valueStart, valueStart + limit),
        )
        copied = valueEnd
      }
    }
    at = i + 1
    if (RAW_TEXT_ELEMENTS.has(tag)) {
      if (tag === 'plaintext') break
      lower ??= html.toLowerCase()
      const closing = lower.indexOf(`</${tag}`, at)
      at = closing < 0 ? html.length : closing
    }
  }
  if (copied === 0) return html
  parts.push(html.slice(copied))
  return parts.join('')
}

export async function extractHtml(html: string): Promise<ExtractedText> {
  let node = ''
  let rawScript = ''
  let scriptType = ''
  const body: string[] = []
  const scripts: string[] = []
  // Remove excluded subtrees in a streaming pass. A second tokenizer sees only
  // the retained markup, including for foreign self-closing elements: no end-tag
  // callback or unsupported element-shape property is needed.
  const filtered = new HTMLRewriter()
    .on('script', {
      element(element) {
        scriptType = element.getAttribute('type') ?? ''
      },
      text(chunk) {
        rawScript += chunk.text
        if (chunk.lastInTextNode) {
          scripts.push(scriptElementStrings(rawScript, scriptType))
          rawScript = ''
        }
      },
    })
    .on('script,style,svg,noscript,canvas,head', {
      element(element) {
        element.replace(' ')
      },
    })
    .transform(
      new Response(withoutLongAttributeValues(html), {
        headers: { 'content-type': 'text/html' },
      }),
    )
  const rewriter = new HTMLRewriter()
    .on('*', {
      element(element) {
        for (const name of ['alt', 'title', 'aria-label', 'placeholder']) {
          const value = element.getAttribute(name)
          if (value) body.push(entities(value, true))
        }
      },
    })
    .onDocument({
      text(chunk) {
        node += chunk.text
        if (chunk.lastInTextNode) {
          body.push(entities(node))
          node = ''
        }
      },
    })
  await rewriter.transform(filtered).arrayBuffer()
  return {
    format: INDEX_FORMAT_VERSION,
    body: body.join(' ').replace(/\s+/gu, ' ').trim(),
    script: scripts.join(' '),
  }
}

export function extractPage(
  source: string,
  path: string,
  kind?: string,
): Promise<ExtractedText> {
  return extractHtml(
    kind === 'markdown_page' || isMarkdownPath(path)
      ? renderMarkdownBody(source)
      : source,
  )
}
export function extractLocalStrings(source: string, path: string): string {
  return /\.json$/iu.test(path) ? jsonStrings(source) : scriptStrings(source)
}

export function isMarkdownPath(path: string): boolean {
  return MD_FILE_EXTENSIONS.some((extension) =>
    path.toLowerCase().endsWith(extension),
  )
}
