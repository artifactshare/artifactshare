import { describe, expect, test } from 'vitest'
import { CLAUDE_INSTALL_URL, CURSOR_INSTALL_URL } from './connect-content'
import {
  claudeCustomConnectorUrl,
  cursorMcpInstallUrl,
  MCP_OAUTH_SCOPES,
  MCP_CONNECTOR_URL,
  protectedResourceMetadata,
} from './mcp-metadata'

// Install links are read by Cursor and Claude as parsed query parameters and
// decoded JSON, so they are compared that way and not as byte strings.
const NAME = 'Artifact Share'

const cursorInstall = (url: string) => {
  const parsed = new URL(url)
  return {
    scheme: parsed.protocol,
    target: `${parsed.host}${parsed.pathname}`,
    name: parsed.searchParams.get('name'),
    config: JSON.parse(atob(parsed.searchParams.get('config') ?? '')),
  }
}

const claudeInstall = (url: string) => {
  const parsed = new URL(url)
  return {
    origin: parsed.origin,
    pathname: parsed.pathname,
    params: Object.fromEntries([...parsed.searchParams].sort()),
  }
}

describe('cursorMcpInstallUrl', () => {
  test('base64-encodes the bare { url } config Cursor expects', () => {
    expect(cursorInstall(cursorMcpInstallUrl(NAME, MCP_CONNECTOR_URL))).toEqual(
      {
        scheme: 'cursor:',
        target: 'anysphere.cursor-deeplink/mcp/install',
        name: NAME,
        config: { url: MCP_CONNECTOR_URL },
      },
    )
  })
})

describe('claudeCustomConnectorUrl', () => {
  test('prefills Claude custom connector name and URL', () => {
    expect(
      claudeInstall(claudeCustomConnectorUrl(NAME, MCP_CONNECTOR_URL)),
    ).toEqual({
      origin: 'https://claude.ai',
      pathname: '/customize/connectors',
      params: {
        modal: 'add-custom-connector',
        connectorName: NAME,
        connectorUrl: MCP_CONNECTOR_URL,
      },
    })
  })
})

describe('connect page install links', () => {
  test('point at the current connector URL', () => {
    expect(MCP_CONNECTOR_URL).toBe('https://artifactshare.com/mcp')
    expect(claudeInstall(CLAUDE_INSTALL_URL)).toEqual(
      claudeInstall(claudeCustomConnectorUrl(NAME, MCP_CONNECTOR_URL)),
    )
    expect(cursorInstall(CURSOR_INSTALL_URL)).toEqual(
      cursorInstall(cursorMcpInstallUrl(NAME, MCP_CONNECTOR_URL)),
    )
  })
})

describe('MCP OAuth metadata', () => {
  test('advertises the complete supported scope set', () => {
    expect(new Set(MCP_OAUTH_SCOPES)).toEqual(
      new Set([
        'openid',
        'profile',
        'email',
        'offline_access',
        'artifactshare:access',
      ]),
    )
    expect(protectedResourceMetadata('https://example.com')).toEqual({
      resource: 'https://example.com/mcp',
      authorization_servers: ['https://example.com/api/auth'],
      bearer_methods_supported: ['header'],
      scopes_supported: [...MCP_OAUTH_SCOPES],
    })
  })
})
