import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { ListResourcesRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker'
import { mcpResourceUrl } from '~/lib/mcp-metadata'
import type { McpRequestContext } from './identity.server'
import { registerArtifactResource } from './artifact-resource.server'
import { registerArtifactPreviewResource } from './preview-widget.server'
import { registerArtifactTools } from './tools.server'

const MCP_SERVER_INFO = {
  name: 'artifactshare',
  version: '0.1.0',
  title: 'Artifact Share',
} as const

/**
 * Build a fresh MCP server for one stateless request. The Streamable HTTP
 * transport handles a single request per instance, so each request creates a
 * new server+transport pair (see transport.server.ts).
 *
 * The validator is pinned to @cfworker/json-schema on purpose: the SDK default
 * constructs an AJV instance, and AJV's codegen (`new Function`) is blocked on
 * Workers. This provider validates without code generation.
 */
export function createMcpServer(ctx: McpRequestContext): McpServer {
  const server = new McpServer(MCP_SERVER_INFO, {
    capabilities: { tools: {}, resources: {} },
    jsonSchemaValidator: new CfWorkerJsonSchemaValidator(),
  })
  registerArtifactTools(server, ctx)
  const artifactResource = registerArtifactResource(server, ctx)
  registerArtifactPreviewResource(
    server,
    new URL(ctx.baseUrl).origin,
    mcpResourceUrl(ctx.baseUrl),
  )

  const listArtifacts = artifactResource.resourceTemplate.listCallback
  if (!listArtifacts) {
    throw new Error('Artifact resource listing is unavailable.')
  }

  // The SDK includes every static resource in resources/list. Keep the
  // ui:// preview readable for MCP Apps, but expose only user-selectable
  // artifacts through resource discovery.
  server.server.setRequestHandler(
    ListResourcesRequestSchema,
    (_request, extra) => listArtifacts(extra),
  )
  return server
}
