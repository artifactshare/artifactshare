import { MARKDOWN_PRINT_STYLE } from '@artifactshare/viewer-kit/markdown-print-style'
import printViewportStyle from '~/styles/print-viewport.css?raw'
import DOMPurify from 'dompurify'
import { canonicalExportPath, exportAssetHref } from '~/lib/export-path'
import { renderExportMermaidSvg } from '~/lib/mermaid-export.client'
import { renderMermaidInDocument } from '~/lib/mermaid-render.client'
import type { ExportSourceData } from './export-actions'

// Bounds cover acquisition, decoding and rendering, not the user's print dialog.
export const EXPORT_TIMEOUT = 30_000
export const PRINT_VIEWPORT_WIDTH = 900
export const PRINT_VIEWPORT_HEIGHT = 760
const MAX_RESOURCES = 128
const MAX_BYTES = 32 * 1024 * 1024
const MAX_EMBEDDED_BYTES = 64 * 1024 * 1024
const MAX_DEPTH = 12
// Vite removes the import from the server build; ordinary Viewer imports and
// non-PDF exports never evaluate or download the embedded font module.
export function loadPrintFont() {
  if (import.meta.env.SSR)
    return Promise.reject(new Error('PDF fonts require a browser'))
  return import('~/lib/export-print-font')
}

export type InertExportDocument = Pick<
  Document,
  | 'documentElement'
  | 'head'
  | 'body'
  | 'createElement'
  | 'importNode'
  | 'querySelector'
  | 'querySelectorAll'
>

