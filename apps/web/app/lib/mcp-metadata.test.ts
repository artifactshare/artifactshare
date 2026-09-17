import { describe, expect, test } from 'vitest'
import { CLAUDE_INSTALL_URL, CURSOR_INSTALL_URL } from './connect-content'
import {
  claudeCustomConnectorUrl,
  cursorMcpInstallUrl,
  MCP_OAUTH_SCOPES,
  MCP_CONNECTOR_URL,
  protectedResourceMetadata,
} from './mcp-metadata'

const EXPECTED_CURSOR =
  'cursor://anysphere.cursor-deeplink/mcp/install?name=Artifact%20Share&config=eyJ1cmwiOiJodHRwczovL2FydGlmYWN0c2hhcmUuY29tL21jcCJ9'
const EXPECTED_CLAUDE =
  'https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Artifact+Share&connectorUrl=https%3A%2F%2Fartifactshare.com%2Fmcp'

describe('cursorMcpInstallUrl', () => {
  test('base64-encodes the bare { url } config Cursor expects', () => {
    expect(
      cursorMcpInstallUrl('Artifact Share', 'https://artifactshare.com/mcp'),
    ).toBe(EXPECTED_CURSOR)
  })
})

describe('claudeCustomConnectorUrl', () => {
  test('prefills Claude custom connector name and URL', () => {
    expect(
      claudeCustomConnectorUrl(
        'Artifact Share',
        'https://artifactshare.com/mcp',
      ),
    ).toBe(EXPECTED_CLAUDE)
  })
})

describe('connect page install link', () => {
  // Locks the link the /connect page renders. Built from MCP_CONNECTOR_URL, so
  // a change to the connector URL must update this expectation deliberately.
  test('is built from the current connector URL', () => {
    expect(MCP_CONNECTOR_URL).toBe('https://artifactshare.com/mcp')
    expect(CLAUDE_INSTALL_URL).toBe(EXPECTED_CLAUDE)
    expect(CURSOR_INSTALL_URL).toBe(EXPECTED_CURSOR)
  })
})

describe('MCP OAuth metadata', () => {
  test('advertises the complete supported scope set', () => {
    expect(MCP_OAUTH_SCOPES).toEqual([
      'openid',
      'profile',
      'email',
      'offline_access',
      'artifactshare:access',
    ])
    expect(protectedResourceMetadata('https://example.com')).toEqual({
      resource: 'https://example.com/mcp',
      authorization_servers: ['https://example.com/api/auth'],
      bearer_methods_supported: ['header'],
      scopes_supported: [...MCP_OAUTH_SCOPES],
    })
  })
})
