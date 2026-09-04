import {
  ResourceTemplate,
  type McpServer,
} from '@modelcontextprotocol/sdk/server/mcp.js'
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js'
import { displayTitle } from '~/lib/display-title'
import { lowerEmail } from '~/lib/grant-emails.server'
import { grantMatchEmail, isTeamWorkspaceAdmin } from '~/services/access.server'
import { getArtifactReadback } from '~/services/artifact-readback-service.server'
import {
  visibleShareableToViewerSql,
  visibleSharedProjectShareableToViewerSql,
} from '~/services/projects.server'
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
const ARTIFACT_RESOURCE_LIST_LIMIT = 50

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
      list: async () => {
        await enforcePerUserLimit(ctx)

        const user = await loadMcpUser(ctx.db, ctx.identity.userId)
        if (!user) {
          throw new McpError(
            ErrorCode.InternalError,
            'Artifact resource user is unavailable.',
          )
        }

        const viewer = mcpUserAsSessionUser(user)
        const isWorkspaceAdmin = await isTeamWorkspaceAdmin(
          ctx.db,
          viewer,
          viewer.workspaceId,
        )
        const rows = await ctx.db
          .selectFrom('shareables')
          .innerJoin('versions', (join) =>
            join
              .onRef('versions.id', '=', 'shareables.current_version_id')
              .onRef('versions.shareable_id', '=', 'shareables.id'),
          )
          .select([
            'shareables.id',
            'shareables.name',
            'shareables.derived_title',
            'shareables.title_override',
            'versions.artifact_kind',
          ])
          .where('versions.status', '=', 'published')
          .where('versions.artifact_kind', 'in', ['markdown_page', 'html_page'])
          .where((eb) =>
            eb.or([
              eb('shareables.owner_user_id', '=', viewer.id),
              eb.exists(
                eb
                  .selectFrom('shareable_grants')
                  .select('shareable_grants.shareable_id')
                  .whereRef(
                    'shareable_grants.shareable_id',
                    '=',
                    'shareables.id',
                  )
                  .where(
                    lowerEmail('shareable_grants.granted_email'),
                    '=',
                    grantMatchEmail(viewer),
                  ),
              ),
              eb.and([
                eb('shareables.workspace_id', '=', viewer.workspaceId),
                eb('shareables.visibility', '!=', 'link'),
                visibleShareableToViewerSql(viewer),
              ]),
              eb.and([
                eb('shareables.workspace_id', '!=', viewer.workspaceId),
                eb('shareables.visibility', '!=', 'link'),
                eb.exists(
                  eb
                    .selectFrom('project_members')
                    .select('project_members.user_id')
                    .whereRef(
                      'project_members.container_id',
                      '=',
                      'shareables.container_id',
                    )
                    .where('project_members.user_id', '=', viewer.id),
                ),
                eb.exists(
                  eb
                    .selectFrom('project_share_defaults')
                    .select('project_share_defaults.id')
                    .whereRef(
                      'project_share_defaults.project_container_id',
                      '=',
                      'shareables.container_id',
                    )
                    .where(
                      lowerEmail('project_share_defaults.email'),
                      '=',
                      grantMatchEmail(viewer),
                    ),
                ),
                visibleSharedProjectShareableToViewerSql(viewer),
              ]),
              ...(isWorkspaceAdmin
                ? [
                    eb.and([
                      eb('shareables.workspace_id', '=', viewer.workspaceId),
                      eb('shareables.visibility', '=', 'link'),
                    ]),
                  ]
                : []),
            ]),
          )
          .orderBy('shareables.updated_at', 'desc')
          .orderBy('shareables.id', 'desc')
          .limit(ARTIFACT_RESOURCE_LIST_LIMIT)
          .execute()

        return {
          resources: rows.map((row) => ({
            uri: `${appOrigin}/a/${row.id}`,
            name: row.id,
            title: displayTitle({
              titleOverride: row.title_override,
              derivedTitle: row.derived_title,
              name: row.name,
            }),
            mimeType:
              row.artifact_kind === 'markdown_page'
                ? 'text/markdown'
                : 'text/html',
          })),
        }
      },
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