// Fragment parsing differs across engines for noscript. Remove its scripting-
// enabled raw text before inert parsing; markup inside it is never tokenized.
// Consume whole tags (including malformed unquoted attributes) and bogus end-tag
// comments so a literal "<noscript>" in either cannot truncate visible content.
export function stripExportNoscript(html: string): string {
  // This prepass only resolves scripting-dependent noscript boundaries. Keep
  // ordinary/malformed markup on the existing inert sanitization path when no
  // possible noscript opener occurs (including existing namespace regressions).
  if (!/<noscript(?=[\t\n\f\r />])/i.test(html)) return html
  // Bogus comments also consume EOF: requiring a closing > retries a full
  // suffix scan at every subsequent < in an unterminated comment.
  const tokens =
    /<!--(?:-?>|[\s\S]*?(?:--!?>|$))|<!\[CDATA\[|<!doctype(?=[\t\n\f\r >])|<![^>]*(?:>|$)|<\?[^>]*(?:>|$)|<\/(?![a-z>])[^>]*(?:>|$)|<\/?[a-z][^\t\n\f\r />]*/gi
  // Unlike bogus declarations, a DOCTYPE identifier can contain quoted '>'.
  // Accept the ordinary HTML/Public/System forms as one token; reject malformed
  // declarations instead of interpreting their identifier text as markup.
  const doctype =
    /<!doctype[\t\n\f\r ]+[a-z][a-z0-9:_-]*(?:[\t\n\f\r ]+public[\t\n\f\r ]+(?:"[^"]*"|'[^']*')(?:[\t\n\f\r ]+(?:"[^"]*"|'[^']*'))?|[\t\n\f\r ]+system[\t\n\f\r ]+(?:"[^"]*"|'[^']*'))?[\t\n\f\r ]*>/iy
  // A quote starts an attribute value only after '='. In an unquoted value,
  // '<' and quotes are ordinary characters, not the start of another tag.
  const tagEnd = (start: number) => {
    let state:
      | 'name'
      | 'before'
      | 'afterName'
      | 'value'
      | 'unquoted'
      | 'quoted' = 'before'
    let quote = ''
    let selfClosing = false
    for (let index = start; index < html.length; index++) {
      const char = html[index]
      if (state === 'quoted') {
        if (char === quote) state = 'before'
        continue
      }
      if (char === '>') return { end: index + 1, selfClosing }
      selfClosing =
        char === '/' &&
        (state === 'before' || state === 'name' || state === 'afterName')
      const space = /[\t\n\f\r ]/.test(char)
      if (state === 'value') {
        if (space) continue
        if (char === '"' || char === "'") {
          quote = char
          state = 'quoted'
        } else state = 'unquoted'
      } else if (state === 'unquoted') {
        if (space) state = 'before'
      } else if (state === 'before') {
        // An unexpected '=' here begins a name; it does not introduce a
        // quoted value. This also applies after '/' or a quoted value.
        if (!space && char !== '/') state = 'name'
      } else if (char === '=') state = 'value'
      else if (char === '/') state = 'before'
      else if (space) state = 'afterName'
      else state = 'name'
    }
    return { end: html.length, selfClosing: false }
  }
  const rawText = new Set([
    'noscript',
    'script',
    'style',
    'textarea',
    'title',
    'xmp',
    'iframe',
    'noembed',
    'noframes',
  ])
  // Each token may scan this stack. Bound it before pushing so synchronous
  // parsing stays linear in input length with at most 256 contexts per scan;
  // the asynchronous preparation deadline cannot interrupt this prepass.
  const maxForeignContexts = 256
  type ForeignContext = {
    name: string
    namespace: 'svg' | 'math'
    integration: boolean
    htmlChildren: string[]
  }
  const foreignContexts: ForeignContext[] = []
  // Track only foreign content. HTML optional end tags and implied ancestors
  // belong to the browser's tree builder, not a second HTML stack here.
  const svgIntegrationPoints = new Set(['foreignobject', 'desc', 'title'])
  const mathIntegrationPoints = new Set(['mi', 'mo', 'mn', 'ms', 'mtext'])
  const htmlVoid = new Set(
    'area base br col embed hr img input link meta param source track wbr'.split(
      ' ',
    ),
  )
  const annotationIsHtml = (markup: string) => {
    // Read attributes with the inert HTML tokenizer, including entities and
    // duplicate-attribute handling. No source element enters an active document.
    const template = document.createElement('template')
    const attributes = template.content.ownerDocument.createElement('template')
    attributes.innerHTML = markup
    const encoding = attributes.content.firstElementChild
      ?.getAttribute('encoding')
      ?.toLowerCase()
    return encoding === 'text/html' || encoding === 'application/xhtml+xml'
  }
  // These tags leave foreign content through HTML error recovery. Refuse that
  // transition rather than guessing the namespace of subsequent declarations.
  const foreignBreakouts = new Set(
    'b big blockquote body br center code dd div dl dt em embed h1 h2 h3 h4 h5 h6 head hr i img li listing menu meta nobr ol p pre ruby s small span strong strike sub sup table tt u ul var font'.split(
      ' ',
    ),
  )
  let kept = 0
  const output: string[] = []
  let token: RegExpExecArray | null
  while ((token = tokens.exec(html))) {
    if (token[0].toLowerCase() === '<!doctype') {
      doctype.lastIndex = token.index
      if (!doctype.exec(html)) throw new Error('Malformed export doctype')
      tokens.lastIndex = doctype.lastIndex
      // Fragment parsing ignores doctypes. Removing the complete declaration
      // also keeps outer-html attribute extraction independent of identifier text.
      output.push(html.slice(kept, token.index))
      kept = tokens.lastIndex
      continue
    }
    if (token[0].toUpperCase() === '<![CDATA[') {
      // HTML descendants of integration points use different CDATA boundaries.
      // This prepass cannot safely infer their namespace after error recovery.
      if (foreignContexts.some((context) => context.integration))
        throw new Error('Ambiguous export CDATA')
      // CDATA is text in ordinary foreign content, a bogus comment in HTML.
      const delimiter =
        foreignContexts.length && token[0] === '<![CDATA[' ? ']]>' : '>'
      const end = html.indexOf(delimiter, tokens.lastIndex)
      tokens.lastIndex = end < 0 ? html.length : end + delimiter.length
      continue
    }
    const tag = /^<(\/?)([a-z][^\t\n\f\r />]*)$/i.exec(token[0])
    if (!tag) continue
    const tagStart = token.index
    const parsedTag = tagEnd(tokens.lastIndex)
    tokens.lastIndex = parsedTag.end
    const name = tag[2].toLowerCase()
    if (
      foreignContexts.length &&
      !foreignContexts.at(-1)?.integration &&
      (tag[1] ? name === 'p' || name === 'br' : foreignBreakouts.has(name))
    )
      throw new Error('Ambiguous foreign export markup')
    const current = foreignContexts.at(-1)
    if (tag[1]) {
      const index = foreignContexts.findLastIndex(
        (context) => context.name === name,
      )
      // A close matching the tracked foreign top can still be ignored by the
      // browser while HTML descendants are open. Refuse both ambiguous cases.
      if (index >= 0) {
        if (
          index !== foreignContexts.length - 1 ||
          current!.htmlChildren.length
        )
          throw new Error('Ambiguous foreign export closing tag')
        foreignContexts.pop()
      } else if (current?.integration && current.htmlChildren.length) {
        if (current.htmlChildren.at(-1) !== name)
          throw new Error('Ambiguous foreign export closing tag')
        current.htmlChildren.pop()
      } else if (current) {
        // An unmatched end tag can be reprocessed by the HTML tree builder,
        // including heading aliases and implied table ancestors. Never guess
        // whether it pops the foreign root and changes subsequent tokenization.
        throw new Error('Ambiguous foreign export closing tag')
      }
      continue
    }
    const inHtml = current?.integration ?? false
    // These MathML text-point exceptions remain foreign, unlike ordinary HTML
    // children. This limited prepass refuses to guess their descendant context.
    if (
      inHtml &&
      current?.namespace === 'math' &&
      (name === 'mglyph' || name === 'malignmark')
    )
      throw new Error('Ambiguous foreign export markup')
    // A foreign root name in another foreign namespace is not a namespace
    // switch. Refuse that ambiguity instead of inventing integration points.
    if (
      current &&
      !inHtml &&
      ((name === 'svg' && current.namespace !== 'svg') ||
        (name === 'math' && current.namespace !== 'math'))
    )
      throw new Error('Ambiguous foreign export markup')
    const integration =
      !!current &&
      !inHtml &&
      (current.namespace === 'svg'
        ? svgIntegrationPoints.has(name)
        : mathIntegrationPoints.has(name) ||
          (name === 'annotation-xml' &&
            annotationIsHtml(html.slice(tagStart, parsedTag.end))))
    if (
      name === 'svg' ||
      name === 'math' ||
      integration ||
      (current && !inHtml && !rawText.has(name) && name !== 'plaintext')
    ) {
      if (!parsedTag.selfClosing) {
        if (foreignContexts.length >= maxForeignContexts)
          throw new Error('Export foreign nesting limit exceeded')
        foreignContexts.push({
          name,
          namespace:
            name === 'svg' || name === 'math' ? name : current!.namespace,
          integration,
          htmlChildren: [],
        })
      }
    } else if (inHtml && !htmlVoid.has(name) && !rawText.has(name)) {
      // HTML ignores the self-closing flag. Optional/end-tag recovery is left
      // to the inert parser only when it cannot change a foreign boundary.
      const children = current!.htmlChildren
      if (children.length >= maxForeignContexts)
        throw new Error('Export foreign nesting limit exceeded')
      children.push(name)
    }
    // A foreign noscript is not HTML raw text. Reject the ambiguous construct
    // before a later HTML closer could make us discard visible content. This
    // conservative prepass does not attempt foreign-content error recovery.
    if (name === 'noscript' && foreignContexts.length)
      throw new Error('Foreign export noscript')
    if (rawText.has(name)) {
      if (foreignContexts.length && parsedTag.selfClosing) {
        if (foreignContexts.some((context) => context.integration))
          throw new Error('Ambiguous foreign export text')
        continue
      }
      const end = new RegExp(`</${name}(?=[\\t\\n\\f\\r />])`, 'gi')
      end.lastIndex = tokens.lastIndex
      const match = end.exec(html)
      // These names are not raw text in foreign namespaces. Simple text has
      // identical boundaries, but embedded markup or a missing closer needs a
      // real tree builder. Refuse it before skipping a root close or noscript.
      if (
        foreignContexts.length &&
        (!match || html.slice(tokens.lastIndex, match.index).includes('<'))
      )
        throw new Error('Ambiguous foreign export text')
      if (name === 'script') {
        // An escaped script can enter double-escaped data, where the first
        // </script> is text. Refuse that case rather than interpreting its
        // contents as markup and consuming a later visible noscript boundary.
        const scriptText = html.slice(
          tokens.lastIndex,
          match?.index ?? html.length,
        )
        let escaped = false
        const markers = /<!--|-->|<script(?=[\t\n\f\r />])/gi
        let marker: RegExpExecArray | null
        while ((marker = markers.exec(scriptText))) {
          if (marker[0] === '<!--') {
            escaped = true
            // The opener ends in escaped dash-dash state. Its trailing dashes
            // can also start the closing sequence in <!--> or <!--->.
            markers.lastIndex = marker.index + 2
          } else if (marker[0] === '-->') escaped = false
          else if (escaped) throw new Error('Double-escaped export script')
        }
      }
      if (name === 'noscript' && !match)
        throw new Error('Unclosed export noscript')
      tokens.lastIndex = match ? tagEnd(end.lastIndex).end : html.length
      if (integration && !parsedTag.selfClosing) foreignContexts.pop()
      if (name === 'noscript') {
        output.push(html.slice(kept, token.index))
        kept = tokens.lastIndex
      }
    } else if (name === 'plaintext') {
      if (foreignContexts.length)
        throw new Error('Ambiguous foreign export text')
      break
    }
  }
  output.push(html.slice(kept))
  return output.join('')
}

export function inertExportDocument(
  html: string,
  forPrint = false,
): InertExportDocument {
  // Keep the entire tree in the template contents' inert owner document. In
  // particular, never connect raw links/images to a detached HTML Document:
  // engines need not treat all detached documents as network-disabled.
  const template = document.createElement('template')
  const inert = template.content.ownerDocument
  const parsed = inert.createElement('html')
  const preparedHtml = forPrint ? stripExportNoscript(html) : html
  parsed.innerHTML = preparedHtml
  const root = inert.createElement('html')
  const head = parsed.querySelector('head') ?? inert.createElement('head')
  const body = parsed.querySelector('body') ?? inert.createElement('body')
  if (!parsed.querySelector('body')) {
    for (const node of Array.from(parsed.childNodes)) {
      if (node !== head) body.appendChild(node)
    }
  }
  root.appendChild(head)
  root.appendChild(body)
  // Fragment parsing ignores the special outer html token. Preserve its
  // attributes without ever parsing the rest of the source in an active doc.
  const outer =
    /^(?:\s|<!--[\s\S]*?-->|<!doctype[^>]*>)*<html\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>/i.exec(
      preparedHtml,
    )
  if (outer) {
    const attributes = inert.createElement('template')
    attributes.innerHTML = `<div${outer[1]}></div>`
    for (const attr of Array.from(
      attributes.content.firstElementChild?.attributes ?? [],
    ))
      root.setAttribute(attr.name, attr.value)
  }
  template.content.appendChild(root)
  return {
    documentElement: root,
    head,
    body,
    createElement: inert.createElement.bind(inert),
    importNode: inert.importNode.bind(inert),
    querySelector: template.content.querySelector.bind(template.content),
    querySelectorAll: template.content.querySelectorAll.bind(template.content),
  }
}

const ACTIVE_ATTRIBUTES = new Set([
  'xml:base',
  'action',
  'formaction',
  'target',
  'formtarget',
  'autofocus',
  'accesskey',
  'contenteditable',
  'ping',
  'download',
  'srcdoc',
  'nonce',
  'integrity',
  'crossorigin',
])

function isExportStylesheet(el: Element): boolean {
  const relations =
    el
      .getAttribute('rel')
      ?.toLowerCase()
      .split(/[\t\n\f\r ]+/) ?? []
  return relations.includes('stylesheet')
}

// Select disjoint subtrees without walking ancestors for each match. Each
// sanitizer already visits all descendants, including nested roots of its kind.
function outermostExportElements(doc: InertExportDocument, name: string) {
  const roots: Element[] = []
  const pending: Element[] = [doc.documentElement]
  while (pending.length) {
    const element = pending.pop()!
    if (element.localName === name) {
      roots.push(element)
      continue
    }
    for (
      let child = element.lastElementChild;
      child;
      child = child.previousElementSibling
    )
      pending.push(child)
  }
  return roots
}

export function sanitizeExportDocument(doc: InertExportDocument) {
  // Comments never paint, but their serialized text can cross a raw-text
  // boundary when srcdoc is reparsed with scripting enabled (notably noscript).
  const comments = doc.documentElement.ownerDocument.createTreeWalker(
    doc.documentElement,
    128,
  )
  const remove: Node[] = []
  while (comments.nextNode()) remove.push(comments.currentNode)
  for (const comment of remove) comment.parentNode!.removeChild(comment)
  doc
    .querySelectorAll(
      'script,base,meta,noscript,iframe,frame,frameset,object,embed,portal,template,foreignObject,animate,animateMotion,animateTransform,set',
    )
    .forEach((el) => el.remove())
  // Preserve native mathematical layout while rejecting namespace integration
  // mutations. Annotations are non-display alternatives, never visible prose.
  for (const math of outermostExportElements(doc, 'math')) {
    DOMPurify.sanitize(math, {
      IN_PLACE: true,
      USE_PROFILES: { html: true, mathMl: true, svg: true, svgFilters: true },
      ADD_TAGS: ['semantics'],
      FORBID_TAGS: ['annotation', 'annotation-xml'],
      FORBID_CONTENTS: ['annotation', 'annotation-xml'],
    })
  }
  // Discover SVG roots after MathML sanitization. Keep the stricter SVG pass
  // even inside surviving MathML, but visit each subtree only once per profile.
  for (const svg of outermostExportElements(doc, 'svg')) {
    DOMPurify.sanitize(svg, {
      IN_PLACE: true,
      USE_PROFILES: { svg: true, svgFilters: true },
    })
  }
  for (const el of doc.querySelectorAll('*')) {
    if (
      el.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
      el.localName === 'img'
    ) {
      const source = el.getAttribute('src')?.trim() ?? ''
      // A fragment-only HTML image resolves to the document, not an image.
      // Remove placeholders while still inert, leaving alt text, dimensions
      // and picture/srcset candidates available for normal browser selection.
      if (!source || source.startsWith('#')) el.removeAttribute('src')
    }
    if (
      el.namespaceURI === 'http://www.w3.org/1999/xhtml' &&
      (el.localName === 'img' ||
        (el.localName === 'source' &&
          el.parentElement?.localName === 'picture' &&
          el.parentElement.namespaceURI === 'http://www.w3.org/1999/xhtml')) &&
      el.hasAttribute('srcset')
    ) {
      // Validate every descriptor before removing document-only placeholders.
      // Keep the parser's data-URI handling and real candidate descriptors.
      const candidates = parseExportSrcset(el.getAttribute('srcset')!).filter(
        ({ url }) => !url.startsWith('#'),
      )
      if (candidates.length)
        el.setAttribute(
          'srcset',
          candidates
            .map(({ url, descriptor }) => `${url} ${descriptor}`.trim())
            .join(', '),
        )
      else el.removeAttribute('srcset')
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      if (/^on/.test(name) || ACTIVE_ATTRIBUTES.has(name))
        el.removeAttribute(attr.name)
      if (
        (name === 'href' || name === 'xlink:href') &&
        el.localName !== 'link' &&
        !(
          el.namespaceURI === 'http://www.w3.org/2000/svg' &&
          ['image', 'feImage', 'use'].includes(el.localName)
        ) &&
        (el.localName === 'a' || !attr.value.startsWith('#'))
      )
        el.removeAttribute(attr.name)
    }
    if (
      el.matches(
        'a,button,input,select,textarea,summary,[tabindex],audio,video',
      )
    )
      el.setAttribute('tabindex', '-1')
    if (el.matches('button,input,select,textarea'))
      el.setAttribute('disabled', '')
    if (el.localName === 'link' && !isExportStylesheet(el)) el.remove()
  }
}

function cssUnescape(value: string): string {
  return value.replace(
    /\\([\da-f]{1,6}\s?|\r\n|[\n\r\f]|.)/gi,
    (_, escape: string) => {
      if (/^[\da-f]/i.test(escape))
        return String.fromCodePoint(parseInt(escape.trim(), 16) || 0xfffd)
      return /[\n\r\f]/.test(escape) ? '' : escape
    },
  )
}

type Token = {
  text: string
  value: string
  kind: 'string' | 'word' | 'space' | 'punct'
}
function cssTokens(css: string): Token[] {
  const matches =
    css.match(
      /\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|[+-]?(?:\d*\.\d+|\d+)(?:e[+-]?\d+)?(?:[a-z]|\\(?:[\da-f]{1,6}\s?|[\s\S]))+|(?:[-\w]|\\(?:[\da-f]{1,6}\s?|[\s\S]))+|\s+|[^]/gi,
    ) ?? []
  return matches.map((text) => {
    const kind = /^\/\*|^\s/.test(text)
      ? 'space'
      : /^["']/.test(text)
        ? 'string'
        : /^[-\w\\]/.test(text)
          ? 'word'
          : 'punct'
    return {
      text,
      kind,
      value: cssUnescape(kind === 'string' ? text.slice(1, -1) : text),
    }
  })
}

// The opaque document is a print preview throughout its lifetime. Evaluate media
// types as print before decoding/fonts/layout, rather than sizing a screen-only
// layout and clipping content when the browser later enters print media.
// Keep feature conditions (width, orientation, etc.) and negation intact.
function printMediaTokens(tokens: Token[]) {
  let depth = 0
  for (const token of tokens) {
    if (token.text === '(') depth++
    if (token.text === ')') depth--
    if (depth !== 0 || token.kind !== 'word') continue
    if (token.value.toLowerCase() === 'print') token.text = 'all'
    if (token.value.toLowerCase() === 'screen')
      token.text = 'artifactshare-screen'
  }
}

export function printMediaQuery(query: string): string {
  const tokens = cssTokens(query)
  printMediaTokens(tokens)
  return tokens.map((token) => token.text).join('')
}

// The frame must grow to contain the whole document. That growth must not also
// grow 100vh heroes, padding, or gaps. Resolve viewport lengths in declaration
// values against the fixed print layout viewport, never against content height.
// Strings, URL tokens, selectors and media feature conditions are not lengths.
function freezePrintViewportValues(tokens: Token[]) {
  let nesting = 0
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.text === '(' || token.text === '[') nesting++
    if (token.text === ')' || token.text === ']') nesting--
    if (nesting !== 0 || token.text !== ':') continue
    let end = i + 1
    let depth = 0
    for (; end < tokens.length; end++) {
      const text = tokens[end].text
      if (depth === 0 && [';', '{', '}'].includes(text)) break
      if (text === '(' || text === '[') depth++
      if (text === ')' || text === ']') depth--
    }
    if (tokens[end]?.text === '{') continue // selector pseudo-class
    let urlDepth = 0
    for (let j = i + 1; j < end; j++) {
      const value = tokens[j]
      if (value.kind === 'word' && value.value.toLowerCase() === 'url') {
        let open = j + 1
        while (tokens[open]?.kind === 'space') open++
        if (tokens[open]?.text === '(') {
          urlDepth = 1
          j = open
          continue
        }
      }
      if (urlDepth) {
        if (value.text === '(') urlDepth++
        if (value.text === ')') urlDepth--
        continue
      }
      if (
        value.kind === 'string' ||
        value.kind === 'space' ||
        !/^[+-]?(?:\d|\.\d)/.test(value.text)
      )
        continue
      const dimension =
        /^([+-]?(?:\d*\.\d+|\d+)(?:e[+-]?\d+)?)([dsl]?v(?:h|w|b|i|min|max))$/i.exec(
          value.value,
        )
      if (!dimension) continue
      const unit = dimension[2].toLowerCase()
      if (unit.endsWith('b') || unit.endsWith('i')) {
        value.text = `calc(${Number(dimension[1])} * var(--artifactshare-print-v${unit.slice(-1)}))`
        continue
      }
      const basis =
        unit.endsWith('w') || unit.endsWith('max')
          ? PRINT_VIEWPORT_WIDTH
          : PRINT_VIEWPORT_HEIGHT
      const pixels = (Number(dimension[1]) * basis) / 100
      if (!Number.isFinite(pixels))
        throw new Error('Invalid print viewport length')
      value.text = `${Number(pixels.toFixed(6))}px`
    }
    i = end - 1
  }
}

export async function rewriteExportCss(
  css: string,
  resolve: (ref: string, css: boolean) => Promise<string>,
  forPrint = true,
): Promise<string> {
  const tokens = cssTokens(css)
  if (forPrint) freezePrintViewportValues(tokens)
  const next = (i: number) => {
    while (tokens[i]?.kind === 'space') i++
    return i
  }
  const edits: Array<() => Promise<void>> = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.text === '@') {
      const name = next(i + 1)
      if (
        forPrint &&
        ['media', 'import'].includes(tokens[name]?.value.toLowerCase())
      ) {
        let end = name + 1
        let depth = 0
        while (end < tokens.length) {
          const token = tokens[end]
          if (depth === 0 && (token.text === '{' || token.text === ';')) break
          if (token.text === '(') depth++
          if (token.text === ')') depth--
          end++
        }
        printMediaTokens(tokens.slice(name + 1, end))
      }
      if (forPrint && tokens[name]?.value.toLowerCase() === 'page') {
        let end = name + 1
        while (
          end < tokens.length &&
          tokens[end].text !== '{' &&
          tokens[end].text !== ';'
        )
          end++
        if (tokens[end]?.text === '{') {
          let depth = 1
          while (++end < tokens.length && depth) {
            if (tokens[end].text === '{') depth++
            if (tokens[end].text === '}') depth--
          }
        } else end++
        for (let j = i; j < end; j++) tokens[j].text = ''
        i = end - 1
        continue
      }
      if (tokens[name]?.value.toLowerCase() === 'namespace') {
        let parentheses = 0
        while (i < tokens.length) {
          const text = tokens[i].text
          if (parentheses === 0 && [';', '{'].includes(text)) break
          if (text === '(' || text === '[') parentheses++
          if (text === ')' || text === ']') parentheses--
          i++
        }
        if (tokens[i]?.text === '{') {
          let depth = 1
          while (++i < tokens.length && depth) {
            if (tokens[i].text === '{') depth++
            if (tokens[i].text === '}') depth--
          }
          i--
        }
        continue
      }
      if (tokens[name]?.value.toLowerCase() === 'import') {
        const ref = next(name + 1)
        if (tokens[ref]?.kind === 'string') {
          edits.push(() =>
            resolve(tokens[ref].value, true).then((uri) => {
              tokens[ref].text = JSON.stringify(uri)
            }),
          )
          i = ref
          continue
        }
      }
    }
    if (t.kind === 'word' && t.value.toLowerCase() === 'url') {
      const open = next(i + 1)
      if (tokens[open]?.text !== '(') continue
      let end = open + 1
      while (end < tokens.length && tokens[end].text !== ')') end++
      if (end === tokens.length) throw new Error('Malformed CSS resource')
      const inside = tokens
        .slice(open + 1, end)
        .filter((token) => token.kind !== 'space')
      const ref =
        inside.length === 1 && inside[0].kind === 'string'
          ? inside[0].value
          : inside.map((token) => token.value).join('')
      let before = i - 1
      while (tokens[before]?.kind === 'space') before--
      const imported = tokens[before]?.value.toLowerCase() === 'import'
      const at = i
      edits.push(() =>
        resolve(ref, imported).then((uri) => {
          tokens[at].text = `url(${JSON.stringify(uri)})`
        }),
      )
      for (let j = i + 1; j <= end; j++) tokens[j].text = ''
      i = end
    }
    if (t.kind === 'word' && /^(?:-webkit-)?image-set$/i.test(t.value)) {
      let depth = 0
      for (let j = next(i + 1); j < tokens.length; j++) {
        if (tokens[j].text === '(') depth++
        if (tokens[j].text === ')' && --depth === 0) break
        if (depth === 1 && tokens[j].kind === 'string') {
          const token = tokens[j]
          edits.push(() =>
            resolve(token.value, false).then((uri) => {
              token.text = JSON.stringify(uri)
            }),
          )
        }
      }
    }
  }
  await Promise.all(edits.map((edit) => edit()))
  return tokens.map((t) => t.text).join('')
}

