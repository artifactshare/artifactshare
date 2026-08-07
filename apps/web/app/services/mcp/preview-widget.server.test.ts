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
  test('carries Claude and ChatGPT widget domains together', async () => {
    const result = await artifactPreviewResourceContents(
      'https://artifactshare.com',
      mcpResourceUrl('https://artifactshare.com'),
    )
    const meta = result.contents[0]._meta

    expect(meta['openai/widgetDomain']).toBe('https://artifactshare.com')
    expect(meta.ui.domain).toBe(
      '9c4c6fc24ec537cb113fc299b3b58165.claudemcpcontent.com',
    )
    expect(meta.ui.csp.frameDomains).toEqual([
      'https://artifactshare.com',
      'https://*.sandbox.artifactshare.com',
    ])
  })
})
