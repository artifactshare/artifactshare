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

function transformInlineNodes(
  nodes: InlineNode[],
  state = { rawAnchorDepth: 0 },
): InlineNode[] {
  return nodes.flatMap((node): InlineNode[] => {
    if (node.type === 'inlineHtml') {
      state.rawAnchorDepth = Math.max(
        0,
        state.rawAnchorDepth +
          tagCount(node.value, /<a\b[^>]*>/giu) -
          tagCount(node.value, /<\/a\s*>/giu),
      )
      return [node]
    }
    if (node.type === 'text')
      return state.rawAnchorDepth ? [node] : autolinkText(node.value)
    if (
      node.type === 'strong' ||
      node.type === 'emphasis' ||
      node.type === 'strike'
    )
      return [{ ...node, children: transformInlineNodes(node.children, state) }]
    return [node]
  })
}

function tagCount(value: string, pattern: RegExp) {
  return Array.from(value.matchAll(pattern)).length
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

    if (hasHttpHost(url)) {
      const link: LinkNode = {
        type: 'link',
        href: url,
        children: [{ type: 'text', value: url }],
      }
      nodes.push(link)
    } else {
      nodes.push({ type: 'text', value: url })
    }

    const trailing = raw.slice(url.length)
    if (trailing) nodes.push({ type: 'text', value: trailing })
    cursor = start + raw.length
  }

  if (cursor === 0) return value ? [{ type: 'text', value }] : []
  if (cursor < value.length)
    nodes.push({ type: 'text', value: value.slice(cursor) })
  return nodes
}

function hasHttpHost(value: string) {
  try {
    return Boolean(new URL(value).hostname)
  } catch {
    return false
  }
}

function trimUrlEnd(value: string) {
  let end = value.length
  const balance = new Map([
    ['(', count(value, '(') - count(value, ')')],
    ['[', count(value, '[') - count(value, ']')],
    ['{', count(value, '{') - count(value, '}')],
  ])

  while (end > 0) {
    const last = value[end - 1] ?? ''
    if (trailingPunctuation.test(last)) {
      end--
      continue
    }
    if (
      (last === ')' && (balance.get('(') ?? 0) < 0) ||
      (last === ']' && (balance.get('[') ?? 0) < 0) ||
      (last === '}' && (balance.get('{') ?? 0) < 0) ||
      (last === '(' && (balance.get('(') ?? 0) > 0) ||
      (last === '[' && (balance.get('[') ?? 0) > 0) ||
      (last === '{' && (balance.get('{') ?? 0) > 0)
    ) {
      const open =
        last === ')' ? '(' : last === ']' ? '[' : last === '}' ? '{' : last
      balance.set(open, (balance.get(open) ?? 0) + (last === open ? -1 : 1))
      end--
      continue
    }
    break
  }

  return value.slice(0, end)
}

function count(value: string, character: string) {
  let total = 0
  for (const candidate of value) if (candidate === character) total++
  return total
}