export function parseExportSrcset(
  value: string,
): Array<{ url: string; descriptor: string }> {
  const result: Array<{ url: string; descriptor: string }> = []
  let rest = value.trim()
  while (rest) {
    rest = rest.replace(/^[\s,]+/, '')
    const match = /^\S+/.exec(rest)
    if (!match) break
    let url = match[0]
    rest = rest.slice(url.length)
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '')
      result.push({ url, descriptor: '' })
      continue
    }
    const comma = rest.indexOf(',')
    const descriptor = (comma < 0 ? rest : rest.slice(0, comma)).trim()
    // Width descriptors must be positive integers; density descriptors may
    // use HTML floating-point syntax (including exponents and negative zero).
    // Reject nonfinite/negative values and validate before placeholder filtering.
    if (
      descriptor &&
      !(
        (/^\d+w$/.test(descriptor) && Number(descriptor.slice(0, -1)) > 0) ||
        (/^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?x$/.test(descriptor) &&
          Number.isFinite(Number(descriptor.slice(0, -1))) &&
          Number(descriptor.slice(0, -1)) >= 0)
      )
    )
      throw new Error('Invalid srcset')
    result.push({ url, descriptor })
    rest = comma < 0 ? '' : rest.slice(comma + 1)
  }
  return result
}

function dataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Unable to read export asset'))
    reader.readAsDataURL(blob)
  })
}

function decodeDataPayload(payload: string): string {
  const bytes = new TextEncoder().encode(payload)
  const decoded = new Uint8Array(bytes.length)
  let length = 0
  for (let i = 0; i < bytes.length; i++) {
    const hex = String.fromCharCode(bytes[i + 1] ?? 0, bytes[i + 2] ?? 0)
    if (bytes[i] === 37 && /^[0-9a-f]{2}$/i.test(hex)) {
      decoded[length++] = parseInt(hex, 16)
      i += 2
    } else decoded[length++] = bytes[i]
  }
  return new TextDecoder().decode(decoded.subarray(0, length))
}

async function decodeEmbeddedImage(uri: string): Promise<string> {
  const image = new Image()
  image.src = uri
  await image.decode()
  if (!image.naturalWidth) throw new Error('Export image unavailable')
  return uri
}

async function embeddedAsset(blob: Blob): Promise<string> {
  const uri = await dataUri(blob)
  return blob.type.startsWith('image/') ? decodeEmbeddedImage(uri) : uri
}

async function prepareDocument(
  id: string,
  data: ExportSourceData,
  signal: AbortSignal,
  forPrint: boolean,
): Promise<InertExportDocument> {
  const html = data.kind === 'markdown' ? data.renderedHtml : data.source
  if (!html || !data.versionId) throw new Error('Export source unavailable')
  // Enforce the source budget before synchronous parsing/sanitization, where
  // the asynchronous deadline cannot interrupt work. UTF-8 is at least as long
  // as the UTF-16 code-unit count, so reject huge strings before allocating it.
  if (html.length > MAX_BYTES) throw new Error('Export exceeds resource budget')
  let bytes = new TextEncoder().encode(html).length
  if (bytes > MAX_BYTES) throw new Error('Export exceeds resource budget')
  const doc = inertExportDocument(html, forPrint)
  if (forPrint) sanitizeExportDocument(doc)
  let count = 0
  let embeddedBytes = 0
  const embedded = (uri: string) => {
    embeddedBytes += new TextEncoder().encode(uri).byteLength
    if (embeddedBytes > MAX_EMBEDDED_BYTES)
      throw new Error('Export exceeds embedded resource budget')
    return uri
  }
  // Credits belong only to surviving references in the diagram that acquired them.
  // DOM identity is trusted provenance; artifact attributes and URI equality are not.
  const diagramCredits = new WeakMap<HTMLElement, Map<string, number>>()
  const preparedImageReferences = new WeakMap<Element, Map<string, string>>()
  const cache = new Map<string, Promise<string>>()
  const origin = window.location.origin
  const dependencies = new Map<string, Set<string>>()
  // Check composed paths even when a subtree was first acquired at shallow depth.
  function addDependency(parent: string | undefined, key: string) {
    if (!dependencies.has(key)) dependencies.set(key, new Set())
    if (parent) {
      const edges = dependencies.get(parent) ?? new Set<string>()
      edges.add(key)
      dependencies.set(parent, edges)
    }
    const depths = new Map<string, number>()
    const depth = (node: string, visiting: Set<string>): number => {
      if (visiting.has(node)) throw new Error('Cyclic export CSS')
      const cached = depths.get(node)
      if (cached !== undefined) return cached
      const path = new Set(visiting).add(node)
      const result =
        1 +
        Math.max(
          0,
          ...Array.from(dependencies.get(node) ?? [], (child) =>
            depth(child, path),
          ),
        )
      if (result > MAX_DEPTH) throw new Error('Deeply nested export resources')
      depths.set(node, result)
      return result
    }
    for (const node of dependencies.keys()) depth(node, new Set())
  }
  async function resource(
    ref: string,
    base: string,
    css = false,
    ancestors: string[] = [],
  ): Promise<string> {
    signal.throwIfAborted()
    const value = ref.trim()
    if (!value || value.startsWith('#')) return value
    if (ancestors.length >= MAX_DEPTH)
      throw new Error('Deeply nested export resources')
    if (/^data:/i.test(value)) {
      if (++count > MAX_RESOURCES) throw new Error('Too many export assets')
      const inlineKey = `inline-${count}`
      addDependency(ancestors.at(-1), inlineKey)
      if (/^data:(?:text\/css|image\/svg\+xml)[;,]/i.test(value)) {
        const hash = value.indexOf('#')
        const fragment = hash < 0 ? '' : value.slice(hash)
        if (
          Array.from(fragment).some(
            (char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127,
          )
        )
          throw new Error('Invalid inline fragment')
        const content = hash < 0 ? value : value.slice(0, hash)
        const comma = content.indexOf(',')
        const decoded = /;base64$/i.test(content.slice(0, comma))
          ? new TextDecoder().decode(
              Uint8Array.from(
                atob(decodeDataPayload(content.slice(comma + 1))),
                (c) => c.charCodeAt(0),
              ),
            )
          : decodeDataPayload(content.slice(comma + 1))
        bytes += new TextEncoder().encode(decoded).byteLength
        if (bytes > MAX_BYTES) throw new Error('Export exceeds resource budget')
        const nested = [...ancestors, inlineKey]
        if (css && /^data:text\/css[;,]/i.test(value)) {
          return embedded(
            await dataUri(
              new Blob(
                [
                  await rewriteExportCss(
                    decoded,
                    (url, imported) => resource(url, base, imported, nested),
                    forPrint,
                  ),
                ],
                { type: 'text/css' },
              ),
            ),
          )
        }
        if (!css && /^data:image\/svg\+xml[;,]/i.test(value)) {
          const svgDoc = inertExportDocument(decoded)
          sanitizeExportDocument(svgDoc)
          await rewriteDocumentResources(svgDoc, base, nested)
          const svg = svgDoc.querySelector('svg')
          if (!svg) throw new Error('Invalid inline SVG')
          svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
          const uri = embedded(
            await dataUri(
              new Blob([new XMLSerializer().serializeToString(svg)], {
                type: 'image/svg+xml',
              }),
            ),
          )
          return decodeEmbeddedImage(uri + fragment)
        }
        throw new Error('Unexpected inline resource type')
      }
      if (
        css ||
        !/^data:(?:image\/(?:png|jpeg|gif|webp|avif|bmp)|font\/[\w-]+|audio\/[\w-]+|video\/[\w-]+)[;,]/i.test(
          value,
        )
      )
        throw new Error('Unsafe inline asset')
      embedded(value)
      return /^data:image\//i.test(value) ? decodeEmbeddedImage(value) : value
    }
    const external =
      /^[a-z][\w+.-]*:|^\/\//i.test(value) || /^https:/.test(base)
    let fetchUrl: string
    let assetBase: string
    let fragment = ''
    if (external) {
      const url = new URL(value, /^https:/.test(base) ? base : origin)
      if (
        url.protocol !== 'https:' ||
        url.origin === origin ||
        url.username ||
        url.password
      )
        throw new Error('Unsafe external asset')
      fragment = url.hash
      url.hash = ''
      fetchUrl = url.href
      assetBase = fetchUrl
    } else {
      assetBase = canonicalExportPath(value, base)
      fetchUrl = exportAssetHref(id, data.versionId, assetBase, origin)
      fragment = value.includes('#') ? value.slice(value.indexOf('#')) : ''
    }
    const key = `${css}:${fetchUrl}`
    if (ancestors.includes(key) || ancestors.length >= MAX_DEPTH)
      throw new Error('Cyclic or deeply nested export CSS')
    addDependency(ancestors.at(-1), key)
    let pending = cache.get(key)
    if (!pending) {
      if (++count > MAX_RESOURCES) throw new Error('Too many export assets')
      pending = (async () => {
        const response = await fetch(fetchUrl, {
          signal,
          cache: 'no-store',
          redirect: 'error',
          credentials: external ? 'omit' : 'same-origin',
          referrerPolicy: 'no-referrer',
          mode: external ? 'cors' : 'same-origin',
        })
        if (!response.ok || response.redirected)
          throw new Error('Export asset unavailable')
        if (!response.body) throw new Error('Export asset body unavailable')
        const reader = response.body.getReader()
        const chunks: Uint8Array<ArrayBuffer>[] = []
        try {
          for (;;) {
            // Each chunk consumes the shared per-export budget before buffering.
            // react-doctor-disable-next-line react-doctor/async-await-in-loop
            const chunk = await reader.read()
            if (chunk.done) break
            bytes += chunk.value.byteLength
            if (bytes > MAX_BYTES)
              throw new Error('Export exceeds resource budget')
            chunks.push(new Uint8Array(chunk.value))
          }
        } finally {
          await reader.cancel()
          reader.releaseLock()
        }
        const blob = new Blob(chunks, {
          type: response.headers.get('content-type') ?? '',
        })
        if (css) {
          if (blob.type.split(';')[0] !== 'text/css')
            throw new Error('Invalid stylesheet type')
          const rewritten = await rewriteExportCss(
            await blob.text(),
            (url, imported) =>
              resource(url, assetBase, imported, [...ancestors, key]),
            forPrint,
          )
          return dataUri(new Blob([rewritten], { type: 'text/css' }))
        }
        if (
          !/^(?:image\/(?!svg\+xml)|font\/|audio\/|video\/|application\/(?:font-woff2?|woff2?|vnd.ms-fontobject|octet-stream))/.test(
            blob.type,
          )
        )
          throw new Error('Invalid passive asset type')
        return embeddedAsset(blob)
      })()
      cache.set(key, pending)
    }
    return embedded((await pending) + fragment)
  }
  async function rewriteDocumentResources(
    resourceDoc: InertExportDocument,
    base: string,
    ancestors: string[] = [],
  ) {
    const pending: Array<() => Promise<unknown>> = []
    for (const el of resourceDoc.querySelectorAll('*')) {
      if (forPrint && ['style', 'link', 'source'].includes(el.localName)) {
        const media = el.getAttribute('media')
        if (media) el.setAttribute('media', printMediaQuery(media))
      }
      if (
        ['script', 'iframe', 'object', 'embed'].includes(el.localName) ||
        (el.localName === 'link' && !isExportStylesheet(el))
      )
        continue
      for (const attr of [
        'src',
        'poster',
        'background',
        ...(el.namespaceURI === 'http://www.w3.org/2000/svg' &&
        ['image', 'feImage', 'use'].includes(el.localName)
          ? ['href', 'xlink:href']
          : []),
      ]) {
        const value = el.getAttribute(attr)
        if (value && preparedImageReferences.get(el)?.get(attr) !== value)
          pending.push(() =>
            resource(value, base, false, ancestors).then((uri) =>
              el.setAttribute(attr, uri),
            ),
          )
      }
      if (el.localName === 'link') {
        // Rewritten CSS bytes no longer match a source-page integrity hash.
        el.removeAttribute('integrity')
        const href = el.getAttribute('href')
        if (href)
          pending.push(() =>
            resource(href, base, true, ancestors).then((uri) =>
              el.setAttribute('href', uri),
            ),
          )
      }
      const srcset = el.getAttribute('srcset')
      if (srcset) {
        const candidates = parseExportSrcset(srcset)
        pending.push(() =>
          Promise.all(
            candidates.map(async (c) =>
              `${await resource(c.url, base, false, ancestors)} ${c.descriptor}`.trim(),
            ),
          ).then((c) => el.setAttribute('srcset', c.join(', '))),
        )
      }
      for (const attr of [
        'fill',
        'stroke',
        'filter',
        'clip-path',
        'mask',
        'marker-start',
        'marker-mid',
        'marker-end',
      ]) {
        const value = el.getAttribute(attr)
        if (value)
          pending.push(() =>
            rewriteExportCss(value, (url, css) =>
              resource(url, base, css, ancestors),
            ).then((rewritten) => el.setAttribute(attr, rewritten)),
          )
      }
      const style = el.getAttribute('style')
      if (style)
        pending.push(() =>
          rewriteExportCss(
            style,
            (url, css) => resource(url, base, css, ancestors),
            forPrint,
          ).then((css) => el.setAttribute('style', css)),
        )
      if (el.localName === 'style')
        pending.push(() =>
          rewriteExportCss(
            el.textContent ?? '',
            (url, css) => resource(url, base, css, ancestors),
            forPrint,
          ).then((css) => {
            el.textContent = css
          }),
        )
    }
    await Promise.all(pending.map((operation) => operation()))
  }
  await renderMermaidInDocument(
    doc,
    data.kind === 'markdown',
    (source, pre) => {
      const credits = new Map<string, number>()
      diagramCredits.set(pre, credits)
      return renderExportMermaidSvg(source, signal, async (ref) => {
        const uri = await resource(ref, data.path)
        credits.set(uri, (credits.get(uri) ?? 0) + 1)
        return uri
      })
    },
    (pre, container) => {
      const credits = diagramCredits.get(pre)!
      for (const el of container.querySelectorAll('image')) {
        for (const attr of ['href', 'xlink:href']) {
          const uri = el.getAttribute(attr)
          if (!uri) continue
          const credit = credits.get(uri) ?? 0
          if (!credit) continue
          credits.set(uri, credit - 1)
          const references = preparedImageReferences.get(el) ?? new Map()
          references.set(attr, uri)
          preparedImageReferences.set(el, references)
        }
      }
      diagramCredits.delete(pre)
    },
  )
  signal.throwIfAborted()
  // Renderer output is still untrusted resource-bearing content.
  await rewriteDocumentResources(doc, data.path)
  if (forPrint) {
    if (data.kind === 'markdown') {
      doc
        .querySelectorAll('.md-code-toolbar > button[data-code-copy]')
        .forEach((button) => button.remove())
      doc
        .querySelectorAll('details.md-toc-mobile')
        .forEach((toc) => toc.setAttribute('open', ''))
      const presentation = doc.createElement('style')
      presentation.textContent = MARKDOWN_PRINT_STYLE
      doc.head.appendChild(presentation)
    }
    const { PRINT_FONT_STYLE, PRINT_FONT_FAMILY } = await loadPrintFont()
    signal.throwIfAborted()
    const style = doc.createElement('style')
    style.textContent = `${PRINT_FONT_STYLE} ${printViewportStyle} html,body{background:#fff!important;color:#37352f;font-family:${PRINT_FONT_FAMILY},sans-serif!important;margin:0!important;min-height:0!important} img,svg,canvas,video{max-width:100%}`
    doc.head.insertBefore(style, doc.head.firstChild)
  }
  signal.throwIfAborted()
  return doc
}

/** Abort the whole preparation, including libraries that do not accept a signal.
 * Late continuations can only touch their inert document and check the signal
 * before handing anything back to the application. */
export function prepareExportDocument(
  id: string,
  data: ExportSourceData,
  signal: AbortSignal,
  forPrint = false,
): Promise<InertExportDocument> {
  return new Promise((resolve, reject) => {
    const controller = new AbortController()
    const abort = () => {
      controller.abort()
      reject(new Error('Export preparation cancelled or timed out'))
    }
    if (signal.aborted) return abort()
    signal.addEventListener('abort', abort, { once: true })
    void prepareDocument(id, data, controller.signal, forPrint)
      .then(resolve, (error) => {
        controller.abort()
        reject(error)
      })
      .finally(() => signal.removeEventListener('abort', abort))
  })
}

export async function withExportDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController()
  const timer = globalThis.setTimeout(() => controller.abort(), EXPORT_TIMEOUT)
  try {
    return await operation(controller.signal)
  } finally {
    globalThis.clearTimeout(timer)
    controller.abort()
  }
}
