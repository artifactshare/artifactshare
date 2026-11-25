import { runInNewContext } from 'node:vm'
import { describe, expect, test } from 'vitest'
import { mcpResourceUrl } from '~/lib/mcp-metadata'
import {
  artifactPreviewResourceContents,
  computeClaudeWidgetDomain,
} from './preview-widget.server'

type ToolOutput = {
  locale?: string
  artifact_kind?: string
  title?: string
  share_url?: string
}

function fakeElement() {
  const handlers: Record<string, Array<(event: unknown) => void>> = {}
  return {
    textContent: '',
    hidden: false,
    href: undefined as string | undefined,
    removeAttribute(name: string) {
      if (name === 'href') this.href = undefined
    },
    addEventListener(type: string, handler: (event: unknown) => void) {
      ;(handlers[type] ??= []).push(handler)
    },
    dispatch(type: string, event: unknown) {
      for (const handler of handlers[type] ?? []) handler(event)
    },
  }
}

async function widgetHtml() {
  const result = await artifactPreviewResourceContents(
    'https://artifactshare.com',
    mcpResourceUrl('https://artifactshare.com'),
  )
  return { html: result.contents[0].text, meta: result.contents[0]._meta }
}

/** Runs the card's script the way a host does and records what it reports. */
function runWidget(html: string, toolOutput: ToolOutput, cardHeight = 184) {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1]
  expect(script).toBeDefined()
  const title = fakeElement()
  const eyebrow = fakeElement()
  const link = fakeElement()
  const elements: Record<string, ReturnType<typeof fakeElement>> = {
    'as-title': title,
    'as-eyebrow': eyebrow,
    'as-open': link,
  }
  const reportedHeights: number[] = []
  const openedExternally: string[] = []
  const observed: unknown[] = []
  const frames: Array<() => void> = []
  let height = cardHeight
  let resized: (() => void) | undefined
  const documentElement = { tag: 'html' }
  const body = { tag: 'body' }

  runInNewContext(script!, {
    document: {
      documentElement,
      body,
      getElementById(id: string) {
        if (id === 'as-card')
          return { getBoundingClientRect: () => ({ height }) }
        const element = elements[id]
        if (!element) throw new Error(`Unexpected widget element: ${id}`)
        return element
      },
    },
    window: {
      openai: {
        toolOutput,
        notifyIntrinsicHeight: (value: number) => reportedHeights.push(value),
        openExternal: ({ href }: { href: string }) =>
          openedExternally.push(href),
      },
      addEventListener() {},
    },
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    ResizeObserver: class {
      constructor(callback: () => void) {
        resized = callback
      }
      observe(target: unknown) {
        observed.push(target)
      }
    },
    URL,
  })

  const flush = () => {
    while (frames.length) frames.shift()!()
  }
  flush()
  return {
    title,
    eyebrow,
    link,
    reportedHeights,
    openedExternally,
    observed,
    documentElement,
    body,
    grow(to: number) {
      height = to
      resized?.()
      flush()
    },
    click() {
      let defaultPrevented = false
      link.dispatch('click', {
        preventDefault: () => {
          defaultPrevented = true
        },
      })
      return defaultPrevented
    },
  }
}

describe('computeClaudeWidgetDomain', () => {
  test('derives the production Claude widget host from the MCP endpoint URL', async () => {
    await expect(
      computeClaudeWidgetDomain('https://artifactshare.com/mcp'),
    ).resolves.toBe('9c4c6fc24ec537cb113fc299b3b58165.claudemcpcontent.com')
  })
})

describe('artifactPreviewResourceContents', () => {
  test.each([
    ['ja', 'ファイル'],
    ['en', 'Artifact'],
  ])('renders the unknown-kind fallback in %s', async (locale, label) => {
    const { html } = await widgetHtml()
    const widget = runWidget(html, { locale, artifact_kind: 'unknown' })
    expect(widget.title.textContent).toBe(label)
    expect(widget.eyebrow.textContent).toBe(`Artifact Share · ${label}`)
  })

  test('carries host widget domains without permitting nested frames', async () => {
    const { html, meta } = await widgetHtml()

    expect(meta['openai/widgetDomain']).toBe('https://artifactshare.com')
    expect(meta.ui.domain).toBe(
      '9c4c6fc24ec537cb113fc299b3b58165.claudemcpcontent.com',
    )
    expect(meta.ui.csp).not.toHaveProperty('frameDomains')
    expect(meta.ui.csp.resourceDomains).toEqual(['https://esm.sh'])
    expect(html).not.toContain('<iframe')
  })

  test('reports the card height to the host and again when it grows', async () => {
    const { html } = await widgetHtml()
    const widget = runWidget(
      html,
      { locale: 'en', artifact_kind: 'html_page' },
      184,
    )

    expect(widget.reportedHeights).toEqual([184])
    expect(widget.observed).toEqual([widget.documentElement, widget.body])
    widget.grow(240)
    expect(widget.reportedHeights).toEqual([184, 240])
    // An unchanged height is not re-reported.
    widget.grow(240)
    expect(widget.reportedHeights).toEqual([184, 240])
  })

  test('opens an https share URL through the host instead of the anchor', async () => {
    const { html } = await widgetHtml()
    const widget = runWidget(html, {
      locale: 'en',
      artifact_kind: 'html_page',
      title: 'Monthly report',
      share_url: 'https://artifactshare.com/a/abc123def4',
    })

    expect(widget.title.textContent).toBe('Monthly report')
    expect(widget.link.hidden).toBe(false)
    expect(widget.link.href).toBe('https://artifactshare.com/a/abc123def4')
    expect(widget.click()).toBe(true)
    expect(widget.openedExternally).toEqual([
      'https://artifactshare.com/a/abc123def4',
    ])
  })

  test.each([
    'http://artifactshare.com/a/abc',
    '/a/abc',
    'javascript:alert(1)',
  ])('hides the open link for a non-HTTPS share URL (%s)', async (shareUrl) => {
    const { html } = await widgetHtml()
    const widget = runWidget(html, {
      locale: 'en',
      artifact_kind: 'html_page',
      share_url: shareUrl,
    })

    expect(widget.link.hidden).toBe(true)
    expect(widget.link.href).toBeUndefined()
    expect(widget.click()).toBe(false)
    expect(widget.openedExternally).toEqual([])
  })
})
