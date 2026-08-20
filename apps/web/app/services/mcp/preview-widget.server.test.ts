import { describe, expect, test } from 'vitest'
import { mcpResourceUrl } from '~/lib/mcp-metadata'
import {
  artifactPreviewResourceContents,
  computeClaudeWidgetDomain,
} from './preview-widget.server'

describe('computeClaudeWidgetDomain', () => {
  test('derives the production Claude widget host from the MCP endpoint URL', async () => {
    await expect(
      computeClaudeWidgetDomain('https://artifactshare.com/mcp'),
    ).resolves.toBe('9c4c6fc24ec537cb113fc299b3b58165.claudemcpcontent.com')
  })
})

describe('artifactPreviewResourceContents', () => {
  test('carries host widget domains without permitting nested frames', async () => {
    const result = await artifactPreviewResourceContents(
      'https://artifactshare.com',
      mcpResourceUrl('https://artifactshare.com'),
    )
    const meta = result.contents[0]._meta

    expect(meta['openai/widgetDomain']).toBe('https://artifactshare.com')
    expect(meta.ui.domain).toBe(
      '9c4c6fc24ec537cb113fc299b3b58165.claudemcpcontent.com',
    )
    expect(meta.ui.csp).not.toHaveProperty('frameDomains')
    expect(meta.ui.csp.resourceDomains).toEqual(['https://esm.sh'])
  })

  test('renders a portable card with standard and compatibility bridges', async () => {
    const result = await artifactPreviewResourceContents(
      'https://artifactshare.com',
      mcpResourceUrl('https://artifactshare.com'),
    )
    const html = result.contents[0].text

    expect(html).toContain('id="as-card"')
    expect(html).toContain('@modelcontextprotocol/ext-apps@1.7.5')
    expect(html).toContain('new mod.PostMessageTransport()')
    expect(html).toContain('window.openai.openExternal')
    expect(html).toContain('window.openai.notifyIntrinsicHeight(height)')
    expect(html).toContain("getElementById('as-card')")
    expect(html).toContain('getBoundingClientRect().height')
    expect(html).toContain('{ autoResize: true }')
    expect(html).toContain('new ResizeObserver(reportIntrinsicHeight)')
    expect(html).toContain("url.protocol === 'https:'")
    expect(html).not.toContain('<iframe')
    expect(html).not.toContain('preview_url')
    expect(html).not.toContain('requestDisplayMode')
  })
})
