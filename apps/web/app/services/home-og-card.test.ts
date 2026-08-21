import { describe, expect, test } from 'vitest'
import { MESSAGES, type Locale } from '~/i18n/messages'
import { createHomeCard, HOME_CARD_SERIF_FONT_FAMILY } from './home-og-card'

type CardNode = {
  type?: string
  props?: {
    style?: Record<string, unknown>
    children?: unknown
  }
}

function walk(node: unknown, visit: (node: CardNode) => void) {
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (!node || typeof node !== 'object') return
  const card = node as CardNode
  visit(card)
  walk(card.props?.children, visit)
}

function collectText(node: unknown): string {
  const parts: string[] = []
  walk(node, (card) => {
    const children = card.props?.children
    if (typeof children === 'string') parts.push(children)
  })
  return parts.join('\n')
}

describe.each(['en', 'ja'] as const)(
  'createHomeCard (%s)',
  (locale: Locale) => {
    const card = createHomeCard(locale)
    const text = collectText(card)

    test('shows the hero headline, the product line, and the locale URL', () => {
      expect(text).toContain(MESSAGES[locale]['lp.hero.titleDim'])
      expect(text).toContain(MESSAGES[locale]['lp.hero.titleMain'])
      expect(text).toContain(MESSAGES[locale]['lp.title'])
      expect(text).toContain(
        locale === 'ja' ? 'artifactshare.com/ja' : 'artifactshare.com',
      )
    })

    test('sets the serif family on the headline block', () => {
      let serifNodes = 0
      walk(card, (node) => {
        if (node.props?.style?.fontFamily === HOME_CARD_SERIF_FONT_FAMILY)
          serifNodes += 1
      })
      expect(serifNodes).toBe(1)
    })

    test('gives every multi-child element an explicit flex display for satori', () => {
      // satori refuses to lay out an element with several children unless it
      // declares display: flex; a missing one would 500 the whole route.
      const offenders: string[] = []
      walk(card, (node) => {
        const children = node.props?.children
        if (
          Array.isArray(children) &&
          children.filter((child) => child != null).length > 1 &&
          node.props?.style?.display !== 'flex'
        ) {
          offenders.push(JSON.stringify(node.props?.style ?? {}))
        }
      })
      expect(offenders).toEqual([])
    })
  },
)
