import {
  ANCHOR_EXCLUDED_TAGS,
  ANCHOR_EXCLUDED_ATTRIBUTES,
  ANCHOR_EXCLUDED_CLASSES,
} from './anchor-policy.js'
import {
  parse,
  parseFragment,
  serialize,
  type DefaultTreeAdapterMap,
} from 'parse5'

/** Versioned, source-backed UTF-16 coordinates. CSS never changes this space. */
export const ANCHOR_TEXT_FORMAT = 'source-dom-v1'
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
  const { document, segments } = indexSource(html)
  const values = segments.map((segment) => segment.value)
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index]!
    const parent = segment.parentNode!
    const at = parent.childNodes.indexOf(segment)
    parent.childNodes.splice(
      at,
      1,
      { nodeName: '#comment', data: `ash-source:${index}`, parentNode: parent },
      segment,
      {
        nodeName: '#comment',
        data: `ash-source-end:${index}`,
        parentNode: parent,
      },
    )
  }
  const manifest = JSON.stringify(values).replace(/</g, '\\u003c')
  const manifestTag = `<script type="application/json" id="ash-source-manifest">${manifest}</script>`
  const htmlElement = document.childNodes.find(
    (node): node is Element => 'tagName' in node && node.tagName === 'html',
  )!
  const head = htmlElement.childNodes.find(
    (node): node is Element => 'tagName' in node && node.tagName === 'head',
  )!
  const prefix = parseFragment(manifestTag + reporter).childNodes
  for (const node of prefix) node.parentNode = head
  head.childNodes.unshift(...prefix)
  return { html: serialize(document), manifest: manifestTag }
}
