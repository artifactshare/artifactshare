import {
  ResourceTemplate,
  type McpServer,
} from '@modelcontextprotocol/sdk/server/mcp.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { getArtifactReadback } from '~/services/artifact-readback-service.server'
import {
  loadMcpUser,
  mcpUserAsSessionUser,
  type McpRequestContext,
} from './identity.server'

const ARTIFACT_RESOURCE_UNAVAILABLE = 'Artifact resource is not available.'
const ARTIFACT_RESOURCE_UNSUPPORTED = 'Artifact resource type is not supported.'
const ARTIFACT_RESOURCE_TOO_LARGE =
  'Artifact resource exceeds the supported size.'
const ARTIFACT_RESOURCE_SOURCE_UNAVAILABLE =
  'Artifact resource content is unavailable.'

export function artifactResourceTemplate(appOrigin: string): string {
  return `${appOrigin.replace(/\/$/, '')}/a/{id}`
}

async function enforcePerUserLimit(ctx: McpRequestContext): Promise<void> {
  const limiter = ctx.rateLimiters.perUser
  if (!limiter) return

  let success: boolean
  try {
    const result = await limiter.limit({
      key: `mcp:user:${ctx.identity.userId}`,
    })
    success = result.success
  } catch (error) {
    console.error('mcp_rate_limit_failed', error)
    return
  }

  if (!success) {
    throw new McpError(
      ErrorCode.RequestTimeout,
      'Artifact resource read is rate limited.',
    )
  }
}

export function registerArtifactResource(
  server: McpServer,
  ctx: McpRequestContext,
): void {
  const appOrigin = new URL(ctx.baseUrl).origin

  server.registerResource(
    'artifact',
    new ResourceTemplate(artifactResourceTemplate(appOrigin), {
      list: undefined,
    }),
    {
      title: 'Artifact Share artifact',
      description:
        'Reads the current Markdown or HTML source of an Artifact Share artifact.',
    },
    async (uri, variables) => {
      await enforcePerUserLimit(ctx)

      const id = uri.pathname.slice('/a/'.length)
      if (
        typeof variables.id !== 'string' ||
        id.length === 0 ||
        id.includes('/')
      ) {
        throw new McpError(
          ErrorCode.InvalidParams,
          ARTIFACT_RESOURCE_UNAVAILABLE,
        )
      }

      const user = await loadMcpUser(ctx.db, ctx.identity.userId)
      if (!user) {
        throw new McpError(
          ErrorCode.InternalError,
          'Artifact resource user is unavailable.',
        )
      }

      const result = await getArtifactReadback(
        ctx.db,
        mcpUserAsSessionUser(user),
        {
          id,
          baseUrl: ctx.baseUrl,
        },
      )

      switch (result.kind) {
        case 'ok':
          if (result.data.truncated) {
            throw new McpError(
              ErrorCode.InvalidParams,
              ARTIFACT_RESOURCE_TOO_LARGE,
            )
          }
          return {
            contents: [
              {
                uri: uri.href,
                mimeType:
                  result.data.format === 'markdown'
                    ? 'text/markdown'
                    : 'text/html',
                text: result.data.content,
              },
            ],
          }
        case 'not-found':
          throw new McpError(
            ErrorCode.InvalidParams,
            ARTIFACT_RESOURCE_UNAVAILABLE,
          )
        case 'unsupported-kind':
          throw new McpError(
            ErrorCode.InvalidParams,
            ARTIFACT_RESOURCE_UNSUPPORTED,
          )
        case 'source-unavailable':
          throw new McpError(
            ErrorCode.InternalError,
            ARTIFACT_RESOURCE_SOURCE_UNAVAILABLE,
          )
        default: {
          const exhaustive: never = result
          return exhaustive
        }
      }
    },
  )
}
