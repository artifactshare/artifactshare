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
    .transform(new Response(html, { headers: { 'content-type': 'text/html' } }))
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
