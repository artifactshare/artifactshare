import type {
  InlineNode,
  LinkNode,
  MarkdownExtension,
} from '@tanstack/markdown'

const httpUrl = /https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&()*+,;=%]+/gu
const trailingPunctuation = /[.,;:!?]$/u

export const httpAutolinkExtension: MarkdownExtension = {
  name: 'http-autolink',
  transformInline(nodes) {
    return transformInlineNodes(nodes)
  },
}

function transformInlineNodes(nodes: InlineNode[]): InlineNode[] {
  return nodes.flatMap((node): InlineNode[] => {
    if (node.type === 'text') return autolinkText(node.value)
    if (
      node.type === 'strong' ||
      node.type === 'emphasis' ||
      node.type === 'strike'
    ) {
      return [{ ...node, children: transformInlineNodes(node.children) }]
    }
    return [node]
  })
}

function autolinkText(value: string): InlineNode[] {
  const nodes: InlineNode[] = []
  let cursor = 0

  for (const match of value.matchAll(httpUrl)) {
    const start = match.index
    const raw = match[0]
    const url = trimUrlEnd(raw)
    if (start > cursor)
      nodes.push({ type: 'text', value: value.slice(cursor, start) })

    const link: LinkNode = {
      type: 'link',
      href: url,
      children: [{ type: 'text', value: url }],
    }
    nodes.push(link)

    const trailing = raw.slice(url.length)
    if (trailing) nodes.push({ type: 'text', value: trailing })
    cursor = start + raw.length
  }

  if (cursor === 0) return value ? [{ type: 'text', value }] : []
  if (cursor < value.length)
    nodes.push({ type: 'text', value: value.slice(cursor) })
  return nodes
}

function trimUrlEnd(value: string) {
  let end = value.length

  while (end > 0) {
    const candidate = value.slice(0, end)
    const last = candidate.at(-1) ?? ''
    if (trailingPunctuation.test(last)) {
      end--
      continue
    }
    if (
      (last === ')' && unbalanced(candidate, '(', ')')) ||
      (last === ']' && unbalanced(candidate, '[', ']')) ||
      (last === '}' && unbalanced(candidate, '{', '}')) ||
      (last === '(' && unbalanced(candidate, ')', '(')) ||
      (last === '[' && unbalanced(candidate, ']', '[')) ||
      (last === '{' && unbalanced(candidate, '}', '{'))
    ) {
      end--
      continue
    }
    break
  }

  return value.slice(0, end)
}

function unbalanced(value: string, open: string, close: string) {
  return count(value, close) > count(value, open)
}

function count(value: string, character: string) {
  let total = 0
  for (const candidate of value) if (candidate === character) total++
  return total
}
