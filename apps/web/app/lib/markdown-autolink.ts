import type { InlineNode, MarkdownExtension } from '@tanstack/markdown'

const httpUrl = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&()*+,;=%]+/giu
const trailingPunctuation = /[.,;:!?]+$/u

export const httpAutolinkExtension: MarkdownExtension = {
  name: 'http-autolink',
  transformInline(nodes) {
    return nodes.flatMap(transformNode)
  },
}

function transformNode(node: InlineNode): InlineNode[] {
  if (node.type === 'text') return autolinkText(node.value)
  if (
    node.type === 'strong' ||
    node.type === 'emphasis' ||
    node.type === 'strike'
  )
    return [{ ...node, children: node.children.flatMap(transformNode) }]
  return [node]
}

function autolinkText(value: string): InlineNode[] {
  const nodes: InlineNode[] = []
  let cursor = 0

  for (const match of value.matchAll(httpUrl)) {
    const start = match.index
    const raw = match[0]
    const url = raw.replace(trailingPunctuation, '')
    if (start > cursor)
      nodes.push({ type: 'text', value: value.slice(cursor, start) })
    nodes.push({
      type: 'link',
      href: url,
      children: [{ type: 'text', value: url }],
    })
    if (url.length < raw.length)
      nodes.push({ type: 'text', value: raw.slice(url.length) })
    cursor = start + raw.length
  }

  if (cursor === 0) return value ? [{ type: 'text', value }] : []
  if (cursor < value.length)
    nodes.push({ type: 'text', value: value.slice(cursor) })
  return nodes
}
