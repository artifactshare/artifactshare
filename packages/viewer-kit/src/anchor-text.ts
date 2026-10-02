import {
  ANCHOR_EXCLUDED_TAGS,
  ANCHOR_EXCLUDED_ATTRIBUTES,
  ANCHOR_EXCLUDED_CLASSES,
} from './anchor-policy.js'
import { parse, type DefaultTreeAdapterMap } from 'parse5'

/** Versioned, source-backed UTF-16 coordinates. CSS never changes this space. */
export const ANCHOR_TEXT_FORMAT = 'source-dom-v2'
export const MAX_ANCHOR_TEXT_UNITS = 1_000_000
export { ANCHOR_EXCLUDED_SELECTOR } from './anchor-policy.js'

export interface AnchorBlock {
  start: number
  end: number
  id: string | null
  unique: boolean
}
export interface AnchorDocument {
  text: string
  blocks: AnchorBlock[]
}
type Node = DefaultTreeAdapterMap['node']
type Element = DefaultTreeAdapterMap['element']
const excludedTags = new Set(ANCHOR_EXCLUDED_TAGS)
const blockTags = new Set([
  'p',
  'li',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'pre',
  'blockquote',
  'td',
  'th',
])
function attr(node: Element, name: string) {
  return node.attrs.find((attribute) => attribute.name === name)?.value
}
function excluded(node: Element, markdown: boolean) {
  const classes = (attr(node, 'class') ?? '').split(/\s+/)
  return (
    excludedTags.has(node.tagName) ||
    ANCHOR_EXCLUDED_ATTRIBUTES.some((name) => attr(node, name) !== undefined) ||
    classes.some(
      (name) =>
        ANCHOR_EXCLUDED_CLASSES.includes(name) ||
        (markdown && name === 'mermaid-diagram'),
    )
  )
}

function indexSource(html: string) {
  const document = parse(html.replace(/^\uFEFF/, ''), {
    scriptingEnabled: true,
    sourceCodeLocationInfo: true,
  })
  const ids = new Map<string, number>()
  let body: Element | undefined
  let root: Element | undefined
  function discover(node: Node, inBody = false) {
    if ('tagName' in node) {
      if (node.tagName === 'body') {
        body = node
        inBody = true
      }
      const id = attr(node, 'id')
      if (id) ids.set(id, (ids.get(id) ?? 0) + 1)
      if (inBody && !root && attr(node, 'data-comment-content') !== undefined)
        root = node
    }
    if ('childNodes' in node)
      for (const child of node.childNodes) discover(child, inBody)
  }
  discover(document)
  const markdown = !!body && attr(body, 'data-artifact-markdown') !== undefined
  const segments: DefaultTreeAdapterMap['textNode'][] = []
  const blocks: AnchorBlock[] = []
  let text = ''
  let previousOwner: Element | null | undefined
  function walk(node: Node, owner: Element | null) {
    if ('tagName' in node) {
      if (excluded(node, markdown)) return
      if (blockTags.has(node.tagName)) owner = node
    }
    if (node.nodeName === '#text' && 'value' in node) {
      segments.push(node)
      const parts = owner
        ? [node.value]
        : (node.value.match(/[^\n]*\n|[^\n]+$/g) ?? [])
      for (const part of parts) {
        if (
          previousOwner !== owner ||
          !blocks.length ||
          (!owner && text.endsWith('\n'))
        ) {
          const id = owner && attr(owner, 'id')
          // Markdown heading slugs are presentation, not authored identities.
          const authored =
            id &&
            !markdown &&
            attr(owner!, 'data-anchor-generated-id') === undefined
          blocks.push({
            start: text.length,
            end: text.length,
            id: authored ? id : null,
            unique: !!authored && ids.get(id) === 1,
          })
        }
        text += part
        blocks[blocks.length - 1]!.end = text.length
        previousOwner = owner
      }
    } else if ('childNodes' in node) {
      for (const child of node.childNodes) walk(child, owner)
    }
  }
  if (root ?? body) walk((root ?? body)!, null)
  return { document, text, blocks, segments }
}

export function extractAnchorDocument(html: string): AnchorDocument {
  const { text, blocks } = indexSource(html)
  return { text, blocks }
}

