import { APEX_HOST } from './hosts'

export const MCP_RESOURCE_PATH = '/mcp'

export const MCP_CONNECTOR_URL = `https://${APEX_HOST}${MCP_RESOURCE_PATH}`

/**
 * Cursor one-click install deep link. Cursor base64-encodes the per-server
 * transport config alone — the `{ url }` object, not the `{ name: { … } }`
 * wrapper — and reads the display name from the `name` query parameter.
 */
export function cursorMcpInstallUrl(
  name: string,
  connectorUrl: string,
): string {
  const config = btoa(JSON.stringify({ url: connectorUrl }))
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${encodeURIComponent(name)}&config=${config}`
}

export function claudeCustomConnectorUrl(
  name: string,
  connectorUrl: string,
): string {
  const params = new URLSearchParams({
    modal: 'add-custom-connector',
    connectorName: name,
    connectorUrl,
  })
  return `https://claude.ai/customize/connectors?${params.toString()}`
}

export const AUTH_BASE_PATH = '/api/auth'

const trimTrailingSlash = (url: string) => url.replace(/\/$/, '')

export function mcpResourceUrl(baseUrl: string): string {
  return `${trimTrailingSlash(baseUrl)}${MCP_RESOURCE_PATH}`
}

/**
 * The OAuth issuer. better-auth serves the authorization server under its base
 * path, so the issuer — and the `iss` claim on tokens — is the origin plus that
 * path, not the bare origin.
 */
export function oauthIssuer(baseUrl: string): string {
  return `${trimTrailingSlash(baseUrl)}${AUTH_BASE_PATH}`
}

export const oauthAuthorizePath = `${AUTH_BASE_PATH}/oauth2/authorize`

export const MCP_OAUTH_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'artifactshare:access',
] as const

/** RFC 9728 protected-resource metadata for the MCP endpoint. */
export function protectedResourceMetadata(baseUrl: string) {
  return {
    resource: mcpResourceUrl(baseUrl),
    authorization_servers: [oauthIssuer(baseUrl)],
    bearer_methods_supported: ['header'],
    scopes_supported: [...MCP_OAUTH_SCOPES],
  }
}