/** Comments do not introduce elements, layout, or new CSS sibling matches. */
export function markAnchorSource(
  html: string,
  reporter = '',
): {
  html: string
  manifest: string
} {
  const { document, segments, text } = indexSource(html)
  if (text.length > MAX_ANCHOR_TEXT_UNITS) return { html, manifest: '' }
  // Source locations are used only to splice insertions. Never serialize the
  // parsed tree: serialization changes doctypes, encoding declarations and
  // authored markup (including browser parser repairs).
  const bom = html.startsWith('\uFEFF') ? 1 : 0
  const edits: Array<{ at: number; value: string; order?: number }> = []
  const tablesByParent = new Map<
    DefaultTreeAdapterMap['parentNode'],
    Element[]
  >()
  const regions: Array<{ start: number; end: number; value: string }> = []
  const fosteredRegions = new Map<Element, (typeof regions)[number]>()
  for (const segment of segments) {
    const location = segment.sourceCodeLocation
    if (!location) return { html, manifest: '' }
    let start = location.startOffset
    // Text after </body> is repaired into body, while comments stay outside.
    // Open its region before that closing tag so the marker precedes the node.
    const parentEnd =
      segment.parentNode && 'tagName' in segment.parentNode
        ? segment.parentNode.sourceCodeLocation?.endTag?.startOffset
        : undefined
    if (parentEnd !== undefined && start >= parentEnd) start = parentEnd
    // Fostered text can live beneath reconstructed formatting elements, not
    // just beside its table. Find the table beside any ancestor, but stop at
    // a containing table so ordinary cell text keeps its source-local marker.
    let parent = segment.parentNode
    let fosterTable: Element | undefined
    while (parent && !('tagName' in parent && parent.tagName === 'table')) {
      let tables = tablesByParent.get(parent)
      if (!tables) {
        tables = parent.childNodes.filter(
          (node): node is Element =>
            'tagName' in node &&
            node.tagName === 'table' &&
            !!node.sourceCodeLocation,
        )
        tablesByParent.set(parent, tables)
      }
      let low = 0,
        high = tables.length
      while (low < high) {
        const middle = (low + high) >>> 1
        if (
          tables[middle]!.sourceCodeLocation!.startOffset < location.endOffset
        )
          low = middle + 1
        else high = middle
      }
      const candidate = tables[low - 1]
      const table = candidate?.sourceCodeLocation
      if (table && table.endOffset >= location.endOffset) {
        fosterTable = candidate
        break
      }
      parent = 'parentNode' in parent ? parent.parentNode : null
    }
    if (fosterTable) {
      // Plain fostered text and reconstructed formatting elements can appear
      // before every comment token inside the table. Enclose them together;
      // nested cell regions exclude their text from this region's value.
      const existing = fosteredRegions.get(fosterTable)
      if (existing) existing.value += segment.value
      else {
        const table = fosterTable.sourceCodeLocation!
        const region = {
          // Fostered text can merge into a node preceding the table.
          start: Math.min(start, table.startOffset),
          end: table.endOffset,
          value: segment.value,
        }
        fosteredRegions.set(fosterTable, region)
        regions.push(region)
      }
    } else
      regions.push({ start, end: location.endOffset, value: segment.value })
  }
  const manifest = JSON.stringify(
    regions.map((region) => region.value),
  ).replace(/</g, '\\u003c')
  const manifestTag = `<script type="application/json" id="ash-source-manifest">${manifest}</script>`
  for (const [index, region] of regions.entries()) {
    edits.push(
      {
        at: region.start + bom,
        value: `<!--ash-source:${index}-->`,
        order: index + 1,
      },
      {
        at: region.end + bom,
        value: `<!--ash-source-end:${index}-->`,
        order: -index - 1,
      },
    )
  }
  edits.push(reporterSourceInsertion(html, manifestTag + reporter, document))
  // At shared boundaries, close inner regions first, then open new ones.
  // Parser-inserted end tags at EOF can give several regions the same end.
  edits.sort((a, b) => a.at - b.at || (a.order ?? 0) - (b.order ?? 0))
  const parts: string[] = []
  let cursor = 0
  for (const edit of edits) {
    parts.push(html.slice(cursor, edit.at), edit.value)
    cursor = edit.at
  }
  parts.push(html.slice(cursor))
  return { html: parts.join(''), manifest: manifestTag }
}

/** Find a safe insertion without serializing any authored bytes. */
export function reporterSourceInsertion(
  html: string,
  reporter: string,
  document = parse(html.replace(/^\uFEFF/, ''), {
    scriptingEnabled: true,
    sourceCodeLocationInfo: true,
  }),
): { at: number; value: string } {
  const htmlElement = document.childNodes.find(
    (node): node is Element => 'tagName' in node && node.tagName === 'html',
  )!
  const head = htmlElement.childNodes.find(
    (node): node is Element => 'tagName' in node && node.tagName === 'head',
  )!
  const headStart = head.sourceCodeLocation?.startTag?.endOffset
  let insertion =
    headStart ?? htmlElement.sourceCodeLocation?.startTag?.endOffset ?? 0
  if (headStart === undefined && !htmlElement.sourceCodeLocation?.startTag) {
    for (const node of document.childNodes) {
      if (node === htmlElement) break
      insertion = Math.max(insertion, node.sourceCodeLocation?.endOffset ?? 0)
    }
  }
  return {
    at: insertion + (html.startsWith('\uFEFF') ? 1 : 0),
    value: headStart === undefined ? `<head>${reporter}</head>` : reporter,
  }
}
